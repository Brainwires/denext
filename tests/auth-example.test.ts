// examples/auth end-to-end through the JavaScript-DISABLED path: the denextAuth
// plugin's /auth/* endpoints (mounted the way the servers mount plugin handlers), the
// requireAuth middleware gate, scrypt-hashed registration + login through the sqlite
// AUTH ADAPTER, roles gating /admin, bearer API tokens, the login rate limit, and
// revocation via the adapter's session store ("sign out everywhere") — and the rc.2 flows:
// email verification, password reset, the magic sign-in link (with the pre-account-hijacking
// retirement of an unverified account's password and sessions), and the TOTP second factor
// with single-use backup codes. Mail is read from the example's dev outbox (lib/outbox.ts).

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { decodeBase32 } from "@std/encoding/base32";
import { createTestApp, createTestClient, type TestClient, type TestHandler } from "denext/testing";
import type { DenextPlugin, PluginContext, PluginRequestHandler } from "../src/plugin/mod.ts";
import {
  createRequestContext,
  runDeferred,
  runWithContext,
} from "../src/server/request-context.ts";

// A throwaway database file + a fixed secret — set before the app loads any module. It is a
// real file, not ":memory:", because the admin page opens a second read handle onto it.
const TMP = Deno.makeTempDirSync({ prefix: "denext-auth-example-" });
Deno.env.set("AUTH_DB", `${TMP}/auth.db`);
Deno.env.set("AUTH_SECRET", "auth-example-test-secret-at-least-32-chars");

const APP = new URL("../examples/auth", import.meta.url).pathname;

/**
 * The example's `denext.config.ts` plugin, set up the way `applyPlugins` does it, and
 * composed with the test app: `/auth/*` goes to the plugin (inside a request context,
 * with its Set-Cookie headers merged like the pipeline's `finalize`, and its `after()`
 * work — the mail a reset or magic-link request sends — drained before answering),
 * everything else to the app (pages, Server Actions, middleware).
 */
async function appWithAuth(): Promise<TestHandler> {
  const config = (await import(`${APP}/denext.config.ts`)).default as {
    plugins: DenextPlugin[];
  };
  const handlers: PluginRequestHandler[] = [];
  const ctx = {
    addRequestHandler: (h: PluginRequestHandler) => void handlers.push(h),
    addTeardown: () => {},
  } as unknown as PluginContext;
  for (const plugin of config.plugins) await plugin.setup(ctx);
  const app = await createTestApp(APP);
  return async (request: Request): Promise<Response> => {
    if (!new URL(request.url).pathname.startsWith("/auth/")) {
      return app(request);
    }
    const rc = createRequestContext(request);
    const res = await runWithContext(rc, () => handlers[0](request));
    await runDeferred(rc);
    const headers = new Headers(res!.headers);
    for (const c of rc.outgoingHeaders.getSetCookie()) {
      headers.append("set-cookie", c);
    }
    return new Response(res!.body, { status: res!.status, headers });
  };
}

const AUTH_COOKIE = "__Host-denext_auth";
type AuthJson = { error?: string; user?: { email: string } };
const login = (email: string, password: string) => ({
  json: { email, password },
  headers: { accept: "application/json" },
});
/** The JSON-client sign-in request against the credentials callback. */
const postCredentials = (client: TestClient, email: string, password: string) =>
  client.post("/auth/callback/credentials", login(email, password));

/** What later steps need from earlier ones: the TOTP secret and the backup codes. */
type Carried = { secret: string; backupCodes: string[] };
type Ctx = { handler: TestHandler; client: TestClient; carried: Carried };

async function homeRendersAndDashboardIsGated({ client }: Ctx) {
  const home = await client.get("/");
  assertEquals(home.status, 200);
  assertStringIncludes(home.text, "First-party auth");
  const gated = await client.get("/dashboard");
  assertEquals(gated.status, 302);
  assertStringIncludes(
    gated.location ?? "",
    "/login?callbackUrl=%2Fdashboard",
  );
}

async function wrongPasswordIsGeneric401({ client }: Ctx) {
  const res = await postCredentials(client, "demo@denext.dev", "nope");
  assertEquals(res.status, 401);
  assertEquals((res.json() as AuthJson).error, "invalid credentials");
  assertEquals(client.cookies.get(AUTH_COOKIE), undefined);
}

async function registerThroughForm({ client }: Ctx) {
  const page = await client.get("/register");
  const res = await client.submit(client.form(page.text), {
    name: "Ada",
    email: "ada@denext.dev",
    password: "correct horse",
  });
  assertEquals(res.status, 303);
  assertStringIncludes(res.location ?? "", "/login?registered=1");
  // The account went into the ADAPTER: a user record, its scrypt credential, and the
  // `credentials` account row registration linked to it.
  const { adapter, findUser } = await import(`${APP}/lib/users.ts`);
  const ada = await findUser("ada@denext.dev");
  assert(ada, "the adapter holds the registered user");
  assertStringIncludes(await adapter.getCredential(ada.id), "scrypt$N=");
  const accounts = await adapter.listAccounts(ada.id);
  assertEquals(accounts.map((a: { provider: string }) => a.provider), ["credentials"]);
}

async function signInOpensDashboard({ client }: Ctx) {
  const res = await postCredentials(client, "ada@denext.dev", "correct horse");
  assertEquals(res.status, 200);
  assertEquals((res.json() as AuthJson).user?.email, "ada@denext.dev");
  assert(
    client.cookies.get(AUTH_COOKIE),
    "the __Host- session cookie is in the jar",
  );
  const dash = await client.get("/dashboard");
  assertEquals(dash.status, 200);
  assertStringIncludes(dash.text, "ada@denext.dev");
  assertStringIncludes(dash.text, "Session id:");
}

async function signOutEverywhereRevokes({ handler, client }: Ctx) {
  const other = createTestClient(handler); // a second device, same account
  await postCredentials(other, "ada@denext.dev", "correct horse");
  assertEquals((await other.get("/dashboard")).status, 200);

  const dash = await client.get("/dashboard");
  // Forms on the page: [0] /auth/signout, [1] signOutEverywhere, [2] changePassword.
  const res = await client.submit(client.form(dash.text, { index: 1 }));
  assertEquals(res.status, 303);
  assertStringIncludes(res.location ?? "", "/?everywhere=1");

  assert(
    other.cookies.get(AUTH_COOKIE),
    "the other device still holds its cookie…",
  );
  assertEquals(
    (await other.get("/dashboard")).status,
    302,
    "…but it is revoked",
  );
  assertEquals((await client.get("/dashboard")).status, 302);
}

async function changePasswordRehashesAndRevokes({ client }: Ctx) {
  await postCredentials(client, "ada@denext.dev", "correct horse");
  const dash = await client.get("/dashboard");
  assertEquals(dash.status, 200);
  const form = () => client.form(dash.text, { has: "current" });
  const wrong = await client.submit(form(), {
    current: "nope",
    next: "new password 1",
  });
  assertEquals(wrong.status, 303);
  assertStringIncludes(wrong.location ?? "", "/dashboard?error=current");
  const weak = await client.submit(form(), {
    current: "correct horse",
    next: "short",
  });
  assertStringIncludes(weak.location ?? "", "/dashboard?error=weak");

  const ok = await client.submit(form(), {
    current: "correct horse",
    next: "new password 1",
  });
  assertStringIncludes(ok.location ?? "", "/login?changed=1");
  assertEquals(
    (await client.get("/dashboard")).status,
    302,
    "the old session was revoked",
  );
  const old = await postCredentials(client, "ada@denext.dev", "correct horse");
  assertEquals(old.status, 401, "the old password no longer works");
  const fresh = await postCredentials(client, "ada@denext.dev", "new password 1");
  assertEquals(fresh.status, 200, "the new password does");
}

async function sixthFailedAttemptIs429({ handler }: Ctx) {
  // A fresh client + an identifier no earlier step failed on (the key is IP + email).
  const fresh = createTestClient(handler);
  for (let i = 0; i < 5; i++) {
    const res = await postCredentials(fresh, "mallory@denext.dev", "x");
    assertEquals(res.status, 401, `attempt ${i + 1}`);
  }
  const locked = await postCredentials(fresh, "mallory@denext.dev", "password");
  assertEquals(locked.status, 429);
  assertEquals((locked.json() as AuthJson).error, "too many attempts");
  assert(Number(locked.headers.get("retry-after")) > 0);
}

async function sessionIsTheAdapterIdentity({ client }: Ctx) {
  const { findUser } = await import(`${APP}/lib/users.ts`);
  const ada = await findUser("ada@denext.dev");
  assertEquals(
    ada.roles,
    ["user"],
    "the seeded demo account registered first, so Ada is not admin",
  );

  const res = await client.get("/auth/session");
  assertEquals(res.status, 200);
  const body = res.json() as { user?: { id: string; roles?: string[] } };
  assertEquals(body.user?.id, ada.id, "session.user.id IS the adapter id");
  assertEquals(body.user?.roles, ["user"], "roles travel in the session");
  // Sliding expiry is configured with `updateAge: 3600` and this session is seconds old,
  // so the canonical refresh path re-issues nothing.
  assertEquals(res.headers.get("set-cookie"), null, "a fresh session is not slid forward");
}

async function adminPageIsRoleGated({ handler, client }: Ctx) {
  const refused = await client.get("/admin");
  assertEquals(refused.status, 302, "a signed-in non-admin is refused");
  assertStringIncludes(refused.location ?? "", "/login?error=forbidden");
  assertStringIncludes(refused.location ?? "", "callbackUrl=%2Fadmin");

  const admin = createTestClient(handler);
  assertEquals((await postCredentials(admin, "demo@denext.dev", "password")).status, 200);
  const page = await admin.get("/admin");
  assertEquals(page.status, 200);
  assertStringIncludes(page.text, "demo@denext.dev");
  assertStringIncludes(page.text, "ada@denext.dev");
  assertStringIncludes(page.text, ">admin<");
}

/** The `tok_…` plaintext rendered on the page, or "" when none is shown. */
function renderedToken(html: string): string {
  return /tok_[A-Za-z0-9_-]+/.exec(html)?.[0] ?? "";
}

/** A GET carrying an `Authorization: Bearer` header (the API-token path, no cookie needed). */
const withBearer = (client: TestClient, token: string) =>
  client.request("/api/me", { headers: { authorization: `Bearer ${token}` } });

/** Sign in, mint a token through the page's form, and return the plaintext shown once. */
async function mintToken(client: TestClient): Promise<string> {
  assertEquals((await postCredentials(client, "demo@denext.dev", "password")).status, 200);
  const page = await client.get("/account/tokens");
  assertEquals(page.status, 200);
  const created = await client.submit(client.form(page.text, { has: "label" }), { label: "ci" });
  assertEquals(created.status, 303);
  const shown = await client.get(created.location ?? "");
  const token = renderedToken(shown.text);
  assert(
    token.startsWith("tok_"),
    `the plaintext is rendered once; got ${shown.text.slice(0, 200)}`,
  );
  const again = await client.get("/account/tokens?created=1");
  assertEquals(renderedToken(again.text), "", "and never a second time");
  return token;
}

async function apiTokensAuthenticateAndRevoke({ handler }: Ctx) {
  const owner = createTestClient(handler);
  const token = await mintToken(owner);

  const me = await withBearer(owner, token);
  assertEquals(me.status, 200);
  const profile = me.json() as { email: string; roles: string[] };
  assertEquals(profile.email, "demo@denext.dev");
  assertEquals(profile.roles, ["admin", "user"]);
  assertEquals((await withBearer(owner, "tok_not-a-real-token")).status, 401);

  const list = await owner.get("/account/tokens");
  const revoked = await owner.submit(owner.form(list.text, { has: "tokenId" }));
  assertEquals(revoked.status, 303);
  assertStringIncludes(revoked.location ?? "", "revoked=1");
  assertEquals((await withBearer(owner, token)).status, 401, "a revoked token is dead at once");
}

// ---- the emailed flows (verification, reset, magic link) + TOTP -------------------------

/** Ada's password after the reset step (and every later step's). */
const RESET_PASSWORD = "reset password 2";

/** A captured message, as lib/outbox.ts keeps it. */
type Mail = { identifier: string; purpose: string; url: string; token: string };

/** Every message the example's dev mailer captured so far, oldest first. */
async function sentMail(): Promise<Mail[]> {
  const { listMail } = await import(`${APP}/lib/outbox.ts`);
  return [...(listMail() as Mail[])].reverse();
}

/**
 * The newest message to `to` for `purpose` sent after `since` messages existed. A Server
 * Action's mail goes out in `after()`, which the pipeline drains once the response is sent,
 * so this waits a few ticks for it.
 */
async function mailTo(to: string, purpose: string, since: number): Promise<Mail> {
  for (let tick = 0; tick < 200; tick++) {
    const found = (await sentMail()).slice(since)
      .filter((m) => m.identifier === to && m.purpose === purpose).at(-1);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no "${purpose}" mail to ${to}`);
}

/** A mailed link as a same-origin path + search (what the test client requests). */
function pathOf(mail: Mail): string {
  const url = new URL(mail.url);
  return url.pathname + url.search;
}

async function verifyEmail({ client }: Ctx) {
  const page = await client.get("/verify-email");
  assertEquals(page.status, 200);
  assertStringIncludes(page.text, "is not verified yet");
  const since = (await sentMail()).length;
  const sent = await client.submit(client.form(page.text));
  assertEquals(sent.status, 303);
  assertStringIncludes(sent.location ?? "", "/verify-email?sent=1");

  const mail = await mailTo("ada@denext.dev", "email", since);
  assertMatch(pathOf(mail), /^\/auth\/verify\?token=[^&]+&email=ada%40denext\.dev$/);
  const opened = await client.get(pathOf(mail));
  assertEquals(opened.status, 303);
  assertEquals(opened.location, "/check-email?verified=1");
  assertStringIncludes((await client.get("/check-email?verified=1")).text, "Address verified");

  const { findUser } = await import(`${APP}/lib/users.ts`);
  assertEquals(typeof (await findUser("ada@denext.dev")).emailVerified, "number");
  assertStringIncludes((await client.get("/verify-email")).text, "verified on");
  assertEquals((await client.get(pathOf(mail))).location, "/check-email?error=invalid_token");
}

async function resetPassword({ handler, client: adaEarlier }: Ctx) {
  const client = createTestClient(handler);
  const forgot = await client.get("/forgot");
  const request = (email: string) => client.submit(client.form(forgot.text), { email });
  const since = (await sentMail()).length;
  // The same answer for an address with no account — and no mail for it.
  const unknown = await request("nobody@denext.dev");
  const known = await request("ada@denext.dev");
  for (const res of [unknown, known]) {
    assertEquals([res.status, res.location], [303, "/check-email?sent=1"]);
  }
  assertStringIncludes((await client.get("/check-email?sent=1")).text, "Check your email");

  const mail = await mailTo("ada@denext.dev", "reset", since);
  assertEquals((await sentMail()).slice(since).length, 1, "nothing was mailed to nobody@");
  assertMatch(pathOf(mail), /^\/reset\?token=/, "the link opens the app's own /reset page");
  const page = await client.get(pathOf(mail));
  assertEquals(page.status, 200);
  const weak = await client.submit(client.form(page.text), { password: "short" });
  assertEquals(weak.status, 303);
  assertMatch(weak.location ?? "", /^\/reset\?.*error=invalid_password/, "the link survives");
  const done = await client.submit(client.form(page.text), { password: RESET_PASSWORD });
  assertEquals([done.status, done.location], [303, "/login?reset=1"]);
  assertStringIncludes((await client.get("/login?reset=1")).text, "Password reset");

  assertEquals((await adaEarlier.get("/dashboard")).status, 302, "the reset revoked sessions");
  assertEquals((await postCredentials(client, "ada@denext.dev", "new password 1")).status, 401);
  assertEquals((await postCredentials(client, "ada@denext.dev", RESET_PASSWORD)).status, 200);
}

/** Ask for a sign-in link from /login's form and return the mail it sent to `email`. */
async function requestMagicLink(client: TestClient, email: string): Promise<Mail> {
  const login = await client.get("/login");
  const since = (await sentMail()).length;
  const form = client.form(login.text, { action: /\/auth\/callback\/email$/ });
  const sent = await client.submit(form, { email });
  assertEquals([sent.status, sent.location], [303, "/check-email?sent=1"]);
  return await mailTo(email, "magic", since);
}

async function magicLinkSignsIn({ handler }: Ctx) {
  const client = createTestClient(handler);
  const mail = await requestMagicLink(client, "ada@denext.dev");
  assertMatch(pathOf(mail), /^\/auth\/callback\/email\?token=.+&callbackUrl=%2Fdashboard$/);
  const opened = await client.get(pathOf(mail));
  assertEquals([opened.status, opened.location], [303, "/dashboard"]);
  const dash = await client.get("/dashboard");
  assertEquals(dash.status, 200);
  assertStringIncludes(dash.text, "ada@denext.dev");
  assertEquals((await client.get(pathOf(mail))).location, "/login?error=Verification");
  // Ada's address was verified, so the link retired nothing: the password still works.
  assertEquals((await postCredentials(client, "ada@denext.dev", RESET_PASSWORD)).status, 200);
}

async function magicLinkRetiresUnverifiedAccess({ handler }: Ctx) {
  // Someone registers grace@ with a password without owning the mailbox…
  const squatter = createTestClient(handler);
  const register = await squatter.get("/register");
  await squatter.submit(squatter.form(register.text), {
    name: "Grace",
    email: "grace@denext.dev",
    password: "squatter password",
  });
  assertEquals(
    (await postCredentials(squatter, "grace@denext.dev", "squatter password")).status,
    200,
  );
  assertEquals((await squatter.get("/dashboard")).status, 200);

  // …then the real owner signs in with a link from that mailbox.
  const owner = createTestClient(handler);
  const opened = await owner.get(pathOf(await requestMagicLink(owner, "grace@denext.dev")));
  assertEquals([opened.status, opened.location], [303, "/dashboard"]);
  assertStringIncludes((await owner.get("/dashboard")).text, "grace@denext.dev");

  assertEquals((await squatter.get("/dashboard")).status, 302, "the squatter's session is gone");
  const old = await postCredentials(squatter, "grace@denext.dev", "squatter password");
  assertEquals(old.status, 401, "and so is the password nobody proved");
  const { findUser } = await import(`${APP}/lib/users.ts`);
  assertEquals(typeof (await findUser("grace@denext.dev")).emailVerified, "number");
}

/** An RFC 6238 code for `secret`, `offset` 30-second steps from now (HMAC-SHA-1, 6 digits). */
async function totp(secret: string, offset = 0): Promise<string> {
  const bytes = decodeBase32(secret.padEnd(Math.ceil(secret.length / 8) * 8, "="));
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(bytes),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = new DataView(new ArrayBuffer(8));
  counter.setBigUint64(0, BigInt(Math.floor(Date.now() / 30_000) + offset));
  const mac = new DataView(await crypto.subtle.sign("HMAC", key, counter.buffer));
  const at = mac.getUint8(mac.byteLength - 1) & 0x0f;
  return String((mac.getUint32(at) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** The backup codes rendered on a page (`xxxxx-xxxxx`). */
function renderedBackupCodes(html: string): string[] {
  return [...html.matchAll(/<code>([2-9a-z]{5}-[2-9a-z]{5})<\/code>/g)].map((m) => m[1]);
}

async function enrolTotp({ client, carried }: Ctx) {
  // The reset revoked this device's session: sign back in with the new password, then enrol.
  assertEquals((await postCredentials(client, "ada@denext.dev", RESET_PASSWORD)).status, 200);
  const page = await client.get("/account/security");
  assertEquals(page.status, 200);
  assertStringIncludes(page.text, "is <strong>off</strong>");
  const started = await client.submit(client.form(page.text));
  assertEquals([started.status, started.location], [303, "/account/security?step=confirm"]);

  const step = await client.get("/account/security?step=confirm");
  carried.secret = /<code class="token">([A-Z2-7]{32})<\/code>/.exec(step.text)?.[1] ?? "";
  assert(carried.secret, "the base32 secret is shown for manual entry");
  assertStringIncludes(step.text, `otpauth://totp/`);
  assertStringIncludes(step.text, `secret=${carried.secret}`);

  const confirmed = await client.submit(client.form(step.text, { has: "code" }), {
    code: await totp(carried.secret),
  });
  assertEquals([confirmed.status, confirmed.location], [303, "/account/security?confirmed=1"]);
  carried.backupCodes = renderedBackupCodes((await client.get(confirmed.location!)).text);
  assertEquals(carried.backupCodes.length, 10, "ten backup codes, shown this once");
  const again = await client.get("/account/security?confirmed=1");
  assertEquals(renderedBackupCodes(again.text), [], "and never again");
  assertStringIncludes(again.text, "is <strong>on</strong>");
}

/** Sign in through the rendered login form (the JS-disabled path) and return its answer. */
async function formSignIn(client: TestClient, password = RESET_PASSWORD) {
  const login = await client.get("/login");
  return await client.submit(client.form(login.text, { has: "password" }), {
    email: "ada@denext.dev",
    password,
  });
}

/** Submit a code on the /mfa page the pending sign-in was sent to. */
async function submitMfaCode(client: TestClient, code: string) {
  const page = await client.get("/mfa?callbackUrl=%2Fdashboard");
  assertEquals(page.status, 200);
  assertStringIncludes(page.text, "ada@denext.dev");
  return await client.submit(client.form(page.text, { has: "code" }), { code });
}

/** Sign in with the password: it must stop at /mfa, with the dashboard still refused. */
async function pendingSignIn(handler: TestHandler): Promise<TestClient> {
  const client = createTestClient(handler);
  const res = await formSignIn(client);
  assertEquals([res.status, res.location], [303, "/mfa?callbackUrl=%2Fdashboard"]);
  assertEquals((await client.get("/dashboard")).status, 302, "a pending session is signed out");
  return client;
}

async function totpStepUp({ client, carried }: Ctx) {
  const dash = await client.get("/dashboard");
  const out = await client.submit(client.form(dash.text, { action: /\/auth\/signout/ }));
  assertEquals(out.status, 303);
  assertEquals((await client.get("/dashboard")).status, 302, "signed out");

  const res = await formSignIn(client);
  assertEquals([res.status, res.location], [303, "/mfa?callbackUrl=%2Fdashboard"]);
  assertEquals((await client.get("/dashboard")).status, 302, "a pending session is signed out");
  // The confirm step claimed the current 30-second step; the next one is still in window.
  const done = await submitMfaCode(client, await totp(carried.secret, 1));
  assertEquals([done.status, done.location], [303, "/dashboard"]);
  assertEquals((await client.get("/dashboard")).status, 200);
}

async function backupCodeWorksOnce({ handler, carried }: Ctx) {
  const [first, second] = carried.backupCodes;
  const one = await pendingSignIn(handler);
  const used = await submitMfaCode(one, first);
  assertEquals([used.status, used.location], [303, "/dashboard"]);
  assertEquals((await one.get("/dashboard")).status, 200);

  const two = await pendingSignIn(handler);
  const reused = await submitMfaCode(two, first);
  assertEquals(reused.status, 303);
  assertStringIncludes(reused.location ?? "", "/mfa?error=CredentialsSignin");
  assertStringIncludes((await two.get(reused.location!)).text, "A code changes every 30 seconds");
  assertEquals((await two.get("/dashboard")).status, 302, "a spent backup code grants nothing");
  const other = await submitMfaCode(two, second);
  assertEquals([other.status, other.location], [303, "/dashboard"]);
}

async function disableTotp({ handler, carried }: Ctx) {
  const client = await pendingSignIn(handler);
  await submitMfaCode(client, carried.backupCodes[2]);
  const page = await client.get("/account/security");
  assertStringIncludes(page.text, "Backup codes left: <strong>7</strong>");
  const form = () => client.form(page.text, { has: "code" });
  const wrong = await client.submit(form(), { code: "abcdef" });
  assertEquals(wrong.location, "/account/security?error=code");
  const off = await client.submit(form(), { code: carried.backupCodes[3] });
  assertEquals(off.location, "/account/security?disabled=1");
  assertStringIncludes((await client.get(off.location!)).text, "is <strong>off</strong>");

  const res = await postCredentials(createTestClient(handler), "ada@denext.dev", RESET_PASSWORD);
  assertEquals((res.json() as AuthJson).user?.email, "ada@denext.dev", "no second step now");
}

const STEPS: Array<[string, (ctx: Ctx) => Promise<void>]> = [
  ["home renders; /dashboard is gated by requireAuth", homeRendersAndDashboardIsGated],
  ["a wrong password is a generic 401 and sets no cookie", wrongPasswordIsGeneric401],
  ["register through the rendered form (password stored as scrypt)", registerThroughForm],
  ["sign in (JSON client) → session cookie → the dashboard opens", signInOpensDashboard],
  [
    "'sign out everywhere' revokes the session: the same cookie no longer authenticates",
    signOutEverywhereRevokes,
  ],
  [
    "change password: wrong current → error; success rehashes + signs out everywhere",
    changePasswordRehashesAndRevokes,
  ],
  ["brute force: the 6th failed attempt is a generic 429", sixthFailedAttemptIs429],
  [
    "the adapter is the identity: session.user.id is its id, with roles, and no idle refresh",
    sessionIsTheAdapterIdentity,
  ],
  [
    "/admin is role-gated: a plain user gets ?error=forbidden, the admin sees the list",
    adminPageIsRoleGated,
  ],
  [
    "API tokens: created once, authenticate `Authorization: Bearer`, dead when revoked",
    apiTokensAuthenticateAndRevoke,
  ],
  ["email verification: /verify-email mails a link; opening it sets emailVerified", verifyEmail],
  [
    "password reset: /forgot → the mailed link → /reset; the old password is refused, the new one signs in",
    resetPassword,
  ],
  [
    "magic link: 'Email me a sign-in link' on /login → the mailed link signs a verified account in",
    magicLinkSignsIn,
  ],
  [
    "a first email sign-in into an UNVERIFIED account retires its password and sessions",
    magicLinkRetiresUnverifiedAccess,
  ],
  [
    "TOTP: enrol on /account/security (secret + otpauth URI) → confirm → backup codes shown once",
    enrolTotp,
  ],
  ["sign out → sign in lands on /mfa, not the dashboard → a TOTP code → dashboard", totpStepUp],
  ["a backup code completes the step-up exactly once", backupCodeWorksOnce],
  ["turning TOTP off needs a current code; then sign-in is one step again", disableTotp],
];

Deno.test("examples/auth: the full app works with JavaScript disabled", async (t) => {
  const handler = await appWithAuth();
  const carried: Carried = { secret: "", backupCodes: [] };
  const ctx: Ctx = { handler, client: createTestClient(handler), carried };
  try {
    for (const [name, fn] of STEPS) await t.step(name, () => fn(ctx));
  } finally {
    Deno.removeSync(TMP, { recursive: true });
  }
});
