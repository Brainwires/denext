// Brute-force protection on the credentials endpoint: the in-memory store, the
// limiter, the default key derivation, and the 429 wiring in handleCredentials
// (lockout after N failures, reset on success, keyGenerator override, opt-out).

import { assert, assertEquals } from "@std/assert";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { credentials } from "../src/server/auth/providers.ts";
import {
  createRateLimiter,
  defaultRateLimitKey,
  inMemoryRateLimitStore,
} from "../src/server/auth/rate-limit.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";

const ORIGIN = "https://app.test";

/** Run `body` with `Date.now` shifted by `deltaMs`. */
async function atOffset(deltaMs: number, body: () => Promise<void> | void): Promise<void> {
  const real = Date.now;
  Date.now = () => real() + deltaMs;
  try {
    await body();
  } finally {
    Date.now = real;
  }
}

// ---- store + limiter -------------------------------------------------------

Deno.test("inMemoryRateLimitStore: increments within a window, expires, resets, evicts", async () => {
  const store = inMemoryRateLimitStore({ maxKeys: 2 });
  assertEquals(store.get("a"), undefined);
  assertEquals((await store.increment("a", 1000)).count, 1);
  const w = await store.increment("a", 1000);
  assertEquals(w.count, 2);
  assert(w.resetAt > Date.now() && w.resetAt <= Date.now() + 1000, "window closes in ≤1s");
  await atOffset(1500, async () => {
    assertEquals(await store.get("a"), undefined, "an expired window reads as none");
    assertEquals((await store.increment("a", 1000)).count, 1, "…and a new one opens at 1");
  });
  store.reset("a");
  assertEquals(store.get("a"), undefined);
  // Past maxKeys the oldest key is evicted (FIFO).
  store.increment("k1", 60_000);
  store.increment("k2", 60_000);
  store.increment("k3", 60_000);
  assertEquals(store.get("k1"), undefined, "oldest evicted");
  assertEquals((await store.get("k3"))?.count, 1);
});

Deno.test("createRateLimiter: locks out after `max` failures, reports retry-after, resets on success", async () => {
  const limiter = createRateLimiter({ max: 2, windowMs: 30_000 });
  assertEquals(await limiter.lockedOut("k"), null);
  await limiter.fail("k");
  assertEquals(await limiter.lockedOut("k"), null, "one failure below max");
  await limiter.fail("k");
  const retry = await limiter.lockedOut("k");
  assert(retry !== null && retry >= 1 && retry <= 30, `retry-after in seconds: ${retry}`);
  await limiter.succeed("k");
  assertEquals(await limiter.lockedOut("k"), null, "a success clears the key");
  await limiter.fail("k");
  await limiter.fail("k");
  await atOffset(31_000, async () => {
    assertEquals(await limiter.lockedOut("k"), null, "the window expired");
  });
});

Deno.test("defaultRateLimitKey: forwarded IP only behind a trusted proxy + the lower-cased identifier", () => {
  const req = (headers: Record<string, string>) => new Request(`${ORIGIN}/x`, { headers });
  const xff = req({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
  // Untrusted (default): the header is whatever the client sent, so it is ignored — no
  // socket peer is known for a hand-built Request, hence `unknown`. A forged header can't
  // mint a fresh key per attempt.
  assertEquals(defaultRateLimitKey(xff, { email: "A@B.co" }), "unknown|a@b.co");
  assertEquals(
    defaultRateLimitKey(req({ "x-real-ip": "198.51.100.7" }), { username: " Bob " }),
    "unknown|bob",
  );
  // Behind a declared proxy the LAST hop (the one the proxy appended) is the client.
  assertEquals(
    defaultRateLimitKey(xff, { email: "A@B.co" }, { trustForwardedHeaders: true }),
    "10.0.0.1|a@b.co",
  );
  assertEquals(defaultRateLimitKey(req({}), { password: "x" }), "unknown|");
});

// ---- the credentials endpoint ----------------------------------------------

function limitedConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    secret: "test-secret-value-at-least-32-chars-long",
    canonicalOrigin: ORIGIN,
    providers: [
      credentials({
        authorize: ({ email, password }) =>
          email === "a@b.co" && password === "pw" ? { id: "1", email } : null,
      }),
    ],
    rateLimit: { max: 2, windowMs: 60_000 },
    ...overrides,
  };
}

/** POST the credentials endpoint as a JSON client from `ip`; returns the response. */
function login(
  config: AuthConfig,
  body: Record<string, string>,
  ip = "203.0.113.1",
): Promise<Response> {
  const request = new Request(`${ORIGIN}/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: ORIGIN,
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
  return runWithContext(
    createRequestContext(request),
    () => handleAuthRequest(request, config),
  ) as Promise<Response>;
}

Deno.test("credentials: a forged x-forwarded-for cannot dodge the limiter (untrusted by default)", async () => {
  const config = limitedConfig();
  assertEquals((await login(config, { email: "a@b.co", password: "no" }, "1.1.1.1")).status, 401);
  assertEquals((await login(config, { email: "a@b.co", password: "no" }, "2.2.2.2")).status, 401);
  // Third attempt from a third "IP": the header is ignored, so the account key is locked.
  assertEquals((await login(config, { email: "a@b.co", password: "pw" }, "3.3.3.3")).status, 429);
});

Deno.test("credentials: too many failures → generic 429 with Retry-After, even for the right password", async () => {
  // Behind a trusted proxy the forwarded IP is part of the key (per client + account).
  const config = limitedConfig({ trustForwardedHeaders: true });
  assertEquals((await login(config, { email: "a@b.co", password: "no" })).status, 401);
  assertEquals((await login(config, { email: "a@b.co", password: "no" })).status, 401);
  const locked = await login(config, { email: "a@b.co", password: "pw" });
  assertEquals(locked.status, 429);
  assertEquals((await locked.json()).error, "too many attempts", "generic — no account hint");
  assert(Number(locked.headers.get("retry-after")) >= 1, "Retry-After is set");
  assertEquals(locked.headers.get("cache-control"), "no-store");
  // Another client (IP) for the same account is not locked out under the default key.
  assertEquals(
    (await login(config, { email: "a@b.co", password: "pw" }, "203.0.113.2")).status,
    200,
  );
  // Another account from the locked IP is a different key too.
  assertEquals((await login(config, { email: "z@b.co", password: "pw" })).status, 401);
});

Deno.test("credentials: a successful sign-in resets the failure count", async () => {
  const config = limitedConfig();
  assertEquals((await login(config, { email: "a@b.co", password: "no" })).status, 401);
  assertEquals((await login(config, { email: "a@b.co", password: "pw" })).status, 200);
  assertEquals((await login(config, { email: "a@b.co", password: "no" })).status, 401);
  assertEquals((await login(config, { email: "a@b.co", password: "no" })).status, 401);
  assertEquals((await login(config, { email: "a@b.co", password: "pw" })).status, 429);
});

Deno.test("credentials: the lockout lifts when the window expires", async () => {
  const config = limitedConfig({ rateLimit: { max: 1, windowMs: 10_000 } });
  assertEquals((await login(config, { email: "a@b.co", password: "no" })).status, 401);
  assertEquals((await login(config, { email: "a@b.co", password: "pw" })).status, 429);
  await atOffset(11_000, async () => {
    assertEquals((await login(config, { email: "a@b.co", password: "pw" })).status, 200);
  });
});

Deno.test("credentials: keyGenerator override (per-account, IP-agnostic) and a custom store", async () => {
  const store = inMemoryRateLimitStore();
  const config = limitedConfig({
    rateLimit: {
      max: 1,
      windowMs: 60_000,
      store,
      keyGenerator: (_req, creds) => `acct:${(creds.email ?? "").toLowerCase()}`,
    },
  });
  assertEquals((await login(config, { email: "a@b.co", password: "no" }, "1.1.1.1")).status, 401);
  assertEquals((await store.get("acct:a@b.co"))?.count, 1, "the custom store saw the key");
  // A different IP shares the per-account lockout.
  assertEquals((await login(config, { email: "A@B.CO", password: "pw" }, "2.2.2.2")).status, 429);
});

Deno.test("credentials: rateLimit:false disables the limiter (every failure is a plain 401)", async () => {
  const config = limitedConfig({ rateLimit: false });
  for (let i = 0; i < 6; i++) {
    assertEquals((await login(config, { email: "a@b.co", password: "no" })).status, 401);
  }
  assertEquals((await login(config, { email: "a@b.co", password: "pw" })).status, 200);
});

Deno.test("credentials: the limiter is ON by default with conservative limits (5 per window)", async () => {
  const config = limitedConfig({ rateLimit: undefined });
  delete config.rateLimit;
  for (let i = 0; i < 5; i++) {
    assertEquals((await login(config, { email: "a@b.co", password: "no" })).status, 401, `#${i}`);
  }
  assertEquals((await login(config, { email: "a@b.co", password: "pw" })).status, 429);
});

Deno.test("credentials: hostile inputs degrade to 404/redirect, never a 500", async () => {
  const config = limitedConfig();
  // An undecodable provider id is an unknown route, not a URIError.
  const bad = new Request(`${ORIGIN}/auth/signin/%zz`, { headers: { origin: ORIGIN } });
  assertEquals(await handleAuthRequest(bad, config), null);
  // A non-string callbackUrl in the JSON body is ignored (falls back to afterSignIn).
  const res = await login(config, {
    email: "a@b.co",
    password: "pw",
    callbackUrl: { evil: 1 } as unknown as string,
  });
  assertEquals(res.status, 200);
});

Deno.test("credentials: a session callback that mangles expiresAt gets the configured lifetime back", async () => {
  const config = limitedConfig({
    callbacks: {
      session: (s) => ({ ...s, expiresAt: "soon" as unknown as number }),
    },
  });
  assertEquals((await login(config, { email: "a@b.co", password: "pw" })).status, 200);
});

Deno.test("inMemoryRateLimitStore: eviction drops expired windows first and keeps the busiest keys", async () => {
  const store = inMemoryRateLimitStore({ maxKeys: 3 });
  await store.increment("locked", 60_000);
  await store.increment("locked", 60_000);
  await store.increment("locked", 60_000);
  await store.increment("quiet-1", 60_000);
  await store.increment("quiet-2", 60_000);
  await store.increment("quiet-3", 60_000); // over the cap: a quiet key goes, not `locked`
  assertEquals((await store.get("locked"))?.count, 3, "a key mid-lockout is never washed out");
});
