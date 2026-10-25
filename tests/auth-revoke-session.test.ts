// revokeSession(sid) for stateless cookie sessions: the session's own `sid` goes on the auth
// adapter's revocation list, `currentSessionId()` names the current one on the server only, an
// adapter without the list is refused, and an app that never revokes one by id pays no
// per-request lookup (a cached marker, src/server/auth/sid-revocation.ts).

import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import type { AuthAdapter } from "../src/server/auth/adapter.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { sqliteAuthAdapter } from "../src/server/auth/sqlite-adapter.ts";
import { auth, currentSessionId, denextAuth, revokeSession } from "../src/server/auth/mod.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { inMemorySessionStore } from "../src/server/auth/session-store.ts";
import {
  MARKER_RECHECK_MS,
  REVOCATIONS_MARKER,
  revocationsInUse,
  revokeStatelessSid,
  sidRevocationOf,
} from "../src/server/auth/sid-revocation.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
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

Deno.test("a revocation list that can't be read fails closed", async () => {
  const base = inMemoryAuthAdapter();
  let fail = false;
  const adapter: AuthAdapter = Object.assign(Object.create(base), {
    isSidRevoked: (sid: string) => {
      if (fail) throw new Error("db down");
      return base.isSidRevoked!(sid);
    },
  });
  const { config } = app(adapter, { logger: { error() {}, warn() {}, debug() {} } });
  const cookie = await signIn(config, "alice@x.test");
  const other = await signIn(config, "alice@x.test");
  await revokeSession((await inRequest(other, () => currentSessionId()))!);
  fail = true;
  assertEquals(await sessionUser(config, cookie), null, "an unreadable list reads as signed out");
  fail = false;
  assert(await sessionUser(config, cookie), "and the session comes back once it can be read");
});
