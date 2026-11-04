// Records a read refuses for good are deleted (or revoked, for the adapter to reclaim) when the
// read meets them, with the answer unchanged: a server-side cookie session of a deleted user, of
// a user who ended it (`sessionsValidAfter`) or of an SSO user its identity provider didn't
// start; a bearer API token whose owner is gone or an SSO user; and a ban's refusals whose record
// expires before the ban ends. A ban that ends first only refuses: the record works again after
// it (tests/auth-ban-tokens.test.ts holds that, unchanged).

import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import type { ApiTokenRecord, AuthAdapter } from "../packages/auth/src/adapter.ts";
import { postgresAuthAdapter } from "../packages/auth/src/postgres-adapter.ts";
import { sqliteAuthAdapter } from "../packages/auth/src/sqlite-adapter.ts";
import { fakeSqlClient } from "./helpers/fake-sql-client.ts";
import { issueApiToken, verifyApiToken } from "../packages/auth/src/api-token.ts";
import { inMemoryAuthAdapter } from "../packages/auth/src/memory-adapter.ts";
import {
  refreshNativeSession,
  resolveNative,
  startNativeSession,
} from "../packages/auth/src/native.ts";
import { credentials } from "../packages/auth/src/providers.ts";
import { hashPassword } from "../src/server/password.ts";
import { inMemorySessionStore, type SessionStore } from "../packages/auth/src/session-store.ts";
import { readAuthSession } from "../packages/auth/src/session.ts";
import type { AuthConfig, AuthSession } from "../packages/auth/src/types.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { ORIGIN, type SupabaseAuthApp, supabaseAuthApp } from "./_supabase-auth-app.ts";

const SECRET = "test-secret-value-at-least-32-chars-long";
const PASSWORD = "the first password";
const SESSION_COOKIE = /^__Host-denext_auth=[^;]/;

/** A session store that keeps count of its records. */
function countingStore(): SessionStore & { readonly ids: Set<string> } {
  const inner = inMemorySessionStore();
  const ids = new Set<string>();
  return {
    ids,
    async create(id, session) {
      ids.add(id);
      await inner.create(id, session);
    },
    update: (id, session) => inner.update!(id, session),
    get: (id) => inner.get(id),
    async delete(id) {
      ids.delete(id);
      await inner.delete(id);
    },
    deleteByUser: (userId) => inner.deleteByUser(userId),
  };
}

async function withApp(
  fn: (app: SupabaseAuthApp, store: ReturnType<typeof countingStore>) => Promise<void>,
  adapter: AuthAdapter = inMemoryAuthAdapter(),
): Promise<void> {
  const store = countingStore();
  const app = await supabaseAuthApp({
    adapter,
    authConfig: { providers: [credentials()], sessionStore: store },
    withClient: false,
  });
  try {
    await fn(app, store);
  } finally {
    await app.close();
  }
}

async function passwordUser(app: SupabaseAuthApp, email: string): Promise<string> {
  const adapter = app.config.adapter!;
  const user = await adapter.createUser({ email, emailVerified: Math.floor(Date.now() / 1000) });
  await adapter.setCredential!(user.id, await hashPassword(PASSWORD));
  return user.id;
}

async function signIn(app: SupabaseAuthApp, email: string): Promise<string> {
  const res = await app.fetch(`${ORIGIN}/auth/callback/credentials`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  await res.body?.cancel();
  const pair = res.headers.getSetCookie().find((c) => SESSION_COOKIE.test(c));
  assert(pair, `a session cookie (${res.status})`);
  return pair.split(";")[0];
}

function read(app: SupabaseAuthApp, cookie: string): Promise<AuthSession | null> {
  const ctx = createRequestContext(new Request(`${ORIGIN}/`, { headers: { cookie } }));
  return runWithContext(ctx, () => readAuthSession(app.config));
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

Deno.test("a deleted user's server-side session is refused and its record deleted", async () => {
  const base = inMemoryAuthAdapter();
  // An adapter that keeps the rest of a deleted user's rows: only the user row goes.
  const adapter: AuthAdapter = { ...base, deleteUser: (id) => base.deleteUser!(id) };
  await withApp(async (app, store) => {
    const id = await passwordUser(app, "gone@example.test");
    const cookie = await signIn(app, "gone@example.test");
    assert(await read(app, cookie));
    assertEquals(store.ids.size, 1);
    await adapter.deleteUser!(id);
    assertEquals(await read(app, cookie), null);
    assertEquals(store.ids.size, 0, "the dead record is gone");
  }, adapter);
});

Deno.test("a session the user ended (sessionsValidAfter) is deleted when read", async () => {
  await withApp(async (app, store) => {
    const id = await passwordUser(app, "ended@example.test");
    const cookie = await signIn(app, "ended@example.test");
    await app.config.adapter!.updateUser({ id, sessionsValidAfter: nowSeconds() + 1 });
    assertEquals(await read(app, cookie), null);
    assertEquals(store.ids.size, 0);
  });
});

Deno.test("a ban that outlasts a session deletes it; a shorter one only refuses", async () => {
  await withApp(async (app, store) => {
    const id = await passwordUser(app, "banned@example.test");
    const cookie = await signIn(app, "banned@example.test");
    const adapter = app.config.adapter!;
    // Shorter than the session: refused while it lasts, kept, and live again after.
    await adapter.updateUser({ id, bannedUntil: nowSeconds() + 60 });
    assertEquals(await read(app, cookie), null);
    assertEquals(store.ids.size, 1, "kept: the ban ends before the session does");
    await adapter.updateUser({ id, bannedUntil: nowSeconds() - 1 });
    assert(await read(app, cookie), "live again once the ban ended");
    // Longer than the session: it can never be used again.
    await adapter.updateUser({ id, bannedUntil: nowSeconds() + 10 * 365 * 86_400 });
    assertEquals(await read(app, cookie), null);
    assertEquals(store.ids.size, 0, "deleted: it expires before the ban ends");
  });
});

/** An auth config with bearer tokens and native sessions on `adapter`, and the revocations seen. */
async function tokenSetup(adapter: AuthAdapter = inMemoryAuthAdapter()) {
  const user = await adapter.createUser({ email: "owner@x.test" });
  const revoked: Array<{ tokenId: string; userId?: string; reason: string }> = [];
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: "https://app.test",
    providers: [{ id: "credentials", type: "credentials" }],
    adapter,
    rateLimit: false,
    native: { redirectUris: ["com.example.app://auth/callback"] },
    events: { apiTokenRevoked: (e) => void revoked.push(e) },
  };
  return { config, adapter, userId: user.id, revoked };
}

Deno.test("a bearer token whose owner is gone is refused and revoked", async () => {
  const base = inMemoryAuthAdapter();
  let gone = false;
  // An adapter that keeps a deleted user's tokens (its getUser no longer finds the user).
  const adapter: AuthAdapter = {
    ...base,
    getUser: (id) => gone ? undefined : base.getUser(id),
  };
  const { config, userId, revoked } = await tokenSetup(adapter);
  const { token, record } = await issueApiToken(config, { userId, name: "ci" });
  assert(await verifyApiToken(config, token));
  gone = true;
  assertEquals(await verifyApiToken(config, token), null);
  assertEquals(revoked, [{ tokenId: record.id, userId, reason: "owner_refused" }]);
  gone = false;
  assertEquals(await verifyApiToken(config, token), null, "revoked: refused for good");
});

Deno.test("a bearer token that expires before its owner's ban ends is revoked; one that outlives it is kept", async () => {
  const { config, adapter, userId, revoked } = await tokenSetup();
  const short = await issueApiToken(config, { userId, name: "short", expiresInSeconds: 3600 });
  const forever = await issueApiToken(config, { userId, name: "forever" });
  await adapter.updateUser({ id: userId, bannedUntil: nowSeconds() + 7200 });
  assertEquals(await verifyApiToken(config, short.token), null);
  assertEquals(await verifyApiToken(config, forever.token), null);
  assertEquals(revoked.map((e) => e.tokenId), [short.record.id], "only the one the ban outlives");
  await adapter.updateUser({ id: userId, bannedUntil: nowSeconds() - 1 });
  assert(await verifyApiToken(config, forever.token), "the other works once the ban ends");
});

Deno.test("a native session family that expires before the ban ends is revoked", async () => {
  const { config, adapter, userId } = await tokenSetup();
  const native = resolveNative(config)!;
  const tokens = await startNativeSession(config, native, {
    user: { id: userId },
    provider: "credentials",
    amr: ["pwd"],
    authTime: nowSeconds(),
  });
  await adapter.updateUser({ id: userId, bannedUntil: nowSeconds() + 10 * 365 * 86_400 });
  const refused = await refreshNativeSession(config, native, tokens.refresh_token);
  assertEquals(refused.ok ? "ok" : refused.reason, "banned", "the answer is unchanged");
  const family = await adapter.getNativeSession!(tokens.refresh_token.split(".")[0].slice(4));
  assert(family?.revokedAt !== undefined, "revoked: it can never refresh again");
});

Deno.test("revoked and expired API tokens are reclaimed once past the retention (sqlite, postgres)", async () => {
  const day = 86_400;
  const dir = await Deno.makeTempDir({ prefix: "dnx-dead-tokens-" });
  try {
    for (const make of ["sqlite", "postgres"] as const) {
      let clock = 1_000_000_000;
      const now = () => clock;
      const sql = fakeSqlClient();
      const path = `${dir}/auth.db`;
      const adapter = make === "sqlite"
        ? sqliteAuthAdapter({ path, now })
        : postgresAuthAdapter({ sql, now });
      const user = await adapter.createUser({ email: `${make}@x.test` });
      const token = (id: string, extra: Partial<ApiTokenRecord> = {}): ApiTokenRecord => ({
        id,
        userId: user.id,
        tokenHash: `hash-${id}`,
        createdAt: clock,
        ...extra,
      });
      await adapter.createApiToken!(token("revoked"));
      await adapter.revokeApiToken!("revoked");
      await adapter.createApiToken!(token("expired", { expiresAt: clock + 10 }));
      await adapter.createApiToken!(token("live"));
      // 31 days on, the next issue reclaims the dead rows; the live one stays.
      clock += 31 * day;
      await adapter.createApiToken!(token("next"));
      const query = "SELECT id FROM auth_api_tokens ORDER BY id";
      let ids: string[];
      if (make === "sqlite") {
        const db = new DatabaseSync(path);
        ids = (db.prepare(query).all() as Array<{ id: string }>).map((r) => r.id);
        db.close();
      } else {
        ids = (sql.raw.prepare(query).all() as Array<{ id: string }>).map((r) => r.id);
      }
      assertEquals(ids, ["live", "next"], make);
      await adapter.close?.();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
