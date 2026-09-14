// Brute-force protection on the sign-in endpoints: the in-memory store, the limiter
// factory, the key derivations, the 429 wiring in handleCredentials (lockout after N
// failures, reset on success, keyGenerator override, opt-out), and the dispatch-level
// per-IP budget on GET {basePath}/signin/:provider.

import { assert, assertEquals } from "@std/assert";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { credentials, github } from "../src/server/auth/providers.ts";
import {
  clientIpBucket,
  createRateLimiter,
  credentialsLimiter,
  defaultRateLimitKey,
  inMemoryRateLimitStore,
  ipBucketKey,
  sessionReadKey,
  sessionReadLimiter,
  signinStartKey,
  signinStartLimiter,
} from "../src/server/auth/rate-limit.ts";
import { setRemoteAddr } from "../src/server/remote-addr.ts";
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

Deno.test("inMemoryRateLimitStore: eviction drops expired windows first and keeps locked-out keys", async () => {
  const store = inMemoryRateLimitStore({ maxKeys: 3, lockoutAt: 3 });
  await store.increment("locked", 60_000);
  await store.increment("locked", 60_000);
  await store.increment("locked", 60_000);
  await store.increment("quiet-1", 60_000);
  await store.increment("quiet-2", 60_000);
  await store.increment("quiet-3", 60_000); // over the cap: a quiet key goes, not `locked`
  assertEquals((await store.get("locked"))?.count, 3, "a key mid-lockout is never washed out");
});

Deno.test("inMemoryRateLimitStore: a full store of live lockouts refuses the new key, fail-closed", async () => {
  const store = inMemoryRateLimitStore({ maxKeys: 2, lockoutAt: 1 });
  // Both slots are keys that are already locked out (count >= lockoutAt).
  await store.increment("attacker-a", 60_000);
  await store.increment("attacker-b", 60_000);
  const refused = await store.increment("newcomer", 60_000);
  assert(refused.count > 1, "the increment reports the key as over budget, so a reader 429s");
  assertEquals(await store.get("newcomer"), undefined, "nothing was tracked for it");
  assertEquals((await store.get("attacker-a"))?.count, 1, "…and no lockout was dropped for it");
  assertEquals((await store.get("attacker-b"))?.count, 1);
});

Deno.test("inMemoryRateLimitStore: an expired lockout is evictable again", async () => {
  const store = inMemoryRateLimitStore({ maxKeys: 2, lockoutAt: 1 });
  await store.increment("old", 1_000);
  await store.increment("older", 1_000);
  await atOffset(2_000, async () => {
    const w = await store.increment("fresh", 60_000);
    assertEquals(w.count, 1, "the expired windows made room");
    assertEquals((await store.get("fresh"))?.count, 1);
  });
});

Deno.test("clientIpBucket: every spelling of one IPv6 address shares ONE /64 bucket", () => {
  const at = (ip: string) => {
    const req = new Request(`${ORIGIN}/x`, { headers: { "x-forwarded-for": ip } });
    return clientIpBucket(req, { trustForwardedHeaders: true });
  };
  const loopback = at("::1");
  for (const spelling of ["0:0:0:0:0:0:0:1", "[::1]", "::0001", "0000:0000::0001"]) {
    assertEquals(at(spelling), loopback, `${spelling} must not open its own budget`);
  }
  // A /64 is one client's allocation: the host half must not multiply the buckets.
  const prefix = at("2001:db8:1:2::1");
  assertEquals(at("2001:db8:1:2:ffff:ffff:ffff:ffff"), prefix, "bucketed by /64");
  assert(at("2001:db8:1:3::1") !== prefix, "a different /64 is a different client");
  // IPv4 is untouched.
  assertEquals(at("203.0.113.9"), "203.0.113.9");
  assertEquals(at("not-an-ip"), "not-an-ip", "an unparseable value passes through");
});

// ---- the sign-in-start endpoint (GET {basePath}/signin/:provider) ------------

/** An OAuth config for the sign-in-START endpoint (which only mints a transaction + redirect). */
function signinConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    secret: "test-secret-value-at-least-32-chars-long",
    canonicalOrigin: ORIGIN,
    providers: [github({ clientId: "client-123", clientSecret: "shh" })],
    ...overrides,
  };
}

/**
 * `GET /auth/signin/idp` from `peer` (the socket peer the server loop would have recorded),
 * optionally also sending a `x-forwarded-for` header the app has not declared trustworthy.
 */
function signinStart(
  config: AuthConfig,
  peer?: string,
  forwardedFor?: string,
  provider = "github",
): Promise<Response | null> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (forwardedFor) headers["x-forwarded-for"] = forwardedFor;
  const request = new Request(`${ORIGIN}/auth/signin/${provider}`, { headers });
  if (peer) setRemoteAddr(request, { transport: "tcp", hostname: peer, port: 443 });
  return runWithContext(
    createRequestContext(request),
    () => handleAuthRequest(request, config),
  );
}

/** Hit sign-in-start `times` times and return the statuses (`null` → no route claimed it). */
async function signinStatuses(
  config: AuthConfig,
  times: number,
  peer?: string,
  forwardedFor?: string,
  provider = "github",
): Promise<Array<number | null>> {
  const out: Array<number | null> = [];
  for (let i = 0; i < times; i++) {
    out.push((await signinStart(config, peer, forwardedFor, provider))?.status ?? null);
  }
  return out;
}

Deno.test("signin-start: 20 starts per IP pass, the 21st is a 429 with Retry-After", async () => {
  const config = signinConfig();
  const statuses = await signinStatuses(config, 20, "203.0.113.10");
  assertEquals(new Set(statuses), new Set([303]), "the whole default budget redirects to the IdP");
  const locked = (await signinStart(config, "203.0.113.10"))!;
  assertEquals(locked.status, 429);
  assertEquals((await locked.json()).error, "too many attempts", "generic — no provider hint");
  assert(Number(locked.headers.get("retry-after")) >= 1, "Retry-After is set");
  assertEquals(locked.headers.get("cache-control"), "no-store");
});

Deno.test("signin-start: the budget is per IP — another client is unaffected", async () => {
  const config = signinConfig({ rateLimit: { signin: { max: 2, windowMs: 60_000 } } });
  assertEquals(await signinStatuses(config, 2, "198.51.100.1"), [303, 303]);
  assertEquals((await signinStart(config, "198.51.100.1"))!.status, 429);
  assertEquals((await signinStart(config, "198.51.100.2"))!.status, 303, "a different IP is fresh");
});

Deno.test("signin-start: a forged x-forwarded-for cannot mint a fresh bucket per request", async () => {
  const config = signinConfig({ rateLimit: { signin: { max: 2, windowMs: 60_000 } } });
  // Same socket peer, a different forged header every time: the header is not trusted, so
  // every attempt lands in the peer's bucket.
  assertEquals((await signinStart(config, "203.0.113.20", "1.1.1.1"))!.status, 303);
  assertEquals((await signinStart(config, "203.0.113.20", "2.2.2.2"))!.status, 303);
  assertEquals((await signinStart(config, "203.0.113.20", "3.3.3.3"))!.status, 429);
});

Deno.test("signin-start: behind a declared proxy the forwarded hop IS the bucket", async () => {
  const config = signinConfig({
    trustForwardedHeaders: true,
    rateLimit: { signin: { max: 1, windowMs: 60_000 } },
  });
  assertEquals((await signinStart(config, "10.0.0.1", "203.0.113.30"))!.status, 303);
  assertEquals((await signinStart(config, "10.0.0.1", "203.0.113.30"))!.status, 429, "same client");
  assertEquals((await signinStart(config, "10.0.0.1", "203.0.113.31"))!.status, 303, "another one");
});

Deno.test("signin-start: rateLimit:false disables it (and the credentials limiter with it)", async () => {
  const config = signinConfig({ rateLimit: false });
  const statuses = await signinStatuses(config, 25, "203.0.113.40");
  assertEquals(new Set(statuses), new Set([303]), "no 429 anywhere in 25 starts");
});

Deno.test("signin-start: the lockout lifts when the window expires", async () => {
  const config = signinConfig({ rateLimit: { signin: { max: 1, windowMs: 10_000 } } });
  assertEquals((await signinStart(config, "203.0.113.50"))!.status, 303);
  assertEquals((await signinStart(config, "203.0.113.50"))!.status, 429);
  await atOffset(11_000, async () => {
    assertEquals((await signinStart(config, "203.0.113.50"))!.status, 303);
  });
});

Deno.test("signin-start: the two budgets are separate — exhausting one leaves the other", async () => {
  // `max: 2` is the CREDENTIALS budget; sign-in-start keeps its own (default 20).
  const withBoth: AuthConfig = {
    ...limitedConfig({ rateLimit: { max: 2, windowMs: 60_000 } }),
    providers: [...limitedConfig().providers, ...signinConfig().providers],
  };
  assertEquals((await login(withBoth, { email: "a@b.co", password: "no" })).status, 401);
  assertEquals((await login(withBoth, { email: "a@b.co", password: "no" })).status, 401);
  assertEquals((await login(withBoth, { email: "a@b.co", password: "pw" })).status, 429);
  assertEquals((await signinStart(withBoth, "203.0.113.60"))!.status, 303, "untouched");
  // …and the reverse: burning the sign-in-start budget never locks the credentials one.
  const other: AuthConfig = {
    ...withBoth,
    rateLimit: { max: 2, windowMs: 60_000, signin: { max: 1, windowMs: 60_000 } },
  };
  assertEquals((await signinStart(other, "203.0.113.61"))!.status, 303);
  assertEquals((await signinStart(other, "203.0.113.61"))!.status, 429);
  assertEquals((await login(other, { email: "a@b.co", password: "pw" })).status, 200);
});

Deno.test("signin-start: hostile input is a fall-through or a 404, never a 500", async () => {
  const config = signinConfig({ rateLimit: { signin: { max: 1, windowMs: 60_000 } } });
  // An undecodable provider segment never reaches the gate — it is simply no route.
  const bad = new Request(`${ORIGIN}/auth/signin/%zz`, { headers: { origin: ORIGIN } });
  assertEquals(await handleAuthRequest(bad, config), null);
  // An unknown provider IS gated (probing costs budget) and answers 404, then 429.
  assertEquals((await signinStart(config, "203.0.113.70", undefined, "nope"))!.status, 404);
  assertEquals((await signinStart(config, "203.0.113.70", undefined, "nope"))!.status, 429);
  // No socket peer and no trusted header: the bucket is `unknown`, still not an error.
  assertEquals((await signinStart(signinConfig()))!.status, 303);
});

Deno.test("signin-start: an UNDECLARED proxy disables the per-IP budget instead of sharing one", async () => {
  // A private socket peer + an x-forwarded-for the app never declared trustworthy: every
  // client looks like the proxy, so keying on it would 429 the whole app at the 21st start.
  const config = signinConfig({ rateLimit: { signin: { max: 2, windowMs: 60_000 } } });
  for (let i = 0; i < 6; i++) {
    assertEquals(
      (await signinStart(config, "10.0.0.7", `203.0.113.${i}`))!.status,
      303,
      "no client is locked out by another client's traffic",
    );
  }
  // Declaring the proxy brings the budget back, keyed on the real client.
  const trusted = signinConfig({
    trustForwardedHeaders: true,
    rateLimit: { signin: { max: 2, windowMs: 60_000 } },
  });
  assertEquals((await signinStart(trusted, "10.0.0.7", "203.0.113.99"))!.status, 303);
  assertEquals((await signinStart(trusted, "10.0.0.7", "203.0.113.99"))!.status, 303);
  assertEquals((await signinStart(trusted, "10.0.0.7", "203.0.113.99"))!.status, 429);
});

Deno.test("GET /auth/session: a per-IP budget, off under rateLimit:false and behind an undeclared proxy", async () => {
  const config = signinConfig({ rateLimit: { session: { max: 2, windowMs: 60_000 } } });
  const read = (peer?: string, forwarded?: string) => {
    const headers: Record<string, string> = {};
    if (forwarded) headers["x-forwarded-for"] = forwarded;
    const request = new Request(`${ORIGIN}/auth/session`, { headers });
    if (peer) setRemoteAddr(request, { transport: "tcp", hostname: peer, port: 443 });
    return runWithContext(
      createRequestContext(request),
      () => handleAuthRequest(request, config),
    );
  };
  assertEquals((await read("198.51.100.9"))!.status, 200);
  assertEquals((await read("198.51.100.9"))!.status, 200);
  const locked = (await read("198.51.100.9"))!;
  assertEquals(locked.status, 429);
  assert(Number(locked.headers.get("retry-after")) >= 1);
  assertEquals((await read("198.51.100.10"))!.status, 200, "another client is unaffected");
  // Behind an undeclared proxy the budget is skipped rather than shared app-wide.
  for (let i = 0; i < 5; i++) {
    assertEquals((await read("127.0.0.1", `198.51.100.${i}`))!.status, 200);
  }
  const off = signinConfig({ rateLimit: false });
  assertEquals(sessionReadLimiter(off), null);
  assert(sessionReadLimiter(config) !== signinStartLimiter(config), "a third, separate budget");
  assert(sessionReadKey(new Request(`${ORIGIN}/x`)).startsWith("session|"));
});

Deno.test("signinStartKey: the client IP alone, namespaced away from the credentials keys", () => {
  const req = new Request(`${ORIGIN}/auth/signin/idp`, {
    headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
  });
  assertEquals(signinStartKey(req), "signin|unknown", "an untrusted header is ignored");
  assertEquals(
    signinStartKey(req, { trustForwardedHeaders: true }),
    "signin|10.0.0.1",
    "behind a proxy, the last hop",
  );
  assert(signinStartKey(req) !== ipBucketKey(req), "never collides with the credentials bucket");
});

Deno.test("signinStartLimiter/credentialsLimiter: memoised per config, both off under rateLimit:false", () => {
  const config = signinConfig();
  assert(signinStartLimiter(config) === signinStartLimiter(config), "memoised per config object");
  assert(credentialsLimiter(config) === credentialsLimiter(config));
  assert(signinStartLimiter(config) !== credentialsLimiter(config), "two separate budgets");
  const off = signinConfig({ rateLimit: false });
  assertEquals(signinStartLimiter(off), null);
  assertEquals(credentialsLimiter(off), null);
});

Deno.test("createRateLimiter: hit counts first, so concurrent hits never overrun; refund gives a unit back", async () => {
  const limiter = createRateLimiter({ max: 3, windowMs: 60_000 });
  const results = await Promise.all(Array.from({ length: 10 }, () => limiter.hit("k")));
  assertEquals(results.filter((r) => r === null).length, 3);
  assert(results.every((r) => r === null || r >= 1), "a refusal carries Retry-After");

  const single = createRateLimiter({ max: 1, windowMs: 60_000 });
  assertEquals(await single.hit("j"), null);
  await single.refund("j");
  assertEquals(await single.hit("j"), null, "the refunded unit is spendable again");
  assert((await single.hit("j")) !== null);
});

Deno.test("credentials: a concurrent burst can't overrun the budget — the right password after it is refused", async () => {
  const config = limitedConfig();
  const burst = Array.from(
    { length: 20 },
    () => login(config, { email: "a@b.co", password: "no" }),
  );
  const statuses = (await Promise.all(burst)).map((r) => r.status);
  assertEquals(statuses.filter((s) => s === 401).length, 2, "only the budget's worth is evaluated");
  assertEquals((await login(config, { email: "a@b.co", password: "pw" })).status, 429);
});
