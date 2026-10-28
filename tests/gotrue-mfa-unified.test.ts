// One MFA factor store for both sign-in paths: a TOTP factor enrolled through denextAuth is a
// `/auth/v1` factor and the reverse, a session owing its second factor is `aal1` in `/auth/v1`
// and fails closed in `auth()`, a password-only session can't add a factor (or a passkey) and
// step up with it, WebAuthn factors are passkeys, the `/auth/v1` passkey endpoints share
// denext's passkey store, and the recovery-code endpoints are denext's backup codes. Raw HTTP
// (no supabase-js), so it runs in the unit suite.

import { assert, assertEquals, assertExists } from "@std/assert";
import { inMemoryAuthAdapter } from "../packages/auth/src/memory-adapter.ts";
import {
  confirmTotp,
  enrollTotp,
  mfaPendingFor,
  verifySecondFactor,
} from "../packages/auth/src/mfa.ts";
import { sessionFromJwtBearer } from "../packages/auth/src/gotrue/access.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { resolveIdentity } from "../packages/backend/server.ts";
import type { AuthConfig, AuthSession } from "../packages/auth/src/types.ts";
import { ORIGIN, type SupabaseAuthApp, supabaseAuthApp, totpCode } from "./_supabase-auth-app.ts";
import { Authenticator } from "./helpers/soft-authenticator.ts";

interface Call {
  method?: string;
  body?: unknown;
  token?: string;
  key?: string | null;
}

async function api(app: SupabaseAuthApp, path: string, call: Call = {}) {
  const headers: Record<string, string> = {};
  const key = call.key === undefined ? app.publishableKey : call.key;
  if (key) headers.apikey = key;
  if (call.token) headers.authorization = `Bearer ${call.token}`;
  if (call.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.fetch(`${ORIGIN}/auth/v1${path}`, {
    method: call.method ?? (call.body === undefined ? "GET" : "POST"),
    headers,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
  });
  const text = await res.text();
  // deno-lint-ignore no-explicit-any
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch { /* not JSON */ }
  return { status: res.status, json };
}

async function withApp(
  fn: (app: SupabaseAuthApp) => Promise<void>,
  authConfig: Partial<AuthConfig> = {},
): Promise<void> {
  const app = await supabaseAuthApp({
    adapter: inMemoryAuthAdapter(),
    authConfig: { mfa: { window: 2 }, ...authConfig },
    withClient: false,
  });
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

const EMAIL = "mfa@example.com";
const PASSWORD = "a password!";

/** A confirmed user. */
async function createUser(app: SupabaseAuthApp): Promise<string> {
  const created = await api(app, "/admin/users", {
    body: { email: EMAIL, password: PASSWORD, email_confirm: true },
    key: app.secretKey,
  });
  assertEquals(created.status, 200, JSON.stringify(created.json));
  return created.json.id;
}

/** A password sign-in's access token. */
async function passwordToken(app: SupabaseAuthApp): Promise<string> {
  const session = await api(app, "/token?grant_type=password", {
    body: { email: EMAIL, password: PASSWORD },
  });
  assertEquals(session.status, 200, JSON.stringify(session.json));
  return session.json.access_token;
}

/** A JWT's claims (unverified: the server already checked it). */
function claims(token: string): Record<string, unknown> {
  const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(part + "=".repeat((4 - part.length % 4) % 4)));
}

/** Challenge + verify a TOTP factor; the stepped-up access token. */
async function verifyTotp(
  app: SupabaseAuthApp,
  token: string,
  factorId: string,
  code: string,
): Promise<{ status: number; token?: string; error?: string }> {
  const challenge = await api(app, `/factors/${factorId}/challenge`, { token, body: {} });
  const verified = await api(app, `/factors/${factorId}/verify`, {
    token,
    body: { challenge_id: challenge.json.id, code },
  });
  return {
    status: verified.status,
    token: verified.json.access_token,
    error: verified.json.error_code,
  };
}

function freshSession(userId: string): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    user: { id: userId, email: EMAIL },
    provider: "credentials",
    expiresAt: now + 3600,
    authTime: now,
  };
}

const STEP = 30_000;

Deno.test("a TOTP factor enrolled through denextAuth is an /auth/v1 factor, and the reverse", async () => {
  await withApp(async (app) => {
    const userId = await createUser(app);
    // Enroll natively (denext's /mfa/enroll + /mfa/confirm functions).
    const enrolment = await enrollTotp(app.config, freshSession(userId));
    assert(enrolment.ok);
    const confirmed = await confirmTotp(app.config, {
      user: { id: userId },
      code: await totpCode(enrolment.secret, Date.now() - STEP),
    });
    assert(confirmed.ok);

    // /auth/v1 sees it; a password session is aal1 and owes it.
    const aal1 = await passwordToken(app);
    assertEquals(claims(aal1).aal, "aal1");
    const user = await api(app, "/user", { token: aal1 });
    const factors = user.json.factors as Array<{ id: string; factor_type: string; status: string }>;
    const native = factors.find((f) => f.factor_type === "totp")!;
    assertEquals(native.id, enrolment.factorId);
    assertEquals(native.status, "verified");
    assertEquals((await sessionFromJwtBearer(app.config, aal1))?.mfaPending, true);
    // Row-level security reads the token's own claims, as Supabase does: the aal1 token is
    // `authenticated` there (policies that need the second factor check `aal`), while `auth()`
    // fails closed on it. Documented in the backend guide (MFA and row-level security).
    const rls = await runWithContext(
      createRequestContext(
        new Request(`${ORIGIN}/rest/v1/notes`, {
          headers: { apikey: app.publishableKey, authorization: `Bearer ${aal1}` },
        }),
      ),
      () => resolveIdentity(),
    );
    assertEquals([rls.role, rls.claims.aal], ["authenticated", "aal1"]);

    // A password-only session can't add a factor of its own and step up with it.
    const sneaky = await api(app, "/factors", {
      token: aal1,
      body: { factor_type: "totp", friendly_name: "sneaky" },
    });
    assertEquals([sneaky.status, sneaky.json.error_code], [403, "insufficient_aal"]);

    // Verifying the natively enrolled factor steps up.
    const stepped = await verifyTotp(app, aal1, native.id, await totpCode(enrolment.secret));
    assertEquals(stepped.status, 200);
    assertEquals(claims(stepped.token!).aal, "aal2");
    assertEquals((await sessionFromJwtBearer(app.config, stepped.token!))?.mfaPending, undefined);

    // An aal2 session adds a second TOTP factor through /auth/v1…
    const second = await api(app, "/factors", {
      token: stepped.token,
      body: { factor_type: "totp", friendly_name: "backup phone" },
    });
    assertEquals(second.status, 200, JSON.stringify(second.json));
    const secret2 = second.json.totp.secret as string;
    const verified2 = await verifyTotp(
      app,
      stepped.token!,
      second.json.id,
      await totpCode(secret2),
    );
    assertEquals(verified2.status, 200);
    // …which denext's own step-up accepts, as it does the first one.
    const native2 = await verifySecondFactor(app.config, {
      userId,
      code: await totpCode(secret2, Date.now() + STEP),
    });
    assertEquals(native2, { ok: true, method: "totp", factorId: second.json.id });
    const native1 = await verifySecondFactor(app.config, {
      userId,
      code: await totpCode(enrolment.secret, Date.now() + STEP),
    });
    assertEquals(native1, { ok: true, method: "totp", factorId: native.id });

    // Removing the first through /auth/v1 retires it for the cookie path too.
    const removed = await api(app, `/factors/${native.id}`, {
      token: verified2.token,
      method: "DELETE",
    });
    assertEquals(removed.status, 200);
    assertEquals(
      await verifySecondFactor(app.config, {
        userId,
        code: await totpCode(enrolment.secret, Date.now() + 2 * STEP),
      }),
      { ok: false, error: "invalid_code" },
    );
    assertEquals(await mfaPendingFor(app.config, { id: userId }), true, "the second remains");
  });
});

Deno.test("a factor verified through /auth/v1 makes denext's cookie sign-in pending", async () => {
  await withApp(async (app) => {
    const userId = await createUser(app);
    assertEquals(await mfaPendingFor(app.config, { id: userId }), false);
    const token = await passwordToken(app);
    const enrolled = await api(app, "/factors", { token, body: { factor_type: "totp" } });
    // Enrolled but unverified: nothing owed yet.
    assertEquals(await mfaPendingFor(app.config, { id: userId }), false);
    const secret = enrolled.json.totp.secret as string;
    const code = await totpCode(secret);
    assertEquals((await verifyTotp(app, token, enrolled.json.id, code)).status, 200);
    assertEquals(await mfaPendingFor(app.config, { id: userId }), true);
    // A wrong code, and a replayed one, are refused. The replay is the SAME code: a fresh one
    // read after a 30 s step boundary (a slow password sign-in in between) is a new, valid code.
    const next = await passwordToken(app);
    assertEquals(
      (await verifyTotp(app, next, enrolled.json.id, code)).error,
      "mfa_verification_failed",
      "the step was already spent",
    );
  });
});

Deno.test("WebAuthn factors are passkeys: create, assert, remove", async () => {
  await withApp(async (app) => {
    const userId = await createUser(app);
    const authenticator = await Authenticator.create();
    const token = await passwordToken(app);
    const enrolled = await api(app, "/factors", {
      token,
      body: { factor_type: "webauthn", friendly_name: "laptop" },
    });
    assertEquals(enrolled.status, 200, JSON.stringify(enrolled.json));
    const factorId = enrolled.json.id as string;
    const rp = { rpId: "app.test", rpOrigins: [ORIGIN] };

    // A client naming another relying party is refused.
    const foreign = await api(app, `/factors/${factorId}/challenge`, {
      token,
      body: { webauthn: { rpId: "evil.test", rpOrigins: [ORIGIN] } },
    });
    assertEquals(foreign.status, 422);

    const create = await api(app, `/factors/${factorId}/challenge`, {
      token,
      body: { webauthn: rp },
    });
    assertEquals(create.status, 200, JSON.stringify(create.json));
    assertEquals(create.json.type, "webauthn");
    assertEquals(create.json.webauthn.type, "create");
    const publicKey = create.json.webauthn.credential_options.publicKey;
    assertEquals(publicKey.rp.id, "app.test");
    const registered = await api(app, `/factors/${factorId}/verify`, {
      token,
      body: {
        challenge_id: create.json.id,
        webauthn: {
          ...rp,
          type: "create",
          credential_response: await authenticator.register(publicKey),
        },
      },
    });
    assertEquals(registered.status, 200, JSON.stringify(registered.json));
    assertEquals(claims(registered.json.access_token).aal, "aal2");
    const passkey = await app.config.adapter!.getPasskey!(authenticator.id);
    assertEquals(passkey?.userId, userId, "the credential is a passkey of the user");
    assertEquals(await mfaPendingFor(app.config, { id: userId }), true);

    // A new password session asserts with it.
    const aal1 = await passwordToken(app);
    const request = await api(app, `/factors/${factorId}/challenge`, {
      token: aal1,
      body: { webauthn: rp },
    });
    assertEquals(request.json.webauthn.type, "request");
    const options = request.json.webauthn.credential_options.publicKey;
    assertEquals(options.allowCredentials.map((c: { id: string }) => c.id), [authenticator.id]);
    // The wrong ceremony type is refused (and spends the challenge).
    const wrongType = await api(app, `/factors/${factorId}/verify`, {
      token: aal1,
      body: {
        challenge_id: request.json.id,
        webauthn: {
          ...rp,
          type: "create",
          credential_response: await authenticator.assert(options),
        },
      },
    });
    assertEquals(wrongType.json.error_code, "mfa_verification_failed");
    const again = await api(app, `/factors/${factorId}/challenge`, {
      token: aal1,
      body: { webauthn: rp },
    });
    const againOptions = again.json.webauthn.credential_options.publicKey;
    const asserted = await api(app, `/factors/${factorId}/verify`, {
      token: aal1,
      body: {
        challenge_id: again.json.id,
        webauthn: {
          ...rp,
          type: "request",
          credential_response: await authenticator.assert(againOptions),
        },
      },
    });
    assertEquals(asserted.status, 200, JSON.stringify(asserted.json));
    const aal2 = asserted.json.access_token as string;
    assertEquals(claims(aal2).aal, "aal2");
    assertEquals(
      (claims(aal2).amr as Array<{ method: string }>).map((e) => e.method),
      ["webauthn", "password"],
    );

    // Removing the passkey removes the factor it backs.
    const list = await api(app, "/passkeys", { token: aal2 });
    assertEquals(list.json.map((p: { id: string }) => p.id), [authenticator.id]);
    const deleted = await api(app, `/passkeys/${authenticator.id}`, {
      token: aal2,
      method: "DELETE",
    });
    assertEquals(deleted.status, 204);
    assertEquals(await mfaPendingFor(app.config, { id: userId }), false);
    const user = await api(app, "/user", { token: aal2 });
    assertEquals(user.json.factors ?? [], []);
  }, { passkeys: true });
});

Deno.test("/auth/v1 passkeys: register (aal2 once enrolled), sign in, rename, delete", async () => {
  await withApp(async (app) => {
    const userId = await createUser(app);
    const authenticator = await Authenticator.create();
    const token = await passwordToken(app);
    // No session, no registration.
    assertEquals((await api(app, "/passkeys/registration/options", { body: {} })).status, 401);

    const options = await api(app, "/passkeys/registration/options", { token, body: {} });
    assertEquals(options.status, 200, JSON.stringify(options.json));
    const credential = await authenticator.register(options.json.options);
    // Another ceremony's id is refused.
    const mismatched = await api(app, "/passkeys/registration/verify", {
      token,
      body: { challenge_id: "other", credential },
    });
    assertEquals(mismatched.status, 400);
    const retry = await api(app, "/passkeys/registration/options", { token, body: {} });
    const registered = await api(app, "/passkeys/registration/verify", {
      token,
      body: {
        challenge_id: retry.json.challenge_id,
        credential: await authenticator.register(retry.json.options),
        friendly_name: "phone",
      },
    });
    assertEquals(registered.status, 200, JSON.stringify(registered.json));
    assertEquals(registered.json.friendly_name, "phone");
    // A plain passkey is not a second factor: a password sign-in owes nothing.
    assertEquals(await mfaPendingFor(app.config, { id: userId }), false);

    // Usernameless sign-in.
    const start = await api(app, "/passkeys/authentication/options", { body: {} });
    assertEquals(start.status, 200);
    assertEquals(start.json.options.allowCredentials, []);
    const assertion = await authenticator.assert(start.json.options);
    const session = await api(app, "/passkeys/authentication/verify", {
      body: { challenge_id: start.json.challenge_id, credential: assertion },
    });
    assertEquals(session.status, 200, JSON.stringify(session.json));
    assertEquals(session.json.user.id, userId);
    assertEquals(claims(session.json.access_token).aal, "aal2", "a UV passkey is two factors");
    // The challenge was single-use.
    const replay = await api(app, "/passkeys/authentication/verify", {
      body: { challenge_id: start.json.challenge_id, credential: assertion },
    });
    assertEquals(replay.json.error_code, "invalid_credentials");

    const renamed = await api(app, `/passkeys/${authenticator.id}`, {
      token,
      method: "PATCH",
      body: { friendly_name: "work phone" },
    });
    assertEquals(renamed.json.friendly_name, "work phone");
    const listed = await api(app, "/passkeys", { token });
    assertEquals(listed.json[0].friendly_name, "work phone");
    assertEquals(listed.json[0].last_used_at !== undefined, true);
    const admin = await api(app, `/admin/users/${userId}/passkeys`, { key: app.secretKey });
    assertEquals(admin.json.length, 1);
    assertEquals(
      (await api(app, `/admin/users/${userId}/passkeys`)).status,
      403,
      "the admin list needs the secret key",
    );

    // Once the user holds a verified factor, an aal1 session can't plant a passkey.
    const enrolled = await api(app, "/factors", { token, body: { factor_type: "totp" } });
    const stepped = await verifyTotp(
      app,
      token,
      enrolled.json.id,
      await totpCode(enrolled.json.totp.secret),
    );
    assertEquals(stepped.status, 200);
    const aal1 = await passwordToken(app);
    const refused = await api(app, "/passkeys/registration/options", { token: aal1, body: {} });
    assertEquals([refused.status, refused.json.error_code], [403, "insufficient_aal"]);
    assertEquals(
      (await api(app, "/passkeys/registration/options", { token: stepped.token, body: {} }))
        .status,
      200,
    );

    const deleted = await api(app, `/admin/users/${userId}/passkeys/${authenticator.id}`, {
      key: app.secretKey,
      method: "DELETE",
    });
    assertEquals(deleted.status, 204);
    assertEquals(await app.config.adapter!.getPasskey!(authenticator.id), undefined);
  }, { passkeys: true });
});

Deno.test("recovery codes: denext's backup codes through /auth/v1", async () => {
  await withApp(async (app) => {
    const userId = await createUser(app);
    const token = await passwordToken(app);
    assertEquals((await api(app, "/factors/recovery-codes", { token })).status, 404);
    const enrolled = await api(app, "/factors", { token, body: { factor_type: "totp" } });
    const secret = enrolled.json.totp.secret as string;
    const aal2 = (await verifyTotp(app, token, enrolled.json.id, await totpCode(secret))).token!;
    // An aal1 session can't mint codes once a factor is verified.
    const aal1 = await passwordToken(app);
    const refused = await api(app, "/factors/recovery-codes", { token: aal1, body: {} });
    assertEquals([refused.status, refused.json.error_code], [403, "insufficient_aal"]);

    const minted = await api(app, "/factors/recovery-codes", { token: aal2, body: {} });
    assertEquals(minted.status, 200, JSON.stringify(minted.json));
    assertEquals(minted.json.type, "recovery_code");
    const codes = minted.json.codes as string[];
    assertEquals(codes.length, minted.json.total);
    assertEquals(
      (await api(app, "/factors/recovery-codes", { token: aal2, body: {} })).status,
      422,
      "a second set needs regenerate",
    );
    const status = await api(app, "/factors/recovery-codes", { token: aal2 });
    assertEquals([status.json.total, status.json.remaining], [codes.length, codes.length]);
    const user = await api(app, "/user", { token: aal2 });
    assert(
      (user.json.factors as Array<{ factor_type: string }>).some((f) =>
        f.factor_type === "recovery_code"
      ),
    );

    // A recovery code steps an aal1 session up, once.
    const used = await api(app, "/factors/recovery-codes/verify", {
      token: aal1,
      body: { code: codes[0] },
    });
    assertEquals(used.status, 200, JSON.stringify(used.json));
    assertEquals(claims(used.json.access_token).aal, "aal2");
    const again = await api(app, "/factors/recovery-codes/verify", {
      token: await passwordToken(app),
      body: { code: codes[0] },
    });
    assertEquals(again.json.error_code, "mfa_verification_failed");
    // denext's own step-up spends the same codes.
    assertEquals(await verifySecondFactor(app.config, { userId, code: codes[1] }), {
      ok: true,
      method: "bcp",
    });
    assertEquals(
      (await api(app, "/factors/recovery-codes", { token: aal2 })).json.remaining,
      codes.length - 2,
    );

    const regenerated = await api(app, "/factors/recovery-codes/regenerate", {
      token: aal2,
      body: {},
    });
    assertEquals(regenerated.json.codes.length, codes.length);
    assertEquals(
      await verifySecondFactor(app.config, { userId, code: codes[2] }),
      { ok: false, error: "invalid_code" },
      "the old set is gone",
    );
    const removed = await api(app, "/factors/recovery-codes", { token: aal2, method: "DELETE" });
    assertEquals(removed.status, 200);
    assertExists(removed.json.id);
    assertEquals((await api(app, "/factors/recovery-codes", { token: aal2 })).status, 404);
  });
});

Deno.test("docs: the backend guide and the security page say an aal1 token is authenticated under RLS", async () => {
  const read = async (path: string) =>
    (await Deno.readTextFile(new URL(path, import.meta.url))).replace(/\s+/g, " ");
  const backend = await read("../site/app/docs/backend/content.md");
  assert(backend.includes("### MFA and row-level security"));
  assert(/aal1` token .*under RLS that token is `authenticated`/.test(backend));
  assert(backend.includes("using ((select auth.jwt() ->> 'aal') = 'aal2')"));
  const security = await read("../site/app/docs/security/content.md");
  assert(security.includes("(/docs/backend#mfa-and-row-level-security)"));
});
