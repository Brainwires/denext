// Account-takeover regressions on `/auth/v1` and the user store it shares with `denextAuth`
// (raw HTTP, the unit suite):
//
// - A password chosen before an address was proven never survives that address's first proof
//   by a magic link, an email one-time code, a recovery link or an anonymous user's address
//   change — only the account's own sign-up confirmation keeps the password it chose.
// - `PUT /user` needs `aal2` to change the password, email or phone of a user with a verified
//   factor (GoTrue's rule), and a session that still owes its second factor is refused by the
//   account endpoints.
// - A ban and an `/auth/v1` password change reach denextAuth's own sign-in and cookie sessions.
// - `session.user.emailVerified` of a JWT bearer comes from the stored user, never from the
//   user-writable `user_metadata`.

import { assert, assertEquals } from "@std/assert";
import { inMemoryAuthAdapter } from "../packages/auth/src/memory-adapter.ts";
import { inMemorySessionStore } from "../packages/auth/src/session-store.ts";
import { sessionFromJwtBearer } from "../packages/auth/src/gotrue/access.ts";
import type { AuthConfig } from "../packages/auth/src/types.ts";
import type { GoTrueOptions } from "../packages/auth/src/gotrue/options.ts";
import { ORIGIN, type SupabaseAuthApp, supabaseAuthApp, totpCode } from "./_supabase-auth-app.ts";
import { ACS, requestIdOf, testIdp } from "./_saml-idp.ts";

interface Call {
  method?: string;
  body?: unknown;
  token?: string;
  key?: string;
}

/** The request headers of a call: the API key, the bearer, the JSON body type. */
function headersOf(app: SupabaseAuthApp, call: Call): Record<string, string> {
  const headers: Record<string, string> = { apikey: call.key ?? app.publishableKey };
  if (call.token) headers.authorization = `Bearer ${call.token}`;
  if (call.body !== undefined) headers["content-type"] = "application/json";
  return headers;
}

async function api(app: SupabaseAuthApp, path: string, call: Call = {}) {
  const res = await app.fetch(`${ORIGIN}/auth/v1${path}`, {
    method: call.method ?? (call.body === undefined ? "GET" : "POST"),
    headers: headersOf(app, call),
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
  });
  const text = await res.text();
  // deno-lint-ignore no-explicit-any
  const json: any = text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : {};
  return { status: res.status, json };
}

async function withApp(
  fn: (app: SupabaseAuthApp) => Promise<void>,
  auth: GoTrueOptions = {},
  authConfig: Partial<AuthConfig> = {},
): Promise<void> {
  const app = await supabaseAuthApp({
    adapter: inMemoryAuthAdapter(),
    auth,
    authConfig: { mfa: { window: 2 }, ...authConfig },
    withClient: false,
  });
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

/** The newest email's link token (`token` query parameter). */
function linkToken(app: SupabaseAuthApp): string {
  return new URL(app.emails.at(-1)!.url).searchParams.get("token")!;
}

/** The newest email's one-time code. */
function emailCode(app: SupabaseAuthApp): string {
  return app.emails.at(-1)!.token;
}

function password(app: SupabaseAuthApp, email: string, secret: string) {
  return api(app, "/token?grant_type=password", { body: { email, password: secret } });
}

/** A JWT's claims (unverified: the server already checked it). */
function claims(token: string): Record<string, unknown> {
  const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(part + "=".repeat((4 - part.length % 4) % 4)));
}

const VICTIM = "victim@example.com";
const ATTACKER_PASSWORD = "attacker-password";

// ── AUTH-1: pre-account hijacking ────────────────────────────────────────────

Deno.test("AUTH-1: a magic link into a squatted account retires the squatter's password", async () => {
  await withApp(async (app) => {
    // The attacker registers the victim's address with their own password (unconfirmed).
    const signup = await api(app, "/signup", {
      body: { email: VICTIM, password: ATTACKER_PASSWORD },
    });
    assertEquals(signup.status, 200);
    // Later the victim signs in with a magic link.
    assertEquals((await api(app, "/otp", { body: { email: VICTIM } })).status, 200);
    const verified = await api(app, "/verify", {
      body: { type: "magiclink", token_hash: linkToken(app) },
    });
    assertEquals(verified.status, 200);
    assert(verified.json.user.email_confirmed_at, "the victim's sign-in confirmed the address");
    const grant = await password(app, VICTIM, ATTACKER_PASSWORD);
    assertEquals(grant.status, 400, "the attacker's password does not sign in");
    assertEquals(grant.json.error_code, "invalid_credentials");
  });
});

Deno.test("AUTH-1: an email one-time code into a squatted account retires the password", async () => {
  await withApp(async (app) => {
    await api(app, "/signup", { body: { email: VICTIM, password: ATTACKER_PASSWORD } });
    await api(app, "/otp", { body: { email: VICTIM } });
    const verified = await api(app, "/verify", {
      body: { type: "email", email: VICTIM, token: emailCode(app) },
    });
    assertEquals(verified.status, 200);
    assertEquals(
      (await password(app, VICTIM, ATTACKER_PASSWORD)).json.error_code,
      "invalid_credentials",
    );
  });
});

Deno.test("AUTH-1: a recovery link into a squatted account retires the password", async () => {
  await withApp(async (app) => {
    await api(app, "/signup", { body: { email: VICTIM, password: ATTACKER_PASSWORD } });
    await api(app, "/recover", { body: { email: VICTIM } });
    const verified = await api(app, "/verify", {
      body: { type: "recovery", token_hash: linkToken(app) },
    });
    assertEquals(verified.status, 200);
    assert(verified.json.user.email_confirmed_at);
    // The victim abandons the reset before choosing a password: the squatter still can't sign in.
    assertEquals(
      (await password(app, VICTIM, ATTACKER_PASSWORD)).json.error_code,
      "invalid_credentials",
    );
  });
});

Deno.test("AUTH-1: an SMS code into a squatted phone account retires the password", async () => {
  await withApp(async (app) => {
    const phone = "+15555550123";
    await api(app, "/signup", { body: { phone, password: ATTACKER_PASSWORD } });
    await api(app, "/otp", { body: { phone } });
    const verified = await api(app, "/verify", {
      body: { type: "sms", phone, token: app.sms.at(-1)!.otp },
    });
    assertEquals(verified.status, 200);
    const grant = await api(app, "/token?grant_type=password", {
      body: { phone, password: ATTACKER_PASSWORD },
    });
    assertEquals(grant.json.error_code, "invalid_credentials");
  });
});

Deno.test("AUTH-1: the account's own sign-up confirmation keeps the password it chose", async () => {
  await withApp(async (app) => {
    await api(app, "/signup", { body: { email: "own@example.com", password: "owner password" } });
    const confirmed = await api(app, "/verify", {
      body: { type: "signup", email: "own@example.com", token: emailCode(app) },
    });
    assertEquals(confirmed.status, 200);
    assertEquals((await password(app, "own@example.com", "owner password")).status, 200);
  });
});

Deno.test("AUTH-1: an anonymous user's password set after an email change is requested does not survive it", async () => {
  await withApp(async (app) => {
    const anon = await api(app, "/signup", { body: {} });
    assertEquals(anon.status, 200);
    const token = anon.json.access_token as string;
    // A password together with the email (GoTrue's documented conversion): kept on confirm.
    assertEquals(
      (await api(app, "/user", {
        method: "PUT",
        token,
        body: { email: "converted@example.com", password: "chosen password" },
      })).status,
      200,
    );
    const code = emailCode(app);
    // Then the session holder changes the password (with a phone, which GoTrue's rule needs)
    // before the email code is redeemed.
    assertEquals(
      (await api(app, "/user", {
        method: "PUT",
        token,
        body: { phone: "+15555550142", password: "swapped password" },
      })).status,
      200,
    );
    const confirmed = await api(app, "/verify", {
      body: { type: "email_change", email: "converted@example.com", token: code },
    });
    assertEquals(confirmed.status, 200);
    assertEquals(confirmed.json.user.is_anonymous, false);
    assertEquals(
      (await password(app, "converted@example.com", "swapped password")).json.error_code,
      "invalid_credentials",
    );
    // An anonymous user may not set a password without an address (GoTrue's rule).
    const other = await api(app, "/signup", { body: {} });
    const refused = await api(app, "/user", {
      method: "PUT",
      token: other.json.access_token,
      body: { password: "no address yet" },
    });
    assertEquals([refused.status, refused.json.error_code], [422, "validation_failed"]);
  }, { anonymousUsers: true });
});

Deno.test("AUTH-1: an anonymous conversion keeps the password chosen with the email", async () => {
  await withApp(async (app) => {
    const anon = await api(app, "/signup", { body: {} });
    await api(app, "/user", {
      method: "PUT",
      token: anon.json.access_token,
      body: { email: "keep@example.com", password: "chosen password" },
    });
    const confirmed = await api(app, "/verify", {
      body: { type: "email_change", email: "keep@example.com", token: emailCode(app) },
    });
    assertEquals(confirmed.status, 200);
    assertEquals((await password(app, "keep@example.com", "chosen password")).status, 200);
  }, { anonymousUsers: true });
});

// ── AUTH-2: aal1 account changes ─────────────────────────────────────────────

/** An MFA user: confirmed, with a verified TOTP factor; their aal2 refresh token. */
async function mfaUser(app: SupabaseAuthApp, email: string, secret: string) {
  const created = await api(app, "/admin/users", {
    body: { email, password: secret, email_confirm: true },
    key: app.secretKey,
  });
  assertEquals(created.status, 200, JSON.stringify(created.json));
  const token = (await password(app, email, secret)).json.access_token as string;
  const enrolled = await api(app, "/factors", { token, body: { factor_type: "totp" } });
  const challenge = await api(app, `/factors/${enrolled.json.id}/challenge`, {
    token,
    body: {},
  });
  const verified = await api(app, `/factors/${enrolled.json.id}/verify`, {
    token,
    body: { challenge_id: challenge.json.id, code: await totpCode(enrolled.json.totp.secret) },
  });
  assertEquals(verified.status, 200, JSON.stringify(verified.json));
  return { id: created.json.id as string, refresh: verified.json.refresh_token as string };
}

Deno.test("AUTH-2: a password-only session of an MFA user can't change the password, email or phone", async () => {
  await withApp(async (app) => {
    const owner = await mfaUser(app, "owner@example.com", "owner-password");
    const attacker = (await password(app, "owner@example.com", "owner-password")).json
      .access_token as string;
    assertEquals(claims(attacker).aal, "aal1");
    for (
      const body of [
        { password: "attacker-new-password" },
        { email: "attacker@evil.test" },
        { phone: "+15555550199" },
        { password: "attacker-new-password", email: "attacker@evil.test" },
      ]
    ) {
      const changed = await api(app, "/user", { method: "PUT", token: attacker, body });
      assertEquals(
        [changed.status, changed.json.error_code],
        [401, "insufficient_aal"],
        JSON.stringify(body),
      );
    }
    // Metadata is not a credential: GoTrue lets an aal1 session write it.
    assertEquals(
      (await api(app, "/user", { method: "PUT", token: attacker, body: { data: { a: 1 } } }))
        .status,
      200,
    );
    // Nothing changed: the owner's aal2 session lives, the password and email are the owner's.
    const refreshed = await api(app, "/token?grant_type=refresh_token", {
      body: { refresh_token: owner.refresh },
    });
    assertEquals(refreshed.status, 200);
    assertEquals(refreshed.json.user.email, "owner@example.com");
    assertEquals((await password(app, "owner@example.com", "owner-password")).status, 200);
    // The account endpoints refuse a session still owing its factor; reading the user and
    // finishing MFA still work.
    assertEquals((await api(app, "/user", { token: attacker })).status, 200);
    const link = await api(app, "/user/identities/authorize?provider=github", {
      token: attacker,
    });
    assertEquals([link.status, link.json.error_code], [403, "insufficient_aal"]);
    // With the factor passed (aal2) the change goes through.
    const aal2 = refreshed.json.access_token as string;
    assertEquals(claims(aal2).aal, "aal2");
    const changed = await api(app, "/user", {
      method: "PUT",
      token: aal2,
      body: { password: "owner-new-password" },
    });
    assertEquals(changed.status, 200);
  }, { autoconfirm: true });
});

// ── AUTH-3: one user store ───────────────────────────────────────────────────

/** A denextAuth credentials sign-in; the session cookie, or the refusal status. */
async function cookieSignIn(app: SupabaseAuthApp, email: string, secret: string) {
  const res = await app.fetch(`${ORIGIN}/auth/callback/credentials`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, password: secret }),
  });
  await res.body?.cancel();
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) =>
    c.includes("denext_auth") && !c.endsWith("=")
  );
  return { status: res.status, cookie };
}

/** The user id the cookie session reads as, or `null`. */
async function cookieUser(app: SupabaseAuthApp, cookie: string): Promise<string | null> {
  const res = await app.fetch(`${ORIGIN}/auth/session`, { headers: { cookie } });
  const body = await res.json();
  return body.user?.id ?? null;
}

Deno.test("AUTH-3: a ban refuses denextAuth sign-in and ends its cookie sessions", async () => {
  await withApp(
    async (app) => {
      const created = await api(app, "/admin/users", {
        body: { email: "bad@example.com", password: "bad-user-password", email_confirm: true },
        key: app.secretKey,
      });
      const id = created.json.id as string;
      const before = await cookieSignIn(app, "bad@example.com", "bad-user-password");
      assertEquals(before.status, 200);
      assertEquals(await cookieUser(app, before.cookie!), id);
      const banned = await api(app, `/admin/users/${id}`, {
        method: "PUT",
        key: app.secretKey,
        body: { ban_duration: "876000h" },
      });
      assertEquals(banned.status, 200);
      assertEquals(await cookieUser(app, before.cookie!), null, "the ban ended the cookie session");
      const after = await cookieSignIn(app, "bad@example.com", "bad-user-password");
      assertEquals(after.status, 403, "a banned user can't sign in through denextAuth");
      assertEquals(
        (await password(app, "bad@example.com", "bad-user-password")).json.error_code,
        "user_banned",
      );
    },
    {},
    { sessionStore: inMemorySessionStore() },
  );
});

Deno.test("AUTH-3: an /auth/v1 password change ends denextAuth cookie sessions", async () => {
  await withApp(
    async (app) => {
      await api(app, "/admin/users", {
        body: { email: "user@example.com", password: "first-password", email_confirm: true },
        key: app.secretKey,
      });
      const stolen = await cookieSignIn(app, "user@example.com", "first-password");
      assert(stolen.cookie);
      const token = (await password(app, "user@example.com", "first-password")).json.access_token;
      const changed = await api(app, "/user", {
        method: "PUT",
        token,
        body: { password: "second-password" },
      });
      assertEquals(changed.status, 200);
      assertEquals(await cookieUser(app, stolen.cookie!), null, "the stolen cookie is signed out");
      assertEquals((await cookieSignIn(app, "user@example.com", "first-password")).status, 401);
      // The caller's own token session stays.
      assertEquals((await api(app, "/user", { token })).status, 200);
    },
    {},
    { sessionStore: inMemorySessionStore() },
  );
});

Deno.test("AUTH-3: an admin password change ends every session of both kinds", async () => {
  await withApp(
    async (app) => {
      const created = await api(app, "/admin/users", {
        body: { email: "user@example.com", password: "first-password", email_confirm: true },
        key: app.secretKey,
      });
      const cookie = (await cookieSignIn(app, "user@example.com", "first-password")).cookie!;
      const session = (await password(app, "user@example.com", "first-password")).json;
      await api(app, `/admin/users/${created.json.id}`, {
        method: "PUT",
        key: app.secretKey,
        body: { password: "admin-set-password" },
      });
      assertEquals(await cookieUser(app, cookie), null);
      assertEquals(
        (await api(app, "/token?grant_type=refresh_token", {
          body: { refresh_token: session.refresh_token },
        })).status,
        400,
      );
    },
    {},
    { sessionStore: inMemorySessionStore() },
  );
});

// ── AUTH-4: emailVerified from the stored user ───────────────────────────────

Deno.test("AUTH-4: user_metadata.email_verified written by the user is not emailVerified", async () => {
  await withApp(async (app) => {
    const signup = await api(app, "/signup", {
      body: { phone: "+15555550100", password: "phone-password" },
    });
    const id = signup.json.user.id as string;
    await api(app, `/admin/users/${id}`, {
      method: "PUT",
      key: app.secretKey,
      body: { email: "unverified@example.com" },
    });
    const first = await api(app, "/token?grant_type=refresh_token", {
      body: { refresh_token: signup.json.refresh_token },
    });
    const wrote = await api(app, "/user", {
      method: "PUT",
      token: first.json.access_token,
      body: { data: { email_verified: true } },
    });
    assertEquals(wrote.status, 200);
    assertEquals(wrote.json.user_metadata.email_verified, false, "the stored flag wins");
    const second = await api(app, "/token?grant_type=refresh_token", {
      body: { refresh_token: first.json.refresh_token },
    });
    const meta = claims(second.json.access_token).user_metadata as Record<string, unknown>;
    assertEquals(meta.email_verified, false);
    const session = await sessionFromJwtBearer(app.config, second.json.access_token);
    assertEquals(session?.user.email, "unverified@example.com");
    assertEquals(session?.user.emailVerified, false);
  }, { phoneAutoconfirm: true });
});

// ── Bans refuse every token at use ───────────────────────────────────────────

/** Ban a user in the store only — no session is revoked — as a missed revocation would leave it. */
async function banInStore(app: SupabaseAuthApp, id: string, seconds = 3600): Promise<void> {
  await app.config.adapter!.updateUser({
    id,
    bannedUntil: Math.floor(Date.now() / 1000) + seconds,
  });
}

Deno.test("a banned user's access token is refused at every use, not only by the revocation", async () => {
  await withApp(async (app) => {
    const signup = await api(app, "/signup", {
      body: { email: "banned@example.com", password: "banned-password" },
    });
    const id = signup.json.user.id as string;
    const token = signup.json.access_token as string;
    assertEquals((await api(app, "/user", { token })).status, 200);
    await banInStore(app, id);
    const refused = await api(app, "/user", { token });
    assertEquals([refused.status, refused.json.error_code], [403, "bad_jwt"]);
    assertEquals(
      await sessionFromJwtBearer(app.config, token),
      null,
      "auth() reads it as signed out",
    );
    const refreshed = await api(app, "/token?grant_type=refresh_token", {
      body: { refresh_token: signup.json.refresh_token },
    });
    assertEquals(refreshed.json.error_code, "user_banned");
    // The ban over, the same token works again.
    await banInStore(app, id, -1);
    assertEquals((await api(app, "/user", { token })).status, 200);
  }, { autoconfirm: true });
});

// ── SSO users: their credentials belong to the IdP ───────────────────────────

const idp = await testIdp();

/** A SAML provider `p1` for `corp.example` (an SSO user's only way in). */
const SSO: GoTrueOptions = {
  saml: { providers: [{ id: "p1", domains: ["corp.example"], metadataXml: idp.metadataXml() }] },
};

/**
 * An SSO user, created by its first SAML sign-in (its only identity is `sso:p1`), and the access
 * token that sign-in issued — an SSO user has no other way to a session.
 */
async function ssoUser(app: SupabaseAuthApp, email: string) {
  const started = await api(app, "/sso", { body: { domain: "corp.example" } });
  assertEquals(started.status, 200, JSON.stringify(started.json));
  const landing = await app.fetch(ACS, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      SAMLResponse: await idp.response({
        inResponseTo: await requestIdOf(started.json.url),
        nameId: email,
      }),
      RelayState: new URL(started.json.url).searchParams.get("RelayState")!,
    }),
    redirect: "manual",
  });
  const fragment = new URLSearchParams(new URL(landing.headers.get("location")!).hash.slice(1));
  const token = fragment.get("access_token");
  assert(token, "the SAML sign-in issued a session");
  return { id: claims(token).sub as string, token };
}

Deno.test("an SSO user can't change its password, email or phone through PUT /user", async () => {
  await withApp(async (app) => {
    const { token } = await ssoUser(app, "worker@corp.example");
    for (
      const body of [
        { password: "a-new-password" },
        { email: "elsewhere@example.com" },
        { phone: "+15555550123" },
        { nonce: "123456" },
      ]
    ) {
      const changed = await api(app, "/user", { method: "PUT", token, body });
      assertEquals(
        [changed.status, changed.json.error_code],
        [422, "user_sso_managed"],
        JSON.stringify(body),
      );
    }
    // Profile data and an unchanged email are not credentials.
    const same = await api(app, "/user", {
      method: "PUT",
      token,
      body: { email: "worker@corp.example", data: { team: "a" } },
    });
    assertEquals(same.status, 200);
    assertEquals(same.json.user_metadata.team, "a");
  }, { ...SSO, autoconfirm: true });
});

Deno.test("an existing account an IdP was linked to keeps its own password changes", async () => {
  await withApp(async (app) => {
    const signup = await api(app, "/signup", {
      body: { email: "linked@corp.example", password: "first-password" },
    });
    await app.config.adapter!.linkAccount({
      userId: signup.json.user.id,
      provider: "sso:p1",
      providerAccountId: "name-id-linked",
      identityId: crypto.randomUUID(),
      identityData: { sub: "name-id-linked" },
    });
    const changed = await api(app, "/user", {
      method: "PUT",
      token: signup.json.access_token,
      body: { password: "second-password" },
    });
    assertEquals(changed.status, 200, JSON.stringify(changed.json));
  }, { autoconfirm: true });
});

Deno.test("an SSO user's identities are its SSO identities only, and the last can't be unlinked", async () => {
  await withApp(async (app) => {
    const { token } = await ssoUser(app, "solo@corp.example");
    const user = await api(app, "/user", { token });
    const identities = user.json.identities as { provider: string; identity_id: string }[];
    assertEquals(identities.map((identity) => identity.provider), ["sso:p1"]);
    const unlink = await api(app, `/user/identities/${identities[0].identity_id}`, {
      method: "DELETE",
      token,
    });
    assertEquals([unlink.status, unlink.json.error_code], [422, "single_identity_not_deletable"]);
  }, { ...SSO, autoconfirm: true, manualLinking: true });
});

// ── Sign-up on an account created by a code or an invite ─────────────────────

Deno.test("a sign-up on an unconfirmed account with no password binds the sign-up's password", async () => {
  await withApp(async (app) => {
    // A one-time code request creates the account, with no password and nothing confirmed.
    assertEquals((await api(app, "/otp", { body: { email: "late@example.com" } })).status, 200);
    const signup = await api(app, "/signup", {
      body: { email: "late@example.com", password: "chosen-password" },
    });
    assertEquals(signup.status, 200);
    const confirmed = await api(app, "/verify", {
      body: { type: "signup", email: "late@example.com", token: emailCode(app) },
    });
    assertEquals(confirmed.status, 200, JSON.stringify(confirmed.json));
    assertEquals((await password(app, "late@example.com", "chosen-password")).status, 200);
  });
});

Deno.test("a contested sign-up stays contested: a later sign-up's password is not bound", async () => {
  await withApp(async (app) => {
    await api(app, "/signup", { body: { email: "c@example.com", password: "owner-password" } });
    await api(app, "/signup", { body: { email: "c@example.com", password: "other-password" } });
    // The contest left a password nobody holds: a third sign-up can't make its own stick.
    await api(app, "/signup", { body: { email: "c@example.com", password: "third-password" } });
    const confirmed = await api(app, "/verify", {
      body: { type: "signup", email: "c@example.com", token: emailCode(app) },
    });
    assertEquals(confirmed.status, 200);
    for (const guess of ["owner-password", "other-password", "third-password"]) {
      assertEquals(
        (await password(app, "c@example.com", guess)).json.error_code,
        "invalid_credentials",
        guess,
      );
    }
  });
});

Deno.test("a sign-up never touches the password of an account with a verified phone", async () => {
  await withApp(async (app) => {
    const phone = await api(app, "/signup", {
      body: { phone: "+15555550111", password: "phone-password" },
    });
    await api(app, `/admin/users/${phone.json.user.id}`, {
      method: "PUT",
      key: app.secretKey,
      body: { email: "unconfirmed@example.com" },
    });
    await api(app, "/signup", {
      body: { email: "unconfirmed@example.com", password: "stranger-password" },
    });
    const grant = await api(app, "/token?grant_type=password", {
      body: { phone: "+15555550111", password: "phone-password" },
    });
    assertEquals(grant.status, 200, "the owner's password still signs in");
  }, { phoneAutoconfirm: true });
});

// ── generate_link type=signup ────────────────────────────────────────────────

Deno.test("a generated sign-up link confirms the account with the password the admin set", async () => {
  await withApp(async (app) => {
    const link = await api(app, "/admin/generate_link", {
      key: app.secretKey,
      body: { type: "signup", email: "made@example.com", password: "admin-set-password" },
    });
    assertEquals(link.status, 200);
    const confirmed = await api(app, "/verify", {
      body: { type: "signup", token_hash: link.json.hashed_token },
    });
    assertEquals(confirmed.status, 200, JSON.stringify(confirmed.json));
    assertEquals((await password(app, "made@example.com", "admin-set-password")).status, 200);
  });
});
