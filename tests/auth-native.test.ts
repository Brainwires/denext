// Native session mode (`denextAuth({ native })`): the authorize → complete → code exchange,
// the PKCE / redirect-URI / expiry / replay checks on the code, the bearer access token that
// `auth()` and `requireSession()` accept, refresh rotation with reuse detection (a replay
// revokes the family; a forged token does not), sign-out revocation, the native origin gate +
// CORS, the config-time checks, and the same token flow over the SQLite adapter.

import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { h as el } from "../src/jsx/jsx-runtime.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import { isPostpone, type Postpone, withPrerender } from "../src/runtime/prerender.ts";
import { createApp } from "../src/server/app.ts";
import {
  inMemoryCacheStore,
  PageCache,
  setCacheStore,
  withCacheScope,
} from "../src/server/cache.ts";
import type { AuthAdapter } from "../src/server/auth/adapter.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { auth, denextAuth, requireAuth, revokeAllSessions } from "../src/server/auth/mod.ts";
import {
  matchRedirectUri,
  refreshNativeSession,
  resolveNative,
  startNativeSession,
} from "../src/server/auth/native.ts";
import { hashPassword } from "../src/server/auth/password.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { inMemorySessionStore } from "../src/server/auth/session-store.ts";
import { NATIVE_SESSION_RETENTION, sqliteAuthAdapter } from "../src/server/auth/sqlite-adapter.ts";
import type { AuthConfig, AuthSession } from "../src/server/auth/types.ts";
import { requireSession } from "../src/server/api-middleware.ts";
import type { CorsConfig } from "../src/server/config.ts";
import { resolveCors } from "../src/server/cors.ts";
import {
  createRequestContext,
  type RequestContext,
  runWithContext,
} from "../src/server/request-context.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const REDIRECT = "com.example.app://auth/callback";
const EMAIL = "ada@x.test";
const PASSWORD = "correct horse battery staple";

// ---- harness -----------------------------------------------------------------------

interface Harness {
  config: AuthConfig;
  adapter: AuthAdapter;
  userId: string;
  events: string[];
}

async function setup(
  overrides: Partial<AuthConfig> = {},
  adapter: AuthAdapter = inMemoryAuthAdapter(),
): Promise<Harness> {
  const user = await adapter.createUser({
    email: EMAIL,
    name: "Ada",
    emailVerified: Math.floor(Date.now() / 1000),
  });
  await adapter.setCredential!(user.id, await hashPassword(PASSWORD));
  const events: string[] = [];
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    trustForwardedHeaders: false,
    providers: [{ id: "credentials", type: "credentials" }],
    adapter,
    sessionStore: inMemorySessionStore(),
    pages: { signIn: "/login" },
    rateLimit: false,
    native: { redirectUris: [REDIRECT, "http://127.0.0.1/cb"] },
    events: {
      sessionRevoked: (p) => void events.push(`revoked:${p.sessionId ?? p.userId}`),
      signOut: () => void events.push("signOut"),
    },
    ...overrides,
  };
  return { config, adapter, userId: user.id, events };
}

/** A tiny cookie jar: `name=value` pairs from Set-Cookie. */
class Jar {
  #cookies = new Map<string, string>();
  take(setCookies: string[]): void {
    for (const c of setCookies) {
      const [pair, ...attrs] = c.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const expired = attrs.some((a) =>
        /max-age=0\b/i.test(a.trim()) || /expires=thu, 01 jan 1970/i.test(a)
      );
      if (expired || pair.slice(eq + 1) === "") this.#cookies.delete(name);
      else this.#cookies.set(name, pair.slice(eq + 1));
    }
  }
  header(): string {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

interface SendOptions {
  jar?: Jar;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  cors?: CorsConfig;
  /** Send no Origin header (a native HTTP client). */
  noOrigin?: boolean;
}

/** Send one request to the auth handler inside a request context; collect Set-Cookie. */
async function send(
  config: AuthConfig,
  method: string,
  path: string,
  opts: SendOptions = {},
): Promise<Response> {
  const headers = new Headers({ accept: "application/json" });
  if (!opts.noOrigin) headers.set("origin", ORIGIN);
  if (opts.body) headers.set("content-type", "application/json");
  if (opts.jar?.header()) headers.set("cookie", opts.jar.header());
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);
  const request = new Request(`${ORIGIN}/auth${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const ctx = createRequestContext(request);
  ctx.cors = resolveCors(opts.cors);
  const res = await runWithContext(ctx, () => handleAuthRequest(request, config));
  opts.jar?.take(ctx.outgoingHeaders.getSetCookie());
  assert(res, `${method} ${path} fell through`);
  return res;
}

/** A PKCE pair. */
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const b64 = (b: Uint8Array) =>
    btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64(new Uint8Array(digest)) };
}

function authorizePath(challenge: string, state = "st4te", redirect = REDIRECT): string {
  const q = new URLSearchParams({
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `/native/authorize?${q}`;
}

/**
 * The browser half: authorize → password sign-in → complete. Returns the callback URL the app
 * would receive and the verifier it holds.
 */
async function browserFlow(
  h: Harness,
  jar = new Jar(),
): Promise<{ callback: URL; verifier: string }> {
  const { verifier, challenge } = await pkce();
  const start = await send(h.config, "GET", authorizePath(challenge), { jar });
  assertEquals(start.status, 303);
  assertEquals(start.headers.get("location"), "/login?callbackUrl=%2Fauth%2Fnative%2Fcomplete");
  const signIn = await send(h.config, "POST", "/callback/credentials", {
    jar,
    body: { email: EMAIL, password: PASSWORD },
  });
  assertEquals(signIn.status, 200);
  const done = await send(h.config, "GET", "/native/complete", { jar });
  assertEquals(done.status, 303);
  return { callback: new URL(done.headers.get("location")!), verifier };
}

/** Exchange a code for tokens. */
function exchange(h: Harness, code: string, verifier: string, redirect = REDIRECT) {
  return send(h.config, "POST", "/native/token", {
    noOrigin: true,
    body: {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
    },
  });
}

/** Full sign-in → the token pair. */
async function signedIn(h: Harness): Promise<Record<string, string>> {
  const { callback, verifier } = await browserFlow(h);
  const res = await exchange(h, callback.searchParams.get("code")!, verifier);
  assertEquals(res.status, 200);
  return await res.json();
}

/** Run `fn` inside a request context carrying `Authorization: Bearer <token>`. */
function asBearer<T>(token: string, fn: () => Promise<T>): Promise<T> {
  const request = new Request(`${ORIGIN}/api/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return runWithContext(createRequestContext(request), fn);
}

function refresh(h: Harness, token: string) {
  return send(h.config, "POST", "/native/token", {
    noOrigin: true,
    body: { grant_type: "refresh_token", refresh_token: token },
  });
}

// ---- config ------------------------------------------------------------------------

Deno.test("native config: needs the adapter's native group and safe redirect URIs", async () => {
  const h = await setup();
  const noGroup: AuthAdapter = { ...inMemoryAuthAdapter(), createNativeGrant: undefined };
  assertThrows(() => denextAuth({ ...h.config, adapter: noGroup }), Error, "native session group");
  for (
    const bad of [
      "https://evil.test/cb#x",
      "javascript:alert(1)",
      "http://example.com/cb",
      "data:text/html,x",
    ]
  ) {
    assertThrows(
      () => denextAuth({ ...h.config, native: { redirectUris: [bad] } }),
      Error,
      "redirectUris",
      bad,
    );
  }
  assertThrows(
    () =>
      denextAuth({ ...h.config, native: { redirectUris: [REDIRECT], apple: { clientIds: [] } } }),
    Error,
    "clientIds",
  );
});

Deno.test("matchRedirectUri: exact, except a loopback http entry matches any port", async () => {
  const native = resolveNative((await setup()).config)!;
  assertEquals(matchRedirectUri(native, REDIRECT), REDIRECT);
  assertEquals(matchRedirectUri(native, `${REDIRECT}/`), null);
  assertEquals(matchRedirectUri(native, "com.example.app://auth/callback?x=1"), null);
  assertEquals(matchRedirectUri(native, "COM.example.app://auth/callback"), null);
  assertEquals(matchRedirectUri(native, "http://127.0.0.1:53124/cb"), "http://127.0.0.1:53124/cb");
  assertEquals(matchRedirectUri(native, "http://127.0.0.1:53124/cb/evil"), null);
  assertEquals(matchRedirectUri(native, "http://localhost:53124/cb"), null);
  assertEquals(matchRedirectUri(native, null), null);
});

// ---- authorize → complete ------------------------------------------------------------

Deno.test("authorize: an unregistered redirect_uri is a 400, never a redirect", async () => {
  const h = await setup();
  const { challenge } = await pkce();
  const res = await send(h.config, "GET", authorizePath(challenge, "s", "evil.app://cb"));
  assertEquals(res.status, 400);
  assertEquals(res.headers.get("location"), null);
});

Deno.test("authorize: a bad challenge or method is reported to the app's redirect URI", async () => {
  const h = await setup();
  const res = await send(h.config, "GET", authorizePath("short", "s1"));
  assertEquals(res.status, 303);
  const back = new URL(res.headers.get("location")!);
  assertEquals(back.searchParams.get("error"), "invalid_request");
  assertEquals(back.searchParams.get("state"), "s1");
  const plain = await send(
    h.config,
    "GET",
    authorizePath("a".repeat(43)).replace("S256", "plain"),
  );
  assertEquals(
    new URL(plain.headers.get("location")!).searchParams.get("error"),
    "invalid_request",
  );
});

Deno.test("complete: a code only for a sign-in made AFTER authorize began", async () => {
  const h = await setup();
  // No session at all → login_required.
  const jar = new Jar();
  const { challenge } = await pkce();
  await send(h.config, "GET", authorizePath(challenge), { jar });
  const none = await send(h.config, "GET", "/native/complete", { jar });
  assertEquals(new URL(none.headers.get("location")!).searchParams.get("error"), "login_required");

  // A session from BEFORE the flow started (a lingering browser session) → login_required.
  const stale = new Jar();
  await send(h.config, "POST", "/callback/credentials", {
    jar: stale,
    body: { email: EMAIL, password: PASSWORD },
  });
  const realNow = Date.now;
  Date.now = () => realNow() + 5_000;
  try {
    await send(h.config, "GET", authorizePath(challenge), { jar: stale });
    const res = await send(h.config, "GET", "/native/complete", { jar: stale });
    const back = new URL(res.headers.get("location")!);
    assertEquals(back.searchParams.get("error"), "login_required");
    assertEquals(back.searchParams.get("code"), null);
  } finally {
    Date.now = realNow;
  }

  // The transaction cookie is single-use: a second /complete has nothing to finish.
  const again = await send(h.config, "GET", "/native/complete", { jar });
  assertEquals(again.status, 400);
});

// ---- the code exchange -----------------------------------------------------------------

Deno.test("code exchange: tokens once; a replayed code is invalid_grant", async () => {
  const h = await setup();
  const { callback, verifier } = await browserFlow(h);
  assertEquals(callback.protocol, "com.example.app:");
  assertEquals(callback.searchParams.get("state"), "st4te");
  const code = callback.searchParams.get("code")!;
  assertMatch(code, /^nac_/);
  const first = await exchange(h, code, verifier);
  assertEquals(first.status, 200);
  assertEquals(first.headers.get("cache-control"), "no-store");
  const tokens = await first.json();
  assertMatch(tokens.access_token, /^nat_/);
  assertMatch(tokens.refresh_token, /^nrt_/);
  assertEquals(tokens.token_type, "Bearer");
  assertEquals(tokens.expires_in, 900);
  assertEquals(tokens.user.email, EMAIL);
  const replay = await exchange(h, code, verifier);
  assertEquals(replay.status, 400);
  assertEquals(await replay.json(), { error: "invalid_grant" });
});

Deno.test("code exchange: a wrong verifier fails AND spends the code", async () => {
  const h = await setup();
  const { callback, verifier } = await browserFlow(h);
  const code = callback.searchParams.get("code")!;
  const wrong = await exchange(h, code, (await pkce()).verifier);
  assertEquals(wrong.status, 400);
  const right = await exchange(h, code, verifier);
  assertEquals(right.status, 400, "the code had exactly one try");
});

Deno.test("code exchange: a different redirect_uri or a malformed verifier is invalid_grant", async () => {
  const h = await setup();
  const a = await browserFlow(h);
  assertEquals(
    (await exchange(h, a.callback.searchParams.get("code")!, a.verifier, "http://127.0.0.1:9/cb"))
      .status,
    400,
  );
  const b = await browserFlow(h);
  assertEquals((await exchange(h, b.callback.searchParams.get("code")!, "short")).status, 400);
  assertEquals((await exchange(h, "nac_forged", b.verifier)).status, 400);
});

Deno.test("code exchange: an expired code is invalid_grant", async () => {
  const offset = { s: 0 };
  const adapter = inMemoryAuthAdapter({ now: () => Math.floor(Date.now() / 1000) + offset.s });
  const h = await setup({}, adapter);
  const { callback, verifier } = await browserFlow(h);
  offset.s = 61; // the default code lifetime is 60 seconds
  assertEquals((await exchange(h, callback.searchParams.get("code")!, verifier)).status, 400);
});

Deno.test("token endpoint: an unknown grant_type is unsupported_grant_type", async () => {
  const h = await setup();
  const res = await send(h.config, "POST", "/native/token", {
    noOrigin: true,
    body: { grant_type: "password", username: EMAIL, password: PASSWORD },
  });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "unsupported_grant_type");
});

// ---- the bearer session ------------------------------------------------------------------

Deno.test("auth() and requireSession() accept the native access token; nothing slides", async () => {
  const h = await setup({ session: { updateAge: 1 } });
  denextAuth(h.config);
  const tokens = await signedIn(h);
  const session = await asBearer(tokens.access_token, () => auth()) as AuthSession;
  assertEquals(session.user.id, h.userId);
  assert(session.nativeSessionId);
  assertEquals(session.provider, "credentials");
  const guarded = await asBearer(tokens.access_token, async () => {
    const ctx = await requireSession()({ request: new Request(ORIGIN) } as never);
    return (ctx as { session: AuthSession }).session;
  });
  assertEquals(guarded.user.id, h.userId);
  // A tampered token, and a cookie-less request with a bad bearer, are signed out.
  const tampered = tokens.access_token.slice(0, -2) +
    (tokens.access_token.endsWith("A") ? "BB" : "AA");
  assertEquals(await asBearer(tampered, () => auth()), null);
  assertEquals(await asBearer(`nat_${"x".repeat(40)}.sig`, () => auth()), null);
  assertEquals(await asBearer(tokens.access_token, () => requireAuth(new Request(ORIGIN))), null);
});

Deno.test("an expired access token is refused", async () => {
  const h = await setup({ native: { redirectUris: [REDIRECT], accessTokenTtl: 60 } });
  denextAuth(h.config);
  const tokens = await signedIn(h);
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    assertEquals(await asBearer(tokens.access_token, () => auth()), null);
  } finally {
    Date.now = realNow;
  }
});

// ---- refresh rotation + reuse detection ----------------------------------------------------

Deno.test("refresh rotates; replaying the old refresh token revokes the whole family", async () => {
  const h = await setup();
  denextAuth(h.config);
  const first = await signedIn(h);
  const rotated = await refresh(h, first.refresh_token);
  assertEquals(rotated.status, 200);
  const second = await rotated.json();
  assertNotEquals(second.refresh_token, first.refresh_token);
  assertNotEquals(second.access_token, first.access_token);
  assert(await asBearer(second.access_token, () => auth()));

  const replay = await refresh(h, first.refresh_token);
  assertEquals(replay.status, 400);
  assertEquals(await replay.json(), { error: "invalid_grant" });
  // The family is gone: the current refresh token AND every access token stop working.
  assertEquals((await refresh(h, second.refresh_token)).status, 400);
  assertEquals(await asBearer(second.access_token, () => auth()), null);
  assertEquals(await asBearer(first.access_token, () => auth()), null);
  assert(h.events.some((e) => e.startsWith("revoked:")));
});

Deno.test("a forged refresh token (bad MAC) is refused WITHOUT revoking the family", async () => {
  const h = await setup();
  denextAuth(h.config);
  const tokens = await signedIn(h);
  const [family, generation] = tokens.refresh_token.slice(4).split(".");
  const forgedOld = `nrt_${family}.${Number(generation)}.${"A".repeat(43)}`;
  assertEquals((await refresh(h, forgedOld)).status, 400);
  const forgedNext = `nrt_${family}.${Number(generation) + 1}.${"A".repeat(43)}`;
  assertEquals((await refresh(h, forgedNext)).status, 400);
  assertEquals((await refresh(h, "nrt_garbage")).status, 400);
  // The real one still works.
  assertEquals((await refresh(h, tokens.refresh_token)).status, 200);
});

Deno.test("two concurrent refreshes with one token: exactly one wins, then the family is revoked", async () => {
  const h = await setup();
  const tokens = await signedIn(h);
  const native = resolveNative(h.config)!;
  const outcomes = await Promise.all([
    refreshNativeSession(h.config, native, tokens.refresh_token),
    refreshNativeSession(h.config, native, tokens.refresh_token),
  ]);
  assertEquals(outcomes.filter((o) => o.ok).length, 1);
  const loser = outcomes.find((o) => !o.ok)!;
  assertEquals(loser.ok ? "" : loser.reason, "reuse");
});

Deno.test("refresh fails once the user is gone, and after the family's lifetime", async () => {
  const h = await setup({ native: { redirectUris: [REDIRECT], refreshTokenTtl: 3600 } });
  const tokens = await signedIn(h);
  const realNow = Date.now;
  Date.now = () => realNow() + 3601_000;
  try {
    assertEquals((await refresh(h, tokens.refresh_token)).status, 400);
  } finally {
    Date.now = realNow;
  }
  const again = await signedIn(h);
  await h.adapter.deleteUser!(h.userId);
  assertEquals((await refresh(h, again.refresh_token)).status, 400);
});

// ---- sign-out -----------------------------------------------------------------------------

Deno.test("revoke by refresh token signs out the family (and always answers 200)", async () => {
  const h = await setup();
  denextAuth(h.config);
  const tokens = await signedIn(h);
  const res = await send(h.config, "POST", "/native/revoke", {
    noOrigin: true,
    body: { refresh_token: tokens.refresh_token },
  });
  assertEquals(res.status, 200);
  assertEquals(await asBearer(tokens.access_token, () => auth()), null);
  assertEquals((await refresh(h, tokens.refresh_token)).status, 400);
  const junk = await send(h.config, "POST", "/native/revoke", {
    noOrigin: true,
    body: { refresh_token: "nrt_x.0.y" },
  });
  assertEquals(junk.status, 200);
});

Deno.test("revoke by bearer access token, and revokeAllSessions, end native families", async () => {
  const h = await setup();
  denextAuth(h.config);
  const a = await signedIn(h);
  await send(h.config, "POST", "/native/revoke", {
    noOrigin: true,
    headers: { authorization: `Bearer ${a.access_token}` },
  });
  assertEquals((await refresh(h, a.refresh_token)).status, 400);
  assert(h.events.includes("signOut"));

  const b = await signedIn(h);
  await revokeAllSessions(h.userId);
  assertEquals(await asBearer(b.access_token, () => auth()), null);
  assertEquals((await refresh(h, b.refresh_token)).status, 400);
});

// ---- the origin gate + CORS -----------------------------------------------------------------

Deno.test("native POSTs: no Origin or an allowed one passes; foreign and null are 403", async () => {
  const h = await setup();
  const cors = { origins: ["capacitor://localhost"] };
  const nonce = (headers: Record<string, string>, noOrigin = false) =>
    send(h.config, "POST", "/native/nonce", { headers, noOrigin, cors, body: {} });
  assertEquals((await nonce({}, true)).status, 200);
  assertEquals((await nonce({ origin: ORIGIN })).status, 200);
  const allowed = await nonce({ origin: "capacitor://localhost" });
  assertEquals(allowed.status, 200);
  assertEquals(allowed.headers.get("access-control-allow-origin"), "capacitor://localhost");
  for (
    const origin of [
      "https://evil.test",
      "null",
      "capacitor://localhost.evil",
      "Capacitor://localhost",
    ]
  ) {
    const res = await nonce({ origin });
    assertEquals(res.status, 403, origin);
    assertEquals(res.headers.get("access-control-allow-origin"), null);
  }
});

Deno.test("a native preflight is answered under the app cors policy", async () => {
  const h = await setup();
  const res = await send(h.config, "OPTIONS", "/native/token", {
    headers: {
      origin: "capacitor://localhost",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
    cors: { origins: ["capacitor://localhost"] },
  });
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), "capacitor://localhost");
});

Deno.test("without `native` the endpoints do not exist", async () => {
  const h = await setup({ native: undefined });
  const request = new Request(`${ORIGIN}/auth/native/token`, { method: "POST", body: "{}" });
  const res = await runWithContext(
    createRequestContext(request),
    () => handleAuthRequest(request, h.config),
  );
  assertEquals(res, null);
});

// ---- the SQLite adapter runs the same flow ----------------------------------------------------

Deno.test("sqliteAuthAdapter: code exchange, rotation, reuse detection, revoke", async () => {
  const adapter = sqliteAuthAdapter({ path: ":memory:" });
  try {
    const h = await setup({}, adapter);
    denextAuth(h.config);
    const tokens = await signedIn(h);
    assert(await asBearer(tokens.access_token, () => auth()));
    const next = await (await refresh(h, tokens.refresh_token)).json();
    assertEquals((await refresh(h, tokens.refresh_token)).status, 400, "replay");
    assertEquals((await refresh(h, next.refresh_token)).status, 400, "family revoked");
    // A fresh family straight from the core helper, then revoked by user.
    const native = resolveNative(h.config)!;
    const pair = await startNativeSession(h.config, native, {
      user: { id: h.userId },
      provider: "credentials",
      amr: ["pwd"],
      authTime: Math.floor(Date.now() / 1000),
    });
    await adapter.revokeNativeSessionsByUser!(h.userId);
    assertEquals(await asBearer(pair.access_token, () => auth()), null);
  } finally {
    await adapter.close?.();
  }
});

Deno.test("sqliteAuthAdapter: families dead past the retention are deleted at the next sign-in", async () => {
  let now = 1_000_000;
  const adapter = sqliteAuthAdapter({ path: ":memory:", now: () => now });
  const family = (id: string, expiresAt: number) => ({
    id,
    userId: "u1",
    generation: 0,
    salt: "s",
    session: "{}",
    createdAt: now,
    expiresAt,
  });
  try {
    await adapter.createNativeSession!(family("expired", now + 10));
    await adapter.createNativeSession!(family("revoked", now + 10 * NATIVE_SESSION_RETENTION));
    await adapter.createNativeSession!(family("live", now + 10 * NATIVE_SESSION_RETENTION));
    await adapter.revokeNativeSession!("revoked");
    // Dead, but still inside the retention: kept (a replay still finds the revoked family).
    now += NATIVE_SESSION_RETENTION - 1;
    await adapter.createNativeSession!(family("trigger1", now + 60));
    assert(await adapter.getNativeSession!("expired"), "expired, inside the retention");
    assert(await adapter.getNativeSession!("revoked"), "revoked, inside the retention");
    // Past the retention: the next sign-in reclaims both; the live family is untouched.
    now += 12;
    await adapter.createNativeSession!(family("trigger2", now + 60));
    assertEquals(await adapter.getNativeSession!("expired"), undefined);
    assertEquals(await adapter.getNativeSession!("revoked"), undefined);
    assert(await adapter.getNativeSession!("live"), "a live family is kept");
    assert(await adapter.getNativeSession!("trigger2"), "the new family is kept");
  } finally {
    await adapter.close?.();
  }
});

// ---- the bearer path goes through the same cache guards as the cookie path ------------

/** An ISR page (`revalidate = 60`) whose body names the signed-in user. */
function isrApp(): (request: Request) => Promise<Response> {
  const modules: Record<string, unknown> = {
    "layout.tsx": { default: (p: { children: unknown }) => el("main", null, p.children as never) },
    "page.tsx": {
      default: async () => el("p", { id: "who" }, `hi ${(await auth())?.user.name ?? "anon"}`),
      revalidate: 60,
    },
  };
  const manifest: RouteManifest = {
    pages: [{
      kind: "page",
      pattern: parsePattern(""),
      routePath: "/",
      filePath: "page.tsx",
      layoutChain: ["layout.tsx"],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
      templateChain: [],
    }],
    api: [],
    rootLayout: "layout.tsx",
    rootNotFound: null,
    rootGlobalError: null,
  };
  return createApp({
    getManifest: () => manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    pageCache: new PageCache(),
  });
}

Deno.test("an ISR page read with a native bearer is private and never served to the next visitor", async () => {
  setCacheStore(inMemoryCacheStore());
  const h = await setup();
  denextAuth(h.config);
  const tokens = await signedIn(h);
  const handler = isrApp();
  const mine = await handler(
    new Request(`${ORIGIN}/`, { headers: { authorization: `Bearer ${tokens.access_token}` } }),
  );
  assertStringIncludes(await mine.text(), "hi Ada");
  assertStringIncludes(mine.headers.get("cache-control") ?? "", "private");
  assertStringIncludes(mine.headers.get("cache-control") ?? "", "no-store");
  const anonymous = await handler(new Request(`${ORIGIN}/`));
  const body = await anonymous.text();
  assertStringIncludes(body, "hi anon");
  assert(!body.includes("Ada"), "the bearer user's page leaked to an anonymous visitor");
  assertNotEquals(anonymous.headers.get("x-denext-cache"), "HIT");
});

Deno.test("auth() with a native bearer postpones during a PPR prerender", async () => {
  const h = await setup();
  denextAuth(h.config);
  const tokens = await signedIn(h);
  const thrown = await asBearer(tokens.access_token, () =>
    withPrerender(async () => {
      try {
        await auth();
      } catch (e) {
        return e;
      }
      return undefined;
    }));
  assert(isPostpone(thrown), "a bearer read must postpone like a cookie read");
  assertEquals((thrown as Postpone).api, "headers");
});

Deno.test('auth() with a native bearer throws inside a "use cache" scope', async () => {
  const h = await setup();
  denextAuth(h.config);
  const tokens = await signedIn(h);
  await asBearer(tokens.access_token, async () => {
    const err = await assertRejects(() => withCacheScope(() => auth()));
    assertStringIncludes(String(err), '"use cache"');
  });
});

Deno.test("auth() with a native bearer reads signed out under force-static and stays cacheable", async () => {
  const h = await setup();
  denextAuth(h.config);
  const tokens = await signedIn(h);
  const ctx = createRequestContext(
    new Request(`${ORIGIN}/`, { headers: { authorization: `Bearer ${tokens.access_token}` } }),
  );
  ctx.segmentConfig = { dynamic: "force-static" } as RequestContext["segmentConfig"];
  assertEquals(await runWithContext(ctx, () => auth()), null);
  assert(!ctx.usedDynamicApi, "force-static must not mark the render dynamic");
  // Outside force-static the same read marks the render dynamic.
  const live = createRequestContext(
    new Request(`${ORIGIN}/`, { headers: { authorization: `Bearer ${tokens.access_token}` } }),
  );
  assertEquals((await runWithContext(live, () => auth()))?.user.id, h.userId);
  assert(live.usedDynamicApi, "a bearer read must mark the render dynamic");
});
