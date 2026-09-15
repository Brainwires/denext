// The rc.2 auth rows, reached through the REAL plugin request handler (`handlers[0]` of
// `denextAuth`): `/verify`, `/reset`, `/reset/confirm` and `/mfa*` spliced into the route
// table; the per-provider-type verbs of `/callback/:provider` (credentials POST, OAuth GET,
// email GET + POST) — an unknown provider is a 404, a verb the type lacks a 405; a row
// whose feature isn't configured falls through; and a custom `basePath` moves them all.

import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import type { PluginContext, PluginRequestHandler } from "../src/plugin/mod.ts";
import {
  type AuthAdapter,
  type AuthConfig,
  credentials,
  denextAuth,
  emailOtp,
  enrollTotp,
  github,
  hashPassword,
  inMemoryAuthAdapter,
  magicLink,
  requestEmailVerification,
  type VerificationRequestParams,
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
const PAGES = {
  signIn: "/login",
  afterSignIn: "/home",
  verifyRequest: "/check-email",
  error: "/oops",
  mfa: "/login/2fa",
};
/** An `Accept: application/json` client. */
const JSON_CLIENT = { accept: "application/json" };
/** The adapter's MFA group; without all four the `/mfa*` rows don't exist. */
const MFA_GROUP = ["getMfa", "setMfa", "consumeBackupCode", "claimTotpStep"] as const;
/** The verification-token group the email flows and email providers need. */
const TOKEN_GROUP = ["createVerificationToken", "useVerificationToken"] as const;

// ---- harness ---------------------------------------------------------------------

/** One mounted app: the plugin's one request handler, its config, and the mail it sent. */
interface App {
  handle: PluginRequestHandler;
  config: AuthConfig;
  adapter: AuthAdapter;
  /** Every message handed to `sendVerificationRequest`. */
  sent: VerificationRequestParams[];
}

/** `adapter` with `keys` removed — an adapter that lacks a method group. */
function without(adapter: AuthAdapter, keys: readonly (keyof AuthAdapter)[]): AuthAdapter {
  const copy: AuthAdapter = { ...adapter };
  for (const key of keys) delete copy[key];
  return copy;
}

/**
 * Build the config (a password user, credentials + magic link + GitHub by default), run
 * the plugin's `setup` the way `applyPlugins` does, and keep its one request handler.
 */
async function mount(
  extra: Partial<AuthConfig> = {},
  adapter: AuthAdapter = inMemoryAuthAdapter(),
): Promise<App> {
  const user = await adapter.createUser({ email: EMAIL, name: "Ada" });
  await adapter.setCredential!(user.id, await hashPassword(PASSWORD));
  const sent: VerificationRequestParams[] = [];
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    trustForwardedHeaders: false,
    providers: [
      credentials(),
      magicLink(),
      github({ clientId: "gh-client", clientSecret: "gh-secret" }),
    ],
    adapter,
    pages: PAGES,
    sendVerificationRequest: (params) => void sent.push(params),
    logger: { warn: () => {} },
    ...extra,
  };
  const handlers: PluginRequestHandler[] = [];
  const ctx = {
    addRequestHandler: (handler: PluginRequestHandler) => void handlers.push(handler),
    addTeardown: () => {},
  } as unknown as PluginContext;
  await denextAuth(config).setup(ctx);
  assertEquals(handlers.length, 1, "denextAuth registers exactly one request handler");
  return { handle: handlers[0], config, adapter, sent };
}

/** How a test request is sent. */
interface Init {
  /** A JSON body (sent with `content-type: application/json`). */
  body?: Record<string, string>;
  /** The `name=value` session cookie to present. */
  cookie?: string;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

/** The answer (`null`: fell through to the app) and the session cookie it set. */
interface Answer {
  res: Response | null;
  cookie?: string;
}

/** Send one same-origin request through the plugin handler, then flush `after()` mail. */
async function call(app: App, method: string, path: string, init: Init = {}): Promise<Answer> {
  const headers = new Headers({ origin: ORIGIN, ...init.headers });
  if (init.body) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  const body = init.body ? JSON.stringify(init.body) : undefined;
  const request = new Request(new URL(path, ORIGIN), { method, headers, body });
  setRemoteAddr(request, { transport: "tcp", hostname: "203.0.113.7", port: 443 });
  const ctx = createRequestContext(request);
  const res = await runWithContext(ctx, async () => await app.handle(request) ?? null);
  await runDeferred(ctx);
  const cookie = ctx.outgoingHeaders.getSetCookie()
    .find((c) => c.startsWith(SESSION_COOKIE))?.split(";")[0];
  return { res, cookie };
}

/** Run `fn` inside a request context (for a server API that reads it), then flush `after()`. */
async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  const request = new Request(`${ORIGIN}/account`);
  setRemoteAddr(request, { transport: "tcp", hostname: "203.0.113.7", port: 443 });
  const ctx = createRequestContext(request);
  const out = await runWithContext(ctx, fn);
  await runDeferred(ctx);
  return out;
}

/** The status and JSON body of an answer that must exist. */
async function jsonOf(answer: Answer): Promise<[number, Record<string, unknown>]> {
  assert(answer.res, "the auth handler claimed the request");
  return [answer.res.status, await answer.res.json()];
}

/** A 303's target as a path + search. */
function location(answer: Answer): string {
  assert(answer.res, "the auth handler claimed the request");
  assertEquals(answer.res.status, 303);
  const target = new URL(answer.res.headers.get("location")!, ORIGIN);
  return target.pathname + target.search;
}

/** The mailed link of the `i`-th message, as a path + search. */
function mailedPath(app: App, i = 0): string {
  const link = new URL(app.sent[i].url);
  assertEquals(link.origin, ORIGIN, "links are built on canonicalOrigin");
  return link.pathname + link.search;
}

/** Sign in with the password as a JSON client; returns the complete session's cookie. */
async function passwordSession(app: App, password = PASSWORD): Promise<string> {
  const answer = await call(app, "POST", "/auth/callback/credentials", {
    body: { email: EMAIL, password },
    headers: JSON_CLIENT,
  });
  const [status, body] = await jsonOf(answer);
  assertEquals([status, body.ok], [200, true]);
  assert(answer.cookie, "a session cookie was issued");
  return answer.cookie;
}

// ---- /verify ---------------------------------------------------------------------

Deno.test("GET /auth/verify?token=… (the mailed link) verifies the address and redirects", async () => {
  const app = await mount();
  await inRequest(() => requestEmailVerification(app.config, EMAIL));
  assertEquals(app.sent.length, 1);
  assertEquals(app.sent[0].purpose, "email");
  const link = mailedPath(app);
  assertMatch(link, /^\/auth\/verify\?token=[^&]+&email=ada%40x\.test$/);

  assertEquals(location(await call(app, "GET", link)), "/check-email?verified=1");
  assertEquals(typeof (await app.adapter.getUserByEmail(EMAIL))?.emailVerified, "number");
  assertEquals(
    location(await call(app, "GET", link)),
    "/oops?error=invalid_token",
    "the token is single-use",
  );
});

Deno.test("POST /auth/verify takes the token from a JSON body", async () => {
  const app = await mount();
  await inRequest(() => requestEmailVerification(app.config, EMAIL));
  const token = new URL(app.sent[0].url).searchParams.get("token")!;
  const post = (value: string) =>
    call(app, "POST", "/auth/verify", {
      body: { email: EMAIL, token: value },
      headers: JSON_CLIENT,
    });
  assertEquals(await jsonOf(await post("not-the-token")), [400, { error: "invalid_token" }]);
  assertEquals(await jsonOf(await post(token)), [200, { ok: true }]);
});

// ---- /reset ------------------------------------------------------------------------

Deno.test("POST /auth/reset → 200 and a reset link; /reset/confirm sets the password the credentials callback then accepts", async () => {
  const app = await mount();
  const requested = await call(app, "POST", "/auth/reset", {
    body: { email: EMAIL },
    headers: JSON_CLIENT,
  });
  assertEquals(await jsonOf(requested), [200, { ok: true }]);
  assertEquals(app.sent.map((m) => m.purpose), ["reset"]);
  const link = new URL(app.sent[0].url);
  assertEquals(link.pathname, "/auth/reset", "the link opens the app's reset page");

  const token = link.searchParams.get("token")!;
  const confirmed = await call(app, "POST", "/auth/reset/confirm", {
    body: { email: EMAIL, token, password: "a brand new password" },
    headers: JSON_CLIENT,
  });
  assertEquals(await jsonOf(confirmed), [200, { ok: true }]);
  await passwordSession(app, "a brand new password");
  const old = await call(app, "POST", "/auth/callback/credentials", {
    body: { email: EMAIL, password: PASSWORD },
    headers: JSON_CLIENT,
  });
  assertEquals(old.res?.status, 401, "the old password is gone");
});

Deno.test("a row claims only its own verb: GET /auth/reset (the app's reset page) and GET /auth/mfa fall through", async () => {
  const app = await mount();
  for (
    const [method, path] of [["GET", "/auth/reset"], ["GET", "/auth/mfa"], ["PUT", "/auth/verify"]]
  ) {
    assertEquals((await call(app, method, path)).res, null, `${method} ${path}`);
  }
});

Deno.test("without the verification-token group /verify and /reset* fall through", async () => {
  const app = await mount(
    { providers: [credentials()] },
    without(inMemoryAuthAdapter(), TOKEN_GROUP),
  );
  assertEquals((await call(app, "GET", `/auth/verify?token=t&email=${EMAIL}`)).res, null);
  assertEquals((await call(app, "POST", "/auth/verify", { body: { token: "t" } })).res, null);
  assertEquals((await call(app, "POST", "/auth/reset", { body: { email: EMAIL } })).res, null);
  assertEquals((await call(app, "POST", "/auth/reset/confirm", { body: {} })).res, null);
  assertEquals(app.sent, []);
});

// ---- /mfa* ---------------------------------------------------------------------------

Deno.test("POST /auth/mfa with no session is a 401", async () => {
  const app = await mount();
  const answer = await call(app, "POST", "/auth/mfa", {
    body: { code: "123456" },
    headers: JSON_CLIENT,
  });
  assertEquals(await jsonOf(answer), [401, { error: "unauthorized" }]);
});

Deno.test("POST /auth/mfa/enroll from a complete session answers { secret, uri }; /confirm and /disable are reachable", async () => {
  const app = await mount();
  const cookie = await passwordSession(app);
  const [status, enrolment] = await jsonOf(await call(app, "POST", "/auth/mfa/enroll", { cookie }));
  assertEquals(status, 200);
  assertMatch(String(enrolment.secret), /^[A-Z2-7]{32}$/);
  assertMatch(String(enrolment.uri), /^otpauth:\/\/totp\/app\.test:ada%40x\.test\?secret=/);

  const confirm = await call(app, "POST", "/auth/mfa/confirm", {
    cookie,
    body: { code: "abcdef" },
  });
  assertEquals(await jsonOf(confirm), [401, { error: "invalid code" }]);
  const disable = await call(app, "POST", "/auth/mfa/disable", { cookie, body: {} });
  assertEquals(await jsonOf(disable), [403, { error: "a fresh second factor is required" }]);
});

Deno.test("an enrolled user's sign-in is pending, and POST /auth/mfa refuses a wrong code", async () => {
  const app = await mount();
  const user = (await app.adapter.getUserByEmail(EMAIL))!;
  const now = Math.floor(Date.now() / 1000);
  const session = { user: { id: user.id, email: EMAIL }, provider: "credentials" };
  const enrolment = await enrollTotp(app.config, {
    ...session,
    expiresAt: now + 60,
    authTime: now,
  });
  if (!enrolment.ok) throw new Error(enrolment.error);
  await app.adapter.setMfa!({
    userId: user.id,
    secret: enrolment.secret,
    backupCodeHashes: [],
    confirmedAt: 1,
  });
  const signIn = await call(app, "POST", "/auth/callback/credentials", {
    body: { email: EMAIL, password: PASSWORD },
    headers: JSON_CLIENT,
  });
  assertEquals(await jsonOf(signIn), [200, { ok: true, mfa: "required" }]);
  const step = await call(app, "POST", "/auth/mfa", {
    cookie: signIn.cookie,
    body: { code: "abcdef" },
    headers: JSON_CLIENT,
  });
  assertEquals(await jsonOf(step), [401, { error: "invalid code" }]);
});

Deno.test("without the adapter's MFA group every /mfa* row falls through", async () => {
  const app = await mount({}, without(inMemoryAuthAdapter(), MFA_GROUP));
  const cookie = await passwordSession(app);
  for (const path of ["/auth/mfa", "/auth/mfa/enroll", "/auth/mfa/confirm", "/auth/mfa/disable"]) {
    assertEquals((await call(app, "POST", path, { cookie, body: {} })).res, null, path);
  }
});

// ---- /callback/:provider ----------------------------------------------------------------

Deno.test("/callback of an unknown provider is a 404 for every verb", async () => {
  const app = await mount();
  for (const method of ["GET", "POST", "DELETE"]) {
    const answer = await call(app, method, "/auth/callback/nope");
    assertEquals(await jsonOf(answer), [404, { error: "unknown provider" }], method);
  }
});

Deno.test("a verb the provider type doesn't answer is a 405: credentials GET, OAuth POST, email DELETE, a code provider's GET", async () => {
  const app = await mount({
    providers: [
      credentials(),
      magicLink(),
      emailOtp(),
      github({ clientId: "a", clientSecret: "b" }),
    ],
  });
  const cases = [
    ["GET", "/auth/callback/credentials"],
    ["PUT", "/auth/callback/credentials"],
    ["POST", "/auth/callback/github"],
    ["DELETE", "/auth/callback/email"],
    ["GET", "/auth/callback/email-otp"],
  ];
  for (const [method, path] of cases) {
    const answer = await call(app, method, path);
    assertEquals(await jsonOf(answer), [405, { error: "method not allowed" }], `${method} ${path}`);
  }
});

Deno.test("the verbs a provider type does answer reach its handler (credentials POST, OAuth GET)", async () => {
  const app = await mount();
  await passwordSession(app);
  const oauth = await call(app, "GET", "/auth/callback/github?code=c&state=s");
  assert(oauth.res);
  assertNotEquals(oauth.res.status, 405);
  assertNotEquals(oauth.res.status, 404);
});

Deno.test("magic link: POST /auth/callback/email with x-denext-auth → { ok: true } + one mail; its GET signs in", async () => {
  const app = await mount();
  const sent = await call(app, "POST", "/auth/callback/email", {
    body: { email: EMAIL },
    headers: { "x-denext-auth": "1" },
  });
  assertEquals(await jsonOf(sent), [200, { ok: true }]);
  assertEquals(app.sent.length, 1);
  assertEquals(app.sent[0].purpose, "magic");
  const link = mailedPath(app);
  assertMatch(link, /^\/auth\/callback\/email\?token=[^&]+&email=ada%40x\.test$/);

  const click = await call(app, "GET", link);
  assertEquals(location(click), "/home");
  assert(click.cookie, "the click issued a session");
  const [status, session] = await jsonOf(
    await call(app, "GET", "/auth/session", { cookie: click.cookie }),
  );
  assertEquals(status, 200);
  assertEquals((session.user as { email: string }).email, EMAIL);
});

Deno.test('the client\'s signIn("email", { credentials: { email } }) request shape sends a link back to callbackUrl', async () => {
  const app = await mount();
  // Exactly what src/client/auth.ts `submitCredentials` sends.
  const answer = await call(app, "POST", "/auth/callback/email", {
    body: { email: EMAIL, callbackUrl: "/dashboard" },
    headers: { accept: "application/json", "x-denext-auth": "1" },
  });
  assertEquals(await jsonOf(answer), [200, { ok: true }]);
  assertEquals(location(await call(app, "GET", mailedPath(app))), "/dashboard");
});

Deno.test("one-time code: POST { email } mails a code; POST { email, code } signs in", async () => {
  const app = await mount({ providers: [emailOtp()] });
  const sent = await call(app, "POST", "/auth/callback/email-otp", {
    body: { email: EMAIL },
    headers: JSON_CLIENT,
  });
  assertEquals(await jsonOf(sent), [200, { ok: true }]);
  assertEquals(app.sent.map((m) => m.purpose), ["otp"]);
  const redeemed = await call(app, "POST", "/auth/callback/email-otp", {
    body: { email: EMAIL, code: app.sent[0].token },
    headers: JSON_CLIENT,
  });
  const [status, body] = await jsonOf(redeemed);
  assertEquals([status, body.ok], [200, true]);
  assert(redeemed.cookie, "the redeem issued a session");
});

// ---- basePath ------------------------------------------------------------------------------

Deno.test("a configured basePath (/api/auth) routes the new rows, and /auth/* is no longer claimed", async () => {
  const app = await mount({ basePath: "/api/auth" });
  const reset = await call(app, "POST", "/api/auth/reset", {
    body: { email: EMAIL },
    headers: JSON_CLIENT,
  });
  assertEquals(await jsonOf(reset), [200, { ok: true }]);
  assertEquals(new URL(app.sent[0].url).pathname, "/api/auth/reset");
  const mfa = await call(app, "POST", "/api/auth/mfa", { body: {}, headers: JSON_CLIENT });
  assertEquals(await jsonOf(mfa), [401, { error: "unauthorized" }]);
  assertEquals(
    location(await call(app, "GET", `/api/auth/verify?token=bad&email=${EMAIL}`)),
    "/oops?error=invalid_token",
  );
  const magic = await call(app, "POST", "/api/auth/callback/email", {
    body: { email: EMAIL },
    headers: JSON_CLIENT,
  });
  assertEquals(await jsonOf(magic), [200, { ok: true }]);
  assertMatch(mailedPath(app, 1), /^\/api\/auth\/callback\/email\?token=/);
  assertEquals(location(await call(app, "GET", mailedPath(app, 1))), "/home");
  assertEquals((await call(app, "POST", "/auth/reset", { body: { email: EMAIL } })).res, null);
});
