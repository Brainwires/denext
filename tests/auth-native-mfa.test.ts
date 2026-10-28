// A native `id_token` sign-in (`POST {basePath}/native/google` | `/native/apple`) for a user with
// a verified second factor answers a pending result — `{ mfa_required, mfa_token, expires_in,
// factors }`, no tokens, no `signIn` event — which the app finishes at `POST /native/mfa` with a
// TOTP, backup or SMS code. The `mfa_token` is single-use (a wrong code hands back a fresh one,
// one attempt fewer, same expiry), short-lived (five minutes), never a bearer, and refused once
// its user is banned or deleted.

import { assert, assertEquals, assertFalse, assertMatch, assertRejects } from "@std/assert";
import { decodeBase32 } from "@std/encoding/base32";
import type { AuthAdapter } from "../packages/auth/src/adapter.ts";
import { inMemoryAuthAdapter } from "../packages/auth/src/memory-adapter.ts";
import { confirmTotp, enrollTotp } from "../packages/auth/src/mfa.ts";
import { verifyNativeAccessToken } from "../packages/auth/src/native.ts";
import { base64UrlEncode } from "../packages/auth/src/oauth.ts";
import { handleAuthRequest } from "../packages/auth/src/routes.ts";
import type { AuthConfig } from "../packages/auth/src/types.ts";
import { nativeSession, NativeSessionError } from "../src/runtime/native-session.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const GOOGLE_WEB = "web-client.apps.googleusercontent.com";
const EMAIL = "g@x.test";

const pair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
) as CryptoKeyPair;
const publicJwk = {
  ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
  kid: "k1",
  alg: "RS256",
  use: "sig",
};

const enc = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
const now = () => Math.floor(Date.now() / 1000);

async function idToken(): Promise<string> {
  const claims = {
    iss: "https://accounts.google.com",
    aud: GOOGLE_WEB,
    azp: GOOGLE_WEB,
    sub: "google-sub-1",
    email: EMAIL,
    email_verified: true,
    iat: now(),
    exp: now() + 600,
  };
  const input = `${enc({ alg: "RS256", kid: "k1", typ: "JWT" })}.${enc(claims)}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64UrlEncode(new Uint8Array(sig))}`;
}

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

const step = () => Math.floor(Date.now() / 30_000);

// Every test runs on a pinned clock, 15 s into one 30 s step: a code computed for a step must
// verify against the step it was computed from. On the wall clock the step could roll over in
// between, putting an edge-of-window code (the enrollment's `- 2`, with a ±2 window) outside it.
const PINNED_MS = Math.floor(Date.now() / 30_000) * 30_000 + 15_000;

/** `Deno.test` with `Date.now` pinned to {@linkcode PINNED_MS} for the test's duration. */
function test(name: string, fn: () => Promise<void>): void {
  Deno.test(name, async () => {
    const realNow = Date.now;
    Date.now = () => PINNED_MS;
    try {
      await fn();
    } finally {
      Date.now = realNow;
    }
  });
}

let jwksCounter = 0;

interface Harness {
  config: AuthConfig;
  adapter: AuthAdapter;
  events: string[];
  userId: string;
  totp: string;
  /** The TOTP step the enrollment's confirming code claimed. */
  enrolledStep: number;
  backupCodes: string[];
}

/**
 * A Google-linked user with a confirmed TOTP factor — or, with `enrolled: false`, with none yet
 * under `mfa.required: "always"`.
 */
async function setup(options: { enrolled?: boolean } = {}): Promise<Harness> {
  const enrolled = options.enrolled ?? true;
  const adapter = inMemoryAuthAdapter();
  const events: string[] = [];
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    providers: [{ id: "credentials", type: "credentials" }],
    adapter,
    rateLimit: false,
    mfa: { window: 2, backupCodes: 2, ...(enrolled ? {} : { required: "always" as const }) },
    native: {
      redirectUris: ["com.example.app://auth/callback"],
      requireNonce: false,
      google: { clientIds: [GOOGLE_WEB], jwksUrl: `https://google.test/${++jwksCounter}/certs` },
      fetch: () => Promise.resolve(Response.json({ keys: [publicJwk] })),
    },
    events: {
      signIn: (p) => void events.push(`signIn:${p.provider}`),
      signInFailed: (p) => void events.push(`failed:${p.reason}`),
    },
  };
  const user = await adapter.createUser({ email: EMAIL, emailVerified: 1 });
  await adapter.linkAccount({
    userId: user.id,
    provider: "google",
    providerAccountId: "google-sub-1",
    type: "oidc",
  });
  const session = {
    user: { id: user.id, email: EMAIL },
    provider: "credentials",
    expiresAt: now() + 3600,
    authTime: now(),
  };
  if (!enrolled) {
    return { config, adapter, events, userId: user.id, totp: "", enrolledStep: 0, backupCodes: [] };
  }
  const enrollment = await enrollTotp(config, session);
  assert(enrollment.ok);
  const enrolledStep = step() - 2;
  const confirmed = await confirmTotp(config, {
    user: session.user,
    code: await totpAt(enrollment.secret, enrolledStep),
  });
  assert(confirmed.ok);
  return {
    config,
    adapter,
    events,
    userId: user.id,
    totp: enrollment.secret,
    enrolledStep,
    backupCodes: confirmed.backupCodes,
  };
}

async function post(h: Harness, path: string, body: Record<string, string>): Promise<Response> {
  const request = new Request(`${ORIGIN}/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await runWithContext(
    createRequestContext(request),
    () => handleAuthRequest(request, h.config),
  );
  assert(res, `${path} fell through`);
  return res;
}

/** The id_token sign-in's pending answer. */
async function pending(h: Harness): Promise<Record<string, unknown>> {
  const res = await post(h, "/native/google", { id_token: await idToken() });
  assertEquals(res.status, 200);
  return await res.json();
}

test("an enrolled user's id_token sign-in answers a pending second factor, no tokens", async () => {
  const h = await setup();
  const body = await pending(h);
  assertEquals(body.mfa_required, true);
  assertMatch(String(body.mfa_token), /^nmf_/);
  assert(Number(body.expires_in) > 0 && Number(body.expires_in) <= 300);
  assertEquals((body.factors as Array<{ type: string }>).map((f) => f.type), ["totp"]);
  assertEquals(body.access_token, undefined);
  assertEquals(body.refresh_token, undefined);
  assertFalse(JSON.stringify(body).includes(h.totp), "no secret in the answer");
  assertEquals(h.events, [], "no signIn before the second factor");
});

test("the mfa_token grants nothing: not a bearer, not a refresh token", async () => {
  const h = await setup();
  const token = String((await pending(h)).mfa_token);
  assertEquals(await verifyNativeAccessToken(h.config, token), null);
  const refresh = await post(h, "/native/token", {
    grant_type: "refresh_token",
    refresh_token: token,
  });
  assertEquals(refresh.status, 400);
  const code = await post(h, "/native/token", {
    grant_type: "authorization_code",
    code: token,
    code_verifier: "x".repeat(43),
    redirect_uri: "com.example.app://auth/callback",
  });
  assertEquals(code.status, 400);
});

test("a TOTP code finishes it: native tokens, the signIn event, and the token is spent", async () => {
  const h = await setup();
  const token = String((await pending(h)).mfa_token);
  const res = await post(h, "/native/mfa", {
    mfa_token: token,
    code: await totpAt(h.totp, step()),
  });
  assertEquals(res.status, 200);
  const tokens = await res.json();
  assertMatch(tokens.access_token, /^nat_/);
  const session = await verifyNativeAccessToken(h.config, tokens.access_token);
  assertEquals(session?.user.id, h.userId);
  assert(session?.amr?.includes("totp"), "the session records the second factor");
  assertEquals(h.events, ["signIn:google"]);
  // Single-use: the same token (with the next valid code) is refused.
  const again = await post(h, "/native/mfa", {
    mfa_token: token,
    code: await totpAt(h.totp, step() + 1),
  });
  assertEquals(again.status, 400);
  assertEquals((await again.json()).error, "invalid_grant");
});

test("a backup code finishes it too", async () => {
  const h = await setup();
  const token = String((await pending(h)).mfa_token);
  const res = await post(h, "/native/mfa", { mfa_token: token, code: h.backupCodes[0] });
  assertEquals(res.status, 200);
  assertMatch((await res.json()).access_token, /^nat_/);
});

test("a wrong code spends the token, hands back a fresh one, and five wrong codes end it", async () => {
  const h = await setup();
  let token = String((await pending(h)).mfa_token);
  for (let left = 4; left >= 1; left--) {
    const res = await post(h, "/native/mfa", { mfa_token: token, code: "000000" });
    assertEquals(res.status, 401);
    const body = await res.json();
    assertEquals([body.error, body.attempts_left], ["invalid_code", left]);
    // The spent token is dead even with a right code.
    const replay = await post(h, "/native/mfa", {
      mfa_token: token,
      code: await totpAt(h.totp, step()),
    });
    assertEquals(replay.status, 400);
    token = body.mfa_token;
  }
  const last = await post(h, "/native/mfa", { mfa_token: token, code: "000000" });
  assertEquals(last.status, 400);
  assertEquals((await last.json()).error, "invalid_grant");
  assert(h.events.includes("failed:invalid_mfa_code"));
  assertFalse(h.events.includes("signIn:google"));
});

test("an expired token is refused, right code or not", async () => {
  const h = await setup();
  const token = String((await pending(h)).mfa_token);
  const code = await totpAt(h.totp, step());
  const realNow = Date.now;
  Date.now = () => realNow() + 301_000;
  try {
    const res = await post(h, "/native/mfa", { mfa_token: token, code });
    assertEquals(res.status, 400);
  } finally {
    Date.now = realNow;
  }
});

test("a user banned or deleted after the id_token never finishes the sign-in", async () => {
  const h = await setup();
  const token = String((await pending(h)).mfa_token);
  await h.adapter.updateUser({ id: h.userId, bannedUntil: now() + 3600 });
  const banned = await post(h, "/native/mfa", {
    mfa_token: token,
    code: await totpAt(h.totp, step()),
  });
  assertEquals(banned.status, 400);

  const h2 = await setup();
  const token2 = String((await pending(h2)).mfa_token);
  await h2.adapter.deleteUser!(h2.userId);
  const gone = await post(h2, "/native/mfa", {
    mfa_token: token2,
    code: await totpAt(h2.totp, step()),
  });
  assertEquals(gone.status, 400);
});

test("an unknown or malformed token is invalid_grant; native off falls through", async () => {
  const h = await setup();
  for (const token of ["", "nmf_nope", "nat_x", "x".repeat(5000)]) {
    const res = await post(h, "/native/mfa", { mfa_token: token, code: "123456" });
    assertEquals(res.status, 400);
  }
  const off = { ...h, config: { ...h.config, native: undefined } };
  const request = new Request(`${ORIGIN}/auth/native/mfa`, { method: "POST", body: "{}" });
  const res = await runWithContext(
    createRequestContext(request),
    () => handleAuthRequest(request, off.config),
  );
  assert(!res || res.status === 404);
});

test("an SMS challenge for an unknown factor keeps the sign-in alive with a fresh token", async () => {
  const h = await setup();
  const token = String((await pending(h)).mfa_token);
  const res = await post(h, "/native/mfa-challenge", { mfa_token: token, factor_id: "nope" });
  assertEquals(res.status, 404);
  const body = await res.json();
  assertMatch(body.mfa_token, /^nmf_/);
  const finish = await post(h, "/native/mfa", {
    mfa_token: body.mfa_token,
    code: await totpAt(h.totp, step()),
  });
  assertEquals(finish.status, 200);
});

// ---- the client helper -------------------------------------------------------------------------

/** `nativeSession()` against the real handler (no network). */
function clientFor(h: Harness) {
  const store = new Map<string, string>();
  const doFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const res = await runWithContext(
      createRequestContext(request),
      () => handleAuthRequest(request, h.config),
    );
    return res ?? new Response("not found", { status: 404 });
  };
  return nativeSession({
    base: ORIGIN,
    redirectUri: "com.example.app://auth/callback",
    fetch: doFetch as typeof fetch,
    storage: {
      get: (k) => Promise.resolve(store.get(k) ?? null),
      set: (k, v) => {
        store.set(k, v);
        return Promise.resolve();
      },
      delete: (k) => {
        store.delete(k);
        return Promise.resolve();
      },
    },
  });
}

test("nativeSession: mfa_required carries the pending sign-in; completeMfa finishes it", async () => {
  const h = await setup();
  const session = clientFor(h);
  const token = await idToken();
  const error = await assertRejects(
    () => session.signInWithIdToken("google", { idToken: token }),
    NativeSessionError,
  );
  assertEquals(error.code, "mfa_required");
  assert(error.mfa?.token.startsWith("nmf_"));
  assertEquals(error.mfa?.factors.map((f) => f.type), ["totp"]);
  assertFalse(await session.signedIn());
  // A wrong code hands back a fresh pending sign-in to retry with.
  const wrong = await assertRejects(
    () => session.completeMfa(error.mfa!, "000000"),
    NativeSessionError,
  );
  assertEquals([wrong.code, wrong.mfa?.attemptsLeft], ["invalid_code", 4]);
  assertEquals(wrong.mfa?.factors.map((f) => f.type), ["totp"], "the factors carry over");
  const user = await session.completeMfa(wrong.mfa!, await totpAt(h.totp, step()));
  assertEquals(user.id, h.userId);
  assert(await session.signedIn());
  assertMatch(String(await session.getToken()), /^nat_/);
});

// ---- enrolling a first factor (`mfa.required: "always"`) ---------------------------------------

/** The pending sign-in, enrolled: the new factor's secret and the token to confirm with. */
async function enrolled(h: Harness): Promise<{ secret: string; token: string }> {
  const body = await pending(h);
  const res = await post(h, "/native/mfa-enroll", { mfa_token: String(body.mfa_token) });
  assertEquals(res.status, 200);
  const enrollment = await res.json();
  assertMatch(enrollment.uri, /^otpauth:\/\/totp\//);
  return { secret: enrollment.secret, token: enrollment.mfa_token };
}

test('"always" + no factor: the id_token sign-in answers a pending enrollment, no tokens', async () => {
  const h = await setup({ enrolled: false });
  const body = await pending(h);
  assertEquals([body.mfa_required, body.mfa_enroll], [true, true]);
  assertMatch(String(body.mfa_token), /^nmf_/);
  assertEquals(body.factors, []);
  assertEquals(body.access_token, undefined);
  assertEquals(h.events, [], "no signIn before the factor is enrolled");
});

test("enroll + confirm finishes the sign-in: tokens, amr totp, backup codes, signIn", async () => {
  const h = await setup({ enrolled: false });
  const { secret, token } = await enrolled(h);
  const res = await post(h, "/native/mfa-confirm", {
    mfa_token: token,
    code: await totpAt(secret, step()),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertMatch(body.access_token, /^nat_/);
  assertEquals(body.backup_codes.length, 2);
  const session = await verifyNativeAccessToken(h.config, body.access_token);
  assertEquals(session?.user.id, h.userId);
  assert(session?.amr?.includes("totp"));
  assertEquals(h.events, ["signIn:google"]);
  // The token is spent, and the user now owes the factor at the next sign-in.
  const again = await post(h, "/native/mfa-confirm", {
    mfa_token: token,
    code: await totpAt(secret, step() + 1),
  });
  assertEquals(again.status, 400);
  const next = await pending(h);
  assertEquals(next.mfa_enroll, undefined);
  assertEquals((next.factors as Array<{ type: string }>).map((f) => f.type), ["totp"]);
});

test("a wrong enrollment code costs an attempt and hands back a fresh token", async () => {
  const h = await setup({ enrolled: false });
  const { secret, token } = await enrolled(h);
  const wrong = await post(h, "/native/mfa-confirm", { mfa_token: token, code: "000000" });
  assertEquals(wrong.status, 401);
  const body = await wrong.json();
  assertEquals([body.error, body.attempts_left], ["invalid_code", 4]);
  const ok = await post(h, "/native/mfa-confirm", {
    mfa_token: body.mfa_token,
    code: await totpAt(secret, step()),
  });
  assertEquals(ok.status, 200);
});

test("enrollment is a first factor only: once one is verified, the pending token can't add one", async () => {
  const h = await setup({ enrolled: false });
  const body = await pending(h);
  // A factor appears meanwhile (the owner enrolled in the browser).
  const owner = {
    user: { id: h.userId, email: EMAIL },
    provider: "credentials",
    expiresAt: now() + 3600,
    authTime: now(),
  };
  const started = await enrollTotp(h.config, owner);
  assert(started.ok);
  assert(
    (await confirmTotp(h.config, { user: owner.user, code: await totpAt(started.secret, step()) }))
      .ok,
  );
  const res = await post(h, "/native/mfa-enroll", { mfa_token: String(body.mfa_token) });
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error, "already_enrolled");
  // Nor can an enrollment started earlier be confirmed next to it.
  const h2 = await setup({ enrolled: false });
  const { secret, token } = await enrolled(h2);
  const owner2 = { ...owner, user: { id: h2.userId, email: EMAIL } };
  const other = await enrollTotp(h2.config, owner2);
  assert(other.ok);
  assert(
    (await confirmTotp(h2.config, { user: owner2.user, code: await totpAt(other.secret, step()) }))
      .ok,
  );
  const confirm = await post(h2, "/native/mfa-confirm", {
    mfa_token: token,
    code: await totpAt(secret, step()),
  });
  assertEquals(confirm.status, 409);
});

test("an enrollment token never verifies a code, and a code-check token never enrolls", async () => {
  const h = await setup({ enrolled: false });
  const { token } = await enrolled(h);
  const verify = await post(h, "/native/mfa", { mfa_token: token, code: "123456" });
  assertEquals(verify.status, 400);
  const e = await setup();
  const plain = String((await pending(e)).mfa_token);
  const enroll = await post(e, "/native/mfa-enroll", { mfa_token: plain });
  assertEquals(enroll.status, 400);
  assertEquals((await enroll.json()).error, "invalid_grant");
});

test("a user banned after the id_token never enrolls", async () => {
  const h = await setup({ enrolled: false });
  const body = await pending(h);
  await h.adapter.updateUser({ id: h.userId, bannedUntil: now() + 3600 });
  const res = await post(h, "/native/mfa-enroll", { mfa_token: String(body.mfa_token) });
  assertEquals(res.status, 400);
});

test("nativeSession: enrollMfa + confirmMfaEnrollment finish an enrollment-owed sign-in", async () => {
  const h = await setup({ enrolled: false });
  const session = clientFor(h);
  const token = await idToken();
  const error = await assertRejects(
    () => session.signInWithIdToken("google", { idToken: token }),
    NativeSessionError,
  );
  assertEquals([error.code, error.mfa?.enroll], ["mfa_required", true]);
  const enrollment = await session.enrollMfa(error.mfa!);
  assertEquals(enrollment.mfa.enroll, true);
  const done = await session.confirmMfaEnrollment(
    enrollment.mfa,
    await totpAt(enrollment.secret, step()),
  );
  assertEquals(done.user.id, h.userId);
  assertEquals(done.backupCodes.length, 2);
  assert(await session.signedIn());
});

// ---- refusals, table-driven --------------------------------------------------------------------

/** A `/native/mfa` exchange that must be refused, and its exact answer. */
interface MfaRefusal {
  name: string;
  /** The code to present (may finish another sign-in first, to spend a step or a code). */
  code: (h: Harness) => Promise<string>;
  /** Change the world after the pending answer, before the code is presented. */
  after?: (h: Harness) => Promise<void>;
  /** Shift the process clock for the presentation, ms. */
  skewMs?: number;
  status: number;
  error: string;
}

/** Finish one whole sign-in with `code` (spending its TOTP step or backup code). */
async function finishWith(h: Harness, code: string): Promise<void> {
  const token = String((await pending(h)).mfa_token);
  const res = await post(h, "/native/mfa", { mfa_token: token, code });
  assertEquals(res.status, 200, await res.clone().text());
}

const MFA_REFUSALS: MfaRefusal[] = [
  {
    name: "a wrong code",
    code: () => Promise.resolve("000000"),
    status: 401,
    error: "invalid_code",
  },
  {
    name: "a code from outside the drift window",
    code: (h) => totpAt(h.totp, step() - 6),
    status: 401,
    error: "invalid_code",
  },
  {
    name: "a TOTP code replayed within its step (it already finished a sign-in)",
    code: async (h) => {
      const code = await totpAt(h.totp, step());
      await finishWith(h, code);
      return code;
    },
    status: 401,
    error: "invalid_code",
  },
  {
    name: "the enrollment's own code, replayed",
    // The exact step the confirmation claimed (not `step() - 2` again: a slow run may have
    // crossed a 30 s boundary since, and a later step is a fresh code).
    code: (h) => totpAt(h.totp, h.enrolledStep),
    status: 401,
    error: "invalid_code",
  },
  {
    name: "a spent backup code",
    code: async (h) => {
      await finishWith(h, h.backupCodes[0]);
      return h.backupCodes[0];
    },
    status: 401,
    error: "invalid_code",
  },
  {
    name: "a right code on an expired mfa_token",
    code: (h) => totpAt(h.totp, step()),
    skewMs: 301_000,
    status: 400,
    error: "invalid_grant",
  },
  {
    name: "a right code after the factor was removed",
    code: (h) => totpAt(h.totp, step()),
    after: async (h) => {
      for (const f of await h.adapter.listMfaFactors?.(h.userId) ?? []) {
        await h.adapter.deleteMfaFactor!(f.id);
      }
      await h.adapter.deleteMfa?.(h.userId);
    },
    // No factor left to check against: the pending sign-in ends, it isn't a wrong code.
    status: 400,
    error: "invalid_grant",
  },
];

for (const row of MFA_REFUSALS) {
  test(`native MFA refusal: ${row.name} is ${row.status} ${row.error}, no session minted`, async () => {
    const h = await setup();
    const code = await row.code(h);
    const sessions: string[] = [];
    const create = h.adapter.createNativeSession!.bind(h.adapter);
    h.adapter.createNativeSession = (s) => {
      sessions.push(s.id);
      return create(s);
    };
    const signIns = h.events.filter((e) => e.startsWith("signIn:")).length;
    const token = String((await pending(h)).mfa_token);
    await row.after?.(h);
    const realNow = Date.now;
    if (row.skewMs) Date.now = () => realNow() + row.skewMs!;
    let res: Response;
    try {
      res = await post(h, "/native/mfa", { mfa_token: token, code });
    } finally {
      Date.now = realNow;
    }
    const body = await res.json();
    assertEquals([res.status, body.error], [row.status, row.error]);
    assertEquals(body.access_token, undefined);
    assertEquals(body.refresh_token, undefined);
    assertEquals(sessions, [], "no native session was created");
    assertEquals(h.events.filter((e) => e.startsWith("signIn:")).length, signIns, "no signIn");
    // The presented token is spent either way: the right code can't finish it afterwards.
    const retry = await post(h, "/native/mfa", {
      mfa_token: token,
      code: await totpAt(h.totp, step() + 1),
    });
    assertEquals([retry.status, (await retry.json()).error], [400, "invalid_grant"]);
    assertEquals(sessions, [], "still no native session");
  });
}
