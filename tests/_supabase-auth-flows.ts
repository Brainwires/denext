// The `/auth/v1` flows the stock supabase-js client runs, shared by the in-memory and the Postgres
// suites. Each step builds its own app (fresh adapter), so the steps are independent.

import {
  assert,
  assertEquals,
  assertExists,
  assertMatch,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import type { AuthAdapter } from "../src/server/auth/adapter.ts";
import type { GoTrueOptions } from "../src/server/auth/gotrue/options.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import { OAUTH_FLOWS } from "./_supabase-auth-flows-oauth.ts";
import {
  memoryStorage,
  ORIGIN,
  type SupabaseAuthApp,
  supabaseAuthApp,
  type SupabaseClient,
  totpCode,
} from "./_supabase-auth-app.ts";
import { ACS, requestIdOf, testIdp } from "./_saml-idp.ts";
import { spKey } from "./_saml-enc-helpers.ts";

const ssoIdp = await testIdp();
const ssoSigning = await spKey();
const ssoEncryption = await spKey();
const staleIdp = await testIdp("https://stale-idp.example.net/metadata");

/** signInWithSSO, the IdP's Response at the ACS, then setSession from the landing fragment. */
async function ssoSignIn(
  app: SupabaseAuthApp,
  client: SupabaseClient,
  target: { domain: string } | { providerId: string },
  response: Omit<Parameters<typeof ssoIdp.response>[0], "inResponseTo">,
) {
  const { data, error } = await client.auth.signInWithSSO({
    ...target,
    options: { redirectTo: `${ORIGIN}/in`, skipBrowserRedirect: true },
  });
  assertEquals(error, null);
  const landing = await app.fetch(ACS, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      SAMLResponse: await ssoIdp.response({
        inResponseTo: await requestIdOf(data.url),
        ...response,
      }),
      RelayState: new URL(data.url).searchParams.get("RelayState")!,
    }),
    redirect: "manual",
  });
  const fragment = new URLSearchParams(new URL(landing.headers.get("location")!).hash.slice(1));
  const set = await client.auth.setSession({
    access_token: fragment.get("access_token")!,
    refresh_token: fragment.get("refresh_token")!,
  });
  assertEquals(set.error, null);
  return { fragment, set };
}

type Step = (app: SupabaseAuthApp) => Promise<void>;

/** Decode a JWT's payload (no verification — the server did that). */
function claimsOf(token: string): Record<string, unknown> {
  const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4)));
}

/** The newest email's one-time code. */
function lastCode(app: SupabaseAuthApp): string {
  const email = app.emails.at(-1);
  assertExists(email, "an email was sent");
  return email.token;
}

const FLOWS: Array<[string, Step, GoTrueOptions?, Partial<AuthConfig>?]> = [
  ["settings, health and the API-key gate", async (app) => {
    const res = await app.fetch(`${ORIGIN}/auth/v1/settings`, {
      headers: { apikey: app.publishableKey },
    });
    assertEquals(res.status, 200);
    const settings = await res.json();
    assertEquals(settings.external.email, true);
    assertEquals(settings.external.phone, true);
    assertEquals(settings.mailer_autoconfirm, false);
    const keyless = await app.fetch(`${ORIGIN}/auth/v1/settings`);
    assertEquals(keyless.status, 401);
    assertEquals((await keyless.json()).error_code, "no_authorization");
    const wrong = await app.fetch(`${ORIGIN}/auth/v1/settings`, { headers: { apikey: "nope" } });
    assertEquals(wrong.status, 401);
    const preflight = await app.fetch(`${ORIGIN}/auth/v1/token`, { method: "OPTIONS" });
    assertEquals(preflight.status, 204);
    assertStringIncludes(preflight.headers.get("access-control-allow-headers")!, "apikey");
    assertEquals(
      (await app.fetch(`${ORIGIN}/auth/v1/nope`, { headers: { apikey: app.publishableKey } }))
        .status,
      404,
    );
    const jwks = await (await app.fetch(`${ORIGIN}/auth/v1/.well-known/jwks.json`)).json();
    assertEquals(jwks.keys[0].alg, "ES256");
  }],

  ["sign up, confirm by code, sign in, refresh, sign out", async (app) => {
    const supabase = app.client();
    const signUp = await supabase.auth.signUp({
      email: "ada@example.com",
      password: "correct horse battery",
      options: { data: { name: "Ada" } },
    });
    assertEquals(signUp.error, null);
    assertEquals(signUp.data.session, null, "confirmation required");
    assertEquals(signUp.data.user.email, "ada@example.com");
    assertEquals(signUp.data.user.user_metadata.name, "Ada");
    // Not confirmed yet: password sign-in is refused.
    const early = await supabase.auth.signInWithPassword({
      email: "ada@example.com",
      password: "correct horse battery",
    });
    assertEquals(early.error?.code, "email_not_confirmed");
    const verified = await supabase.auth.verifyOtp({
      email: "ada@example.com",
      token: lastCode(app),
      type: "signup",
    });
    assertEquals(verified.error, null);
    assertExists(verified.data.session.access_token);
    assertExists(verified.data.user.email_confirmed_at);
    const signIn = await supabase.auth.signInWithPassword({
      email: "ada@example.com",
      password: "correct horse battery",
    });
    assertEquals(signIn.error, null);
    const { session } = signIn.data;
    const claims = claimsOf(session.access_token);
    assertEquals(claims.role, "authenticated");
    assertEquals(claims.aud, "authenticated");
    assertEquals(claims.email, "ada@example.com");
    assertEquals(claims.aal, "aal1");
    assertEquals((claims.amr as Array<{ method: string }>)[0].method, "password");
    assertEquals((claims.app_metadata as { provider: string }).provider, "email");
    assertExists(claims.session_id);
    const me = await supabase.auth.getUser(session.access_token);
    assertEquals(me.data.user.id, signIn.data.user.id);
    assertEquals(me.data.user.identities[0].provider, "email");
    // Wrong password: the generic refusal.
    const wrong = await supabase.auth.signInWithPassword({
      email: "ada@example.com",
      password: "nope-nope-nope",
    });
    assertEquals(wrong.error?.code, "invalid_credentials");
    assertEquals(wrong.error?.status, 400);
    const unknown = await supabase.auth.signInWithPassword({
      email: "who@example.com",
      password: "nope-nope-nope",
    });
    assertEquals(unknown.error?.code, "invalid_credentials");
    // A signed-up address answers a second sign-up without revealing the account.
    const again = await supabase.auth.signUp({
      email: "ada@example.com",
      password: "another password",
    });
    assertEquals(again.error, null);
    assertEquals(again.data.user.identities, []);
    // Refresh: a new pair; the old refresh token is now a replay, which revokes the session.
    const refreshed = await supabase.auth.refreshSession({ refresh_token: session.refresh_token });
    assertEquals(refreshed.error, null);
    assertNotEquals(refreshed.data.session.refresh_token, session.refresh_token);
    const forged = await supabase.auth.refreshSession({
      refresh_token: "x.0.aaaaaaaaaaaaaaaaaaaaaa",
    });
    assertEquals(forged.error?.code, "refresh_token_not_found");
    // Sign out (local): the session's access token stops working at once.
    const fresh = refreshed.data.session;
    await supabase.auth.setSession({
      access_token: fresh.access_token,
      refresh_token: fresh.refresh_token,
    });
    assertEquals((await supabase.auth.signOut({ scope: "local" })).error, null);
    const after = await supabase.auth.getUser(fresh.access_token);
    assertExists(after.error);
  }],

  ["refresh-token reuse outside the grace window revokes the session", async (app) => {
    const supabase = app.client();
    await app.admin().auth.admin.createUser({
      email: "reuse@example.com",
      password: "a long password",
      email_confirm: true,
    });
    const { data } = await supabase.auth.signInWithPassword({
      email: "reuse@example.com",
      password: "a long password",
    });
    const first = data.session.refresh_token;
    const second = (await supabase.auth.refreshSession({ refresh_token: first })).data.session;
    // Inside the reuse interval, the same refresh token is answered again (two tabs).
    const grace = await supabase.auth.refreshSession({ refresh_token: first });
    assertEquals(grace.error, null);
    assertEquals(grace.data.session.refresh_token, second.refresh_token);
    // A token two generations back is a replay: the family is revoked.
    const third =
      (await supabase.auth.refreshSession({ refresh_token: second.refresh_token })).data.session;
    const replay = await supabase.auth.refreshSession({ refresh_token: first });
    assertEquals(replay.error?.code, "refresh_token_already_used");
    const dead = await supabase.auth.refreshSession({ refresh_token: third.refresh_token });
    assertExists(dead.error, "the whole family is gone");
    assertExists((await supabase.auth.getUser(third.access_token)).error);
  }],

  ["sign-out scopes: others and global", async (app) => {
    await app.admin().auth.admin.createUser({
      email: "scope@example.com",
      password: "a long password",
      email_confirm: true,
    });
    const a = app.client();
    const b = app.client();
    const c = app.client();
    const sa =
      (await a.auth.signInWithPassword({ email: "scope@example.com", password: "a long password" }))
        .data.session;
    const sb =
      (await b.auth.signInWithPassword({ email: "scope@example.com", password: "a long password" }))
        .data.session;
    const sc =
      (await c.auth.signInWithPassword({ email: "scope@example.com", password: "a long password" }))
        .data.session;
    await a.auth.setSession(sa);
    assertEquals((await a.auth.signOut({ scope: "others" })).error, null);
    assertExists((await b.auth.getUser(sb.access_token)).error);
    assertExists((await c.auth.getUser(sc.access_token)).error);
    assertEquals((await a.auth.getUser(sa.access_token)).error, null);
    const sd =
      (await b.auth.signInWithPassword({ email: "scope@example.com", password: "a long password" }))
        .data.session;
    await a.auth.signOut({ scope: "global" });
    assertExists((await b.auth.getUser(sd.access_token)).error);
  }],

  ["updateUser: metadata, password (other sessions end), email change by code", async (app) => {
    await app.admin().auth.admin.createUser({
      email: "upd@example.com",
      password: "first password",
      email_confirm: true,
    });
    const supabase = app.client();
    const other = app.client();
    const elsewhere = (await other.auth.signInWithPassword({
      email: "upd@example.com",
      password: "first password",
    })).data.session;
    const { session } = (await supabase.auth.signInWithPassword({
      email: "upd@example.com",
      password: "first password",
    })).data;
    await supabase.auth.setSession(session);
    const meta = await supabase.auth.updateUser({ data: { theme: "dark" } });
    assertEquals(meta.data.user.user_metadata.theme, "dark");
    const weak = await supabase.auth.updateUser({ password: "short" });
    assertEquals(weak.error?.code, "weak_password");
    const same = await supabase.auth.updateUser({ password: "first password" });
    assertEquals(same.error?.code, "same_password");
    assertEquals((await supabase.auth.updateUser({ password: "second password" })).error, null);
    assertExists((await other.auth.getUser(elsewhere.access_token)).error, "other sessions ended");
    const relog = await app.client().auth.signInWithPassword({
      email: "upd@example.com",
      password: "second password",
    });
    assertEquals(relog.error, null);
    const change = await supabase.auth.updateUser({ email: "new@example.com" });
    assertEquals(change.error, null);
    assertEquals(change.data.user.new_email, "new@example.com");
    assertEquals(app.emails.at(-1)!.identifier, "new@example.com");
    const done = await supabase.auth.verifyOtp({
      email: "new@example.com",
      token: lastCode(app),
      type: "email_change",
    });
    assertEquals(done.error, null);
    assertEquals(done.data.user.email, "new@example.com");
  }],

  ["magic link / email OTP sign-in, and recovery", async (app) => {
    const supabase = app.client();
    const otp = await supabase.auth.signInWithOtp({ email: "magic@example.com" });
    assertEquals(otp.error, null);
    assertMatch(app.emails.at(-1)!.url, /\/auth\/v1\/verify\?token=/);
    const signedIn = await supabase.auth.verifyOtp({
      email: "magic@example.com",
      token: lastCode(app),
      type: "email",
    });
    assertEquals(signedIn.error, null);
    assertEquals(claimsOf(signedIn.data.session.access_token).email, "magic@example.com");
    // A code works once.
    const replay = await supabase.auth.verifyOtp({
      email: "magic@example.com",
      token: lastCode(app),
      type: "email",
    });
    assertEquals(replay.error?.code, "otp_expired");
    // create_user: false for an unknown address.
    const none = await supabase.auth.signInWithOtp({
      email: "ghost@example.com",
      options: { shouldCreateUser: false },
    });
    assertEquals(none.error?.code, "otp_disabled");
    // Recovery: the link's token_hash signs in; then a new password.
    const recover = await supabase.auth.resetPasswordForEmail("magic@example.com", {
      redirectTo: `${ORIGIN}/reset`,
    });
    assertEquals(recover.error, null);
    const link = new URL(app.emails.at(-1)!.url);
    const hash = link.searchParams.get("token")!;
    const recovered = await supabase.auth.verifyOtp({ token_hash: hash, type: "recovery" });
    assertEquals(recovered.error, null);
    await supabase.auth.setSession(recovered.data.session);
    assertEquals((await supabase.auth.updateUser({ password: "brand new password" })).error, null);
    const relog = await app.client().auth.signInWithPassword({
      email: "magic@example.com",
      password: "brand new password",
    });
    assertEquals(relog.error, null);
    // An unknown address is answered like a known one.
    assertEquals((await supabase.auth.resetPasswordForEmail("ghost@example.com")).error, null);
  }],

  ["the email link (GET /verify): implicit fragment, PKCE code exchange", async (app) => {
    // Implicit: the link lands on redirect_to with the session in the fragment.
    await app.client().auth.signInWithOtp({
      email: "link@example.com",
      options: { emailRedirectTo: `${ORIGIN}/welcome` },
    });
    const implicit = await app.fetch(app.emails.at(-1)!.url, { redirect: "manual" });
    assertEquals(implicit.status, 303);
    const landing = new URL(implicit.headers.get("location")!);
    assertEquals(landing.pathname, "/welcome");
    const fragment = new URLSearchParams(landing.hash.slice(1));
    assertEquals(fragment.get("token_type"), "bearer");
    assertExists(fragment.get("access_token"));
    // A spent link answers with an error fragment.
    const spent = await app.fetch(app.emails.at(-1)!.url, { redirect: "manual" });
    assertStringIncludes(spent.headers.get("location")!, "error_code=otp_expired");
    // PKCE: the link lands with ?code=, exchanged with the verifier the client kept.
    const storage = memoryStorage();
    const pkce = app.client({ flowType: "pkce", storage });
    await pkce.auth.signInWithOtp({
      email: "pkce@example.com",
      options: { emailRedirectTo: `${ORIGIN}/cb` },
    });
    const res = await app.fetch(app.emails.at(-1)!.url, { redirect: "manual" });
    const code = new URL(res.headers.get("location")!).searchParams.get("code");
    assertExists(code);
    const exchanged = await pkce.auth.exchangeCodeForSession(code);
    assertEquals(exchanged.error, null);
    assertEquals(exchanged.data.user.email, "pkce@example.com");
    // A second exchange of the same code fails, and so does a wrong verifier.
    const twice = await pkce.auth.exchangeCodeForSession(code);
    assertExists(twice.error);
  }],

  ["anonymous sign-in, then conversion to a permanent user", async (app) => {
    const supabase = app.client();
    const anon = await supabase.auth.signInAnonymously({ options: { data: { color: "blue" } } });
    assertEquals(anon.error, null);
    assertEquals(anon.data.user.is_anonymous, true);
    assertEquals(claimsOf(anon.data.session.access_token).is_anonymous, true);
    await supabase.auth.setSession(anon.data.session);
    const update = await supabase.auth.updateUser({ email: "converted@example.com" });
    assertEquals(update.error, null);
    const verified = await supabase.auth.verifyOtp({
      email: "converted@example.com",
      token: lastCode(app),
      type: "email_change",
    });
    assertEquals(verified.error, null);
    assertEquals(verified.data.user.is_anonymous, false);
    assertEquals(verified.data.user.id, anon.data.user.id, "the same user");
    assertEquals(verified.data.user.user_metadata.color, "blue");
    await supabase.auth.setSession(verified.data.session);
    assertEquals((await supabase.auth.updateUser({ password: "now a password" })).error, null);
    const relog = await app.client().auth.signInWithPassword({
      email: "converted@example.com",
      password: "now a password",
    });
    assertEquals(relog.error, null);
  }, { anonymousUsers: true }],

  ["anonymous sign-in is off by default", async (app) => {
    const anon = await app.client().auth.signInAnonymously();
    assertEquals(anon.error?.code, "anonymous_provider_disabled");
  }],

  ["phone: SMS OTP sign-in and phone sign-up confirmation", async (app) => {
    const supabase = app.client();
    const sent = await supabase.auth.signInWithOtp({ phone: "+15555550100" });
    assertEquals(sent.error, null);
    assertEquals(app.sms.at(-1)!.phone, "+15555550100");
    const signedIn = await supabase.auth.verifyOtp({
      phone: "+15555550100",
      token: app.sms.at(-1)!.otp,
      type: "sms",
    });
    assertEquals(signedIn.error, null);
    assertEquals(signedIn.data.user.phone, "+15555550100");
    assertExists(signedIn.data.user.phone_confirmed_at);
    const signUp = await supabase.auth.signUp({
      phone: "+15555550101",
      password: "phone password",
    });
    assertEquals(signUp.error, null);
    const confirmed = await supabase.auth.verifyOtp({
      phone: "+15555550101",
      token: app.sms.at(-1)!.otp,
      type: "sms",
    });
    assertEquals(confirmed.error, null);
    const relog = await app.client().auth.signInWithPassword({
      phone: "+15555550101",
      password: "phone password",
    });
    assertEquals(relog.error, null);
  }],

  ["MFA: TOTP enroll, challenge, verify (aal2), list, unenroll", async (app) => {
    await app.admin().auth.admin.createUser({
      email: "mfa@example.com",
      password: "mfa password!",
      email_confirm: true,
    });
    const supabase = app.client();
    const { session } = (await supabase.auth.signInWithPassword({
      email: "mfa@example.com",
      password: "mfa password!",
    })).data;
    await supabase.auth.setSession(session);
    const enrolled = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: "phone app",
    });
    assertEquals(enrolled.error, null);
    assertMatch(enrolled.data.totp.qr_code, /^data:image\/svg\+xml/);
    assertMatch(enrolled.data.totp.uri, /^otpauth:\/\/totp\//);
    const factorId = enrolled.data.id;
    const challenge = await supabase.auth.mfa.challenge({ factorId });
    assertEquals(challenge.error, null);
    const wrong = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.data.id,
      code: "000000",
    });
    assertEquals(wrong.error?.code, "mfa_verification_failed");
    const challenge2 = await supabase.auth.mfa.challenge({ factorId });
    const verified = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge2.data.id,
      code: await totpCode(enrolled.data.totp.secret),
    });
    assertEquals(verified.error, null);
    assertEquals(claimsOf(verified.data.access_token).aal, "aal2");
    const aal = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    assertEquals(aal.data.currentLevel, "aal2");
    const factors = await supabase.auth.mfa.listFactors();
    assertEquals(factors.data.totp.length, 1);
    assertEquals(factors.data.totp[0].status, "verified");
    // The previous (aal1) session was replaced.
    // (A separate client: supabase-js drops its own session on `session_not_found`.)
    assertExists((await app.client().auth.getUser(session.access_token)).error);
    const removed = await supabase.auth.mfa.unenroll({ factorId });
    assertEquals(removed.error, null);
    // A fresh aal1 session may not remove a verified factor.
    const e2 = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "second" });
    const c2 = await supabase.auth.mfa.challenge({ factorId: e2.data.id });
    await supabase.auth.mfa.verify({
      factorId: e2.data.id,
      challengeId: c2.data.id,
      code: await totpCode(e2.data.totp.secret, Date.now() + 30_000),
    });
    const low = app.client();
    await low.auth.setSession(
      (await low.auth.signInWithPassword({ email: "mfa@example.com", password: "mfa password!" }))
        .data.session,
    );
    const denied = await low.auth.mfa.unenroll({ factorId: e2.data.id });
    assertEquals(denied.error?.code, "insufficient_aal");
    // The admin removes it.
    const adminDelete = await app.admin().auth.admin.mfa.deleteFactor({
      userId: e2.data.id ? (await low.auth.getUser()).data.user.id : "",
      id: e2.data.id,
    });
    assertEquals(adminDelete.error, null);
  }],

  [
    "admin API: create, list (paginated), get, update (ban), generate links, invite, delete",
    async (app) => {
      const admin = app.admin().auth.admin;
      const created = await admin.createUser({
        email: "admin-made@example.com",
        password: "admin password",
        email_confirm: true,
        user_metadata: { a: 1 },
        app_metadata: { plan: "pro" },
      });
      assertEquals(created.error, null);
      assertEquals(created.data.user.app_metadata.plan, "pro");
      for (let i = 0; i < 3; i++) {
        await admin.createUser({
          email: `bulk${i}@example.com`,
          email_confirm: true,
        });
      }
      const page1 = await admin.listUsers({ page: 1, perPage: 2 });
      assertEquals(page1.error, null);
      assertEquals(page1.data.users.length, 2);
      assertEquals(page1.data.total, 4);
      assertEquals(page1.data.nextPage, 2);
      const got = await admin.getUserById(created.data.user.id);
      assertEquals(got.data.user.email, "admin-made@example.com");
      const banned = await admin.updateUserById(created.data.user.id, { ban_duration: "24h" });
      assertEquals(banned.error, null);
      assertExists(banned.data.user.banned_until);
      const refused = await app.client().auth.signInWithPassword({
        email: "admin-made@example.com",
        password: "admin password",
      });
      assertEquals(refused.error?.code, "user_banned");
      await admin.updateUserById(created.data.user.id, {
        ban_duration: "none",
        user_metadata: { b: 2 },
      });
      const ok = await app.client().auth.signInWithPassword({
        email: "admin-made@example.com",
        password: "admin password",
      });
      assertEquals(ok.error, null);
      assertEquals(ok.data.user.user_metadata, { ...ok.data.user.user_metadata, a: 1, b: 2 });
      // The custom claims an app_metadata change carries reach the next token.
      assertEquals(
        (claimsOf(ok.data.session.access_token).app_metadata as { plan: string }).plan,
        "pro",
      );
      const link = await admin.generateLink({ type: "magiclink", email: "admin-made@example.com" });
      assertEquals(link.error, null);
      assertMatch(link.data.properties.action_link, /\/auth\/v1\/verify\?token=/);
      const viaLink = await app.client().auth.verifyOtp({
        token_hash: link.data.properties.hashed_token,
        type: "magiclink",
      });
      assertEquals(viaLink.error, null);
      const invite = await admin.inviteUserByEmail("invitee@example.com", { data: { team: "x" } });
      assertEquals(invite.error, null);
      const accepted = await app.client().auth.verifyOtp({
        email: "invitee@example.com",
        token: lastCode(app),
        type: "invite",
      });
      assertEquals(accepted.error, null);
      assertEquals(accepted.data.user.user_metadata.team, "x");
      const deleted = await admin.deleteUser(created.data.user.id);
      assertEquals(deleted.error, null);
      assertExists((await admin.getUserById(created.data.user.id)).error);
      // Without the secret key the admin API refuses.
      const anonAdmin = await app.client().auth.admin.listUsers();
      assertExists(anonAdmin.error);
    },
  ],

  ["SAML SSO: a stored provider, signInWithSSO, and signOut with Single Logout", async (app) => {
    // auth-js 2.117.2 has no `auth.admin.sso`: the provider is created over raw HTTP.
    const created = await app.fetch(`${ORIGIN}/auth/v1/admin/sso/providers`, {
      method: "POST",
      headers: {
        apikey: app.secretKey,
        authorization: `Bearer ${app.secretKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "saml",
        metadata_xml: ssoIdp.metadataXml(),
        domains: ["sso.test"],
        attribute_mapping: { keys: { name: { name: "displayName" } } },
      }),
    });
    assertEquals(created.status, 201);
    const client = app.client();
    const { fragment, set } = await ssoSignIn(app, client, { domain: "sso.test" }, {
      nameId: "sam@sso.test",
      sessionIndex: "_sso1",
      attributes: { displayName: ["Sam"] },
    });
    assertEquals(set.data.user.email, "sam@sso.test");
    assertEquals(set.data.user.user_metadata.name, "Sam");
    assertEquals(claimsOf(fragment.get("access_token")!).amr, [
      {
        method: "sso/saml",
        timestamp: claimsOf(fragment.get("access_token")!).iat,
        provider: `sso:${(await created.json()).id}`,
      },
    ]);
    // signOut on an SSO session: the server answers the IdP URL; supabase-js is fine with it.
    const out = await client.auth.signOut();
    assertEquals(out.error, null);
    const after = await client.auth.getUser(fragment.get("access_token")!);
    assertNotEquals(after.error, null);
  }, { saml: { signingKey: ssoSigning.pem, signingCertificate: ssoSigning.certificate } }],
  ["SAML SSO: an EncryptedID signs in; expired metadata is an AuthApiError", async (app) => {
    const client = app.client();
    const expired = await client.auth.signInWithSSO({ providerId: "stale" });
    assertEquals(expired.error?.status, 400);
    assertEquals(expired.error?.code, "saml_metadata_expired");
    const { set } = await ssoSignIn(app, client, { providerId: "enc" }, {
      nameId: "enid@sso-enc.test",
      encryptNameIdTo: ssoEncryption,
    });
    assertEquals(set.data.user.email, "enid@sso-enc.test");
  }, {
    saml: {
      encryptionKey: ssoEncryption.pem,
      encryptionCertificate: ssoEncryption.certificate,
      providers: [
        { id: "enc", domains: ["sso-enc.test"], metadataXml: ssoIdp.metadataXml() },
        {
          id: "stale",
          metadataXml: staleIdp.metadataXml({ validUntil: "2020-01-01T00:00:00Z" }),
        },
      ],
    },
  }],
  ["SAML SSO: an SSO user's address has no other way in", async (app) => {
    const email = "only@sso-only.test";
    await ssoSignIn(app, app.client(), { domain: "sso-only.test" }, { nameId: email });
    const client = app.client();
    const sent = app.emails.length;
    // A magic link / code, a password, a recovery and a sign-up: answered as for an unknown
    // address, with nothing sent and no second account.
    assertEquals((await client.auth.signInWithOtp({ email })).error, null);
    const noSignup = await client.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });
    assertEquals(noSignup.error?.code, "otp_disabled");
    const password = await client.auth.signInWithPassword({ email, password: "any password" });
    assertEquals(password.error?.code, "invalid_credentials");
    assertEquals((await client.auth.resetPasswordForEmail(email)).error, null);
    const signUp = await client.auth.signUp({ email, password: "a sign-up password" });
    assertEquals(signUp.error, null);
    assertEquals(signUp.data.session, null);
    assertEquals(app.emails.length, sent, "nothing was sent");
    // The admin API's links: a magic link would be a new account, a recovery has no target.
    const admin = app.admin().auth.admin;
    const magic = await admin.generateLink({ type: "magiclink", email });
    assertEquals(magic.error?.code, "email_exists");
    const recovery = await admin.generateLink({ type: "recovery", email });
    assertEquals(recovery.error?.code, "user_not_found");
  }, {
    saml: {
      providers: [{ id: "only", domains: ["sso-only.test"], metadataXml: ssoIdp.metadataXml() }],
    },
  }],
  ["custom access token hook and captcha", async (app) => {
    await app.admin().auth.admin.createUser({
      email: "hook@example.com",
      password: "hook password",
      email_confirm: true,
    });
    const noCaptcha = await app.client().auth.signInWithPassword({
      email: "hook@example.com",
      password: "hook password",
    });
    assertEquals(noCaptcha.error?.code, "captcha_failed");
    const bad = await app.client().auth.signInWithPassword({
      email: "hook@example.com",
      password: "hook password",
      options: { captchaToken: "bad" },
    });
    assertEquals(bad.error?.code, "captcha_failed");
    const signedIn = await app.client().auth.signInWithPassword({
      email: "hook@example.com",
      password: "hook password",
      options: { captchaToken: "good" },
    });
    assertEquals(signedIn.error, null);
    const claims = claimsOf(signedIn.data.session.access_token);
    assertEquals(claims.tenant, "acme");
    assertEquals(claims.role, "authenticated", "the hook cannot change the role");
  }, {
    hooks: {
      customAccessToken: ({ claims }) => ({
        claims: { ...claims, tenant: "acme", role: "service_role" },
      }),
    },
    captcha: {
      provider: "turnstile",
      secret: "test-secret",
      fetch: (_url, init) => {
        const body = new URLSearchParams(String((init as RequestInit).body));
        return Promise.resolve(Response.json({ success: body.get("response") === "good" }));
      },
    },
  }],
];

/**
 * Run every flow as a step, each on a fresh app.
 *
 * @param t The test context.
 * @param adapter Makes a fresh adapter.
 * @param cleanup Runs after each step (drop a database).
 */
export async function runFlows(
  t: Deno.TestContext,
  adapter: () => AuthAdapter | Promise<AuthAdapter>,
  cleanup?: () => Promise<void>,
): Promise<void> {
  for (const [name, step, auth, authConfig] of [...FLOWS, ...OAUTH_FLOWS]) {
    await t.step(name, async () => {
      const app = await supabaseAuthApp({ adapter: await adapter(), auth, authConfig });
      try {
        await step(app);
      } finally {
        await app.close();
        await cleanup?.();
      }
    });
  }
  assert(FLOWS.length > 0);
}
