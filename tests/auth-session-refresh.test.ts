// Sliding sessions (`session.updateAge`): the v1-tolerant read, the refresh on the paths
// that still own their response (`GET /auth/session`, `requireAuth`, `requireSession`,
// `updateAuthSession`), the silence of bare `auth()`, and the session lifecycle events
// (`signOut`, `sessionRevoked`).

import { assert, assertEquals } from "@std/assert";
import {
  createRequestContext,
  type RequestContext,
  runWithContext,
} from "../src/server/request-context.ts";
import { getSession } from "../src/server/session.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import {
  auth,
  denextAuth,
  requireAuth,
  revokeAllSessions,
  revokeSession,
  updateAuthSession,
} from "../src/server/auth/mod.ts";
import { requireSession } from "../src/server/api-middleware.ts";
import { readAuthSession, refreshIfStale } from "../src/server/auth/session.ts";
import { cookieSessionOptions, resolveAuthOptions } from "../src/server/auth/options.ts";
import { inMemorySessionStore, type SessionStore } from "../src/server/auth/session-store.ts";
import { credentials } from "../src/server/auth/providers.ts";
import type { ApiMiddlewareInput } from "../src/server/define-api.ts";
import type { AuthConfig, AuthSession } from "../src/server/auth/types.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const MAX_AGE = 3600;
const UPDATE_AGE = 60;
const SESSION_COOKIE = "__Host-denext_auth=";

const nowSec = (): number => Math.floor(Date.now() / 1000);

function config(extra: Partial<AuthConfig> = {}): AuthConfig {
  return {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    rateLimit: false,
    session: { maxAge: MAX_AGE, updateAge: UPDATE_AGE },
    providers: [credentials({ authorize: ({ email }) => ({ id: email, email }) })],
    ...extra,
  };
}

/** A session payload, `agedBy` seconds old (its expiry moves with it). */
function payload(agedBy = 0, over: Partial<AuthSession> = {}): AuthSession {
  const issuedAt = nowSec() - agedBy;
  return {
    user: { id: "u1", email: "u1@x.test" },
    provider: "credentials",
    expiresAt: issuedAt + MAX_AGE,
    v: 2,
    issuedAt,
    ...over,
  };
}

/** Run `body` in a fresh request context for `request`; hand back the queued Set-Cookies. */
async function inContext<T>(
  request: Request,
  body: (ctx: RequestContext) => Promise<T>,
): Promise<{ value: T; cookies: string[] }> {
  const ctx = createRequestContext(request);
  const value = await runWithContext(ctx, () => body(ctx));
  return { value, cookies: ctx.outgoingHeaders.getSetCookie() };
}

/** Sign an arbitrary cookie payload with this config's session cookie — v1 shapes included. */
async function mintCookie(cfg: AuthConfig, data: unknown): Promise<string> {
  const options = resolveAuthOptions(cfg);
  const { cookies } = await inContext(new Request(`${ORIGIN}/`), async () => {
    const cookie = await getSession<unknown>(
      cookieSessionOptions(cfg, options.cookies.session, options.maxAge),
    );
    await cookie.set(data);
  });
  return cookies.find((c) => c.startsWith(SESSION_COOKIE))!.split(";")[0];
}

/** The data inside a signed session cookie pair (`name=<payload>.<sig>`). */
function decodeCookie<T>(pair: string): T {
  const b64 = pair.slice(pair.indexOf("=") + 1).split(".")[0]
    .replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)),
  );
  return (JSON.parse(json) as { d: T }).d;
}

/** `GET {basePath}/session` with `cookie`, returning the JSON body and the queued cookies. */
async function fetchSessionRoute(
  cfg: AuthConfig,
  cookie?: string,
): Promise<{ body: Record<string, unknown>; cookies: string[] }> {
  const request = new Request(`${ORIGIN}/auth/session`, {
    headers: cookie ? { cookie } : {},
  });
  const { value, cookies } = await inContext(
    request,
    async () => (await handleAuthRequest(request, cfg))!,
  );
  return { body: await value.json() as Record<string, unknown>, cookies };
}

/** The session cookie a response queued, if any. */
function issued(cookies: string[]): string | undefined {
  return cookies.find((c) => c.startsWith(SESSION_COOKIE));
}

// ---- the v1-tolerant read ---------------------------------------------------

Deno.test("a v1 payload (no issuedAt/amr/v) still verifies and reads, with issuedAt inferred", async () => {
  const cfg = config();
  const expiresAt = nowSec() + MAX_AGE;
  const cookie = await mintCookie(cfg, {
    user: { id: "old", email: "old@x.test" },
    provider: "credentials",
    expiresAt,
  });

  const { value: session } = await inContext(
    new Request(`${ORIGIN}/`, { headers: { cookie } }),
    () => readAuthSession(cfg),
  );
  assert(session, "a pre-2.5 cookie keeps verifying");
  assertEquals(session.user.id, "old");
  assertEquals(session.issuedAt, expiresAt - MAX_AGE, "issuedAt is inferred from expiresAt");
  assertEquals(session.amr, [], "a missing amr reads as none");
});

Deno.test("a v1 payload past updateAge refreshes like any other", async () => {
  const cfg = config();
  const expiresAt = nowSec() + MAX_AGE - UPDATE_AGE * 2; // issued 2×updateAge ago
  const cookie = await mintCookie(cfg, {
    user: { id: "old", email: "old@x.test" },
    provider: "credentials",
    expiresAt,
  });

  const { body, cookies } = await fetchSessionRoute(cfg, cookie);
  assert(issued(cookies), "the aged v1 session is re-issued");
  assert((body.expires as number) > expiresAt, "and its expiry moves forward");
});

// ---- GET /auth/session ------------------------------------------------------

Deno.test("GET /auth/session: past updateAge it re-issues; before it, nothing is written", async () => {
  const cfg = config();

  const stale = payload(UPDATE_AGE * 2);
  const staleCookie = await mintCookie(cfg, stale);
  const refreshed = await fetchSessionRoute(cfg, staleCookie);
  const setCookie = issued(refreshed.cookies);
  assert(setCookie, "a stale session is re-issued");
  assertEquals((refreshed.body.user as { id: string }).id, "u1");
  assert(
    (refreshed.body.expires as number) > stale.expiresAt,
    "the reported expiry slides forward by the full maxAge",
  );
  const written = decodeCookie<AuthSession>(setCookie.split(";")[0]);
  assertEquals(written.expiresAt, refreshed.body.expires, "the cookie carries the new expiry");
  assert(
    written.issuedAt! > stale.issuedAt!,
    "issuedAt is reset, so the next slide is a full updateAge away",
  );

  const fresh = payload(UPDATE_AGE - 10);
  const freshResult = await fetchSessionRoute(cfg, await mintCookie(cfg, fresh));
  assertEquals(issued(freshResult.cookies), undefined, "before updateAge nothing is re-issued");
  assertEquals(freshResult.body.expires, fresh.expiresAt, "and the expiry is untouched");
});

Deno.test("GET /auth/session: updateAge unset (the default) never re-issues", async () => {
  const cfg = config({ session: { maxAge: MAX_AGE } });
  const old = payload(MAX_AGE - 60);
  const { body, cookies } = await fetchSessionRoute(cfg, await mintCookie(cfg, old));
  assertEquals(issued(cookies), undefined, "sliding is opt-in");
  assertEquals(body.expires, old.expiresAt);
});

Deno.test("GET /auth/session: an expired session is never refreshed", async () => {
  const cfg = config();
  const expired = payload(MAX_AGE + 600); // issued longer ago than maxAge
  const { body, cookies } = await fetchSessionRoute(cfg, await mintCookie(cfg, expired));
  assertEquals(body.user, null, "an expired payload reads as signed out");
  assertEquals(issued(cookies), undefined, "and is never resurrected by a refresh");
});

Deno.test("GET /auth/session: a signed-out request answers nulls with no cookie", async () => {
  const { body, cookies } = await fetchSessionRoute(config());
  assertEquals(body, { user: null, expires: null });
  assertEquals(cookies.length, 0);
});

Deno.test("GET /auth/session: an MFA-pending session answers { user: null, mfa: 'required' }", async () => {
  const cfg = config();
  const pending = payload(UPDATE_AGE * 2, { mfaPending: true });
  const { body, cookies } = await fetchSessionRoute(cfg, await mintCookie(cfg, pending));
  assertEquals(body, { user: null, expires: null, mfa: "required" });
  assertEquals(
    issued(cookies),
    undefined,
    "a half-authenticated session is never slid forward",
  );
});

// ---- store-backed sliding ---------------------------------------------------

/** A store-backed config plus a live record, whose cookie carries only the id. */
async function storeSetup(
  agedBy: number,
): Promise<{ cfg: AuthConfig; store: SessionStore; cookie: string; record: AuthSession }> {
  const store = inMemorySessionStore();
  const cfg = config({ sessionStore: store });
  const record = payload(agedBy);
  await store.create("sid-1", record);
  return { cfg, store, cookie: await mintCookie(cfg, { sid: "sid-1" }), record };
}

Deno.test("store-backed refresh rewrites the record in place and keeps the same sid", async () => {
  const { cfg, store, cookie, record } = await storeSetup(UPDATE_AGE * 2);

  const { body, cookies } = await fetchSessionRoute(cfg, cookie);
  const setCookie = issued(cookies);
  assert(setCookie, "the cookie is re-sent so the browser renews its Max-Age");
  assertEquals(
    decodeCookie<{ sid: string }>(setCookie.split(";")[0]).sid,
    "sid-1",
    "the session id is NEVER rotated on a refresh — fixation is handled at login",
  );
  const stored = await store.get("sid-1");
  assert(stored && stored.expiresAt > record.expiresAt, "the stored record slid forward");
  assertEquals(body.expires, stored.expiresAt);
  assertEquals(stored.sessionId, undefined, "the store payload carries no id (it is the key)");
});

Deno.test("store-backed: a revoked session neither reads nor refreshes", async () => {
  const { cfg, store, cookie } = await storeSetup(UPDATE_AGE * 2);
  await store.delete("sid-1");
  const { body, cookies } = await fetchSessionRoute(cfg, cookie);
  assertEquals(body.user, null);
  assertEquals(issued(cookies), undefined);
});

// ---- auth() vs updateAuthSession() ------------------------------------------

Deno.test("bare auth() reads a stale session but writes no Set-Cookie", async () => {
  const cfg = config();
  denextAuth(cfg);
  const cookie = await mintCookie(cfg, payload(UPDATE_AGE * 2));

  const { value, cookies } = await inContext(
    new Request(`${ORIGIN}/dashboard`, { headers: { cookie } }),
    () => auth(),
  );
  assertEquals(value?.user.id, "u1", "auth() still returns the session");
  assertEquals(
    cookies.length,
    0,
    "auth() never refreshes: a Set-Cookie after the headers flush would be dropped",
  );
});

Deno.test("updateAuthSession() returns the refreshed session and queues the cookie", async () => {
  const cfg = config();
  denextAuth(cfg);
  const stale = payload(UPDATE_AGE * 2);
  const cookie = await mintCookie(cfg, stale);

  const { value, cookies } = await inContext(
    new Request(`${ORIGIN}/api/me`, { headers: { cookie } }),
    () => updateAuthSession(),
  );
  assert(value, "the session survives the update");
  assert(value.expiresAt > stale.expiresAt, "the returned session carries the new expiry");
  assert(issued(cookies), "and the re-issued cookie rides this response");

  const signedOut = await inContext(new Request(`${ORIGIN}/api/me`), () => updateAuthSession());
  assertEquals(signedOut.value, null, "no session → null, and nothing written");
  assertEquals(signedOut.cookies.length, 0);
});

Deno.test("refreshIfStale: an explicit `now` decides staleness, and a fresh session is returned as-is", async () => {
  const cfg = config();
  const session = payload(0);
  const { value: same, cookies: none } = await inContext(
    new Request(`${ORIGIN}/`),
    () => refreshIfStale(cfg, session, Date.now()),
  );
  assertEquals(same, session, "not stale yet → the same object, no write");
  assertEquals(none.length, 0);

  const { value: slid, cookies } = await inContext(
    new Request(`${ORIGIN}/`),
    () => refreshIfStale(cfg, session, Date.now() + UPDATE_AGE * 1000),
  );
  assert(slid.expiresAt > session.expiresAt, "past updateAge at that clock → refreshed");
  assert(issued(cookies));
});

// ---- the guards -------------------------------------------------------------

Deno.test("requireAuth(): the allowed 'continue' case still carries the refreshed cookie", async () => {
  const cfg = config();
  denextAuth(cfg);
  const cookie = await mintCookie(cfg, payload(UPDATE_AGE * 2));

  const request = new Request(`${ORIGIN}/dashboard`, { headers: { cookie } });
  const { value, cookies } = await inContext(request, () => requireAuth(request));
  assertEquals(value, null, "the request continues");
  assert(
    issued(cookies),
    "the cookie is queued on the request context, so the pipeline attaches it to " +
      "whatever response this request produces",
  );
});

Deno.test("requireAuth(): a refusal writes nothing", async () => {
  const cfg = config({ pages: { signIn: "/login" } });
  denextAuth(cfg);
  const request = new Request(`${ORIGIN}/dashboard`);
  const { value, cookies } = await inContext(request, () => requireAuth(request));
  assertEquals(value?.status, 302);
  assertEquals(cookies.length, 0);
});

Deno.test("requireSession(): the API guard refreshes too", async () => {
  const cfg = config();
  denextAuth(cfg);
  const stale = payload(UPDATE_AGE * 2);
  const cookie = await mintCookie(cfg, stale);

  const request = new Request(`${ORIGIN}/api/me`, { headers: { cookie } });
  const { value, cookies } = await inContext(request, async () => {
    const input = { request } as unknown as ApiMiddlewareInput<object>;
    return await requireSession()(input) as { session: AuthSession };
  });
  assert(value.session.expiresAt > stale.expiresAt, "ctx.session is the fresh one");
  assert(issued(cookies), "and the refreshed cookie rides the API response");
});

// ---- events -----------------------------------------------------------------

Deno.test("signOut fires with the session that ended", async () => {
  const ended: Array<AuthSession | null> = [];
  const cfg = config({ events: { signOut: ({ session }) => void ended.push(session) } });
  const cookie = await mintCookie(cfg, payload());

  const request = new Request(`${ORIGIN}/auth/signout`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN, accept: "application/json", "x-denext-auth": "1" },
  });
  const { value } = await inContext(request, async () => (await handleAuthRequest(request, cfg))!);
  assertEquals(value.status, 200);
  assertEquals(ended.length, 1);
  assertEquals(ended[0]?.user.id, "u1");

  const anonymous = new Request(`${ORIGIN}/auth/signout`, {
    method: "POST",
    headers: { origin: ORIGIN, accept: "application/json", "x-denext-auth": "1" },
  });
  await inContext(anonymous, () => handleAuthRequest(anonymous, cfg));
  assertEquals(ended[1], null, "signing out with no session reports null, not a miss");
});

Deno.test("sessionRevoked fires for one session and for a whole user", async () => {
  const seen: Array<{ sessionId?: string; userId?: string }> = [];
  const store = inMemorySessionStore();
  const cfg = config({
    sessionStore: store,
    events: { sessionRevoked: (p) => void seen.push(p) },
  });
  denextAuth(cfg);
  await store.create("sid-1", payload());

  await revokeSession("sid-1");
  assertEquals(await store.get("sid-1"), undefined);
  assertEquals(seen[0], { sessionId: "sid-1" });

  await revokeAllSessions("u1");
  assertEquals(seen[1], { userId: "u1" });
});
