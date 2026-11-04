// With `@denext/backend`'s Postgres set up, the auth state that must hold across replicas
// defaults onto it: the limiters' store (the adapter's own `rateLimits`, else one on the
// backend's client) and the SAML message-id replay cache (the adapter's claim, else the auth
// table on the backend's client). Without the backend both stay per process. A scripted client
// stands in for Postgres; tests/backend-auth-replicas-integration.test.ts runs two real replicas.

import { assert, assertEquals } from "@std/assert";
import { scriptedSql } from "./helpers/scripted-sql.ts";
import {
  credentialsLimiter,
  inMemoryRateLimitStore,
  type RateLimitStore,
} from "../packages/auth/src/rate-limit.ts";
import { replayCacheOf } from "../packages/auth/src/gotrue/sso-providers.ts";
import type { AuthAdapter } from "../packages/auth/src/adapter.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";

/** A fake Postgres that answers the two statements under test and records the rest. */
function fakePostgres() {
  const claimed = new Set<string>();
  return scriptedSql((text, params) => {
    if (/INSERT INTO\s+\S*auth_rate_limits/.test(text)) {
      return [{ hits: 1, reset_at: Date.now() + 60_000 }];
    }
    if (/INSERT INTO\s+\S*auth_saml_message_ids/.test(text)) {
      const id = String(params[0]);
      if (claimed.has(id)) return [];
      claimed.add(id);
      return [{ id }];
    }
    return [];
  });
}

const touched = (sql: ReturnType<typeof fakePostgres>, table: string) =>
  sql.calls.some((call) => call.text.includes(table));

/** A store that records the keys it counted. */
function spyStore(): RateLimitStore & { keys: string[] } {
  const inner = inMemoryRateLimitStore();
  const keys: string[] = [];
  return {
    keys,
    get: (key) => inner.get(key),
    increment: (key, windowMs) => {
      keys.push(key);
      return inner.increment(key, windowMs);
    },
    reset: (key) => inner.reset(key),
  };
}

Deno.test("auth limiters: per process without the backend, its Postgres with it", async () => {
  const sql = fakePostgres();
  try {
    // No backend: the in-memory default, nothing reaches a database.
    await credentialsLimiter({})!.hit("k1");
    installPostgres({ sql });
    assertEquals(sql.calls.length, 0);

    // The backend's Postgres and an adapter without a store: auth_rate_limits on its client.
    await credentialsLimiter({})!.hit("k2");
    assert(touched(sql, "auth_rate_limits"), "counted in Postgres");

    // The adapter's own store (backendAuthAdapter()'s, in the adapter's schema) comes first.
    const own = spyStore();
    sql.calls.length = 0;
    await credentialsLimiter({ adapter: { rateLimits: own } })!.hit("k3");
    assertEquals(own.keys, ["k3"]);
    assert(!touched(sql, "auth_rate_limits"));

    // An explicit rateLimit.store always wins.
    const explicit = spyStore();
    await credentialsLimiter({ adapter: { rateLimits: own }, rateLimit: { store: explicit } })!
      .hit("k4");
    assertEquals([explicit.keys, own.keys], [["k4"], ["k3"]]);
  } finally {
    installPostgres(undefined);
  }
});

Deno.test("SAML replay cache: the adapter's claim, else the backend's Postgres, else the process", async () => {
  const sql = fakePostgres();
  const expires = Math.floor(Date.now() / 1000) + 300;
  const cache = (adapter?: Partial<AuthAdapter>) =>
    replayCacheOf({ adapter } as unknown as Parameters<typeof replayCacheOf>[0], "assertion");
  try {
    // An adapter that keeps the claim (but not the rest of the SSO group) is used.
    const seen: string[] = [];
    const adapter: Partial<AuthAdapter> = {
      claimSamlMessageId: (id) => {
        const fresh = !seen.includes(id);
        seen.push(id);
        return fresh;
      },
    };
    assertEquals(await cache(adapter).claim("_a1", expires), true);
    assertEquals(await cache(adapter).claim("_a1", expires), false);
    assertEquals(seen.length, 2);

    // No claim on the adapter, no backend: a per-process cache.
    assertEquals(await cache({}).claim("_p1", expires), true);
    assertEquals(await cache({}).claim("_p1", expires), false);

    // With the backend's Postgres it is the shared table, never the process.
    installPostgres({ sql });
    assertEquals(await cache({}).claim("_b1", expires), true);
    assert(touched(sql, "auth_saml_message_ids"), "claimed in Postgres");
    assertEquals(await cache(undefined).claim("_b1", expires), false);
    // An id the process cache already holds is still claimed in Postgres (a different replica
    // may never have seen it).
    assertEquals(await cache({}).claim("_p1", expires), true);
  } finally {
    installPostgres(undefined);
  }
});
