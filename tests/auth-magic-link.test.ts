// Passwordless email sign-in — `magicLink()` and `emailOtp()`: the one-recipient rule (a
// list sends nothing and is answered like a real send), the magic-link click and its single
// use + 10-minute life, the one-time code (keyed at rest, 5-minute life, the failure
// budget), sign-up vs `allowSignUp: false`, `emailVerified` on redeem, the MFA step-up, the
// `callbacks.signIn` veto, the config-time check, and `GET /providers`.

import { assert, assertEquals, assertMatch, assertNotEquals, assertThrows } from "@std/assert";
import {
  createRequestContext,
  type RequestContext,
  runDeferred,
  runWithContext,
} from "../src/server/request-context.ts";
import { setRemoteAddr } from "../src/server/remote-addr.ts";
import { resolveAuthOptions } from "../src/server/auth/options.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { issueApiToken } from "../src/server/auth/api-token.ts";
import { handleCredentials } from "../src/server/auth/routes-credentials.ts";
import type { AuthRouteContext } from "../src/server/auth/routes-shared.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { sha256Hex } from "../src/server/auth/hash.ts";
import {
  credentials,
  emailOtp,
  type EmailProviderOptions,
  magicLink,
} from "../src/server/auth/providers.ts";
import { assertEmailProviderConfig } from "../src/server/auth/providers-email.ts";
import {
  emailCallbacks,
  handleEmailRedeem,
  handleEmailRequest,
} from "../src/server/auth/routes-email.ts";
import { handleProviders } from "../src/server/auth/routes-session.ts";
import { readAuthSession } from "../src/server/auth/session.ts";
import { redeemVerificationCode } from "../src/server/auth/verification.ts";
import type { AuthAdapter, VerificationTokenRecord } from "../src/server/auth/adapter.ts";
import {
  type AuthConfig,
  type AuthSession,
  type EmailProvider,
  isEmailProvider,
  type VerificationRequestParams,
} from "../src/server/auth/types.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const PAGES = {
  signIn: "/login",
  afterSignIn: "/home",
  mfa: "/mfa",
  verifyRequest: "/check-email",
  error: "/oops",
};

// ---- harness ---------------------------------------------------------------

/** One app on one email provider, with a recording mailer, token store and event log. */
interface Harness {
  config: AuthConfig;
  adapter: AuthAdapter;
  provider: EmailProvider;
  /** Every message handed to `sendVerificationRequest`. */
  sent: VerificationRequestParams[];
  /** Every verification-token record the adapter was asked to store. */
  stored: VerificationTokenRecord[];
  /** Event names (and `signInFailed:<reason>`) in firing order. */
  events: string[];
  /** Each `signIn` event's `isNewUser`. */
  newUser: (boolean | undefined)[];
}

function setup(
  provider: EmailProvider,
  extra: Partial<AuthConfig> = {},
  base: AuthAdapter = inMemoryAuthAdapter(),
): Harness {
  const sent: VerificationRequestParams[] = [];
  const stored: VerificationTokenRecord[] = [];
  const events: string[] = [];
  const newUser: (boolean | undefined)[] = [];
  const adapter: AuthAdapter = {
    ...base,
    createVerificationToken: (record) => {
      stored.push({ ...record });
      return base.createVerificationToken!(record);
    },
  };
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    providers: [provider],
    adapter,
    pages: PAGES,
    sendVerificationRequest: (params) => void sent.push(params),
    events: {
      createUser: () => void events.push("createUser"),
      emailVerified: () => void events.push("emailVerified"),
      signIn: ({ isNewUser }) => {
        events.push("signIn");
        newUser.push(isNewUser);
      },
      signInFailed: ({ reason }) => void events.push(`signInFailed:${reason}`),
    },
    ...extra,
  };
  return { config, adapter, provider, sent, stored, events, newUser };
}

interface CallInit {
  body?: Record<string, string>;
  form?: boolean;
  origin?: string;
  peer?: string;
  /** Answer with this handler instead of the provider's callback verb. */
  via?: (route: AuthRouteContext) => Promise<Response>;
}

/** Drive the provider's callback verb the way the dispatcher would, then flush `after()` mail. */
async function call(
  h: Harness,
  method: "GET" | "POST",
  target: string,
  init: CallInit = {},
): Promise<{ res: Response; ctx: RequestContext }> {
  const url = new URL(target, ORIGIN);
  const headers = new Headers();
  let body: string | undefined;
  if (method === "POST") {
    headers.set("origin", init.origin ?? ORIGIN);
    if (init.form) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(init.body).toString();
    } else {
      headers.set("content-type", "application/json");
      headers.set("accept", "application/json");
      body = JSON.stringify(init.body ?? {});
    }
  }
  const request = new Request(url, { method, headers, body });
  setRemoteAddr(request, { transport: "tcp", hostname: init.peer ?? "203.0.113.9", port: 443 });
  const ctx = createRequestContext(request);
  const route = {
    request,
    config: h.config,
    options: resolveAuthOptions(h.config),
    url,
    method,
    params: { provider: h.provider.id },
  };
  const res = await runWithContext(
    ctx,
    () => init.via ? init.via(route) : emailCallbacks[method](route, h.provider),
  );
  await runDeferred(ctx);
  return { res, ctx };
}

/** The provider's callback path. */
const callback = (h: Harness) => `/auth/callback/${h.provider.id}`;

/** POST a send for `email` (plus extra fields). */
const send = (h: Harness, email: string, extra: Record<string, string> = {}, init: CallInit = {}) =>
  call(h, "POST", callback(h), { ...init, body: { email, ...extra } });

/** Open the magic link from the `i`-th mail. */
function click(h: Harness, i = 0) {
  const link = new URL(h.sent[i].url);
  return call(h, "GET", link.pathname + link.search);
}

/** POST a code for `email`. */
const submitCode = (h: Harness, email: string, code: string, init: CallInit = {}) =>
  call(h, "POST", callback(h), { ...init, body: { email, code } });

/** A code guaranteed to differ from `code`. */
const wrongCode = (code: string) => code === "000000" ? "111111" : "000000";

/** The session a response issued, read back through its cookie — or `null`. */
async function sessionOf(h: Harness, ctx: RequestContext): Promise<AuthSession | null> {
  const cookie = ctx.outgoingHeaders.getSetCookie()
    .find((c) => c.startsWith("__Host-denext_auth="))
    ?.split(";")[0];
  if (!cookie) return null;
  const request = new Request(`${ORIGIN}/`, { headers: { cookie } });
  return await runWithContext(createRequestContext(request), () => readAuthSession(h.config));
}

/** A 303's target, resolved against the app origin. */
function location(res: Response): URL {
  assertEquals(res.status, 303);
  return new URL(res.headers.get("location")!, ORIGIN);
}

/** Everything a client can see of an answer. */
async function visible(res: Response): Promise<[number, string | null, string]> {
  return [res.status, res.headers.get("location"), await res.text()];
}

// ---- providers + config ------------------------------------------------------

Deno.test("magicLink / emailOtp: defaults and overrides; GET /providers echoes { id, name, type }", async () => {
  assertEquals(magicLink(), {
    id: "email",
    name: "Email",
    type: "email",
    mode: "magic",
    allowSignUp: true,
  });
  const overrides: EmailProviderOptions = { id: "code", name: "Code", allowSignUp: false };
  assertEquals(emailOtp(overrides), {
    id: "code",
    name: "Code",
    type: "email",
    mode: "otp",
    allowSignUp: false,
  });
  assert(isEmailProvider(emailOtp()) && !isEmailProvider(credentials()));

  const config: AuthConfig = {
    secret: SECRET,
    providers: [magicLink(), emailOtp(), credentials()],
  };
  const url = new URL(`${ORIGIN}/auth/providers`);
  const res = handleProviders({
    request: new Request(url),
    config,
    options: resolveAuthOptions(config),
    url,
    method: "GET",
    params: {},
  });
  assertEquals(await res.json(), [
    { id: "email", name: "Email", type: "email" },
    { id: "email-otp", name: "Email code", type: "email" },
    { id: "credentials", type: "credentials" },
  ]);
});

Deno.test("denextAuth: an email provider without a mailer is refused at construction", () => {
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    providers: [magicLink()],
    adapter: inMemoryAuthAdapter(),
  };
  assertThrows(() => denextAuth(config), Error, "sendVerificationRequest");
  const plugin = denextAuth({ ...config, sendVerificationRequest: () => {} });
  assertEquals(plugin.name, "denext-auth");
});

Deno.test("assertEmailProviderConfig: refuses an email provider without a mailer or the adapter groups", () => {
  const ok: AuthConfig = {
    secret: SECRET,
    providers: [emailOtp()],
    adapter: inMemoryAuthAdapter(),
    sendVerificationRequest: () => {},
  };
  assertEmailProviderConfig(ok);
  assertEmailProviderConfig({
    secret: SECRET,
    providers: [credentials({ authorize: () => null })],
  });

  assertThrows(
    () => assertEmailProviderConfig({ ...ok, sendVerificationRequest: undefined }),
    Error,
    "sendVerificationRequest",
  );
  assertThrows(
    () => assertEmailProviderConfig({ ...ok, adapter: undefined }),
    Error,
    "none is configured",
  );
  const { createVerificationToken: _c, useVerificationToken: _u, ...tokenless } =
    inMemoryAuthAdapter();
  assertThrows(
    () => assertEmailProviderConfig({ ...ok, adapter: tokenless as AuthAdapter }),
    Error,
    "createVerificationToken / useVerificationToken",
  );
  const { createUser: _n, ...noSignUp } = inMemoryAuthAdapter();
  assertThrows(
    () => assertEmailProviderConfig({ ...ok, adapter: noSignUp as AuthAdapter }),
    Error,
    "createUser",
  );
});

// ---- send --------------------------------------------------------------------

Deno.test("a list of addresses sends nothing and is answered exactly like a real send", async () => {
  const h = setup(magicLink());
  await h.adapter.createUser({ email: "a@x.test", emailVerified: 1 });
  const real = await visible((await send(h, "a@x.test")).res);
  assertEquals(real, [200, null, JSON.stringify({ ok: true })]);
  const realForm = await visible((await send(h, "a@x.test", {}, { form: true })).res);
  assertEquals(realForm, [303, "/check-email?sent=1", ""]);

  for (const list of ["a@x.test,b@y.test", "a@x.test; b@y.test", "a@x.test b@y.test"]) {
    assertEquals(await visible((await send(h, list)).res), real, list);
    assertEquals(await visible((await send(h, list, {}, { form: true })).res), realForm, list);
  }
  assertEquals(h.sent.map((m) => m.identifier), ["a@x.test", "a@x.test"], "only the real sends");
});

Deno.test("allowSignUp: false — an unknown address gets no mail and exactly the answer a known one gets", async () => {
  const h = setup(magicLink({ allowSignUp: false }));
  await h.adapter.createUser({ email: "member@x.test", emailVerified: 1 });
  const known = await visible((await send(h, "member@x.test")).res);
  assertEquals(await visible((await send(h, "stranger@x.test")).res), known);
  const knownForm = await visible((await send(h, "member@x.test", {}, { form: true })).res);
  assertEquals(
    await visible((await send(h, "stranger@x.test", {}, { form: true })).res),
    knownForm,
  );
  assertEquals(h.sent.map((m) => m.identifier), ["member@x.test", "member@x.test"]);
  assertEquals(await h.adapter.getUserByEmail("stranger@x.test"), undefined);
});

Deno.test("the send budget: the 4th send for one address is the same 429 whether or not it exists", async () => {
  const h = setup(emailOtp({ allowSignUp: false }));
  await h.adapter.createUser({ email: "real@x.test", emailVerified: 1 });
  const run = async (email: string, peer: string) => {
    const out: [number, string | null, string][] = [];
    for (let i = 0; i < 4; i++) out.push(await visible((await send(h, email, {}, { peer })).res));
    return out;
  };
  const known = await run("real@x.test", "203.0.113.7");
  assertEquals(known.map(([status]) => status), [200, 200, 200, 429]);
  assertEquals(await run("ghost@x.test", "203.0.113.8"), known);
  assertEquals(h.sent.length, 3, "only the real address was mailed");
});

// ---- magic links -----------------------------------------------------------

Deno.test("magic link: the emailed link signs in once and lands on callbackUrl; a replay is ?error=Verification", async () => {
  const h = setup(magicLink());
  const user = await h.adapter.createUser({ email: "ada@x.test", emailVerified: 1 });
  await send(h, "Ada@X.test", { callbackUrl: "/dash" });
  assertEquals(h.sent.length, 1);
  const mail = h.sent[0];
  assertEquals(mail.purpose, "magic");
  const link = new URL(mail.url);
  assertEquals(link.origin + link.pathname, `${ORIGIN}/auth/callback/email`);
  assertEquals(link.searchParams.get("token"), mail.token);
  assertEquals(link.searchParams.get("email"), "ada@x.test");
  assertEquals(link.searchParams.get("callbackUrl"), "/dash");
  assertEquals(h.stored[0].tokenHash, await sha256Hex(mail.token), "stored as its SHA-256 only");

  const first = await click(h);
  assertEquals(location(first.res).pathname, "/dash");
  const session = await sessionOf(h, first.ctx);
  assertEquals([session?.user.id, session?.provider, session?.amr], [user.id, "email", ["email"]]);
  assertEquals(h.events, ["signIn"]);

  const replay = await click(h);
  const refused = location(replay.res);
  assertEquals(refused.pathname + refused.search, "/oops?error=Verification");
  assertEquals(await sessionOf(h, replay.ctx), null);
});

Deno.test("magic link: dead after email.magicMaxAge (10 minutes)", async () => {
  let clock = Math.floor(Date.now() / 1000);
  const h = setup(magicLink(), {}, inMemoryAuthAdapter({ now: () => clock }));
  await send(h, "late@x.test");
  const life = h.stored[0].expires - Math.floor(Date.now() / 1000);
  assert(life >= 599 && life <= 600, `lives 10 minutes (got ${life}s)`);
  clock += 601;
  assertEquals(location((await click(h)).res).searchParams.get("error"), "Verification");
  assertEquals(
    await h.adapter.getUserByEmail("late@x.test"),
    undefined,
    "no user from a dead link",
  );
});

Deno.test("magic link: a JS client may redeem by POST; cross-origin POSTs and a code provider's GET are refused", async () => {
  const h = setup(magicLink());
  await send(h, "js@x.test");
  const { res, ctx } = await call(h, "POST", callback(h), {
    body: { email: "js@x.test", token: h.sent[0].token },
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals([body.ok, body.user.email], [true, "js@x.test"]);
  assert(await sessionOf(h, ctx));

  assertEquals((await send(h, "js@x.test", {}, { origin: "https://evil.test" })).res.status, 403);
  const otp = setup(emailOtp());
  const get = await call(otp, "GET", `${callback(otp)}?email=a%40x.test&token=123456`);
  assertEquals(get.res.status, 405);
  assert(emailCallbacks.GET === handleEmailRedeem && emailCallbacks.POST === handleEmailRequest);
});

// ---- one-time codes ----------------------------------------------------------

Deno.test("one-time code: mailed as `token` (never in `url`); a right code works after a wrong one", async () => {
  const h = setup(emailOtp());
  const user = await h.adapter.createUser({ email: "otp@x.test", emailVerified: 1 });
  await send(h, "otp@x.test");
  const mail = h.sent[0];
  assertEquals(mail.purpose, "otp");
  assertMatch(mail.token, /^\d{6}$/);
  assertEquals(mail.url, `${ORIGIN}/check-email?email=otp%40x.test`);

  const miss = await submitCode(h, "otp@x.test", wrongCode(mail.token));
  assertEquals([miss.res.status, await miss.res.json()], [401, { error: "invalid code" }]);
  const grouped = `${mail.token.slice(0, 3)} ${mail.token.slice(3)}`;
  const hit = await submitCode(h, "otp@x.test", grouped);
  assertEquals(hit.res.status, 200);
  const session = await sessionOf(h, hit.ctx);
  assertEquals([session?.user.id, session?.provider, session?.amr], [user.id, "email-otp", [
    "otp",
  ]]);
  assertEquals(h.events, ["signInFailed:invalid_credentials", "signIn"]);
});

Deno.test("one-time code: stored keyed (HMAC under the secret) — not a bare SHA-256, dead under another secret", async () => {
  const h = setup(emailOtp({ allowSignUp: true }), { email: { otpDigits: 8 } });
  await send(h, "keyed@x.test");
  const code = h.sent[0].token;
  assertMatch(code, /^\d{8}$/);
  const [record] = h.stored;
  assertEquals(record.purpose, "otp");
  assertMatch(record.tokenHash, /^[0-9a-f]{64}$/);
  assertNotEquals(record.tokenHash, await sha256Hex(code));
  assertNotEquals(record.tokenHash, await sha256Hex(`otp\0keyed@x.test\0${code}`));

  const other: AuthConfig = { ...h.config, secret: "another-secret-value-at-least-32-chars" };
  const redeem = (config: AuthConfig) =>
    redeemVerificationCode(config, { identifier: "keyed@x.test", purpose: "otp", token: code });
  assertEquals(await redeem(other), null, "the same code under another secret matches nothing");
  assertEquals((await redeem(h.config))?.identifier, "keyed@x.test", "and did not burn it");
});

Deno.test("one-time code: every wrong code is the same 401 and counts; the 6th attempt is a 429", async () => {
  const h = setup(emailOtp());
  await send(h, "brute@x.test");
  const code = h.sent[0].token;
  const answers: string[] = [];
  for (let i = 0; i < 5; i++) {
    const { res } = await submitCode(h, "brute@x.test", wrongCode(code));
    answers.push(`${res.status} ${await res.text()}`);
  }
  assertEquals(new Set(answers).size, 1);
  assertEquals(answers[0], `401 ${JSON.stringify({ error: "invalid code" })}`);

  const locked = await submitCode(h, "brute@x.test", code);
  assertEquals(locked.res.status, 429);
  assert(Number(locked.res.headers.get("retry-after")) > 0);
  assertEquals(await sessionOf(h, locked.ctx), null, "not even the right code gets through");
  const elsewhere = await submitCode(h, "brute@x.test", code, { peer: "198.51.100.4" });
  assertEquals(elsewhere.res.status, 429, "the budget is per address, not only per IP");
  assertEquals(h.events.filter((e) => e === "signInFailed:invalid_credentials").length, 5);

  const form = setup(emailOtp());
  await send(form, "form@x.test");
  const refused = location((await submitCode(form, "form@x.test", "", { form: true })).res);
  assertEquals(refused.pathname + refused.search, "/oops?error=Verification");
});

Deno.test("one-time code: dead after email.otpMaxAge (5 minutes)", async () => {
  let clock = Math.floor(Date.now() / 1000);
  const h = setup(emailOtp(), {}, inMemoryAuthAdapter({ now: () => clock }));
  await send(h, "slow@x.test");
  const life = h.stored[0].expires - Math.floor(Date.now() / 1000);
  assert(life >= 299 && life <= 300, `lives 5 minutes (got ${life}s)`);
  clock += 301;
  assertEquals((await submitCode(h, "slow@x.test", h.sent[0].token)).res.status, 401);
});

// ---- who signs in ----------------------------------------------------------

Deno.test("an unknown address signs up on redeem: a verified user, createUser, isNewUser", async () => {
  const h = setup(magicLink());
  await send(h, "new@x.test");
  assertEquals(await h.adapter.getUserByEmail("new@x.test"), undefined, "a send creates nothing");
  const { res, ctx } = await click(h);
  assertEquals(location(res).pathname, "/home");
  const created = await h.adapter.getUserByEmail("new@x.test");
  assertEquals(typeof created?.emailVerified, "number");
  assertEquals((await sessionOf(h, ctx))?.user.id, created?.id);
  assertEquals(h.events, ["createUser", "signIn"]);
  assertEquals(h.newUser, [true]);
  assertEquals(await h.adapter.listAccounts!(created!.id), [], "the address is the identity");
});

Deno.test("an existing unverified user: redeeming marks the address verified", async () => {
  const h = setup(emailOtp());
  const user = await h.adapter.createUser({ email: "unverified@x.test" });
  await send(h, "unverified@x.test");
  const { res, ctx } = await submitCode(h, "unverified@x.test", h.sent[0].token);
  assertEquals(res.status, 200);
  assertEquals(typeof (await h.adapter.getUser(user.id))?.emailVerified, "number");
  assertEquals((await sessionOf(h, ctx))?.user.emailVerified, true);
  assertEquals(h.events, ["emailVerified", "signIn"]);
  assertEquals(h.newUser, [false]);
});

Deno.test("an MFA-enrolled user: a pending session, mfa required (JSON) / pages.mfa (link), no signIn yet", async () => {
  const enrolled = async (provider: EmailProvider) => {
    const h = setup(provider);
    const user = await h.adapter.createUser({ email: "mfa@x.test", emailVerified: 1 });
    await h.adapter.setMfa!({
      userId: user.id,
      secret: "JBSWY3DPEHPK3PXP",
      confirmedAt: 1,
      backupCodeHashes: [],
    });
    await send(h, "mfa@x.test");
    return h;
  };

  const otp = await enrolled(emailOtp());
  const coded = await submitCode(otp, "mfa@x.test", otp.sent[0].token);
  assertEquals(await coded.res.json(), { ok: true, mfa: "required" });
  assertEquals((await sessionOf(otp, coded.ctx))?.mfaPending, true);
  assertEquals(otp.events, []);

  const magic = await enrolled(magicLink());
  const clicked = await click(magic);
  const step = location(clicked.res);
  assertEquals([step.pathname, step.searchParams.get("callbackUrl")], ["/mfa", "/home"]);
  assertEquals((await sessionOf(magic, clicked.ctx))?.mfaPending, true);
  assertEquals(magic.events, []);
});

Deno.test("callbacks.signIn returning false refuses the sign-in: no session", async () => {
  const deny = { callbacks: { signIn: () => false } };
  const h = setup(magicLink(), deny);
  await send(h, "deny@x.test");
  const { res, ctx } = await click(h);
  const to = location(res);
  assertEquals(to.pathname + to.search, "/oops?error=AccessDenied");
  assertEquals(await sessionOf(h, ctx), null);
  assertEquals(h.events, ["createUser", "signInFailed:access_denied"]);

  const otp = setup(emailOtp(), deny);
  await send(otp, "deny@x.test");
  const coded = await submitCode(otp, "deny@x.test", otp.sent[0].token);
  assertEquals([coded.res.status, await coded.res.json()], [403, { error: "access denied" }]);
  assertEquals(await sessionOf(otp, coded.ctx), null);
});

// ---- pre-account hijacking -------------------------------------------------------

const ATTACKER_PASSWORD = "attacker-chosen-password";
const OWNER_PASSWORD = "owner-chosen-password";

/** A credentials POST through the built-in adapter-backed check. */
const passwordSignIn = (h: Harness, email: string, password: string) =>
  call(h, "POST", "/auth/callback/credentials", {
    body: { email, password },
    via: (route) => handleCredentials(route, credentials()),
  });

/** An adapter user for `email` with `password` on file (`emailVerified` as given). */
async function withPassword(
  h: Harness,
  email: string,
  password: string,
  emailVerified?: number,
): Promise<string> {
  const user = await h.adapter.createUser({ email, emailVerified });
  const hash = await resolveAuthOptions(h.config).hasher.hash(password);
  await h.adapter.setCredential!(user.id, hash);
  return user.id;
}

Deno.test("pre-account hijacking: a first email sign-in retires the unverified account's password, tokens and sessions", async () => {
  const h = setup(magicLink(), { session: { strategy: "database" } });
  const id = await withPassword(h, "victim@x.test", ATTACKER_PASSWORD);
  const attacker = await passwordSignIn(h, "victim@x.test", ATTACKER_PASSWORD);
  assertEquals(attacker.res.status, 200, "the password works while the address is unproven");
  const sid = (await sessionOf(h, attacker.ctx))?.sessionId;
  assert(sid, "a store-backed session");
  await issueApiToken(h.config, { userId: id, name: "persistence" });

  await send(h, "victim@x.test");
  const victim = await click(h);
  assertEquals(location(victim.res).pathname, "/home");
  assertEquals((await sessionOf(h, victim.ctx))?.user.id, id, "the mailbox owner is signed in");
  assertEquals(typeof (await h.adapter.getUser(id))?.emailVerified, "number");
  assertEquals(await h.adapter.sessions!.get(sid), undefined, "the attacker's session is revoked");
  assertEquals(await h.adapter.listApiTokens!(id), [], "and their bearer token");

  const refused = await passwordSignIn(h, "victim@x.test", ATTACKER_PASSWORD);
  assertEquals([refused.res.status, await refused.res.json()], [401, {
    error: "invalid credentials",
  }]);
  assertEquals(await sessionOf(h, refused.ctx), null);
  assertEquals(h.events.slice(1), ["emailVerified", "signIn", "signInFailed:invalid_credentials"]);
});

Deno.test("an already-verified account keeps its password and its sessions through an email sign-in", async () => {
  const h = setup(emailOtp(), { session: { strategy: "database" } });
  await withPassword(h, "owner@x.test", OWNER_PASSWORD, 1);
  const before = await passwordSignIn(h, "owner@x.test", OWNER_PASSWORD);
  const sid = (await sessionOf(h, before.ctx))?.sessionId;
  assert(sid);

  await send(h, "owner@x.test");
  assertEquals((await submitCode(h, "owner@x.test", h.sent[0].token)).res.status, 200);
  assert(await h.adapter.sessions!.get(sid), "the earlier session survives");
  assertEquals((await passwordSignIn(h, "owner@x.test", OWNER_PASSWORD)).res.status, 200);
  assert(!h.events.includes("emailVerified"));
});

Deno.test("an adapter that can read a password but not replace it fails the first email sign-in closed", async () => {
  const base = inMemoryAuthAdapter();
  const errors: string[] = [];
  const h = setup(emailOtp(), { logger: { error: (message) => void errors.push(message) } }, {
    ...base,
    setCredential: undefined,
  });
  const user = await base.createUser({ email: "stuck@x.test" });
  await base.setCredential!(user.id, "scrypt$anything");
  await send(h, "stuck@x.test");
  const { res, ctx } = await submitCode(h, "stuck@x.test", h.sent[0].token);
  assertEquals([res.status, await res.json()], [401, { error: "invalid code" }]);
  assertEquals(await sessionOf(h, ctx), null);
  assertEquals((await h.adapter.getUser(user.id))?.emailVerified, undefined, "still unverified");
  assertEquals(h.events, ["signInFailed:adapter_error"]);
  assertEquals(errors.length, 1);
});
