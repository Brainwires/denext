// TOTP second factor: enrolment + confirmation (backup codes minted once, stored hashed),
// the pending session every first-factor tail mints for an enrolled user (credentials and
// the OAuth tail), the `/mfa` step-up (a FRESH session — new id, old store record gone,
// amr extended, `signIn` fired once), the replay guard, single-use backup codes, the
// per-user attempt budget, `/mfa/disable`'s pending refusal + fresh-factor rule,
// `mfa.required: "always"` enrolment during the step-up, the no-adapter 404, and
// `pendingMfaSession()`.

import { assert, assertEquals, assertMatch, assertNotEquals, assertRejects } from "@std/assert";
import { decodeBase32 } from "@std/encoding/base32";
import type { AuthAdapter } from "../src/server/auth/adapter.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import {
  confirmTotp,
  enrollTotp,
  hasFreshFactor,
  mfaPendingFor,
  mfaStatus,
} from "../src/server/auth/mfa.ts";
import { auth, denextAuth, pendingMfaSession } from "../src/server/auth/mod.ts";
import { resolveAuthOptions } from "../src/server/auth/options.ts";
import { hashPassword } from "../src/server/auth/password.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { mfaRoutes } from "../src/server/auth/routes-mfa.ts";
import type { AuthRouteContext } from "../src/server/auth/routes-shared.ts";
import { readAuthSession } from "../src/server/auth/session.ts";
import { inMemorySessionStore, type SessionStore } from "../src/server/auth/session-store.ts";
import { finishSignIn } from "../src/server/auth/sign-in-tail.ts";
import type { AuthConfig, AuthSession } from "../src/server/auth/types.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const EMAIL = "grace@x.test";
const PASSWORD = "hunter2";
const SESSION_COOKIE = "__Host-denext_auth=";

// ---- harness -------------------------------------------------------------------

/** One app: an adapter holding one password user, a session store, recorded events. */
interface Harness {
  config: AuthConfig;
  adapter: AuthAdapter;
  store: SessionStore;
  userId: string;
  /** `signIn`, and `failed:<reason>` for each `signInFailed`, in order. */
  events: string[];
}

/** Build a store-backed app. `window: 2` keeps codes valid across a step boundary. */
async function setup(
  overrides: Partial<AuthConfig> = {},
  adapter: AuthAdapter = inMemoryAuthAdapter(),
): Promise<Harness> {
  const user = await adapter.createUser({ email: EMAIL, name: "Grace" });
  await adapter.setCredential!(user.id, await hashPassword(PASSWORD));
  const store = inMemorySessionStore();
  const events: string[] = [];
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    trustForwardedHeaders: false,
    providers: [{ id: "credentials", type: "credentials" }],
    adapter,
    sessionStore: store,
    mfa: { window: 2, backupCodes: 2 },
    pages: { signIn: "/login", mfa: "/login/2fa" },
    events: {
      signIn: () => void events.push("signIn"),
      signInFailed: ({ reason }) => void events.push(`failed:${reason}`),
    },
    ...overrides,
  };
  return { config, adapter, store, userId: user.id, events };
}

/** The TOTP code for `step` (RFC 6238, SHA-1, 6 digits), computed independently. */
async function totpAt(secret: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(decodeBase32(secret)),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = new DataView(new ArrayBuffer(8));
  counter.setBigUint64(0, BigInt(step));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter.buffer));
  const at = mac[mac.length - 1] & 15;
  const bin = ((mac[at] & 0x7f) << 24 | mac[at + 1] << 16 | mac[at + 2] << 8 | mac[at + 3]) >>> 0;
  return String(bin % 1_000_000).padStart(6, "0");
}

/** The current 30-second TOTP step. */
const nowStep = (): number => Math.floor(Date.now() / 30_000);

/** How a test request is sent. */
interface Send {
  /** The `name=value` session cookie to present. */
  cookie?: string;
  /** Body fields. */
  body?: Record<string, string>;
  /** Post as a plain HTML form (and expect a redirect) instead of a JSON client. */
  form?: boolean;
  /** Extra request headers (they win over the defaults). */
  headers?: Record<string, string>;
}

/** What came back: the response (null = fell through) and the session cookie it set. */
interface Sent {
  res: Response | null;
  cookie?: string;
}

/** The route context a handler receives, built for `request`. */
function routeContext(request: Request, config: AuthConfig): AuthRouteContext {
  const url = new URL(request.url);
  const options = resolveAuthOptions(config);
  return { request, config, options, url, method: request.method, params: {} };
}

/**
 * POST `{basePath}<path>`: an MFA row is called straight from `mfaRoutes` (the route table
 * splices them in later); anything else goes through the dispatcher.
 */
async function post(config: AuthConfig, path: string, send: Send = {}): Promise<Sent> {
  const headers = new Headers(
    send.form
      ? { "content-type": "application/x-www-form-urlencoded" }
      : { "content-type": "application/json", accept: "application/json" },
  );
  headers.set("origin", ORIGIN);
  if (send.cookie) headers.set("cookie", send.cookie);
  for (const [name, value] of Object.entries(send.headers ?? {})) headers.set(name, value);
  const fields = send.body ?? {};
  const request = new Request(`${ORIGIN}/auth${path}`, {
    method: "POST",
    headers,
    body: send.form ? new URLSearchParams(fields).toString() : JSON.stringify(fields),
  });
  const ctx = createRequestContext(request);
  const row = mfaRoutes.find((route) => route.pattern === path);
  const res = await runWithContext(
    ctx,
    () => row ? row.handler(routeContext(request, config)) : handleAuthRequest(request, config),
  );
  const cookie = ctx.outgoingHeaders.getSetCookie()
    .find((c) => c.startsWith(SESSION_COOKIE))?.split(";")[0];
  return { res, cookie };
}

/** Read the session a cookie carries (null when absent/expired/revoked). */
function readSession(config: AuthConfig, cookie: string | undefined): Promise<AuthSession | null> {
  const request = new Request(`${ORIGIN}/`, { headers: cookie ? { cookie } : {} });
  return runWithContext(createRequestContext(request), () => readAuthSession(config));
}

/** Sign in with the password; returns the answer and the session cookie. */
function passwordSignIn(h: Harness, form = false): Promise<Sent> {
  return post(h.config, "/callback/credentials", {
    body: { email: EMAIL, password: PASSWORD },
    form,
  });
}

/** Sign in an enrolled user: asserts the pending answer, returns the pending cookie. */
async function pendingSignIn(h: Harness): Promise<string> {
  const { res, cookie } = await passwordSignIn(h);
  assertEquals(await res!.json(), { ok: true, mfa: "required" });
  assert(cookie, "a pending session cookie was issued");
  return cookie;
}

/** A complete session that signed in just now — what enrollTotp()'s recent-sign-in rule wants. */
function freshSession(user: AuthSession["user"]): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  return { user, provider: "credentials", expiresAt: now + 3600, authTime: now };
}

/** Enrol + confirm the harness user (the confirm spends the step before now). */
async function enrol(h: Harness): Promise<{ secret: string; backupCodes: string[] }> {
  const user = { id: h.userId, email: EMAIL };
  const enrolment = await enrollTotp(h.config, freshSession(user));
  assert(enrolment.ok, "enrolment started");
  const confirmed = await confirmTotp(h.config, {
    user,
    code: await totpAt(enrolment.secret, nowStep() - 1),
  });
  assert(confirmed.ok, "enrolment confirmed");
  return { secret: enrolment.secret, backupCodes: confirmed.backupCodes };
}

// ---- enrolment -----------------------------------------------------------------

Deno.test("enrollTotp → confirmTotp: confirmedAt flips, N backup codes come back once, stored hashed", async () => {
  const h = await setup({ mfa: { window: 2, backupCodes: 3 } });
  const user = { id: h.userId, email: EMAIL };
  const enrolment = await enrollTotp(h.config, freshSession(user));
  assert(enrolment.ok);
  assertMatch(enrolment.uri, /^otpauth:\/\/totp\/app\.test:grace%40x\.test\?secret=[A-Z2-7]{32}&/);
  assertEquals(await mfaStatus(h.config, h.userId), {
    enrolled: false,
    pendingConfirmation: true,
    backupCodesRemaining: 0,
  });
  assertEquals((await h.adapter.getMfa!(h.userId))?.confirmedAt, undefined);

  const result = await confirmTotp(h.config, {
    user,
    code: await totpAt(enrolment.secret, nowStep()),
  });
  assert(result.ok);
  assertEquals(result.backupCodes.length, 3);
  const record = (await h.adapter.getMfa!(h.userId))!;
  assertEquals(typeof record.confirmedAt, "number");
  assertEquals(record.backupCodeHashes.length, 3);
  for (const code of result.backupCodes) {
    assert(!record.backupCodeHashes.some((hash) => hash.includes(code.replace("-", ""))));
  }
  assertEquals((await mfaStatus(h.config, h.userId)).backupCodesRemaining, 3);
  assertEquals(
    await enrollTotp(h.config, freshSession(user)),
    { ok: false, error: "already_enrolled" },
    "a confirmed factor is not replaced",
  );
  assertEquals(
    await confirmTotp(h.config, { user, code: "123456" }),
    { ok: false, error: "not_pending" },
    "no second confirm",
  );
});

Deno.test("confirmTotp: a wrong code is refused and the enrolment stays unconfirmed", async () => {
  const h = await setup();
  const user = { id: h.userId, email: EMAIL };
  const enrolment = await enrollTotp(h.config, freshSession(user));
  assert(enrolment.ok);
  const wrong = await totpAt(enrolment.secret, nowStep() + 10);
  assertEquals(await confirmTotp(h.config, { user, code: wrong }), {
    ok: false,
    error: "invalid_code",
  });
  assertEquals((await h.adapter.getMfa!(h.userId))?.confirmedAt, undefined);
  assertEquals((await mfaStatus(h.config, h.userId)).enrolled, false);
  assertEquals(await mfaPendingFor(resolveAuthOptions(h.config), user), false);
});

// ---- the pending session ---------------------------------------------------------

Deno.test("credentials sign-in of an enrolled user: a short-lived pending session, no signIn event", async () => {
  const h = await setup();
  await enrol(h);
  const cookie = await pendingSignIn(h);
  const session = (await readSession(h.config, cookie))!;
  assertEquals(session.mfaPending, true);
  assertEquals(session.amr, ["pwd"]);
  assertEquals(session.expiresAt - session.issuedAt!, 15 * 60, "pending lives 15 minutes");
  assertEquals(h.events, [], "signIn waits for the second factor");

  const form = await passwordSignIn(h, true);
  assertEquals(form.res!.status, 303);
  assertEquals(form.res!.headers.get("location"), "/login/2fa?callbackUrl=%2F");
});

Deno.test("the OAuth tail (finishSignIn, amr ext) leaves an enrolled user pending too", async () => {
  const h = await setup();
  await enrol(h);
  const request = new Request(`${ORIGIN}/auth/callback/google?code=x&state=y`);
  const reqCtx = createRequestContext(request);
  const res = await runWithContext(
    reqCtx,
    () =>
      finishSignIn(routeContext(request, h.config), { id: h.userId, email: EMAIL }, "google", {
        amr: ["ext"],
        returnTo: "/dash",
        json: false,
      }),
  );
  assertEquals(res.status, 303);
  assertEquals(res.headers.get("location"), "/login/2fa?callbackUrl=%2Fdash");
  const cookie = reqCtx.outgoingHeaders.getSetCookie()[0].split(";")[0];
  const session = (await readSession(h.config, cookie))!;
  assertEquals([session.mfaPending, session.provider, session.amr], [true, "google", ["ext"]]);
  assertEquals(h.events, []);
});

// ---- the step-up -----------------------------------------------------------------

Deno.test("POST /mfa with a valid TOTP mints a FRESH session: new id, old record gone, amr extended, signIn once", async () => {
  const h = await setup();
  const { secret } = await enrol(h);
  const pending = await pendingSignIn(h);
  const oldSid = (await readSession(h.config, pending))!.sessionId!;

  const { res, cookie } = await post(h.config, "/mfa", {
    cookie: pending,
    body: { code: await totpAt(secret, nowStep()) },
  });
  assertEquals(res!.status, 200);
  assertEquals((await res!.json()).user.id, h.userId);
  const fresh = (await readSession(h.config, cookie))!;
  assertNotEquals(fresh.sessionId, oldSid);
  assertEquals(fresh.mfaPending, undefined);
  assertEquals(fresh.amr, ["pwd", "totp"]);
  assert(fresh.expiresAt - fresh.issuedAt! > 15 * 60, "a complete session gets the full maxAge");
  assertEquals(await h.store.get(oldSid), undefined, "the pending record was deleted");
  assertEquals(await readSession(h.config, pending), null, "the pending cookie is dead");
  assertEquals(h.events, ["signIn"]);
});

Deno.test("POST /mfa: the same TOTP step can't be presented twice", async () => {
  const h = await setup();
  const { secret } = await enrol(h);
  const code = await totpAt(secret, nowStep());
  const first = await post(h.config, "/mfa", { cookie: await pendingSignIn(h), body: { code } });
  assertEquals(first.res!.status, 200);

  const second = await pendingSignIn(h);
  const replay = await post(h.config, "/mfa", { cookie: second, body: { code } });
  assertEquals(replay.res!.status, 401);
  assertEquals(await replay.res!.json(), { error: "invalid code" });
  assertEquals(replay.cookie, undefined, "no session was minted");
  assertEquals((await readSession(h.config, second))?.mfaPending, true);
  assertEquals(h.events, ["signIn", "failed:invalid_mfa_code"]);
});

Deno.test("POST /mfa: a backup code completes the step-up once, then it is spent", async () => {
  const h = await setup();
  const { backupCodes } = await enrol(h);
  const code = backupCodes[0].toUpperCase();
  const used = await post(h.config, "/mfa", { cookie: await pendingSignIn(h), body: { code } });
  assertEquals(used.res!.status, 200);
  assertEquals((await readSession(h.config, used.cookie))?.amr, ["pwd", "bcp"]);
  assertEquals((await mfaStatus(h.config, h.userId)).backupCodesRemaining, 1);

  const again = await post(h.config, "/mfa", { cookie: await pendingSignIn(h), body: { code } });
  assertEquals(again.res!.status, 401);
});

Deno.test("POST /mfa: every attempt spends the per-user budget — the 6th in 5 minutes is a 429", async () => {
  const h = await setup();
  const { secret } = await enrol(h);
  const pending = await pendingSignIn(h);
  const wrong = await totpAt(secret, nowStep() + 10);
  for (let i = 0; i < 5; i++) {
    const { res } = await post(h.config, "/mfa", { cookie: pending, body: { code: wrong } });
    assertEquals(res!.status, 401);
  }
  const right = await totpAt(secret, nowStep());
  const { res } = await post(h.config, "/mfa", { cookie: pending, body: { code: right } });
  assertEquals(res!.status, 429, "even a right code waits out the window");
  assert(Number(res!.headers.get("retry-after")) > 0);
  assertEquals(h.events.at(-1), "failed:rate_limited");
});

Deno.test("POST /mfa as a form: a wrong code goes back to pages.mfa with ?error, a right one to callbackUrl", async () => {
  const h = await setup();
  const { secret } = await enrol(h);
  const pending = await pendingSignIn(h);
  const wrong = await post(h.config, "/mfa", {
    cookie: pending,
    form: true,
    body: { code: "000000x", callbackUrl: "/dash" },
  });
  assertEquals(wrong.res!.status, 303);
  assertEquals(
    wrong.res!.headers.get("location"),
    "/login/2fa?error=CredentialsSignin&callbackUrl=%2Fdash",
  );
  const right = await post(h.config, "/mfa", {
    cookie: pending,
    form: true,
    body: { code: await totpAt(secret, nowStep()), callbackUrl: "https://evil.test/steal" },
  });
  assertEquals(right.res!.status, 303);
  assertEquals(right.res!.headers.get("location"), "/", "a foreign callbackUrl is coerced");
});

Deno.test("POST /mfa refuses a complete session, a cross-origin post, and a bearer header without a cookie", async () => {
  const h = await setup();
  const complete = await passwordSignIn(h); // not enrolled → a complete session
  assertEquals((await complete.res!.json()).user.id, h.userId);
  const again = await post(h.config, "/mfa", { cookie: complete.cookie, body: { code: "123456" } });
  assertEquals(again.res!.status, 403, "no double step-up");

  const crossSite = await post(h.config, "/mfa", {
    cookie: complete.cookie,
    headers: { origin: "https://evil.test" },
  });
  assertEquals(crossSite.res!.status, 403);

  const bearer = await post(h.config, "/mfa", {
    headers: { authorization: "Bearer dnx_anything" },
    body: { code: "123456" },
  });
  assertEquals(bearer.res!.status, 401, "the Authorization header is never read");
});

// ---- disable -------------------------------------------------------------------

Deno.test("POST /mfa/disable from a pending session is 403 and never calls setMfa", async () => {
  const h = await setup();
  const { secret } = await enrol(h);
  const pending = await pendingSignIn(h);
  let writes = 0;
  const setMfa = h.adapter.setMfa!.bind(h.adapter);
  h.adapter.setMfa = (record) => {
    writes++;
    return setMfa(record);
  };
  const { res } = await post(h.config, "/mfa/disable", {
    cookie: pending,
    body: { code: await totpAt(secret, nowStep()) },
  });
  assertEquals(res!.status, 403);
  assertEquals(writes, 0);
  const enrolAttempt = await post(h.config, "/mfa/enroll", { cookie: pending });
  assertEquals(enrolAttempt.res!.status, 403, "a pending session enrols only under 'always'");
  assertEquals(writes, 0);
  assertEquals((await mfaStatus(h.config, h.userId)).enrolled, true);
});

Deno.test("POST /mfa/disable needs a fresh factor: refused without one, accepted with a valid code", async () => {
  const h = await setup();
  const { cookie } = await passwordSignIn(h); // amr ["pwd"], signed in before enrolling
  const { secret } = await enrol(h);
  const bare = await post(h.config, "/mfa/disable", { cookie });
  assertEquals(bare.res!.status, 403);
  const wrong = await post(h.config, "/mfa/disable", {
    cookie,
    body: { code: await totpAt(secret, nowStep() + 10) },
  });
  assertEquals(wrong.res!.status, 403);
  assertEquals((await mfaStatus(h.config, h.userId)).enrolled, true);

  const ok = await post(h.config, "/mfa/disable", {
    cookie,
    body: { code: await totpAt(secret, nowStep()) },
  });
  assertEquals(ok.res!.status, 200);
  assertEquals(await mfaStatus(h.config, h.userId), {
    enrolled: false,
    pendingConfirmation: false,
    backupCodesRemaining: 0,
  });
  const user = { id: h.userId, email: EMAIL };
  assertEquals(await mfaPendingFor(resolveAuthOptions(h.config), user), false);
  assertEquals((await passwordSignIn(h)).res!.status, 200, "sign-in no longer steps up");
});

Deno.test("POST /mfa/disable accepts the session's own recent step-up; sliding expiry or age voids it", async () => {
  const h = await setup();
  const { secret } = await enrol(h);
  const stepped = await post(h.config, "/mfa", {
    cookie: await pendingSignIn(h),
    body: { code: await totpAt(secret, nowStep()) },
  });
  const session = (await readSession(h.config, stepped.cookie))!;
  const options = resolveAuthOptions(h.config);
  assert(hasFreshFactor(options, session));
  assert(!hasFreshFactor(options, session, (session.issuedAt! + 901) * 1000), "past freshness");
  assert(!hasFreshFactor(options, { ...session, amr: ["pwd"] }), "no second factor in amr");
  const sliding = resolveAuthOptions({ ...h.config, session: { updateAge: 60 } });
  assert(hasFreshFactor(sliding, session), "authTime never moves with a slide, so it still counts");
  const legacy = { ...session, authTime: undefined };
  assert(!hasFreshFactor(sliding, legacy), "a session without authTime can't count while sliding");

  const { res } = await post(h.config, "/mfa/disable", { cookie: stepped.cookie });
  assertEquals(res!.status, 200);
  assertEquals((await mfaStatus(h.config, h.userId)).enrolled, false);
});

// ---- required: "always" ----------------------------------------------------------

Deno.test("required 'always': an unenrolled user is pending; enrol + confirm during the step-up completes it", async () => {
  const h = await setup({ mfa: { required: "always", window: 2, backupCodes: 2 } });
  const signIn = await passwordSignIn(h, true);
  assertEquals(signIn.res!.headers.get("location"), "/login/2fa?callbackUrl=%2F");
  const pending = signIn.cookie!;
  const pendingSid = (await readSession(h.config, pending))!.sessionId!;

  const enrolled = await post(h.config, "/mfa/enroll", { cookie: pending });
  assertEquals(enrolled.res!.status, 200);
  const { secret, uri } = await enrolled.res!.json();
  assertMatch(uri, /^otpauth:\/\/totp\//);
  assertEquals(h.events, []);

  const confirmed = await post(h.config, "/mfa/confirm", {
    cookie: pending,
    body: { code: await totpAt(secret, nowStep()) },
  });
  assertEquals(confirmed.res!.status, 200);
  const body = await confirmed.res!.json();
  assertEquals([body.ok, body.backupCodes.length, body.user.id], [true, 2, h.userId]);
  const fresh = (await readSession(h.config, confirmed.cookie))!;
  assertEquals([fresh.mfaPending, fresh.amr], [undefined, ["pwd", "totp"]]);
  assertEquals(await h.store.get(pendingSid), undefined);
  assertEquals(h.events, ["signIn"]);
});

// ---- no MFA group ----------------------------------------------------------------

Deno.test("without the adapter's MFA group nobody is pending and every /mfa* row falls through", async () => {
  const { getMfa: _g, setMfa: _s, consumeBackupCode: _c, claimTotpStep: _t, ...bare } =
    inMemoryAuthAdapter();
  const h = await setup({}, bare as AuthAdapter);
  const user = { id: h.userId, email: EMAIL };
  assertEquals(await mfaPendingFor(resolveAuthOptions(h.config), user), false);
  const { res, cookie } = await passwordSignIn(h);
  assertEquals(res!.status, 200);
  for (const route of mfaRoutes) {
    const sent = await post(h.config, route.pattern, { cookie, body: { code: "123456" } });
    assertEquals(sent.res, null, `${route.pattern} does not exist`);
  }
  await assertRejects(() => enrollTotp(h.config, freshSession(user)), Error, "no MFA group");
});

// ---- pendingMfaSession() ---------------------------------------------------------

Deno.test("pendingMfaSession(): the pending session for the /mfa page, null once complete", async () => {
  const h = await setup();
  denextAuth(h.config);
  const { secret } = await enrol(h);
  const pending = await pendingSignIn(h);
  const onPage = (cookie: string | undefined) => {
    const request = new Request(`${ORIGIN}/login/2fa`, { headers: cookie ? { cookie } : {} });
    return runWithContext(
      createRequestContext(request),
      async () => [await pendingMfaSession(), await auth()] as const,
    );
  };
  const [waiting, signedIn] = await onPage(pending);
  assertEquals([waiting?.mfaPending, waiting?.user.id, signedIn], [true, h.userId, null]);

  const done = await post(h.config, "/mfa", {
    cookie: pending,
    body: { code: await totpAt(secret, nowStep()) },
  });
  const [after, complete] = await onPage(done.cookie);
  assertEquals([after, complete?.user.id], [null, h.userId]);
  assertEquals(await onPage(undefined), [null, null]);
});

Deno.test("POST /mfa/enroll from a complete session needs a recent sign-in, else reauth_required", async () => {
  const h = await setup();
  const { cookie } = await passwordSignIn(h); // not enrolled yet, so the session is complete
  assert(cookie, "a complete session cookie");
  const session = (await readSession(h.config, cookie))!;
  assertEquals(typeof session.authTime, "number", "sign-in stamps authTime");
  const realNow = Date.now;
  Date.now = () => realNow() + 16 * 60_000; // past the 15-minute freshness window
  try {
    const stale = await post(h.config, "/mfa/enroll", { cookie });
    assertEquals(stale.res!.status, 403);
    assertEquals(await stale.res!.json(), { error: "reauth_required" });
  } finally {
    Date.now = realNow;
  }
  const fresh = await post(h.config, "/mfa/enroll", { cookie });
  assertEquals(fresh.res!.status, 200);
  assert((await fresh.res!.json()).secret, "a recent sign-in may enroll");
});

Deno.test("enrollTotp: a complete session needs a recent sign-in, as the route does", async () => {
  const h = await setup();
  const user = { id: h.userId, email: EMAIL };
  const stale = { ...freshSession(user), authTime: Math.floor(Date.now() / 1000) - 3600 };
  assertEquals(await enrollTotp(h.config, stale), { ok: false, error: "reauth_required" });
  assertEquals((await mfaStatus(h.config, h.userId)).pendingConfirmation, false, "nothing stored");
  const pending: AuthSession = { ...stale, mfaPending: true };
  assert(
    (await enrollTotp(h.config, pending)).ok,
    "a pending session is minutes old and may enroll",
  );
});
