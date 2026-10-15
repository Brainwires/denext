// `/auth/v1` over raw HTTP (no supabase-js, so it runs in the unit suite): the wire shapes, and
// the refusals a client library rarely reaches — the API-key gate, bad bodies, unknown routes,
// validation errors, the admin gate, captcha, redirect allow-listing, rate limits, PKCE
// mistakes, reauthentication, identities, phone factors and generated links. The happy paths
// through the real client are tests/backend-supabase-auth.test.ts.

import { assert, assertEquals, assertExists, assertMatch, assertStringIncludes } from "@std/assert";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { github } from "../src/server/auth/providers.ts";
import type { GoTrueOptions } from "../src/server/auth/gotrue/options.ts";
import { parseBanDuration } from "../src/server/auth/gotrue/routes-admin.ts";
import { ORIGIN, type SupabaseAuthApp, supabaseAuthApp, totpCode } from "./_supabase-auth-app.ts";

interface Call {
  method?: string;
  body?: unknown;
  token?: string;
  key?: string | null;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

async function api(app: SupabaseAuthApp, path: string, call: Call = {}) {
  const url = new URL(`${ORIGIN}/auth/v1${path}`);
  for (const [k, v] of Object.entries(call.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { ...call.headers };
  const key = call.key === undefined ? app.publishableKey : call.key;
  if (key) headers.apikey = key;
  if (call.token) headers.authorization = `Bearer ${call.token}`;
  if (call.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.fetch(url, {
    method: call.method ?? (call.body === undefined ? "GET" : "POST"),
    headers,
    body: call.body === undefined
      ? undefined
      : typeof call.body === "string"
      ? call.body
      : JSON.stringify(call.body),
    redirect: "manual",
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers, text };
}

async function withApp(
  auth: GoTrueOptions,
  fn: (app: SupabaseAuthApp) => Promise<void>,
  extra: Parameters<typeof supabaseAuthApp>[0]["authConfig"] = {},
): Promise<void> {
  const app = await supabaseAuthApp({
    adapter: inMemoryAuthAdapter(),
    auth,
    authConfig: extra,
    withClient: false,
  });
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

/** A confirmed user and a session for them. */
async function signedIn(app: SupabaseAuthApp, email = "u@example.com", password = "a password!") {
  const created = await api(app, "/admin/users", {
    body: { email, password, email_confirm: true },
    key: app.secretKey,
  });
  assertEquals(created.status, 200, JSON.stringify(created.json));
  const session = await api(app, "/token", {
    query: { grant_type: "password" },
    body: { email, password },
  });
  assertEquals(session.status, 200, JSON.stringify(session.json));
  return session.json as {
    access_token: string;
    refresh_token: string;
    user: { id: string; identities: Array<{ identity_id: string; provider: string }> };
  };
}

Deno.test("routing, the API-key gate, bodies and the error shape", async () => {
  await withApp({}, async (app) => {
    assertEquals((await api(app, "/health", { key: null })).status, 200);
    const keyless = await api(app, "/settings", { key: null });
    assertEquals(keyless.status, 401);
    assertEquals(keyless.json.error_code, "no_authorization");
    assertEquals(keyless.json.code, 401);
    assertExists(keyless.json.msg);
    assertEquals(keyless.headers.get("access-control-allow-origin"), "*");
    assertEquals((await api(app, "/settings", { key: "sb_publishable_wrong" })).status, 401);
    // The apikey in the query works too (a link someone pasted).
    assertEquals(
      (await api(app, "/settings", { key: null, query: { apikey: app.publishableKey } })).status,
      200,
    );
    assertEquals((await api(app, "/nope")).json.error_code, "not_found");
    assertEquals((await api(app, "/signup", { method: "GET" })).status, 405);
    assertEquals((await api(app, "/signup", { body: "{nope" })).json.error_code, "bad_json");
    assertEquals((await api(app, "/signup", { body: "[1]" })).json.error_code, "bad_json");
    assertEquals(
      (await api(app, "/signup", { body: { email: 5 } })).json.error_code,
      "validation_failed",
    );
    assertEquals(
      (await api(app, "/signup", { body: { email: "x@", password: "p" } })).json.error_code,
      "email_address_invalid",
    );
    assertEquals(
      (await api(app, "/signup", { body: { email: "a@example.com" } })).json.error_code,
      "validation_failed",
    );
    const weak = await api(app, "/signup", { body: { email: "a@example.com", password: "short" } });
    assertEquals(weak.status, 422);
    assertEquals(weak.json.error_code, "weak_password");
    assertEquals(weak.json.weak_password, { reasons: ["length"] });
    assertEquals(
      (await api(app, "/signup", { body: { phone: "12", password: "long enough!" } })).json
        .error_code,
      "validation_failed",
    );
    assertEquals(
      (await api(app, "/token", { query: { grant_type: "nope" }, body: {} })).json.error_code,
      "validation_failed",
    );
    assertEquals(
      (await api(app, "/token", { query: { grant_type: "password" }, body: {} })).json.error_code,
      "invalid_credentials",
    );
    const preflight = await app.fetch(`${ORIGIN}/auth/v1/user`, { method: "OPTIONS" });
    assertEquals(preflight.status, 204);
    // Outside /auth/v1, the handler is not involved.
    assertEquals((await app.fetch(`${ORIGIN}/auth/v2/x`)).status, 404);
  });
});

Deno.test("settings reflect the options and the configured providers", async () => {
  await withApp({ autoconfirm: true, disableSignup: true, anonymousUsers: true }, async (app) => {
    const settings = (await api(app, "/settings")).json as {
      mailer_autoconfirm: boolean;
      disable_signup: boolean;
      saml_enabled: boolean;
      external: Record<string, boolean>;
    };
    assertEquals(settings.mailer_autoconfirm, true);
    assertEquals(settings.disable_signup, true);
    assertEquals(settings.external.anonymous_users, true);
    assertEquals(settings.external.github, true);
    assertEquals(settings.saml_enabled, false);
    const refused = await api(app, "/signup", {
      body: { email: "a@example.com", password: "long enough!" },
    });
    assertEquals(refused.json.error_code, "signup_disabled");
  }, { providers: [github({ clientId: "id", clientSecret: "secret" })] as never });
});

Deno.test("autoconfirm: sign-up signs in at once; a second sign-up is user_already_exists", async () => {
  await withApp({ autoconfirm: true, phoneAutoconfirm: true }, async (app) => {
    const first = await api(app, "/signup", {
      body: { email: "a@example.com", password: "long enough!" },
    });
    assertEquals(first.status, 200);
    assertExists(first.json.access_token);
    assertEquals(first.json.token_type, "bearer");
    const again = await api(app, "/signup", {
      body: { email: "a@example.com", password: "long enough!" },
    });
    assertEquals(again.json.error_code, "user_already_exists");
    const phone = await api(app, "/signup", {
      body: { phone: "+1 (555) 555-0123", password: "long enough!" },
    });
    assertEquals((phone.json.user as { phone: string }).phone, "+15555550123");
    assertEquals(
      (await api(app, "/signup", { body: { phone: "+15555550123", password: "long enough!" } }))
        .json.error_code,
      "user_already_exists",
    );
  });
});

Deno.test("the admin gate: only the secret key; the admin user routes' refusals", async () => {
  await withApp({}, async (app) => {
    const { access_token } = await signedIn(app);
    assertEquals(
      (await api(app, "/admin/users", { key: null })).json.error_code,
      "no_authorization",
    );
    assertEquals((await api(app, "/admin/users")).json.error_code, "not_admin");
    assertEquals(
      (await api(app, "/admin/users", { token: access_token })).json.error_code,
      "not_admin",
    );
    const admin = { key: app.secretKey };
    // The secret key as the bearer works as well as in the apikey header.
    assertEquals((await api(app, "/admin/users", { key: null, token: app.secretKey })).status, 200);
    assertEquals((await api(app, "/admin/users/nope", admin)).json.error_code, "user_not_found");
    assertEquals((await api(app, "/admin/users/../x", admin)).status, 404);
    const dup = await api(app, "/admin/users", { ...admin, body: { email: "u@example.com" } });
    assertEquals(dup.json.error_code, "email_exists");
    const phoneUser = await api(app, "/admin/users", {
      ...admin,
      body: { phone: "+15555550111", phone_confirm: true },
    });
    assertEquals(phoneUser.status, 200);
    assertEquals(
      (await api(app, "/admin/users", { ...admin, body: { phone: "+15555550111" } })).json
        .error_code,
      "phone_exists",
    );
    const anon = await api(app, "/admin/users", { ...admin, body: {} });
    assertEquals((anon.json as { is_anonymous: boolean }).is_anonymous, true);
    const id = (phoneUser.json as { id: string }).id;
    assertEquals(
      (await api(app, `/admin/users/${id}`, {
        ...admin,
        method: "PUT",
        body: { ban_duration: "1x" },
      })).json.error_code,
      "validation_failed",
    );
    assertEquals(
      (await api(app, `/admin/users/${id}`, {
        ...admin,
        method: "PUT",
        body: { email: "u@example.com" },
      })).json.error_code,
      "email_exists",
    );
    const list = await api(app, "/admin/users", { ...admin, query: { page: "2", per_page: "1" } });
    assertEquals(list.headers.get("x-total-count"), "3");
    assertStringIncludes(list.headers.get("link")!, 'rel="next"');
    // supabase-js's `listUsers()` with no options sends empty values: GoTrue's defaults apply.
    const defaults = await api(app, "/admin/users", {
      ...admin,
      query: { page: "", per_page: "" },
    });
    assertEquals((defaults.json.users as unknown[]).length, 3);
    assertEquals(
      defaults.headers.get("link"),
      '</auth/v1/admin/users?page=1&per_page=50>; rel="last"',
    );
    assertEquals((await api(app, `/admin/users/${id}/factors`, admin)).json, [] as never);
    assertEquals(
      (await api(app, `/admin/users/${id}/factors/nope`, { ...admin, method: "DELETE" })).json
        .error_code,
      "mfa_factor_not_found",
    );
    assertEquals(
      (await api(app, "/invite", { ...admin, body: { email: "u@example.com" } })).json.error_code,
      "email_exists",
    );
    assertEquals(
      (await api(app, "/invite", { ...admin, body: {} })).json.error_code,
      "validation_failed",
    );
  });
});

Deno.test("parseBanDuration reads Go durations", () => {
  assertEquals(parseBanDuration("none"), 0);
  assertEquals(parseBanDuration("24h"), 86_400);
  assertEquals(parseBanDuration("1h30m10s"), 5410);
  assertEquals(parseBanDuration("1500ms"), 1);
  for (const bad of ["", "h", "10", "1d", "1h junk"]) {
    let threw = false;
    try {
      parseBanDuration(bad);
    } catch {
      threw = true;
    }
    assert(threw, bad);
  }
});

Deno.test("generate_link: every type, and the refusals", async () => {
  await withApp({}, async (app) => {
    const admin = { key: app.secretKey };
    const link = (body: Record<string, unknown>) =>
      api(app, "/admin/generate_link", { ...admin, body });
    const signup = await link({
      type: "signup",
      email: "new@example.com",
      password: "long enough!",
    });
    assertEquals(signup.status, 200);
    assertEquals(signup.json.verification_type, "signup");
    assertMatch(String(signup.json.action_link), /\/auth\/v1\/verify\?token=.*type=signup/);
    assertMatch(String(signup.json.email_otp), /^\d{6}$/);
    assertEquals((await link({ type: "invite", email: "new2@example.com" })).status, 200);
    assertEquals(
      (await link({ type: "magiclink", email: "ghost@example.com" })).json.error_code,
      "user_not_found",
    );
    assertEquals(
      (await link({ type: "recovery", email: "new@example.com" })).json.verification_type,
      "recovery",
    );
    assertEquals(
      (await link({ type: "email_change_new", email: "new@example.com" })).json.error_code,
      "validation_failed",
    );
    const change = await link({
      type: "email_change_new",
      email: "new@example.com",
      new_email: "moved@example.com",
    });
    assertEquals(change.json.verification_type, "email_change");
    assertEquals(
      (await link({ type: "bogus", email: "new@example.com" })).json.error_code,
      "validation_failed",
    );
    assertEquals((await link({ type: "signup" })).json.error_code, "validation_failed");
    // The email-change code moves the address.
    const verified = await api(app, "/verify", {
      body: { type: "email_change", email: "moved@example.com", token: change.json.email_otp },
    });
    assertEquals(verified.status, 200);
    assertEquals((verified.json.user as { email: string }).email, "moved@example.com");
    await signedIn(app, "conf@example.com");
    assertEquals(
      (await link({ type: "signup", email: "conf@example.com" })).json.error_code,
      "email_exists",
    );
  });
});

Deno.test("verify: refusals, the GET link's error redirect, and redirect allow-listing", async () => {
  await withApp({ redirectUrls: ["https://other.example/**"] }, async (app) => {
    assertEquals(
      (await api(app, "/verify", { body: { type: "bogus", token: "1" } })).json.error_code,
      "validation_failed",
    );
    assertEquals(
      (await api(app, "/verify", { body: { type: "email", token: "123456" } })).json.error_code,
      "validation_failed",
    );
    assertEquals(
      (await api(app, "/verify", {
        body: { type: "email", email: "a@example.com", token: "123456" },
      })).json.error_code,
      "otp_expired",
    );
    assertEquals(
      (await api(app, "/verify", { body: { type: "magiclink", token_hash: "garbage" } })).json
        .error_code,
      "otp_expired",
    );
    // The GET link: unknown type, missing token, a forged hash → an error fragment on the site URL.
    const queries: Record<string, string>[] = [
      { type: "nope", token: "x" },
      { type: "signup" },
      { type: "signup", token: "eA.bad" },
    ];
    for (const query of queries) {
      const res = await api(app, "/verify", { key: null, query });
      assertEquals(res.status, 303);
      assertStringIncludes(res.headers.get("location")!, `${ORIGIN}#error=access_denied`);
    }
    // redirect_to: same origin and the allow-list pass; anything else lands on the site URL.
    const send = async (redirect: string) => {
      await api(app, "/otp", {
        body: { email: "r@example.com" },
        query: { redirect_to: redirect },
      });
      return new URL(app.emails.at(-1)!.url).searchParams.get("redirect_to");
    };
    assertEquals(await send(`${ORIGIN}/after`), `${ORIGIN}/after`);
    assertEquals(await send("https://other.example/deep/path"), "https://other.example/deep/path");
    assertEquals(await send("https://evil.example/"), ORIGIN);
    assertEquals(await send("javascript:alert(1)"), ORIGIN);
    assertEquals(await send("https://user:pw@other.example/x"), ORIGIN);
  });
});

Deno.test("OTP sends are rate-limited per address", async () => {
  await withApp({}, async (app) => {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await api(app, "/otp", { body: { email: "limited@example.com" } })).status);
    }
    assertEquals(statuses.slice(0, 3), [200, 200, 200]);
    const last = await api(app, "/otp", { body: { email: "limited@example.com" } });
    assertEquals(last.status, 429);
    assertEquals(last.json.error_code, "over_email_send_rate_limit");
    assertEquals(last.headers.get("retry-after"), "60");
  }, { rateLimit: {} });
});

Deno.test("phone: disabled without sendSms; phone MFA factors when on", async () => {
  await withApp({ mfa: { phone: true } }, async (app) => {
    const { access_token } = await signedIn(app);
    const enroll = await api(app, "/factors", {
      token: access_token,
      body: { factor_type: "phone", phone: "+15555550199", friendly_name: "cell" },
    });
    assertEquals(enroll.status, 200, JSON.stringify(enroll.json));
    const factorId = enroll.json.id as string;
    assertEquals(
      (await api(app, "/factors", {
        token: access_token,
        body: { factor_type: "phone", phone: "+15555550199" },
      })).json.error_code,
      "validation_failed",
    );
    assertEquals(
      (await api(app, "/factors", {
        token: access_token,
        body: { factor_type: "totp", friendly_name: "cell" },
      })).json.error_code,
      "validation_failed",
    );
    assertEquals(
      (await api(app, "/factors", { token: access_token, body: { factor_type: "webauthn" } })).json
        .error_code,
      "validation_failed",
    );
    const challenge = await api(app, `/factors/${factorId}/challenge`, {
      token: access_token,
      body: {},
    });
    assertEquals(challenge.status, 200);
    const code = app.sms.at(-1)!.otp;
    assertEquals(app.sms.at(-1)!.type, "mfa");
    const verified = await api(app, `/factors/${factorId}/verify`, {
      token: access_token,
      body: { challenge_id: challenge.json.id, code },
    });
    assertEquals(verified.status, 200, JSON.stringify(verified.json));
    const aal2 = verified.json.access_token as string;
    // The challenge was single-use.
    const replay = await api(app, `/factors/${factorId}/verify`, {
      token: aal2,
      body: { challenge_id: challenge.json.id, code },
    });
    assertEquals(replay.json.error_code, "mfa_challenge_expired");
    assertEquals(
      (await api(app, "/factors/nope/challenge", { token: aal2, body: {} })).json.error_code,
      "mfa_factor_not_found",
    );
    const user = (await api(app, "/user", { token: aal2 })).json as {
      factors: Array<{ status: string }>;
    };
    assertEquals(user.factors[0].status, "verified");
    assertEquals(
      (await api(app, `/factors/${factorId}`, { token: aal2, method: "DELETE" })).json.id,
      factorId,
    );
  });
  await withApp({ sendSms: undefined, hooks: {} }, async (app) => {
    const { access_token } = await signedIn(app);
    const refused = await api(app, "/factors", {
      token: access_token,
      body: { factor_type: "phone", phone: "+15555550199" },
    });
    assertEquals(refused.json.error_code, "mfa_phone_enroll_not_enabled");
  });
});

Deno.test("TOTP: a code is accepted once (replay guard), wrong codes are refused", async () => {
  await withApp({}, async (app) => {
    const { access_token } = await signedIn(app);
    const enroll = await api(app, "/factors", {
      token: access_token,
      body: { factor_type: "totp" },
    });
    const id = enroll.json.id as string;
    const secret = (enroll.json.totp as { secret: string }).secret;
    const c1 = await api(app, `/factors/${id}/challenge`, { token: access_token, body: {} });
    const code = await totpCode(secret);
    const ok = await api(app, `/factors/${id}/verify`, {
      token: access_token,
      body: { challenge_id: c1.json.id, code },
    });
    assertEquals(ok.status, 200);
    const token = ok.json.access_token as string;
    const c2 = await api(app, `/factors/${id}/challenge`, { token, body: {} });
    const again = await api(app, `/factors/${id}/verify`, {
      token,
      body: { challenge_id: c2.json.id, code },
    });
    assertEquals(again.json.error_code, "mfa_verification_failed");
  });
});

Deno.test("user: reauthentication for a password change, identities, logout scope", async () => {
  await withApp({ requireReauthentication: true }, async (app) => {
    const { access_token, user } = await signedIn(app);
    const needs = await api(app, "/user", {
      token: access_token,
      method: "PUT",
      body: { password: "brand new one" },
    });
    assertEquals(needs.json.error_code, "reauthentication_needed");
    const bad = await api(app, "/user", {
      token: access_token,
      method: "PUT",
      body: { password: "brand new one", nonce: "000000" },
    });
    assertEquals(bad.json.error_code, "reauthentication_not_valid");
    assertEquals((await api(app, "/reauthenticate", { token: access_token })).status, 200);
    const nonce = app.emails.at(-1)!.token;
    const ok = await api(app, "/user", {
      token: access_token,
      method: "PUT",
      body: { password: "brand new one", nonce },
    });
    assertEquals(ok.status, 200, JSON.stringify(ok.json));
    // Identities: the only one can't go, an unknown one is 404, the email one can't be unlinked.
    const only = user.identities[0].identity_id;
    assertEquals(
      (await api(app, `/user/identities/${only}`, { token: access_token, method: "DELETE" })).json
        .error_code,
      "single_identity_not_deletable",
    );
    assertEquals(
      (await api(app, "/user/identities/nope", { token: access_token, method: "DELETE" })).json
        .error_code,
      "identity_not_found",
    );
    assertEquals(
      (await api(app, "/logout", { token: access_token, query: { scope: "bogus" }, body: {} })).json
        .error_code,
      "validation_failed",
    );
    assertEquals((await api(app, "/logout", { body: {} })).json.error_code, "no_authorization");
    assertEquals((await api(app, "/user", { token: "a.b.c" })).json.error_code, "bad_jwt");
    assertEquals(
      (await api(app, "/user", { token: app.secretKey })).json.error_code,
      "no_authorization",
    );
  });
});

Deno.test("OAuth authorize: the provider URL, skip_http_redirect, PKCE s256 only, linking", async () => {
  await withApp({}, async (app) => {
    const res = await api(app, "/authorize", {
      key: null,
      query: { provider: "github", redirect_to: `${ORIGIN}/after`, scopes: "repo" },
    });
    assertEquals(res.status, 302);
    const url = new URL(res.headers.get("location")!);
    assertEquals(url.host, "github.com");
    assertEquals(url.searchParams.get("redirect_uri"), `${ORIGIN}/auth/callback/github`);
    assertStringIncludes(url.searchParams.get("scope")!, "repo");
    assertExists(res.headers.get("set-cookie"), "the flow is bound to this browser");
    const json = await api(app, "/authorize", {
      key: null,
      query: { provider: "github", skip_http_redirect: "true" },
    });
    assertMatch(String(json.json.url), /^https:\/\/github\.com\//);
    assertEquals(
      (await api(app, "/authorize", { key: null, query: { provider: "nope" } })).json.error_code,
      "validation_failed",
    );
    const plain = await api(app, "/authorize", {
      key: null,
      query: { provider: "github", code_challenge: "x".repeat(43), code_challenge_method: "plain" },
    });
    assertEquals(plain.json.error_code, "validation_failed");
    const { access_token } = await signedIn(app);
    const link = await api(app, "/user/identities/authorize", {
      token: access_token,
      query: { provider: "github" },
    });
    assertMatch(String(link.json.url), /^https:\/\/github\.com\//);
    // A callback whose state matches no flow is not an /auth/v1 one.
    const stray = await app.fetch(`${ORIGIN}/auth/callback/github?code=x&state=nope`, {
      redirect: "manual",
    });
    assertEquals(stray.status, 303);
  }, { providers: [github({ clientId: "id", clientSecret: "secret" })] as never });
});

Deno.test("PKCE exchange refusals and the anonymous switch", async () => {
  await withApp({}, async (app) => {
    const missing = await api(app, "/token", {
      query: { grant_type: "pkce" },
      body: { auth_code: "nope", code_verifier: "v".repeat(43) },
    });
    assertEquals(missing.json.error_code, "flow_state_not_found");
    assertEquals(
      (await api(app, "/signup", { body: {} })).json.error_code,
      "anonymous_provider_disabled",
    );
    const sso = await api(app, "/sso", { body: { domain: "example.com" } });
    assertEquals(sso.json.error_code, "sso_provider_not_found");
    const id = await api(app, "/token", {
      query: { grant_type: "id_token" },
      body: { provider: "google", id_token: "x" },
    });
    assertEquals(id.json.error_code, "provider_disabled");
  });
});

Deno.test("captcha: missing, refused, provider failure and accepted tokens", async () => {
  const seen: string[] = [];
  await withApp({
    captcha: {
      provider: "hcaptcha",
      secret: "s",
      fetch: (_url, init) => {
        const response = new URLSearchParams(String((init as RequestInit).body)).get("response")!;
        seen.push(response);
        if (response === "boom") return Promise.reject(new Error("network"));
        return Promise.resolve(Response.json({ success: response === "good" }));
      },
    },
  }, async (app) => {
    const otp = (body: Record<string, unknown>) =>
      api(app, "/otp", { body: { email: "c@example.com", ...body } });
    assertEquals((await otp({})).json.error_code, "captcha_failed");
    assertEquals((await otp({ captcha_token: "bad" })).json.error_code, "captcha_failed");
    assertEquals((await otp({ captcha_token: "boom" })).json.error_code, "captcha_failed");
    assertEquals((await otp({ gotrue_meta_security: { captcha_token: "good" } })).status, 200);
    assertEquals(seen, ["bad", "boom", "good"]);
  });
});

Deno.test("denextAuth's shared settings (anonymous, captcha, hooks) apply to /auth/v1", async () => {
  await withApp({}, async (app) => {
    const refused = await api(app, "/signup", { body: {} });
    assertEquals(refused.json.error_code, "captcha_failed");
    const anon = await api(app, "/signup", {
      body: { gotrue_meta_security: { captcha_token: "ok" } },
    });
    assertEquals(anon.status, 200);
    const claims = JSON.parse(
      atob((anon.json.access_token as string).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    assertEquals(claims.is_anonymous, true);
    assertEquals(claims.shared, true);
  }, {
    anonymous: true,
    captcha: {
      provider: "turnstile",
      secret: "s",
      fetch: () => Promise.resolve(Response.json({ success: true })),
    },
    hooks: {
      customAccessToken: ({ claims }: { claims: Record<string, unknown> }) => ({
        claims: { ...claims, shared: true },
      }),
    },
  } as never);
});
