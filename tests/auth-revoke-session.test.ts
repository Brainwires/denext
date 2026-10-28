// revokeSession(sid) for stateless cookie sessions: the session's own `sid` goes on the auth
// adapter's revocation list, `currentSessionId()` names the current one on the server only, an
// adapter without the list is refused, and an app that never revokes one by id pays no
// per-request lookup (a cached marker, packages/auth/src/sid-revocation.ts).

import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import type { AuthAdapter } from "../packages/auth/src/adapter.ts";
import { inMemoryAuthAdapter } from "../packages/auth/src/memory-adapter.ts";
import { sqliteAuthAdapter } from "../packages/auth/src/sqlite-adapter.ts";
import { auth, currentSessionId, denextAuth, revokeSession } from "../packages/auth/src/mod.ts";
import { credentials } from "../packages/auth/src/providers.ts";
import { handleAuthRequest } from "../packages/auth/src/routes.ts";
import { inMemorySessionStore } from "../packages/auth/src/session-store.ts";
import {
  MARKER_RECHECK_MS,
  MAX_REMEMBERED_ANSWERS,
  resetSidRevocationForTesting,
  REVOCATION_FLOOR_SECONDS,
  REVOCATION_HEALTH_CHECK,
  REVOCATIONS_MARKER,
  revocationsInUse,
  revokeStatelessSid,
  sidRevocationOf,
  sidRevoked,
  STALE_ANSWER_MS,
  WARN_INTERVAL_MS,
} from "../packages/auth/src/sid-revocation.ts";
import type { AuthConfig } from "../packages/auth/src/types.ts";
import { runHealthChecks } from "../src/server/health.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { makeTempDirUntilExit } from "./helpers/temp.ts";

const ORIGIN = "https://app.test";

/** An adapter that counts `isSidRevoked` lookups. */
function counting(base: AuthAdapter): AuthAdapter & { lookups: string[] } {
  const lookups: string[] = [];
  return Object.assign(Object.create(base), {
    lookups,
    isSidRevoked(sid: string) {
      lookups.push(sid);
      return base.isSidRevoked!(sid);
    },
  });
}

/** A stateless credentials app over `adapter` (signing in creates the user there). */
function app(adapter?: AuthAdapter, extra: Partial<AuthConfig> = {}) {
  const revoked: unknown[] = [];
  const config: AuthConfig = {
    secret: "test-secret-value-at-least-32-chars-long",
    canonicalOrigin: ORIGIN,
    providers: [
      credentials({
        authorize: ({ email, password }) =>
          password === "pw" ? { id: String(email), email, emailVerified: true } : null,
      }),
    ],
    rateLimit: false,
    events: { sessionRevoked: (p) => void revoked.push(p) },
    ...(adapter ? { adapter } : {}),
    ...extra,
  };
  denextAuth(config); // activates the config for revokeSession / auth()
  return { config, revoked };
}

/** Call an auth endpoint; returns the response and the session cookie pair it set (if any). */
async function call(
  config: AuthConfig,
  path: string,
  init: RequestInit & { cookie?: string } = {},
) {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("origin", ORIGIN);
  if (init.cookie) headers.set("cookie", init.cookie);
  const request = new Request(`${ORIGIN}${path}`, { ...init, headers });
  const ctx = createRequestContext(request);
  const res = (await runWithContext(ctx, () => handleAuthRequest(request, config)))!;
  const setCookies = ctx.outgoingHeaders.getSetCookie();
  const cookie = setCookies
    .find((c) => c.startsWith("__Host-denext_auth=") && !c.startsWith("__Host-denext_auth=;"))
    ?.split(";")[0];
  return { res, cookie, setCookies };
}

async function signIn(config: AuthConfig, email: string): Promise<string> {
  const { cookie } = await call(config, "/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "pw" }),
  });
  assert(cookie, "signed in");
  return cookie;
}

/** Run `fn` in a request carrying `cookie`. */
function inRequest<T>(cookie: string, fn: () => Promise<T>): Promise<T> {
  const req = new Request(`${ORIGIN}/`, { headers: { cookie } });
  return runWithContext(createRequestContext(req), fn);
}

async function sessionUser(config: AuthConfig, cookie: string): Promise<unknown> {
  return (await (await call(config, "/auth/session", { cookie })).res.json()).user;
}

Deno.test("revokeSession(sid) ends exactly one stateless session through the adapter", async () => {
  const { config, revoked } = app(sqliteAuthAdapter({ path: ":memory:" }));
  const a1 = await signIn(config, "alice@x.test");
  const a2 = await signIn(config, "alice@x.test");
  const b1 = await signIn(config, "bob@x.test");

  const sid = await inRequest(a1, () => currentSessionId());
  assert(sid && /^[A-Za-z0-9_-]{22}$/.test(sid), "the current stateless session's own id");
  assertEquals(await inRequest(a1, async () => (await auth())?.sid), sid);
  assert(sid !== await inRequest(a2, () => currentSessionId()), "each session has its own id");
  // The browser never sees it: the session endpoint carries the user and the expiry only.
  const { res } = await call(config, "/auth/session", { cookie: a1 });
  const body = await res.text();
  assertFalse(body.includes(sid), body);

  await revokeSession(sid);
  assertEquals(revoked, [{ sessionId: sid }]);
  assertEquals(await sessionUser(config, a1), null, "the revoked session reads as signed out");
  assertEquals(await inRequest(a1, () => auth()), null);
  const cleared = await call(config, "/auth/session", { cookie: a1 });
  assert(cleared.setCookies.some((c) => c.startsWith("__Host-denext_auth=;")), "cookie cleared");
  assert(await sessionUser(config, a2), "alice's other session still works");
  assert(await sessionUser(config, b1), "bob is unaffected");
  assertEquals(await inRequest("x=y", () => currentSessionId()), null, "signed out: no id");
});

Deno.test("revokeSession: store-backed sessions are deleted from the store", async () => {
  const store = inMemorySessionStore();
  const { config } = app(undefined, { sessionStore: store });
  const cookie = await signIn(config, "alice@x.test");
  const id = await inRequest(cookie, () => currentSessionId());
  assert(id && await store.get(id), "currentSessionId is the store id");
  await revokeSession(id);
  assertEquals(await store.get(id), undefined);
  assertEquals(await sessionUser(config, cookie), null);
});

Deno.test("revokeSession refuses without a revocation list, and an empty id", async () => {
  const base = inMemoryAuthAdapter();
  const { revokeSids: _r, isSidRevoked: _i, ...rest } = base;
  for (const adapter of [undefined, rest as AuthAdapter]) {
    app(adapter);
    const err = await assertRejects(() => revokeSession("abc"), Error);
    assert(err.message.includes("keeps no revocation list"), err.message);
    assert(err.message.includes("revokeAllSessions(userId)"), err.message);
  }
  app(inMemoryAuthAdapter());
  await assertRejects(() => revokeSession(""), TypeError, "non-empty");
});

Deno.test("an app that never revokes by id makes no per-request lookup", async () => {
  const adapter = counting(inMemoryAuthAdapter());
  const { config } = app(adapter);
  const cookie = await signIn(config, "alice@x.test");
  for (let i = 0; i < 5; i++) assert(await sessionUser(config, cookie));
  // One marker lookup for the process, then nothing until the recheck interval passes.
  assertEquals(adapter.lookups, [REVOCATIONS_MARKER]);
  const sid = (await inRequest(cookie, () => currentSessionId()))!;
  await revokeSession(sid);
  adapter.lookups.length = 0;
  assertEquals(await sessionUser(config, cookie), null);
  assertEquals(adapter.lookups, [sid], "from the first revocation on, each read checks its sid");
});

Deno.test("another instance turns the check on within the recheck interval", async () => {
  const path = `${makeTempDirUntilExit("denext-revoke-")}/auth.db`;
  const a = sidRevocationOf(sqliteAuthAdapter({ path }))!;
  const b = sidRevocationOf(sqliteAuthAdapter({ path }))!;
  const t0 = Date.now();
  assertFalse(await revocationsInUse(b, t0), "nothing revoked yet");
  await revokeStatelessSid(a, "s1", Math.floor(t0 / 1000) + 60);
  assert(await revocationsInUse(a, t0), "the revoking instance sees it at once");
  assertFalse(await revocationsInUse(b, t0 + MARKER_RECHECK_MS - 1), "cached until the recheck");
  assert(await revocationsInUse(b, t0 + MARKER_RECHECK_MS), "then read from the adapter");
  assert(await revocationsInUse(b, t0), "and kept for good");
  assert(await b.isSidRevoked("s1"));
  assertEquals(sidRevocationOf(undefined), null);
});

/** An adapter whose `isSidRevoked` throws while `fail` is set, counting the lookups it makes. */
function flaky(): { adapter: AuthAdapter; fail: (on: boolean) => void; lookups: () => number } {
  const base = inMemoryAuthAdapter();
  let failing = false;
  let lookups = 0;
  const adapter: AuthAdapter = Object.assign(Object.create(base), {
    isSidRevoked: (sid: string) => {
      lookups++;
      if (failing) throw new Error("db down");
      return base.isSidRevoked!(sid);
    },
  });
  return { adapter, fail: (on) => void (failing = on), lookups: () => lookups };
}

/** Run `fn` with `Date.now` moved `ms` forward. */
async function later<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => real() + ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

/** A logger collecting its warnings. */
function warnings(): { logger: AuthConfig["logger"]; warned: string[] } {
  const warned: string[] = [];
  return { warned, logger: { error() {}, warn: (m) => void warned.push(m), debug() {} } };
}

Deno.test("a revocation list that can't be read: a recent answer stands in, else signed out", async () => {
  const { adapter, fail } = flaky();
  const { logger, warned } = warnings();
  const { config } = app(adapter, { logger });
  const live = await signIn(config, "alice@x.test");
  const revokedCookie = await signIn(config, "alice@x.test");
  const unseen = await signIn(config, "alice@x.test");
  const revokedSid = (await inRequest(revokedCookie, () => currentSessionId()))!;
  await revokeSession(revokedSid);
  assert(await sessionUser(config, live), "read once while the list answers (remembered: live)");
  assertEquals(await sessionUser(config, revokedCookie), null, "remembered: revoked");
  try {
    fail(true);
    // Within STALE_ANSWER_MS: each session answers as it last did.
    await later(STALE_ANSWER_MS - 1000, async () => {
      assert(await sessionUser(config, live), "a live session stays live through the outage");
      assertEquals(await sessionUser(config, revokedCookie), null, "a revoked one stays revoked");
      assertEquals(await sessionUser(config, unseen), null, "no answer yet: signed out");
    });
    assertEquals(warned.length, 1, "one warning for the outage, not one per request");
    assert(warned[0].includes("revocation list could not be read"), warned[0]);
    assertEquals((await runHealthChecks()).checks[REVOCATION_HEALTH_CHECK], "down");
    // Past it, a stale answer is no better than none.
    await later(STALE_ANSWER_MS + 1000, async () => {
      assertEquals(await sessionUser(config, live), null, "a stale answer reads as signed out");
      assertEquals(await sessionUser(config, revokedCookie), null);
    });
    assertEquals(warned.length, 1, "still rate-limited within the interval");
    await later(STALE_ANSWER_MS + WARN_INTERVAL_MS + 1000, () => sessionUser(config, live));
    assertEquals(warned.length, 2, "and one more once the interval has passed");
    // The cookie was kept: once the list answers again, every session is back as it should be.
    fail(false);
    assert(await sessionUser(config, live), "the live session comes back");
    assertEquals(await sessionUser(config, revokedCookie), null, "the revoked one stays revoked");
    assert(await sessionUser(config, unseen), "and the one never answered for is signed in");
    assertEquals((await runHealthChecks()).checks[REVOCATION_HEALTH_CHECK], "ok");
  } finally {
    resetSidRevocationForTesting(sidRevocationOf(adapter)!);
  }
});

Deno.test("the health probe itself finds the list back before any request does", async () => {
  const { adapter, fail } = flaky();
  const { config } = app(adapter, { logger: { error() {}, warn() {}, debug() {} } });
  const cookie = await signIn(config, "alice@x.test");
  await revokeSession((await inRequest(cookie, () => currentSessionId()))!);
  try {
    fail(true);
    assertEquals(await sessionUser(config, cookie), null);
    assertEquals((await runHealthChecks()).checks[REVOCATION_HEALTH_CHECK], "down");
    fail(false);
    assertEquals((await runHealthChecks()).checks[REVOCATION_HEALTH_CHECK], "ok", "probed");
  } finally {
    resetSidRevocationForTesting(sidRevocationOf(adapter)!);
  }
});

Deno.test("a failed marker lookup keeps a recent 'no revocation yet'; without one it fails closed", async () => {
  const { adapter, fail, lookups } = flaky();
  const { config } = app(adapter, { logger: { error() {}, warn() {}, debug() {} } });
  const cookie = await signIn(config, "alice@x.test");
  try {
    assert(await sessionUser(config, cookie));
    assertEquals(lookups(), 1, "the marker, once");
    fail(true);
    // The recheck interval has passed, the lookup throws: the answer of a minute ago stands.
    await later(MARKER_RECHECK_MS + 1000, async () => {
      assert(await sessionUser(config, cookie), "the app has not revoked anything: still live");
    });
    assertEquals(lookups(), 2);
    // Past STALE_ANSWER_MS nothing recent is known: signed out until the adapter answers.
    await later(STALE_ANSWER_MS + 1000, async () => {
      assertEquals(await sessionUser(config, cookie), null);
    });
    fail(false);
    assert(await sessionUser(config, cookie), "back once the adapter answers");
  } finally {
    resetSidRevocationForTesting(sidRevocationOf(adapter)!);
  }
});

Deno.test("sidRevoked: remembered answers are bounded, oldest first", async () => {
  const base = inMemoryAuthAdapter();
  let fail = false;
  const adapter = sidRevocationOf(Object.assign(Object.create(base), {
    isSidRevoked: (sid: string) => {
      if (fail) throw new Error("db down");
      return base.isSidRevoked!(sid);
    },
  }) as AuthAdapter)!;
  try {
    const t0 = Date.now();
    for (let i = 0; i <= MAX_REMEMBERED_ANSWERS; i++) {
      assertFalse(await sidRevoked(adapter, `s${i}`, undefined, t0));
    }
    fail = true;
    await assertRejects(() => sidRevoked(adapter, "s0", undefined, t0), Error, "db down");
    assertFalse(await sidRevoked(adapter, "s1", undefined, t0), "the 10,000 newest are kept");
    await assertRejects(() => sidRevoked(adapter, "s1", undefined, t0 + STALE_ANSWER_MS + 1));
  } finally {
    resetSidRevocationForTesting(adapter);
  }
});

Deno.test("a revocation lives the larger of session.maxLifetime and 400 days", async () => {
  const expiries: number[] = [];
  const base = inMemoryAuthAdapter();
  const adapter: AuthAdapter = Object.assign(Object.create(base), {
    revokeSids: (sids: readonly string[], expiresAt: number) => {
      if (!sids.includes(REVOCATIONS_MARKER)) expiries.push(expiresAt);
      return base.revokeSids!(sids, expiresAt);
    },
  });
  const day = 86_400;
  // The default lifetime (30 days): the row outlives it, so a lifetime raised later (while the
  // cookie keeps sliding) can't bring the session back once the row would have been pruned.
  const { config } = app(adapter);
  const sid = (await inRequest(await signIn(config, "a@x.test"), () => currentSessionId()))!;
  const before = Math.floor(Date.now() / 1000);
  await revokeSession(sid);
  assert(expiries[0] >= before + REVOCATION_FLOOR_SECONDS, `floor: ${expiries[0]}`);
  assert(expiries[0] <= before + REVOCATION_FLOOR_SECONDS + 5);
  assertEquals(REVOCATION_FLOOR_SECONDS, 400 * day);
  // A lifetime past the floor: the row lives the lifetime.
  const long = app(adapter, { session: { maxAge: 30 * day, maxLifetime: 500 * day } });
  const sid2 = (await inRequest(await signIn(long.config, "b@x.test"), () => currentSessionId()))!;
  const at = Math.floor(Date.now() / 1000);
  await revokeSession(sid2);
  assert(expiries[1] >= at + 500 * day && expiries[1] <= at + 500 * day + 5, `${expiries[1]}`);
});
