// MFA bypass rows: a session that passed the first factor but still owes the second
// (`mfaPending`) grants NOTHING, on every path that reads a session. Each row signs in a
// user with a confirmed TOTP factor through the plugin's REAL request handler
// (`handlers[0]` of `denextAuth`), takes the pending cookie that answer sets, and presents
// it to one path: `auth()`, `requireAuth`, `requireSession`, `GET /auth/session`, the Live
// `authorize` hook (and `callbacks.authorized`), `requireBearer`, `POST /auth/tokens` and
// `POST /auth/mfa/disable`. Then the pending cookie's own end of life: dead once its
// step-up completed, and after its 15-minute lifetime.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { decodeBase32 } from "@std/encoding/base32";
import type { PluginContext, PluginRequestHandler } from "../src/plugin/mod.ts";
import { isApiError } from "../src/server/api-error.ts";
import type { ApiMiddleware, ApiMiddlewareInput } from "../src/server/define-api.ts";
import { issueAuthSession } from "../src/server/auth/session.ts";
import { handleLiveUpgrade, installLiveHub, uninstallLiveHub } from "../src/server/live.ts";
import {
  auth,
  type AuthAdapter,
  type AuthConfig,
  type BearerContext,
  credentials,
  denextAuth,
  generateTotpSecret,
  hashPassword,
  inMemoryAuthAdapter,
  inMemorySessionStore,
  issueApiToken,
  listApiTokens,
  mfaStatus,
  pendingMfaSession,
  requireAuth,
  requireBearer,
  requireSession,
  verifyTotp,
} from "../src/server/mod.ts";
import { setRemoteAddr } from "../src/server/remote-addr.ts";
import {
  createRequestContext,
  runDeferred,
  runWithContext,
} from "../src/server/request-context.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const EMAIL = "ada@x.test";
const PASSWORD = "correct horse battery";
const SESSION_COOKIE = "__Host-denext_auth=";
const PAGES = { signIn: "/login", afterSignIn: "/home", mfa: "/login/2fa" };
/** An `Accept: application/json` client. */
const JSON_CLIENT = { accept: "application/json" };
/** A pending session's lifetime (the sign-in tail's 15 minutes), in ms. */
const PENDING_MS = 15 * 60 * 1000;

// ---- harness ---------------------------------------------------------------------

/** One mounted app whose one user has a confirmed TOTP factor. */
interface App {
  /** The plugin's one request handler. */
  handle: PluginRequestHandler;
  config: AuthConfig;
  adapter: AuthAdapter;
  userId: string;
  /** The user's TOTP secret (the factor is confirmed). */
  totpSecret: string;
}

/** The one request handler `denextAuth(config)` registers, captured as `applyPlugins` wires it. */
async function pluginHandler(config: AuthConfig): Promise<PluginRequestHandler> {
  let handler: PluginRequestHandler | undefined;
  const plugin = denextAuth(config);
  await plugin.setup({
    addRequestHandler(registered: PluginRequestHandler) {
      handler = registered;
    },
    addTeardown() {},
  } as unknown as PluginContext);
  assert(handler, "denextAuth registered its request handler");
  return handler;
}

/** A store-backed app for one password user with a confirmed TOTP factor. */
async function mount(extra: Partial<AuthConfig> = {}): Promise<App> {
  const adapter = inMemoryAuthAdapter();
  const user = await adapter.createUser({ email: EMAIL, name: "Ada", emailVerified: 1 });
  await adapter.setCredential!(user.id, await hashPassword(PASSWORD));
  const totpSecret = generateTotpSecret();
  await adapter.setMfa!({
    userId: user.id,
    confirmedAt: 1,
    secret: totpSecret,
    backupCodeHashes: [],
  });
  const config: AuthConfig = {
    providers: [credentials()],
    adapter,
    sessionStore: inMemorySessionStore(),
    pages: PAGES,
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    trustForwardedHeaders: false,
    ...extra,
  };
  return { handle: await pluginHandler(config), config, adapter, userId: user.id, totpSecret };
}

/** How a test request is built (a same-origin `GET /dashboard` by default). */
interface Init {
  method?: string;
  path?: string;
  /** The `name=value` session cookie to present. */
  cookie?: string;
  /** A JSON body. */
  body?: Record<string, string>;
  /** Extra headers (`accept`, `authorization`). */
  headers?: Record<string, string>;
}

/** What ran: its value, and the session cookie the request set (if any). */
interface Ran<T> {
  value: T;
  setCookie?: string;
}

/** Build `init`'s request, run `fn` with it inside its own request context, flush `after()`. */
async function inRequest<T>(init: Init, fn: (request: Request) => Promise<T>): Promise<Ran<T>> {
  const request = new Request(`${ORIGIN}${init.path ?? "/dashboard"}`, {
    method: init.method ?? "GET",
    headers: {
      origin: ORIGIN,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...init.headers,
    },
    body: init.body && JSON.stringify(init.body),
  });
  setRemoteAddr(request, { transport: "tcp", hostname: "198.51.100.4", port: 443 });
  const ctx = createRequestContext(request);
  const value = await runWithContext(ctx, () => fn(request));
  await runDeferred(ctx);
  const set = ctx.outgoingHeaders.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE));
  return { value, setCookie: set?.split(";")[0] };
}

/** Send `init` through the plugin's request handler (`null`: it fell through). */
function send(app: App, init: Init): Promise<Ran<Response | null>> {
  return inRequest(init, async (request) => (await app.handle(request)) ?? null);
}

/** A JSON-client POST of `body` to `path`. */
function post(app: App, path: string, cookie: string, body: Record<string, string> = {}) {
  return send(app, { method: "POST", path, cookie, body, headers: JSON_CLIENT });
}

/** The status and JSON body of an answer the handler claimed. */
async function answer(ran: Ran<Response | null>): Promise<[number, Record<string, unknown>]> {
  assert(ran.value, "the auth handler claimed the request");
  return [ran.value.status, await ran.value.json()];
}

/** Sign the enrolled user in with the password; asserts the pending answer, returns its cookie. */
async function pendingCookie(app: App): Promise<string> {
  const signIn = await send(app, {
    method: "POST",
    path: "/auth/callback/credentials",
    body: { email: EMAIL, password: PASSWORD },
    headers: JSON_CLIENT,
  });
  assertEquals(await answer(signIn), [200, { ok: true, mfa: "required" }]);
  assert(signIn.setCookie, "the first factor set a (pending) session cookie");
  return signIn.setCookie;
}

/** A COMPLETE session's cookie for the same user — the control each refusal is measured by. */
async function completeCookie(app: App): Promise<string> {
  const user = { id: app.userId, email: EMAIL };
  const issued = await inRequest(
    {},
    () => issueAuthSession(app.config, user, "credentials", { amr: ["pwd", "totp"] }),
  );
  assert(issued.setCookie, "a complete session cookie was issued");
  return issued.setCookie;
}

/** The RFC 6238 code (HMAC-SHA-1, 6 digits, 30 s steps) for `secret` now, computed here. */
async function totpNow(secret: string): Promise<string> {
  const counter = new ArrayBuffer(8);
  new DataView(counter).setUint32(4, Math.floor(Date.now() / 30_000));
  const raw = new Uint8Array(decodeBase32(secret));
  const hmac = { name: "HMAC", hash: "SHA-1" };
  const key = await crypto.subtle.importKey("raw", raw, hmac, false, ["sign"]);
  const mac = new DataView(await crypto.subtle.sign("HMAC", key, counter));
  const truncated = mac.getUint32(mac.getUint8(19) & 0xf) & 0x7fffffff;
  return String(truncated % 1_000_000).padStart(6, "0");
}

/** Run `fn` with the clock `ms` ahead (still ticking), restoring the real one after. */
async function later<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

/** Run an API middleware the way `createApi().use()` does, for `init`'s request. */
function runMiddleware<Add extends object>(
  middleware: ApiMiddleware<object, Add>,
  init: Init,
): Promise<Ran<unknown>> {
  return inRequest(init, async (request) => {
    const input: ApiMiddlewareInput<object> = { request, params: {}, ctx: {}, method: "GET" };
    return await middleware(input);
  });
}

/** The `[status, code, message]` of the `ApiError` `run` throws, or `"passed"`. */
async function thrown(run: () => Promise<unknown>): Promise<[number, string, string] | "passed"> {
  try {
    await run();
  } catch (error) {
    if (!isApiError(error)) throw error;
    return [error.status, error.code, error.message];
  }
  return "passed";
}

/** Count calls to one adapter method from now on (the original still runs). */
function countCalls(adapter: AuthAdapter, method: "setMfa" | "createApiToken"): { calls: number } {
  const counter = { calls: 0 };
  const methods = adapter as unknown as Record<string, (...args: unknown[]) => unknown>;
  const original = methods[method];
  methods[method] = (...args) => {
    counter.calls++;
    return original.apply(adapter, args);
  };
  return counter;
}

/** A same-origin WebSocket handshake to the Live endpoint, presenting `cookie`. */
function liveHandshake(cookie: string): Promise<Response> {
  const headers = { upgrade: "websocket", origin: ORIGIN, cookie };
  return handleLiveUpgrade(new Request(`${ORIGIN}/_denext/live`, { headers }));
}

// ---- the eight paths ------------------------------------------------------------------

Deno.test("bypass 1 — auth() reads a pending session as signed out (only pendingMfaSession() sees it)", async () => {
  const app = await mount();
  const cookie = await pendingCookie(app);
  const read = () => Promise.all([auth(), pendingMfaSession()]);
  const [session, pending] = (await inRequest({ cookie }, read)).value;
  assertEquals(session, null);
  assertEquals(pending?.user.id, app.userId, "the cookie IS a live pending session");
});

Deno.test("bypass 2 — requireAuth redirects a pending session to pages.mfa, never lets it through", async () => {
  const app = await mount();
  const cookie = await pendingCookie(app);
  const guarded = await inRequest({ cookie, path: "/dashboard?tab=keys" }, requireAuth);
  assert(guarded.value, "a pending session is never passed through (null)");
  assertEquals(guarded.value.status, 302);
  assertEquals(
    guarded.value.headers.get("location"),
    "/login/2fa?callbackUrl=%2Fdashboard%3Ftab%3Dkeys",
  );
  const control = await inRequest({ cookie: await completeCookie(app) }, requireAuth);
  assertEquals(control.value, null, "a complete session passes the same guard");
});

Deno.test("bypass 3 — requireSession refuses a pending session exactly like a signed-out caller", async () => {
  const app = await mount();
  const cookie = await pendingCookie(app);
  const signedOut = await thrown(() => runMiddleware(requireSession(), {}));
  assertEquals(signedOut, [401, "unauthorized", "Unauthorized"]);
  assertEquals(await thrown(() => runMiddleware(requireSession(), { cookie })), signedOut);
  const withRole = requireSession({ role: "admin" });
  assertEquals(
    await thrown(() => runMiddleware(withRole, { cookie })),
    signedOut,
    "a 401, not a 403: a pending session isn't even a 'who'",
  );
  const complete = await completeCookie(app);
  assertEquals(await thrown(() => runMiddleware(requireSession(), { cookie: complete })), "passed");
});

Deno.test("bypass 4 — GET /auth/session: { user: null, expires: null, mfa: 'required' } and no sliding Set-Cookie", async () => {
  const app = await mount({ session: { updateAge: 1 } });
  const pending = await pendingCookie(app);
  const complete = await completeCookie(app);
  // Five seconds on, both sessions are past `updateAge` — a complete one slides.
  await later(5_000, async () => {
    const read = await send(app, { path: "/auth/session", cookie: pending });
    assertEquals(await answer(read), [200, { user: null, expires: null, mfa: "required" }]);
    assertEquals(read.setCookie, undefined, "a pending session is never re-issued");
    const control = await send(app, { path: "/auth/session", cookie: complete });
    assertEquals((await answer(control))[0], 200);
    assert(control.setCookie, "the same age DOES slide a complete session");
  });
});

Deno.test("bypass 5 — Live authorize refuses a pending session and callbacks.authorized is never consulted", async () => {
  let consulted = 0;
  const authorized = () => {
    consulted++;
    return true;
  };
  const app = await mount({ callbacks: { authorized } });
  const pending = await pendingCookie(app);
  installLiveHub({
    appHandler: () => Promise.resolve(new Response(null, { status: 404 })),
    originAllowed: () => true,
    config: {
      // The hook runs under the viewer's own cookies: the app's guard decides.
      authorize: async ({ origin }) => (await requireAuth(new Request(`${origin}/live`))) === null,
    },
  });
  try {
    assertEquals((await liveHandshake(pending)).status, 403);
    assertEquals(consulted, 0, "callbacks.authorized never sees a pending session");
    const complete = await liveHandshake(await completeCookie(app));
    assertNotEquals(complete.status, 403, "a complete session passes the same hook");
    assertEquals(consulted, 1);
  } finally {
    uninstallLiveHub();
  }
});

Deno.test("bypass 6 — requireBearer: a token works beside a pending cookie, which never upgrades it; the cookie alone is refused", async () => {
  const app = await mount();
  const cookie = await pendingCookie(app);
  const { token } = await issueApiToken(app.config, { userId: app.userId, scopes: ["read"] });
  const authorization = `Bearer ${token}`;
  const bearer = requireBearer(app.config);
  for (const init of [{ headers: { authorization } }, { cookie, headers: { authorization } }]) {
    const ran = await runMiddleware(bearer, init);
    const { session } = ran.value as BearerContext;
    assertEquals(
      [session.provider, session.amr, session.mfaPending, session.sessionId, session.user.id],
      ["api-token", ["bearer"], undefined, undefined, app.userId],
      "the token's own session, never the cookie's",
    );
    assertEquals(ran.setCookie, undefined, "bearer authentication writes no cookie");
  }
  const scoped = requireBearer(app.config, { scope: "write" });
  assertEquals(
    await thrown(() => runMiddleware(scoped, { cookie, headers: { authorization } })),
    [403, "forbidden", "Forbidden"],
    "the cookie adds no scope",
  );
  assertEquals(
    await thrown(() => runMiddleware(bearer, { cookie })),
    [401, "unauthorized", "Missing or invalid bearer token"],
  );
});

Deno.test("bypass 7 — POST /auth/tokens with a pending cookie is a 401 and writes no token row", async () => {
  const app = await mount();
  const cookie = await pendingCookie(app);
  const writes = countCalls(app.adapter, "createApiToken");
  const minted = await post(app, "/auth/tokens", cookie, { name: "ci" });
  assertEquals(await answer(minted), [401, { error: "unauthorized" }]);
  const listed = await send(app, { path: "/auth/tokens", cookie, headers: JSON_CLIENT });
  assertEquals(await answer(listed), [401, { error: "unauthorized" }]);
  assertEquals(writes.calls, 0);
  assertEquals(await listApiTokens(app.config, app.userId), []);
});

Deno.test("bypass 8 — POST /auth/mfa/disable from a pending cookie, even with a VALID TOTP code, is a 403 and never calls setMfa", async () => {
  const app = await mount();
  const cookie = await pendingCookie(app);
  const code = await totpNow(app.totpSecret);
  assert((await verifyTotp(app.totpSecret, code)).ok, "the presented code is valid right now");
  const setMfa = countCalls(app.adapter, "setMfa");
  const disable = await post(app, "/auth/mfa/disable", cookie, { code });
  assertEquals(await answer(disable), [403, { error: "forbidden" }]);
  assertEquals(setMfa.calls, 0);
  assertEquals((await mfaStatus(app.config, app.userId)).confirmed, true);
  const step = await post(app, "/auth/mfa", cookie, { code });
  assertEquals((await answer(step))[0], 200, "the refusal never checked (or spent) the code");
});

// ---- the pending cookie's end of life -----------------------------------------------

Deno.test("a pending cookie replayed after its step-up completed is dead: its store record was deleted", async () => {
  const app = await mount();
  const pending = await pendingCookie(app);
  const step = await post(app, "/auth/mfa", pending, { code: await totpNow(app.totpSecret) });
  assertEquals((await answer(step))[0], 200);
  assert(step.setCookie, "the step-up minted a session");
  assertNotEquals(step.setCookie, pending, "a FRESH one, not the pending one upgraded");

  const replay = await send(app, { path: "/auth/session", cookie: pending });
  assertEquals(await answer(replay), [200, { user: null, expires: null }]);
  const again = await post(app, "/auth/mfa", pending, { code: "123456" });
  assertEquals(await answer(again), [401, { error: "unauthorized" }]);
  const fresh = await send(app, { path: "/auth/session", cookie: step.setCookie });
  assertEquals(((await answer(fresh))[1].user as { id: string }).id, app.userId);
});

Deno.test("a pending session expires after its 15-minute lifetime", async () => {
  const app = await mount();
  const pending = await pendingCookie(app);
  const sessionAt = (ms: number) =>
    later(
      ms,
      async () => await answer(await send(app, { path: "/auth/session", cookie: pending })),
    );
  assertEquals(await sessionAt(PENDING_MS - 5_000), [200, {
    user: null,
    expires: null,
    mfa: "required",
  }]);
  assertEquals(await sessionAt(PENDING_MS + 1_000), [200, { user: null, expires: null }]);
  const late = await later(
    PENDING_MS + 1_000,
    async () => await post(app, "/auth/mfa", pending, { code: await totpNow(app.totpSecret) }),
  );
  assertEquals(await answer(late), [401, { error: "unauthorized" }]);
});
