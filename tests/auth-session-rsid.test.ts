// A stateless session's id in the cookie and on the session object (src/server/auth/session.ts):
//   - the sealed payload carries it as `rsid`, never `sid` — a 4.8 instance reads any cookie with
//     a `sid` key as a store id and signs the user out, so a 4.9 cookie must not use it (a rolling
//     4.8 → 4.9 deploy and a rollback keep every session);
//   - a cookie from an early 4.9 build (`sid` of 22 characters beside the `user`) still reads as
//     stateless, and a store cookie (`{ sid }`, no `user`) is still a store id;
//   - on the session `auth()` returns, `sid` is non-enumerable: a session passed to a client
//     component, spread or JSON.stringify'd doesn't carry it, while `session.sid` reads;
//   - a slide and an in-place rewrite keep the id in the cookie, even from a spread copy.

import { assert, assertEquals, assertFalse, assertMatch } from "@std/assert";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { auth, currentSessionId, denextAuth } from "../src/server/auth/mod.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { readAuthSession, refreshIfStale, replaceAuthSession } from "../src/server/auth/session.ts";
import { cookieSessionOptions, resolveAuthOptions } from "../src/server/auth/options.ts";
import type { AuthConfig, AuthSession } from "../src/server/auth/types.ts";
import { getSession } from "../src/server/session.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";

const ORIGIN = "https://app.test";
const COOKIE = "__Host-denext_auth";
const UPDATE_AGE = 60;

function app(extra: Partial<AuthConfig> = {}): AuthConfig {
  const config: AuthConfig = {
    secret: "test-secret-value-at-least-32-chars-long",
    canonicalOrigin: ORIGIN,
    adapter: inMemoryAuthAdapter(),
    providers: [
      credentials({
        authorize: ({ email, password }) =>
          password === "pw" ? { id: String(email), email, emailVerified: true } : null,
      }),
    ],
    rateLimit: false,
    session: { updateAge: UPDATE_AGE },
    ...extra,
  };
  denextAuth(config);
  return config;
}

/** Call an auth endpoint; the response and the session cookie pair it set (if any). */
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
  const cookie = ctx.outgoingHeaders.getSetCookie()
    .find((c) => c.startsWith(`${COOKIE}=`) && !c.startsWith(`${COOKIE}=;`))?.split(";")[0];
  return { res, cookie };
}

async function signIn(config: AuthConfig, email = "alice@x.test"): Promise<string> {
  const { cookie } = await call(config, "/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "pw" }),
  });
  assert(cookie, "signed in");
  return cookie;
}

/** Run `fn` in a request carrying `cookie`; its result and the cookies the request queued. */
async function inRequest<T>(cookie: string, fn: () => Promise<T>) {
  const ctx = createRequestContext(new Request(`${ORIGIN}/`, { headers: { cookie } }));
  const value = await runWithContext(ctx, fn);
  const set = ctx.outgoingHeaders.getSetCookie()
    .find((c) => c.startsWith(`${COOKIE}=`) && !c.startsWith(`${COOKIE}=;`))?.split(";")[0];
  return { value, set };
}

/** The data inside a signed session cookie pair (`name=<payload>.<sig>`). */
function decodeCookie(pair: string): Record<string, unknown> {
  const b64 = pair.slice(pair.indexOf("=") + 1).split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const json = new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
  return (JSON.parse(json) as { d: Record<string, unknown> }).d;
}

/** A session cookie sealing `data` as a client of this config would carry it. */
async function mintCookie(config: AuthConfig, data: Record<string, unknown>): Promise<string> {
  const options = resolveAuthOptions(config);
  const ctx = createRequestContext(new Request(`${ORIGIN}/`));
  await runWithContext(ctx, async () => {
    const cookie = await getSession<Record<string, unknown>>(
      cookieSessionOptions(config, options.cookies.session, options.maxAge),
    );
    await cookie.set(data);
  });
  return ctx.outgoingHeaders.getSetCookie().find((c) => c.startsWith(COOKIE))!.split(";")[0];
}

/**
 * v4.8.0's cookie reader, as `src/server/auth/session.ts` had it: any cookie with a `sid` key is a
 * store id, so without a store it reads as signed out; anything else is the stateless payload.
 */
function read48(data: Record<string, unknown>): AuthSession | null {
  return "sid" in data ? null : data as unknown as AuthSession;
}

Deno.test("a 4.9 stateless cookie keeps its id under `rsid`, which a 4.8 instance reads as stateless", async () => {
  const config = app();
  const cookie = await signIn(config);
  const data = decodeCookie(cookie);
  assertMatch(String(data.rsid), /^[A-Za-z0-9_-]{22}$/, "the id rides as rsid");
  assertFalse("sid" in data, "never as sid — 4.8's store-id key");
  assertFalse("sessionId" in data);
  // A 4.8 instance in the same fleet (a rolling deploy, a rollback) keeps the user signed in.
  const legacy = read48(data);
  assert(legacy, "4.8 reads it as a stateless payload");
  assertEquals(legacy.user.email, "alice@x.test");
  // And 4.9 reads its own cookie with the id under `sid`.
  const { value: session } = await inRequest(cookie, () => auth());
  assertEquals(session?.sid, data.rsid);
  assertEquals(await (await inRequest(cookie, () => currentSessionId())).value, data.rsid);
});

Deno.test("a cookie from an early 4.9 build (`sid` beside the user) still reads as stateless, with its id", async () => {
  const config = app({ adapter: undefined }); // no stored user to re-read: the payload decides
  const now = Math.floor(Date.now() / 1000);
  const early = {
    user: { id: "alice@x.test", email: "alice@x.test" },
    provider: "credentials",
    expiresAt: now + 3600,
    v: 2,
    issuedAt: now,
    authTime: now,
    authTimeMs: now * 1000,
    amr: ["pwd"],
    sid: "early49sessionidxxxxxx", // 22 characters
  };
  const cookie = await mintCookie(config, early);
  const { value: session } = await inRequest(cookie, () => readAuthSession(config));
  assertEquals(session?.user.id, "alice@x.test");
  assertEquals(session?.sid, early.sid);
  assertEquals(session?.sessionId, undefined);
  // A store id alone (no `user`) is still a store cookie: without a store it is signed out.
  const storeCookie = await mintCookie(config, { sid: "a".repeat(43) });
  assertEquals((await inRequest(storeCookie, () => readAuthSession(config))).value, null);
});

Deno.test("auth()'s session carries `sid` non-enumerably: readable, never serialized or spread", async () => {
  const config = app();
  const cookie = await signIn(config);
  const { value: session } = await inRequest(cookie, () => auth());
  assert(session?.sid, "readable on the server");
  assertFalse(Object.keys(session).includes("sid"), "not an own enumerable key");
  assertFalse(JSON.stringify(session).includes(session.sid), "a client component never gets it");
  assertFalse("sid" in { ...session }, "a spread copy drops it");
  assertEquals(Object.getOwnPropertyDescriptor(session, "sid")?.enumerable, false);
});

Deno.test("a slide keeps the id in the cookie (as rsid), even from a spread copy of the session", async () => {
  const config = app();
  const cookie = await signIn(config);
  const { value: session } = await inRequest(cookie, () => auth());
  const sid = session!.sid!;
  const later = Date.now() + (UPDATE_AGE + 5) * 1000;
  // The session as read (its sid hidden, still carried).
  const slid = await inRequest(cookie, () => refreshIfStale(config, session!, later));
  assert(slid.set, "a stale session is re-issued");
  const written = decodeCookie(slid.set);
  assertEquals(written.rsid, sid, "the new cookie carries the same id");
  assertFalse("sid" in written);
  assertEquals(slid.value.sid, sid);
  assertEquals(Object.getOwnPropertyDescriptor(slid.value, "sid")?.enumerable, false);
  assert(slid.value.expiresAt > session!.expiresAt);
  // A spread copy (what an app's wrapper, or next-auth's re-seal, hands back) has lost `sid`:
  // the rewrite takes the id from the cookie it rewrites.
  const copy = { ...session! };
  assertEquals(copy.sid, undefined);
  const slidCopy = await inRequest(cookie, () => refreshIfStale(config, copy, later));
  assertEquals(decodeCookie(slidCopy.set!).rsid, sid);
  const replaced = await inRequest(
    cookie,
    () => replaceAuthSession(config, { ...copy, user: { ...copy.user, name: "Alice" } }),
  );
  assert(replaced.value);
  const rewritten = decodeCookie(replaced.set!);
  assertEquals(rewritten.rsid, sid, "an in-place rewrite keeps the id too");
  assertEquals((rewritten.user as { name: string }).name, "Alice");
  // The rewritten cookie still names the same session.
  assertEquals((await inRequest(replaced.set!, () => currentSessionId())).value, sid);
});
