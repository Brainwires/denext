// SSO users sign in through their identity provider only (GoTrue's `is_sso_user` rule): every
// non-SSO sign-in, recovery and one-time-code lookup by email or phone treats one as an unknown
// address — on `/auth/v1` and on denextAuth's own endpoints alike — with nothing sent and no
// second account created for its address. An existing account an IdP was linked to
// (`linkExistingAccounts`) is not an SSO user and keeps every other sign-in method.
//
// Raw HTTP into the app (the unit suite); the supabase-js side runs in tests/_supabase-auth-flows.ts.

import { assert, assertEquals, assertInstanceOf, assertNotEquals } from "@std/assert";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { resolveAuthOptions } from "../src/server/auth/options.ts";
import { credentials, emailOtp, magicLink, phoneOtp } from "../src/server/auth/providers.ts";
import { AccountNotLinkedError, resolveSignInUser } from "../src/server/auth/adapter-link.ts";
import { requestPasswordReset, resetPassword } from "../src/server/auth/email.ts";
import { base64UrlEncode } from "../src/server/auth/oauth.ts";
import type { AuthConfig, OAuthProvider } from "../src/server/auth/types.ts";
import type { GoTrueOptions, GoTrueSmsMessage } from "../src/server/auth/gotrue/options.ts";
import { inMemorySessionStore } from "../src/server/auth/session-store.ts";
import { readAuthSession, refreshLiveSession } from "../src/server/auth/session.ts";
import {
  refreshNativeSession,
  resolveNative,
  startNativeSession,
  verifyNativeAccessToken,
} from "../src/server/auth/native.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { ORIGIN, type SupabaseAuthApp, supabaseAuthApp, totpCode } from "./_supabase-auth-app.ts";
import { ACS, requestIdOf, type TestIdp, testIdp } from "./_saml-idp.ts";

const idp = await testIdp();

const SSO_EMAIL = "worker@corp.example";
const SSO_PHONE = "+15550100777";
const LINKED_EMAIL = "linked@corp.example";
const PASSWORD = "a-password-the-idp-never-saw";
const GOOGLE_CLIENT = "web-client.apps.googleusercontent.com";

interface Call {
  method?: string;
  body?: unknown;
  token?: string;
  key?: string;
}

interface Harness {
  app: SupabaseAuthApp;
  /** Texts denextAuth's own `phoneOtp()` sent. */
  texts: GoTrueSmsMessage[];
  /** Everything sent so far, both surfaces: emails + texts. */
  sent(): number;
}

async function api(app: SupabaseAuthApp, path: string, call: Call = {}) {
  const headers: Record<string, string> = { apikey: call.key ?? app.publishableKey };
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

/** A JSON POST to denextAuth's own endpoints (`/auth/...`), same-origin. */
async function own(app: SupabaseAuthApp, path: string, body: Record<string, string>) {
  const res = await app.fetch(`${ORIGIN}/auth${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const session = res.headers.getSetCookie().some((c) => /^__Host-denext_auth=[^;]/.test(c));
  return { status: res.status, text: await res.text(), session };
}

/** A fake Google: its key set (no network), and id tokens signed with it. */
async function googleIdp() {
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
  const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "g1", alg: "RS256" };
  const jwksUrl = `https://google.test/${crypto.randomUUID()}/certs`;
  const enc = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
  return {
    native: {
      redirectUris: ["com.example.app://auth/callback"],
      google: { clientIds: [GOOGLE_CLIENT], jwksUrl },
      fetch: () => Promise.resolve(Response.json({ keys: [jwk] })),
    },
    async idToken(email: string): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      const input = `${enc({ alg: "RS256", kid: "g1", typ: "JWT" })}.${
        enc({
          iss: "https://accounts.google.com",
          aud: GOOGLE_CLIENT,
          azp: GOOGLE_CLIENT,
          sub: `google-${email}`,
          email,
          email_verified: true,
          iat: now,
          exp: now + 600,
        })
      }`;
      const sig = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(input),
      );
      return `${input}.${base64UrlEncode(new Uint8Array(sig))}`;
    },
  };
}

async function withApp(
  fn: (h: Harness) => Promise<void>,
  auth: GoTrueOptions = {},
  authConfig: Partial<AuthConfig> = {},
): Promise<void> {
  const texts: GoTrueSmsMessage[] = [];
  const app = await supabaseAuthApp({
    adapter: inMemoryAuthAdapter(),
    auth: {
      saml: {
        providers: [{
          id: "acme",
          domains: ["corp.example"],
          metadataXml: idp.metadataXml(),
          linkExistingAccounts: true,
        }],
      },
      ...auth,
    },
    authConfig: {
      providers: [credentials(), magicLink(), emailOtp(), phoneOtp()],
      sendSms: (message) => void texts.push(message),
      ...authConfig,
    },
    withClient: false,
  });
  try {
    await fn({ app, texts, sent: () => app.emails.length + app.sms.length + texts.length });
  } finally {
    await app.close();
  }
}

/** A SAML sign-in at the ACS (SP-initiated): the landing fragment, or the refusal's code. */
async function samlLanding(
  app: SupabaseAuthApp,
  email: string,
  via: { providerId: string; idp: TestIdp } | undefined = undefined,
): Promise<{ status: number; fragment: URLSearchParams; error?: string }> {
  const started = await api(app, "/sso", {
    body: {
      ...(via ? { provider_id: via.providerId } : { domain: "corp.example" }),
      redirect_to: `${ORIGIN}/in`,
    },
  });
  assertEquals(started.status, 200, JSON.stringify(started.json));
  const landing = await app.fetch(ACS, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      SAMLResponse: await (via?.idp ?? idp).response({
        inResponseTo: await requestIdOf(started.json.url),
        nameId: email,
      }),
      RelayState: new URL(started.json.url).searchParams.get("RelayState")!,
    }),
    redirect: "manual",
  });
  const location = landing.headers.get("location");
  if (!location) {
    return {
      status: landing.status,
      fragment: new URLSearchParams(),
      error: (await landing.json()).error_code,
    };
  }
  return {
    status: landing.status,
    fragment: new URLSearchParams(new URL(location).hash.slice(1)),
  };
}

/** A SAML sign-in at the ACS (SP-initiated); the session from the landing fragment. */
async function samlSession(
  app: SupabaseAuthApp,
  email: string,
): Promise<{ access: string; refresh: string }> {
  const { status, fragment, error } = await samlLanding(app, email);
  assertEquals(status, 303, error);
  const access = fragment.get("access_token");
  assert(access, `a session: ${fragment}`);
  return { access, refresh: fragment.get("refresh_token")! };
}

/** A SAML sign-in at the ACS (SP-initiated); the access token from the landing fragment. */
async function samlSignIn(app: SupabaseAuthApp, email: string): Promise<string> {
  return (await samlSession(app, email)).access;
}

/**
 * An SSO user (its first SAML sign-in created it), also holding a verified phone and a password —
 * what an admin import or an account from before it became SSO-managed could leave behind.
 */
async function ssoUser(app: SupabaseAuthApp): Promise<{ id: string; token: string }> {
  const token = await samlSignIn(app, SSO_EMAIL);
  const adapter = app.config.adapter!;
  const user = (await adapter.getUserByEmail(SSO_EMAIL))!;
  assertEquals(user.appMetadata?.provider, "sso:acme");
  await adapter.updateUser({ id: user.id, phone: SSO_PHONE, phoneVerified: 1 });
  await adapter.setCredential!(user.id, await resolveAuthOptions(app.config).hasher.hash(PASSWORD));
  return { id: user.id, token };
}

/** Turn a user into an SSO user (as a SAML sign-in leaves one). */
async function makeSso(app: SupabaseAuthApp, id: string): Promise<void> {
  const adapter = app.config.adapter!;
  await adapter.updateUser({
    id,
    appMetadata: { provider: "sso:acme", providers: ["sso:acme"] },
  });
  await adapter.linkAccount({
    userId: id,
    provider: "sso:acme",
    providerAccountId: `name-id-${id}`,
    identityId: crypto.randomUUID(),
    identityData: { sub: `name-id-${id}` },
  });
}

/** A confirmed password user, through the admin API. */
async function passwordUser(app: SupabaseAuthApp, email: string): Promise<string> {
  const created = await api(app, "/admin/users", {
    key: app.secretKey,
    body: { email, password: PASSWORD, email_confirm: true },
  });
  assertEquals(created.status, 200, JSON.stringify(created.json));
  return created.json.id;
}

// ── /auth/v1 ─────────────────────────────────────────────────────────────────

Deno.test("/auth/v1: a magic link, email code or SMS code for an SSO user sends nothing, like an unknown address", async () => {
  await withApp(async (h) => {
    const { id } = await ssoUser(h.app);
    const before = h.sent();
    assertEquals(await api(h.app, "/otp", { body: { email: SSO_EMAIL } }), {
      status: 200,
      json: {},
    });
    assertEquals(await api(h.app, "/otp", { body: { phone: SSO_PHONE } }), {
      status: 200,
      json: { message_id: null },
    });
    // Without sign-up: exactly the refusal an unknown address gets.
    const noSignup = await api(h.app, "/otp", { body: { email: SSO_EMAIL, create_user: false } });
    const unknown = await api(h.app, "/otp", {
      body: { email: "nobody@corp.example", create_user: false },
    });
    assertEquals(noSignup, unknown);
    assertEquals([noSignup.status, noSignup.json.error_code], [422, "otp_disabled"]);
    assertEquals(h.sent(), before, "no email, no text");
    // No second account for the address.
    assertEquals((await h.app.config.adapter!.getUserByEmail(SSO_EMAIL))?.id, id);
  });
});

Deno.test("/auth/v1: an SSO user's password, recovery, resend and sign-up go nowhere", async () => {
  await withApp(async (h) => {
    const { id } = await ssoUser(h.app);
    const before = h.sent();
    for (const body of [{ email: SSO_EMAIL }, { phone: SSO_PHONE }]) {
      const grant = await api(h.app, "/token?grant_type=password", {
        body: { ...body, password: PASSWORD },
      });
      assertEquals([grant.status, grant.json.error_code], [400, "invalid_credentials"]);
    }
    assertEquals((await api(h.app, "/recover", { body: { email: SSO_EMAIL } })).status, 200);
    for (const body of [{ type: "signup", email: SSO_EMAIL }, { type: "sms", phone: SSO_PHONE }]) {
      assertEquals((await api(h.app, "/resend", { body })).status, 200);
    }
    // Confirmations on: the answer a registered address gets — a user that isn't this one.
    const signup = await api(h.app, "/signup", {
      body: { email: SSO_EMAIL, password: "another-password" },
    });
    assertEquals(signup.status, 200);
    assertNotEquals(signup.json.id, id);
    assertEquals(signup.json.access_token, undefined);
    assertEquals(h.sent(), before, "no email, no text");
    assertEquals((await h.app.config.adapter!.getUserByEmail(SSO_EMAIL))?.id, id);
  });
});

Deno.test("/auth/v1 with autoconfirm: an SSO user's address is a registered one, and its password is dead", async () => {
  await withApp(async (h) => {
    await ssoUser(h.app);
    for (const body of [{ email: SSO_EMAIL }, { phone: SSO_PHONE }]) {
      const signup = await api(h.app, "/signup", {
        body: { ...body, password: "another-password" },
      });
      assertEquals([signup.status, signup.json.error_code], [422, "user_already_exists"]);
      const grant = await api(h.app, "/token?grant_type=password", {
        body: { ...body, password: PASSWORD },
      });
      assertEquals([grant.status, grant.json.error_code], [400, "invalid_credentials"]);
    }
  }, { autoconfirm: true, phoneAutoconfirm: true });
});

Deno.test("/auth/v1: a code issued before the account became an SSO user signs nobody in", async () => {
  await withApp(async (h) => {
    const id = await passwordUser(h.app, SSO_EMAIL);
    assertEquals((await api(h.app, "/otp", { body: { email: SSO_EMAIL } })).status, 200);
    const mail = h.app.emails.at(-1)!;
    await makeSso(h.app, id);
    const byCode = await api(h.app, "/verify", {
      body: { type: "magiclink", email: SSO_EMAIL, token: mail.token },
    });
    assertEquals([byCode.status, byCode.json.error_code], [403, "otp_expired"]);
  });
});

Deno.test("/auth/v1 admin: generate_link and invite for an SSO user are refused, with nothing sent", async () => {
  await withApp(async (h) => {
    await ssoUser(h.app);
    const before = h.sent();
    const link = (type: string, extra: Record<string, unknown> = {}) =>
      api(h.app, "/admin/generate_link", {
        key: h.app.secretKey,
        body: { type, email: SSO_EMAIL, ...extra },
      });
    const outcome = async (pending: ReturnType<typeof link>) => {
      const res = await pending;
      return [res.status, res.json.error_code];
    };
    assertEquals(await outcome(link("magiclink")), [422, "email_exists"]);
    assertEquals(await outcome(link("signup", { password: "another-password" })), [
      422,
      "email_exists",
    ]);
    assertEquals(await outcome(link("invite")), [422, "email_exists"]);
    assertEquals(await outcome(link("recovery")), [404, "user_not_found"]);
    assertEquals(
      await outcome(link("email_change_current", { new_email: "else@corp.example" })),
      [404, "user_not_found"],
    );
    const invite = await api(h.app, "/invite", {
      key: h.app.secretKey,
      body: { email: SSO_EMAIL },
    });
    assertEquals([invite.status, invite.json.error_code], [422, "email_exists"]);
    assertEquals(h.sent(), before);
  });
});

Deno.test("/auth/v1: an id_token sign-in with an SSO user's email neither links nor creates", async () => {
  const google = await googleIdp();
  await withApp(
    async (h) => {
      const { id } = await ssoUser(h.app);
      const grant = await api(h.app, "/token?grant_type=id_token", {
        body: { provider: "google", id_token: await google.idToken(SSO_EMAIL) },
      });
      assertEquals([grant.status, grant.json.error_code], [422, "email_exists"]);
      const accounts = await h.app.config.adapter!.listAccounts!(id);
      assertEquals(accounts.map((account) => account.provider), ["sso:acme"]);
      // A regular confirmed account still links (the rule is SSO users only).
      await passwordUser(h.app, "regular@corp.example");
      const linked = await api(h.app, "/token?grant_type=id_token", {
        body: { provider: "google", id_token: await google.idToken("regular@corp.example") },
      });
      assertEquals(linked.status, 200, JSON.stringify(linked.json));
    },
    {},
    { native: google.native },
  );
});

Deno.test("/auth/v1: an SSO user registers no passkey and links no identity without an SSO session", async () => {
  await withApp(
    async (h) => {
      const id = await passwordUser(h.app, SSO_EMAIL);
      // A session from before the account became an SSO user (a password sign-in).
      const old = await api(h.app, "/token?grant_type=password", {
        body: { email: SSO_EMAIL, password: PASSWORD },
      });
      assertEquals(old.status, 200);
      await makeSso(h.app, id);
      const sso = await samlSignIn(h.app, SSO_EMAIL);
      const options = await api(h.app, "/passkeys/registration/options", { token: sso, body: {} });
      assertEquals([options.status, options.json.error_code], [422, "validation_failed"]);
      // The session from before is dead outright (see the session tests below).
      const stale = await api(h.app, "/passkeys/registration/options", {
        token: old.json.access_token,
        body: {},
      });
      assertEquals([stale.status, stale.json.error_code], [403, "session_not_found"]);
      const link = (token: string) =>
        api(h.app, "/user/identities/authorize?provider=nope&skip_http_redirect=true", { token });
      const refused = await link(old.json.access_token);
      assertEquals([refused.status, refused.json.error_code], [403, "session_not_found"]);
      // From the IdP's session the link goes on (and fails only on the unknown provider here).
      const allowed = await link(sso);
      assertEquals([allowed.status, allowed.json.error_code], [400, "validation_failed"]);
    },
    {},
    { passkeys: true },
  );
});

Deno.test("/auth/v1: an SSO user stays one after linking and unlinking identities", async () => {
  await withApp(async (h) => {
    const { id, token } = await ssoUser(h.app);
    await h.app.config.adapter!.linkAccount({
      userId: id,
      provider: "github",
      providerAccountId: "gh-1",
      identityId: crypto.randomUUID(),
      identityData: { sub: "gh-1" },
    });
    const user = await api(h.app, "/user", { token });
    const identities = user.json.identities as { provider: string; identity_id: string }[];
    assertEquals(identities.map((identity) => identity.provider).sort(), ["github", "sso:acme"]);
    const sso = identities.find((identity) => identity.provider === "sso:acme")!;
    const unlinked = await api(h.app, `/user/identities/${sso.identity_id}`, {
      method: "DELETE",
      token,
    });
    assertEquals(unlinked.status, 200, JSON.stringify(unlinked.json));
    assertEquals(
      (await h.app.config.adapter!.getUser(id))?.appMetadata?.provider,
      "sso:acme",
      "the kind of user doesn't change",
    );
    const before = h.sent();
    assertEquals((await api(h.app, "/otp", { body: { email: SSO_EMAIL } })).status, 200);
    const grant = await api(h.app, "/token?grant_type=password", {
      body: { email: SSO_EMAIL, password: PASSWORD },
    });
    assertEquals(grant.status, 400);
    assertEquals(h.sent(), before);
  }, { manualLinking: true });
});

// ── denextAuth's own endpoints ───────────────────────────────────────────────

Deno.test("denextAuth: magicLink(), emailOtp(), phoneOtp() and /reset send an SSO user nothing", async () => {
  await withApp(async (h) => {
    const { id } = await ssoUser(h.app);
    const before = h.sent();
    const answers = [
      await own(h.app, "/callback/email", { email: SSO_EMAIL }),
      await own(h.app, "/callback/email-otp", { email: SSO_EMAIL }),
      await own(h.app, "/callback/phone", { phone: SSO_PHONE }),
    ];
    const reset = await own(h.app, "/reset", { email: SSO_EMAIL });
    assertEquals(await requestPasswordReset(h.app.config, SSO_EMAIL), { ok: true });
    assertEquals(h.sent(), before, "no email, no text");
    assertEquals((await h.app.config.adapter!.getUserByEmail(SSO_EMAIL))?.id, id);
    // Each answer is the one an unknown address gets (which, with sign-up on, IS sent a code).
    const unknown = [
      await own(h.app, "/callback/email", { email: "nobody@corp.example" }),
      await own(h.app, "/callback/email-otp", { email: "nobody@corp.example" }),
      await own(h.app, "/callback/phone", { phone: "+15550100999" }),
      await own(h.app, "/reset", { email: "nobody@corp.example" }),
    ];
    assertEquals(
      [...answers, reset].map((answer) => [answer.status, answer.text]),
      unknown.map((answer) => [answer.status, answer.text]),
    );
  });
});

Deno.test("denextAuth: credentials() refuses an SSO user's password", async () => {
  await withApp(async (h) => {
    await ssoUser(h.app);
    const signIn = await own(h.app, "/callback/credentials", {
      email: SSO_EMAIL,
      password: PASSWORD,
    });
    assertEquals(signIn.status, 401);
    assertEquals(signIn.session, false);
  });
});

Deno.test("denextAuth: a code or reset link issued before the account became an SSO user is dead", async () => {
  await withApp(async (h) => {
    const id = await passwordUser(h.app, SSO_EMAIL);
    await own(h.app, "/callback/email-otp", { email: SSO_EMAIL });
    const code = h.app.emails.at(-1)!.token;
    await own(h.app, "/reset", { email: SSO_EMAIL });
    const reset = h.app.emails.at(-1)!;
    assertEquals(reset.purpose, "reset");
    await makeSso(h.app, id);
    const redeemed = await own(h.app, "/callback/email-otp", { email: SSO_EMAIL, code });
    assertNotEquals(redeemed.status, 200);
    assertEquals(redeemed.session, false);
    const result = await resetPassword(h.app.config, {
      email: SSO_EMAIL,
      token: reset.token,
      password: "a-brand-new-password",
    });
    assertEquals(result, { ok: false, error: "invalid_token" });
  });
});

Deno.test("account linking: an OAuth / native / credentials sign-in never links onto an SSO user", async () => {
  await withApp(async (h) => {
    const { id } = await ssoUser(h.app);
    const options = resolveAuthOptions(h.app.config);
    const provider = {
      id: "github",
      type: "oauth",
      allowDangerousEmailAccountLinking: true,
    } as OAuthProvider;
    const error = await resolveSignInUser(
      options,
      provider,
      { id: "gh-7", email: SSO_EMAIL, emailVerified: true },
      { provider: "github", providerAccountId: "gh-7", type: "oauth" },
    ).then(() => undefined, (e) => e);
    assertInstanceOf(error, AccountNotLinkedError);
    assertEquals(
      (await h.app.config.adapter!.listAccounts!(id)).map((account) => account.provider),
      ["sso:acme"],
    );
  });
});

// ── a linked existing account is not an SSO user ─────────────────────────────

Deno.test("an existing account an IdP was linked to keeps its password, codes and recovery", async () => {
  await withApp(
    async (h) => {
      const id = await passwordUser(h.app, LINKED_EMAIL);
      // The IdP links onto the confirmed account (`linkExistingAccounts`).
      await samlSignIn(h.app, LINKED_EMAIL);
      const accounts = await h.app.config.adapter!.listAccounts!(id);
      assert(accounts.some((account) => account.provider === "sso:acme"), "linked");
      // /auth/v1
      const grant = await api(h.app, "/token?grant_type=password", {
        body: { email: LINKED_EMAIL, password: PASSWORD },
      });
      assertEquals(grant.status, 200, JSON.stringify(grant.json));
      const sent = h.app.emails.length;
      assertEquals((await api(h.app, "/otp", { body: { email: LINKED_EMAIL } })).status, 200);
      assertEquals((await api(h.app, "/recover", { body: { email: LINKED_EMAIL } })).status, 200);
      assertEquals(h.app.emails.length, sent + 2);
      const options = await api(h.app, "/passkeys/registration/options", {
        token: grant.json.access_token,
        body: {},
      });
      assertEquals(options.status, 200, JSON.stringify(options.json));
      // denextAuth's own endpoints
      const signIn = await own(h.app, "/callback/credentials", {
        email: LINKED_EMAIL,
        password: PASSWORD,
      });
      assertEquals([signIn.status, signIn.session], [200, true]);
      await own(h.app, "/callback/email", { email: LINKED_EMAIL });
      await own(h.app, "/reset", { email: LINKED_EMAIL });
      assertEquals(h.app.emails.length, sent + 4);
    },
    {},
    { passkeys: true },
  );
});

// ── sessions an SSO user's identity provider did not start ───────────────────

Deno.test("/auth/v1: an SSO user's session from before it became one is refused at use and at refresh", async () => {
  await withApp(async (h) => {
    const id = await passwordUser(h.app, SSO_EMAIL);
    const old = await api(h.app, "/token?grant_type=password", {
      body: { email: SSO_EMAIL, password: PASSWORD },
    });
    assertEquals(old.status, 200);
    assertEquals((await api(h.app, "/user", { token: old.json.access_token })).status, 200);
    await makeSso(h.app, id);
    const used = await api(h.app, "/user", { token: old.json.access_token });
    assertEquals([used.status, used.json.error_code], [403, "session_not_found"]);
    const refreshed = await api(h.app, "/token?grant_type=refresh_token", {
      body: { refresh_token: old.json.refresh_token },
    });
    assertEquals([refreshed.status, refreshed.json.error_code], [400, "refresh_token_not_found"]);
    // The family is revoked, not merely refused.
    const family = await h.app.config.adapter!.getNativeSession!(
      old.json.refresh_token.split(".")[0],
    );
    assert(family?.revokedAt !== undefined, "revoked");
  });
});

Deno.test("/auth/v1: an SSO user's IdP session refreshes, and keeps working after an MFA step-up", async () => {
  await withApp(async (h) => {
    const first = await samlSession(h.app, SSO_EMAIL);
    const refreshed = await api(h.app, "/token?grant_type=refresh_token", {
      body: { refresh_token: first.refresh },
    });
    assertEquals(refreshed.status, 200, JSON.stringify(refreshed.json));
    const token = refreshed.json.access_token as string;
    assertEquals((await api(h.app, "/user", { token })).status, 200);
    // Step up to aal2 with a TOTP factor: the new family keeps the `sso/saml` entry.
    const enrolled = await api(h.app, "/factors", { token, body: { factor_type: "totp" } });
    assertEquals(enrolled.status, 200, JSON.stringify(enrolled.json));
    const challenge = await api(h.app, `/factors/${enrolled.json.id}/challenge`, {
      token,
      body: {},
    });
    const verified = await api(h.app, `/factors/${enrolled.json.id}/verify`, {
      token,
      body: { challenge_id: challenge.json.id, code: await totpCode(enrolled.json.totp.secret) },
    });
    assertEquals(verified.status, 200, JSON.stringify(verified.json));
    const stepped = await api(h.app, "/token?grant_type=refresh_token", {
      body: { refresh_token: verified.json.refresh_token },
    });
    assertEquals(stepped.status, 200, JSON.stringify(stepped.json));
    const user = await api(h.app, "/user", { token: stepped.json.access_token });
    assertEquals(user.status, 200);
  });
});

Deno.test("/auth/v1: a sign-in through an identity linked to an SSO user starts no session", async () => {
  const google = await googleIdp();
  await withApp(
    async (h) => {
      const { id } = await ssoUser(h.app);
      await h.app.config.adapter!.linkAccount({
        userId: id,
        provider: "google",
        providerAccountId: `google-${SSO_EMAIL}`,
        identityId: crypto.randomUUID(),
        identityData: { sub: `google-${SSO_EMAIL}`, email: SSO_EMAIL },
      });
      const grant = await api(h.app, "/token?grant_type=id_token", {
        body: { provider: "google", id_token: await google.idToken(SSO_EMAIL) },
      });
      assertEquals([grant.status, grant.json.error_code], [422, "user_sso_managed"]);
    },
    {},
    { native: google.native },
  );
});

/** A denextAuth credentials sign-in; the session cookie pair. */
async function cookieSignIn(app: SupabaseAuthApp, email: string): Promise<string> {
  const res = await app.fetch(`${ORIGIN}/auth/callback/credentials`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  await res.body?.cancel();
  const pair = res.headers.getSetCookie().find((c) => /^__Host-denext_auth=[^;]/.test(c));
  assert(pair, `a session cookie (${res.status})`);
  return pair.split(";")[0];
}

/** Read the cookie's session and, when `slide`, slide it as if `updateAge` had passed. */
function cookieSession(app: SupabaseAuthApp, cookie: string, slide = true) {
  const ctx = createRequestContext(new Request(`${ORIGIN}/`, { headers: { cookie } }));
  return runWithContext(ctx, async () => {
    const session = await readAuthSession(app.config);
    if (!session || !slide) return session;
    return await refreshLiveSession(app.config, session, Date.now() + 120_000);
  });
}

Deno.test("denextAuth: an SSO user's cookie session ends when it is due to slide", async () => {
  await withApp(
    async (h) => {
      const id = await passwordUser(h.app, SSO_EMAIL);
      await passwordUser(h.app, "regular@corp.example");
      const cookie = await cookieSignIn(h.app, SSO_EMAIL);
      const regular = await cookieSignIn(h.app, "regular@corp.example");
      assert(await cookieSession(h.app, cookie, false), "live");
      await makeSso(h.app, id);
      assert(await cookieSession(h.app, cookie, false), "auth() still reads it (no user read)");
      assertEquals(await cookieSession(h.app, cookie), null);
      assertEquals(await cookieSession(h.app, cookie, false), null, "its record is gone");
      assert(await cookieSession(h.app, regular), "another user's still slides");
    },
    {},
    { sessionStore: inMemorySessionStore(), session: { updateAge: 60 } },
  );
});

Deno.test("denextAuth: an SSO user's native session is refused at use and at refresh", async () => {
  await withApp(
    async (h) => {
      const id = await passwordUser(h.app, SSO_EMAIL);
      const native = resolveNative(h.app.config)!;
      const pair = await startNativeSession(h.app.config, native, {
        user: { id, email: SSO_EMAIL },
        provider: "credentials",
        amr: ["pwd"],
        authTime: Math.floor(Date.now() / 1000),
      });
      assert(await verifyNativeAccessToken(h.app.config, pair.access_token), "live before");
      await makeSso(h.app, id);
      assertEquals(await verifyNativeAccessToken(h.app.config, pair.access_token), null);
      assertEquals(await refreshNativeSession(h.app.config, native, pair.refresh_token), {
        ok: false,
        reason: "sso_user",
      });
    },
    {},
    { native: { redirectUris: ["com.example.app://auth/callback"] } },
  );
});

Deno.test("denextAuth: an OAuth sign-in through an account linked to an SSO user is refused", async () => {
  await withApp(async (h) => {
    const { id } = await ssoUser(h.app);
    await h.app.config.adapter!.linkAccount({
      userId: id,
      provider: "github",
      providerAccountId: "gh-9",
      type: "oauth",
    });
    const error = await resolveSignInUser(
      resolveAuthOptions(h.app.config),
      { id: "github", type: "oauth" } as OAuthProvider,
      { id: "gh-9", email: SSO_EMAIL, emailVerified: true },
      { provider: "github", providerAccountId: "gh-9", type: "oauth" },
    ).then(() => undefined, (e) => e);
    assertInstanceOf(error, AccountNotLinkedError);
  });
});

// ── the admin API, reauthentication and a second identity provider ──────────

Deno.test("/auth/v1 admin: app_metadata never makes a user an SSO user, nor stops one being one", async () => {
  await withApp(async (h) => {
    const admin = (path: string, body: unknown, method = "POST") =>
      api(h.app, path, { key: h.app.secretKey, method, body });
    const id = await passwordUser(h.app, "regular@corp.example");
    const flipped = await admin(`/admin/users/${id}`, {
      app_metadata: { provider: "sso:acme", plan: "pro" },
    }, "PUT");
    assertEquals(flipped.status, 200, JSON.stringify(flipped.json));
    assertEquals(flipped.json.app_metadata.provider, "email");
    assertEquals(flipped.json.app_metadata.plan, "pro", "the rest of app_metadata is written");
    const stored = await h.app.config.adapter!.getUser(id);
    assertEquals(stored?.appMetadata?.provider, "email");
    // …so its non-SSO sign-ins still work.
    const grant = await api(h.app, "/token?grant_type=password", {
      body: { email: "regular@corp.example", password: PASSWORD },
    });
    assertEquals(grant.status, 200);

    const created = await admin("/admin/users", {
      email: "made@corp.example",
      password: PASSWORD,
      email_confirm: true,
      app_metadata: { provider: "sso:acme" },
    });
    assertEquals(created.status, 200, JSON.stringify(created.json));
    assertEquals(
      (await h.app.config.adapter!.getUser(created.json.id))?.appMetadata?.provider,
      "email",
    );

    const sso = await ssoUser(h.app);
    for (const provider of ["email", "sso:other"]) {
      const cleared = await admin(`/admin/users/${sso.id}`, {
        app_metadata: { provider },
      }, "PUT");
      assertEquals(cleared.status, 200, JSON.stringify(cleared.json));
      assertEquals(
        (await h.app.config.adapter!.getUser(sso.id))?.appMetadata?.provider,
        "sso:acme",
        provider,
      );
    }
    const still = await api(h.app, "/token?grant_type=password", {
      body: { email: SSO_EMAIL, password: PASSWORD },
    });
    assertEquals([still.status, still.json.error_code], [400, "invalid_credentials"]);
  });
});

Deno.test("/auth/v1: GET /reauthenticate for an SSO user sends nothing", async () => {
  await withApp(async (h) => {
    const { token } = await ssoUser(h.app);
    const before = h.sent();
    const res = await api(h.app, "/reauthenticate", { token });
    assertEquals([res.status, res.json.error_code], [422, "user_sso_managed"]);
    assertEquals(h.sent(), before, "no email, no text");
    // A regular user's still sends.
    await passwordUser(h.app, "regular@corp.example");
    const grant = await api(h.app, "/token?grant_type=password", {
      body: { email: "regular@corp.example", password: PASSWORD },
    });
    const regular = await api(h.app, "/reauthenticate", { token: grant.json.access_token });
    assertEquals(regular.status, 200, JSON.stringify(regular.json));
    assertEquals(h.sent(), before + 1);
  });
});

const idp2 = await testIdp("https://idp2.example.org/metadata");

Deno.test("SAML linkExistingAccounts: another identity provider's SSO user is never linked", async () => {
  await withApp(async (h) => {
    const { id } = await ssoUser(h.app);
    const via = { providerId: "beta", idp: idp2 };
    const refused = await samlLanding(h.app, SSO_EMAIL, via);
    assertEquals([refused.status, refused.error], [422, "email_exists"]);
    const accounts = await h.app.config.adapter!.listAccounts!(id);
    assertEquals(accounts.map((account) => account.provider), ["sso:acme"]);
    // A regular account on the same domain still links to it.
    const regular = await passwordUser(h.app, LINKED_EMAIL);
    const linked = await samlLanding(h.app, LINKED_EMAIL, via);
    assertEquals(linked.status, 303, linked.error);
    assert(
      (await h.app.config.adapter!.listAccounts!(regular)).some((a) => a.provider === "sso:beta"),
    );
  }, {
    saml: {
      providers: [
        {
          id: "acme",
          domains: ["corp.example"],
          metadataXml: idp.metadataXml(),
          linkExistingAccounts: true,
        },
        {
          id: "beta",
          domains: ["corp.example"],
          metadataXml: idp2.metadataXml(),
          linkExistingAccounts: true,
        },
      ],
    },
  });
});
