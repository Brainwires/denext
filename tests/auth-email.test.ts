// Email verification + password reset: hashed-at-rest single-use verification tokens,
// their (identifier, purpose) scoping, the no-existence-oracle request path, the send
// throttle, the /verify + /reset + /reset/confirm endpoints, and the email/mfa config.

import { assert, assertEquals, assertNotEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createRequestContext,
  runDeferred,
  runWithContext,
} from "../src/server/request-context.ts";
import { setRemoteAddr } from "../src/server/remote-addr.ts";
import { resolveAuthOptions } from "../src/server/auth/options.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { constantTimeEqualHex, sha256Hex } from "../src/server/auth/hash.ts";
import { issueApiToken } from "../src/server/auth/api-token.ts";
import {
  issueVerificationToken,
  normalizeEmailIdentifier,
  redeemVerificationToken,
} from "../src/server/auth/verification.ts";
import {
  requestEmailVerification,
  requestPasswordReset,
  resetPassword,
  verifyEmail,
} from "../src/server/auth/email.ts";
import { accountRoutes } from "../src/server/auth/routes-account.ts";
import { mfaLimiter, verificationLimiter } from "../src/server/auth/rate-limit.ts";
import type { AuthAdapter, VerificationTokenRecord } from "../src/server/auth/adapter.ts";
import type { Hasher } from "../src/server/auth/hasher.ts";
import type {
  AuthConfig,
  AuthSession,
  VerificationRequestParams,
} from "../src/server/auth/types.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";

/** A config over an adapter, with a recording mailer and a recording `logger.error`. */
interface Harness {
  config: AuthConfig;
  adapter: AuthAdapter;
  sent: VerificationRequestParams[];
  errors: string[];
}

function setup(extra: Partial<AuthConfig> = {}, adapter = inMemoryAuthAdapter()): Harness {
  const sent: VerificationRequestParams[] = [];
  const errors: string[] = [];
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    providers: [],
    adapter,
    sendVerificationRequest: (params) => void sent.push(params),
    logger: { error: (message) => void errors.push(message) },
    ...extra,
  };
  return { config, adapter, sent, errors };
}

/** A hasher that records what it hashed and stores a recognisable string. */
function spyHasher(hashed: string[]): Hasher {
  return {
    hash: (plain) => Promise.resolve(`spy$${hashed.push(plain) && plain}`),
    verify: () => Promise.resolve(false),
  };
}

let userCount = 0;

/** Create an adapter user with a fresh address. */
async function makeUser(
  adapter: AuthAdapter,
  extra: { emailVerified?: number } = {},
): Promise<{ id: string; email: string }> {
  const email = `user-${++userCount}@x.test`;
  const user = await adapter.createUser({ email, ...extra });
  return { id: user.id, email };
}

/** SHA-256 hex, computed independently of the implementation under test. */
async function referenceSha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface CallInit {
  body?: string;
  type?: string;
  json?: boolean;
  origin?: string;
  peer?: string;
}

/** Drive one account row the way the dispatcher would, then flush `after()` mail. */
async function call(
  config: AuthConfig,
  method: "GET" | "POST",
  path: string,
  init: CallInit = {},
): Promise<Response | null> {
  const url = new URL(`/auth${path}`, ORIGIN);
  const route = accountRoutes.find((r) =>
    r.method === method && `/auth${r.pattern}` === url.pathname
  );
  if (!route) throw new Error(`no ${method} row for ${path}`);
  const headers = new Headers();
  if (init.json) headers.set("accept", "application/json");
  if (init.type) headers.set("content-type", init.type);
  if (method === "POST") headers.set("origin", init.origin ?? ORIGIN);
  const request = new Request(url, { method, headers, body: init.body });
  if (init.peer) setRemoteAddr(request, { transport: "tcp", hostname: init.peer, port: 443 });
  const ctx = createRequestContext(request);
  const options = resolveAuthOptions(config);
  const res = await runWithContext(
    ctx,
    () => route.handler({ request, config, options, url, method, params: {} }),
  );
  await runDeferred(ctx);
  return res;
}

const form = (fields: Record<string, string>): CallInit => ({
  body: new URLSearchParams(fields).toString(),
  type: "application/x-www-form-urlencoded",
});
const jsonBody = (fields: Record<string, string>): CallInit => ({
  body: JSON.stringify(fields),
  type: "application/json",
  json: true,
});

/** The 303 target of a redirect response, resolved against the app origin. */
function location(res: Response | null): URL {
  assert(res, "the route answered");
  assertEquals(res.status, 303);
  return new URL(res.headers.get("location")!, ORIGIN);
}

// ---- hash primitives --------------------------------------------------------

Deno.test("sha256Hex: the known vectors, and byte-identical to what api tokens store", async () => {
  assertEquals(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assertEquals(
    await sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  const { config, adapter } = setup();
  const { id } = await makeUser(adapter);
  const issued = await issueApiToken(config, { userId: id });
  assertEquals(issued.record.tokenHash, await referenceSha256(issued.token));
});

Deno.test("constantTimeEqualHex: equal, unequal, and a length mismatch that doesn't throw", () => {
  assert(constantTimeEqualHex("ab12", "ab12"));
  assert(!constantTimeEqualHex("ab12", "ab13"));
  assert(!constantTimeEqualHex("ab12", "ab1"));
  assert(!constantTimeEqualHex("", "00"));
});

// ---- verification tokens ----------------------------------------------------

Deno.test("normalizeEmailIdentifier: one trimmed, lower-cased address — never a list", () => {
  assertEquals(normalizeEmailIdentifier("  Alice@Example.COM "), "alice@example.com");
  for (
    const bad of [
      "a@x.com,b@y.com",
      "a@x.com;b@y.com",
      "a@x.com b@y.com",
      "a@x.com\r\nBcc: b@y.com",
      '"A" <a@x.com>',
      "<a@x.com>",
      "a@@x.com",
      "no-at-sign",
      "",
      `${"a".repeat(65)}@x.com`,
      42,
      undefined,
    ]
  ) {
    assertEquals(normalizeEmailIdentifier(bad), null, String(bad));
  }
});

Deno.test("issueVerificationToken: only the SHA-256 of the token is stored", async () => {
  const base = inMemoryAuthAdapter();
  const stored: VerificationTokenRecord[] = [];
  const adapter: AuthAdapter = {
    ...base,
    createVerificationToken: (record) => {
      stored.push({ ...record });
      return base.createVerificationToken!(record);
    },
  };
  const { config } = setup({}, adapter);
  const before = Math.floor(Date.now() / 1000);
  const { token, expiresAt } = await issueVerificationToken(config, {
    identifier: " Bob@X.test ",
    purpose: "reset",
    ttl: 3600,
  });
  assertEquals(stored.length, 1);
  assertEquals(stored[0].identifier, "bob@x.test");
  assertEquals(stored[0].purpose, "reset");
  assertEquals(stored[0].tokenHash, await referenceSha256(token));
  assertNotEquals(stored[0].tokenHash, token);
  assert(!JSON.stringify(stored).includes(token), "the plaintext never reaches storage");
  assertEquals(stored[0].expires, expiresAt);
  assert(expiresAt >= before + 3600 && expiresAt <= before + 3601);
});

Deno.test("redeemVerificationToken: a wrong token can't burn the real one; the real one works once", async () => {
  const { config } = setup();
  const { token } = await issueVerificationToken(config, {
    identifier: "a@x.test",
    purpose: "email",
    ttl: 60,
  });
  const redeem = (t: string) =>
    redeemVerificationToken(config, { identifier: "a@x.test", purpose: "email", token: t });
  assertEquals(await redeem("not-the-token"), null);
  assertEquals(await redeem(""), null);
  assertEquals((await redeem(token))?.identifier, "a@x.test");
  assertEquals(await redeem(token), null, "single use");
});

Deno.test("redeemVerificationToken: an expired token is consumed AND refused", async () => {
  let clock = Math.floor(Date.now() / 1000);
  const { config } = setup({}, inMemoryAuthAdapter({ now: () => clock }));
  const { token } = await issueVerificationToken(config, {
    identifier: "a@x.test",
    purpose: "reset",
    ttl: 60,
  });
  const redeem = () =>
    redeemVerificationToken(config, { identifier: "a@x.test", purpose: "reset", token });
  clock += 61;
  assertEquals(await redeem(), null, "expired");
  clock -= 61;
  assertEquals(await redeem(), null, "and gone — not left to be retried");
});

Deno.test("verification tokens are scoped by (identifier, purpose)", async () => {
  const { config, adapter } = setup();
  const { email } = await makeUser(adapter);
  const { token } = await issueVerificationToken(config, {
    identifier: email,
    purpose: "reset",
    ttl: 60,
  });
  assertEquals(
    await verifyEmail(config, { email, token }),
    { ok: false, error: "invalid_token" },
    "a reset token verifies nothing",
  );
  assertEquals(
    await redeemVerificationToken(config, { identifier: "other@x.test", purpose: "reset", token }),
    null,
    "nor acts for another address",
  );
  const record = await redeemVerificationToken(config, {
    identifier: email,
    purpose: "reset",
    token,
  });
  assertEquals(record?.purpose, "reset", "and neither miss spent it");
});

// ---- request flows (server functions) ---------------------------------------

Deno.test("requestPasswordReset: a real account gets one link; an unknown address gets none but the same work", async () => {
  const base = inMemoryAuthAdapter();
  let redemptions = 0;
  const adapter: AuthAdapter = {
    ...base,
    useVerificationToken: (ref) => {
      redemptions++;
      return base.useVerificationToken!(ref);
    },
  };
  const { config, sent } = setup({}, adapter);
  const { email } = await makeUser(adapter);

  const known = await requestPasswordReset(config, email.toUpperCase());
  assertEquals(sent.length, 1);
  assertEquals(sent[0].purpose, "reset");
  assertEquals(sent[0].identifier, email);
  const link = new URL(sent[0].url);
  assertEquals(link.origin + link.pathname, `${ORIGIN}/auth/reset`);
  assertEquals(link.searchParams.get("token"), sent[0].token);
  assertEquals(link.searchParams.get("email"), email);
  assertEquals(redemptions, 0);

  const unknown = await requestPasswordReset(config, "nobody@x.test");
  assertEquals(sent.length, 1, "no mail for an unknown address");
  assertEquals(redemptions, 1, "the dummy adapter round-trip ran");
  assertEquals(unknown, known, "and the answer is identical");
});

Deno.test("requestPasswordReset: a list of addresses sends nothing — even when one is real", async () => {
  const { config, adapter, sent } = setup();
  const { email } = await makeUser(adapter);
  await requestPasswordReset(config, `${email},attacker@evil.test`);
  await requestPasswordReset(config, `${email}; attacker@evil.test`);
  assertEquals(
    (await call(config, "POST", "/reset", jsonBody({ email: `${email},a@b.co` })))?.status,
    200,
  );
  assertEquals(sent.length, 0);
});

Deno.test("requestPasswordReset: without a mailer it throws; POST /reset still answers 200 and logs", async () => {
  const { config, adapter, errors } = setup({ sendVerificationRequest: undefined });
  const { email } = await makeUser(adapter);
  await assertRejects(() => requestPasswordReset(config, email), Error, "no mailer");
  const res = await call(config, "POST", "/reset", jsonBody({ email }));
  assertEquals(res?.status, 200);
  assertEquals(await res!.json(), { ok: true });
  assertEquals(errors.length, 1);
});

Deno.test("requestPasswordReset: no canonicalOrigin outside a request fails the same for every address", async () => {
  const { config, adapter, sent } = setup({ canonicalOrigin: undefined });
  const { email } = await makeUser(adapter);
  await assertRejects(() => requestPasswordReset(config, email), Error, "canonicalOrigin");
  await assertRejects(
    () => requestPasswordReset(config, "nobody@x.test"),
    Error,
    "canonicalOrigin",
  );
  assertEquals(sent.length, 0);
});

Deno.test("a failing mailer is logged, never thrown, and fires no verificationRequested", async () => {
  const requested: unknown[] = [];
  const { config, adapter, errors } = setup({
    sendVerificationRequest: () => {
      throw new Error("smtp down");
    },
    events: { verificationRequested: (payload) => void requested.push(payload) },
  });
  const { email } = await makeUser(adapter);
  assertEquals(await requestPasswordReset(config, email), { throttled: false });
  assertEquals(errors.length, 1);
  assert(!errors[0].includes("token="), "the log line carries no link");
  assertEquals(requested.length, 0);
});

// ---- reset + verify completion ----------------------------------------------

Deno.test("resetPassword: stores the hasher's output and revokes every session of that user", async () => {
  const hashed: string[] = [];
  const revoked: unknown[] = [];
  const resets: string[] = [];
  const adapter = inMemoryAuthAdapter();
  const { config, sent } = setup({
    session: { strategy: "database" },
    hasher: spyHasher(hashed),
    events: {
      sessionRevoked: (payload) => void revoked.push(payload),
      passwordReset: ({ user }) => void resets.push(user.id),
    },
  }, adapter);
  const { id, email } = await makeUser(adapter);
  const other = await makeUser(adapter);
  const live = (userId: string): AuthSession => ({
    user: { id: userId },
    provider: "credentials",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  await adapter.sessions!.create("mine-1", live(id));
  await adapter.sessions!.create("mine-2", live(id));
  await adapter.sessions!.create("theirs", live(other.id));

  await requestPasswordReset(config, email);
  const token = sent[0].token;
  const result = await resetPassword(config, { email, token, password: "correct horse" });
  assert(result.ok);
  assertEquals(result.user.id, id);
  assertEquals(hashed, ["correct horse"]);
  assertEquals(await adapter.getCredential!(id), "spy$correct horse");
  assertEquals(await adapter.sessions!.get("mine-1"), undefined);
  assertEquals(await adapter.sessions!.get("mine-2"), undefined);
  assert(await adapter.sessions!.get("theirs"), "another user's session survives");
  assertEquals(revoked, [{ userId: id }]);
  assertEquals(resets, [id]);
  assertEquals(await resetPassword(config, { email, token, password: "another one" }), {
    ok: false,
    error: "invalid_token",
  });
});

Deno.test("verifyEmail: register → verify keeps the password the registrant set", async () => {
  const { config, adapter, sent } = setup();
  const { id, email } = await makeUser(adapter);
  await adapter.setCredential!(id, "scrypt$registered");
  await requestEmailVerification(config, email);
  const verified = await verifyEmail(config, { email, token: sent[0].token });
  assert(verified.ok);
  assertEquals(typeof verified.user.emailVerified, "number");
  assertEquals(await adapter.getCredential!(id), "scrypt$registered");
});

Deno.test("resetPassword: a refused password leaves the link usable", async () => {
  const { config, adapter, sent } = setup({ hasher: spyHasher([]) });
  const { email } = await makeUser(adapter);
  await requestPasswordReset(config, email);
  const token = sent[0].token;
  assertEquals(await resetPassword(config, { email, token, password: "short" }), {
    ok: false,
    error: "invalid_password",
  });
  assert((await resetPassword(config, { email, token, password: "long enough" })).ok);
});

Deno.test("POST /reset/confirm: a plain form sets the password and 303s to the sign-in page", async () => {
  const { config, adapter, sent } = setup({ hasher: spyHasher([]), pages: { signIn: "/login" } });
  const { id, email } = await makeUser(adapter);
  await call(config, "POST", "/reset", form({ email }));
  assertEquals(sent.length, 1, "the form-posted request mailed a link (after the response)");
  const token = sent[0].token;

  const weak = location(
    await call(config, "POST", "/reset/confirm", form({ email, token, password: "x" })),
  );
  assertEquals(weak.pathname, "/auth/reset", "a refused password goes back to the reset page");
  assertEquals(weak.searchParams.get("token"), token);
  assertEquals(weak.searchParams.get("error"), "invalid_password");

  const done = location(
    await call(
      config,
      "POST",
      "/reset/confirm",
      form({ email, token, password: "brand-new-pass" }),
    ),
  );
  assertEquals(done.pathname, "/login");
  assertEquals(done.searchParams.get("reset"), "1");
  assertEquals(await adapter.getCredential!(id), "spy$brand-new-pass");

  const replay = await call(
    config,
    "POST",
    "/reset/confirm",
    jsonBody({ email, token, password: "brand-new-pass" }),
  );
  assertEquals(replay?.status, 400);
  assertEquals(await replay!.json(), { error: "invalid_token" });
});

Deno.test("GET /verify: the emailed link sets emailVerified and redirects; a replay lands on the error page", async () => {
  const verified: string[] = [];
  const { config, adapter, sent } = setup({
    pages: { verifyRequest: "/welcome", error: "/oops" },
    events: { emailVerified: ({ user }) => void verified.push(user.id) },
  });
  const { id, email } = await makeUser(adapter);
  await requestEmailVerification(config, { email });
  assertEquals(sent.length, 1);
  assertEquals(sent[0].purpose, "email");
  const link = new URL(sent[0].url);
  assertEquals(link.origin + link.pathname, `${ORIGIN}/auth/verify`);

  const ok = location(await call(config, "GET", `/verify${link.search}`));
  assertEquals(ok.pathname, "/welcome");
  assertEquals(ok.searchParams.get("verified"), "1");
  assertEquals(typeof (await adapter.getUser(id))?.emailVerified, "number");
  assertEquals(verified, [id]);

  const replay = location(await call(config, "GET", `/verify${link.search}`));
  assertEquals(replay.pathname, "/oops");
  assertEquals(replay.searchParams.get("error"), "invalid_token");

  await requestEmailVerification(config, email);
  await requestEmailVerification(config, "nobody@x.test");
  assertEquals(sent.length, 1, "nothing for a verified address or an unknown one");
});

Deno.test("POST /verify: a JSON submit verifies; a cross-origin POST is refused", async () => {
  const { config, adapter } = setup();
  const { email } = await makeUser(adapter);
  const { token } = await issueVerificationToken(config, {
    identifier: email,
    purpose: "email",
    ttl: 60,
  });
  const foreign = await call(config, "POST", "/verify", {
    ...jsonBody({ email, token }),
    origin: "https://evil.test",
  });
  assertEquals(foreign?.status, 403);
  const res = await call(config, "POST", "/verify", jsonBody({ email, token }));
  assertEquals(res?.status, 200);
  assertEquals(await res!.json(), { ok: true });
  assertEquals(
    (await call(config, "POST", "/reset", { ...jsonBody({ email }), origin: "https://evil.test" }))
      ?.status,
    403,
  );
});

Deno.test("POST /reset: answers every address alike, and the 4th request for one address is a 429 either way", async () => {
  const { config, adapter, sent } = setup({ pages: { verifyRequest: "/check-email" } });
  const { email } = await makeUser(adapter);
  const statuses = async (address: string, peer: string) => {
    const out: number[] = [];
    let last: Response | null = null;
    for (let i = 0; i < 4; i++) {
      last = await call(config, "POST", "/reset", { ...jsonBody({ email: address }), peer });
      out.push(last!.status);
    }
    return { out, body: await last!.text(), retryAfter: last!.headers.get("retry-after") };
  };
  const known = await statuses(email, "203.0.113.7");
  const unknown = await statuses("nobody@x.test", "203.0.113.8");
  assertEquals(known.out, [200, 200, 200, 429]);
  assertEquals(unknown.out, known.out);
  assertEquals(unknown.body, known.body);
  assert(known.retryAfter && unknown.retryAfter);
  assertEquals(sent.length, 3, "only the real account was mailed");

  const page = location(await call(config, "POST", "/reset", form({ email: "x@y.test" })));
  assertEquals(page.pathname, "/check-email", "a form post gets a 303 to the notice page");
  assertEquals(page.searchParams.get("sent"), "1");
});

Deno.test("POST /reset: rateLimit false never throttles", async () => {
  const { config, adapter, sent } = setup({ rateLimit: false });
  const { email } = await makeUser(adapter);
  for (let i = 0; i < 5; i++) {
    assertEquals((await call(config, "POST", "/reset", jsonBody({ email })))?.status, 200);
  }
  assertEquals(sent.length, 5);
});

Deno.test("the account rows answer null (→ 404) without the adapter group they need", async () => {
  const everyRow = async (config: AuthConfig) => [
    await call(config, "GET", "/verify?token=t&email=a%40x.test"),
    await call(config, "POST", "/verify", jsonBody({})),
    await call(config, "POST", "/reset", jsonBody({})),
    await call(config, "POST", "/reset/confirm", jsonBody({})),
  ];
  assertEquals(await everyRow(setup({ adapter: undefined }).config), [null, null, null, null]);

  const { createVerificationToken: _c, useVerificationToken: _u, ...noTokens } =
    inMemoryAuthAdapter();
  const tokenless = setup({}, noTokens as AuthAdapter).config;
  assertEquals(await everyRow(tokenless), [null, null, null, null]);
  await assertRejects(() => verifyEmail(tokenless, { email: "a@x.test", token: "t" }));

  const { setCredential: _s, ...noCredentials } = inMemoryAuthAdapter();
  const [get, post, reset, confirm] = await everyRow(
    setup({}, noCredentials as AuthAdapter).config,
  );
  assertEquals(get?.status, 303, "verification needs no credential storage");
  assertEquals(post?.status, 400);
  assertEquals([reset, confirm], [null, null]);
});

// ---- config + limiters ------------------------------------------------------

Deno.test("resolveAuthOptions: email + mfa defaults, clamping, and link-path validation", () => {
  const cfg = (extra: Partial<AuthConfig> = {}): AuthConfig => ({
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    providers: [],
    ...extra,
  });
  const defaults = resolveAuthOptions(cfg());
  assertEquals(defaults.email, {
    verifyMaxAge: 86_400,
    resetMaxAge: 3_600,
    magicMaxAge: 600,
    otpMaxAge: 300,
    otpDigits: 6,
    verifyPath: "/auth/verify",
    resetPath: "/auth/reset",
  });
  assertEquals(defaults.mfa, {
    required: "enrolled",
    issuer: "app.test",
    window: 1,
    backupCodes: 10,
    freshness: 900,
  });

  const low = resolveAuthOptions(cfg({
    email: { otpDigits: 3, verifyMaxAge: -5, resetMaxAge: Number.NaN },
    mfa: { window: -1, backupCodes: -3, required: "bogus" as "always", issuer: "  Acme  " },
  }));
  assertEquals([low.email.otpDigits, low.email.verifyMaxAge, low.email.resetMaxAge], [
    6,
    86_400,
    3_600,
  ]);
  assertEquals([low.mfa.window, low.mfa.backupCodes, low.mfa.required, low.mfa.issuer], [
    0,
    0,
    "enrolled",
    "Acme",
  ]);

  const high = resolveAuthOptions(cfg({
    email: { otpDigits: 99 },
    mfa: { window: 5, backupCodes: 50, required: "always", freshness: Infinity },
  }));
  assertEquals([high.email.otpDigits, high.mfa.window, high.mfa.backupCodes], [10, 2, 20]);
  assertEquals([high.mfa.required, high.mfa.freshness], ["always", 900]);

  const custom = resolveAuthOptions(cfg({ basePath: "/account", canonicalOrigin: undefined }));
  assertEquals([custom.email.verifyPath, custom.email.resetPath], [
    "/account/verify",
    "/account/reset",
  ]);
  assertEquals(custom.mfa.issuer, "denext");
  assertEquals(
    resolveAuthOptions(cfg({ email: { resetPath: "/pw/reset" } })).email.resetPath,
    "/pw/reset",
  );

  for (const bad of ["//evil.test/x", "https://evil.test/x", "/\\evil.test", "relative", "/a b"]) {
    assertThrows(
      () => resolveAuthOptions(cfg({ email: { verifyPath: bad } })),
      Error,
      "verifyPath",
    );
  }
});

Deno.test("verificationLimiter + mfaLimiter: memoised per config, own budgets, off with rateLimit false", async () => {
  const config: AuthConfig = { secret: SECRET, providers: [] };
  const verify = verificationLimiter(config)!;
  assert(verify === verificationLimiter(config), "memoised");
  for (let i = 0; i < 2; i++) await verify.fail("verify|a@x.test");
  assertEquals(await verify.lockedOut("verify|a@x.test"), null);
  await verify.fail("verify|a@x.test");
  assert((await verify.lockedOut("verify|a@x.test"))! > 0, "3 per window");

  const mfa = mfaLimiter(config)!;
  for (let i = 0; i < 4; i++) await mfa.fail("mfa|u1");
  assertEquals(await mfa.lockedOut("mfa|u1"), null);
  await mfa.fail("mfa|u1");
  assert((await mfa.lockedOut("mfa|u1"))! <= 300, "5 per 5 minutes");

  const tuned = verificationLimiter({ rateLimit: { verification: { max: 1 } } })!;
  await tuned.fail("k");
  assertNotEquals(await tuned.lockedOut("k"), null);

  const off = { rateLimit: false as const };
  assertEquals([verificationLimiter(off), mfaLimiter(off)], [null, null]);
});

Deno.test("resetPassword: a never-verified account loses the tokens and TOTP set up without proof, and becomes verified", async () => {
  const adapter = inMemoryAuthAdapter();
  const { config, sent } = setup({}, adapter);
  // Pre-registered by someone who never proved the mailbox: a password, a bearer token, TOTP.
  const { id, email } = await makeUser(adapter);
  await adapter.setCredential!(id, "attacker-hash");
  await issueApiToken(config, { userId: id, name: "attacker" });
  await adapter.setMfa!({
    userId: id,
    confirmedAt: 1,
    secret: "JBSWY3DPEHPK3PXP",
    backupCodeHashes: ["h"],
  });

  await requestPasswordReset(config, email);
  const result = await resetPassword(config, {
    email,
    token: sent[0].token,
    password: "the owner's new password",
  });
  assert(result.ok);
  assertEquals(await adapter.listApiTokens!(id), [], "the pre-registered bearer token is revoked");
  assertEquals((await adapter.getMfa!(id))?.confirmedAt, undefined, "the TOTP factor is dropped");
  assertEquals(
    typeof (await adapter.getUser(id))?.emailVerified,
    "number",
    "the reset proved the mailbox",
  );
  assertEquals(typeof result.user.emailVerified, "number");
  assertNotEquals(await adapter.getCredential!(id), "attacker-hash");
});

Deno.test("resolveAuthOptions: mfa.freshness 0 is kept (always ask), not replaced by the default", () => {
  const { config } = setup();
  assertEquals(resolveAuthOptions({ ...config, mfa: { freshness: 0 } }).mfa.freshness, 0);
  assertEquals(resolveAuthOptions({ ...config, mfa: { freshness: -5 } }).mfa.freshness, 0);
  assertEquals(resolveAuthOptions({ ...config, mfa: {} }).mfa.freshness, 900);
});
