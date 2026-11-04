// The `/auth/v1` OAuth 2.1 authorization server over raw HTTP: the client admin API (secrets
// shown once, stored hashed), `/oauth/authorize` (exact redirect match, PKCE S256 mandatory,
// errors that never redirect to an unregistered URI), the consent calls (bound to one user,
// settled once, auto-approval within an existing grant), `/oauth/token` (client
// authentication by the registered method, single-use codes whose replay revokes the tokens,
// rotating refresh tokens with reuse detection, the id_token), the grants list and revocation,
// what an OAuth client's token may and may not call, userinfo and discovery.

import { assert, assertEquals, assertExists, assertNotEquals } from "@std/assert";
import { inMemoryAuthAdapter } from "../packages/auth/src/memory-adapter.ts";
import { base64UrlEncode } from "../packages/auth/src/oauth.ts";
import type { GoTrueOptions } from "../packages/auth/src/gotrue/options.ts";
import { ORIGIN, type SupabaseAuthApp, supabaseAuthApp, totpCode } from "./_supabase-auth-app.ts";

interface Call {
  method?: string;
  body?: unknown;
  token?: string;
  form?: Record<string, string>;
  basic?: [string, string];
  apikey?: string | null;
}

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

async function api(app: SupabaseAuthApp, path: string, call: Call = {}) {
  const headers: Record<string, string> = {};
  if (call.apikey !== null) headers.apikey = call.apikey ?? app.publishableKey;
  if (call.token) headers.authorization = `Bearer ${call.token}`;
  if (call.basic) headers.authorization = `Basic ${btoa(call.basic.join(":"))}`;
  let body: string | undefined;
  if (call.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(call.form).toString();
  } else if (call.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(call.body);
  }
  const res = await app.fetch(new URL(`${ORIGIN}/auth/v1${path}`), {
    method: call.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
    redirect: "manual",
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : {}) as Json };
}

const admin = (app: SupabaseAuthApp, path: string, call: Call = {}) =>
  api(app, path, { ...call, token: app.secretKey, apikey: app.secretKey });

async function withApp(
  fn: (app: SupabaseAuthApp) => Promise<void>,
  auth: GoTrueOptions = { oauthServer: {} },
): Promise<void> {
  const app = await supabaseAuthApp({ adapter: inMemoryAuthAdapter(), auth, withClient: false });
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

async function signIn(app: SupabaseAuthApp, email = "ada@example.com"): Promise<Json> {
  await admin(app, "/admin/users", {
    body: { email, password: "correct horse battery", email_confirm: true },
  });
  const res = await api(app, "/token?grant_type=password", {
    body: { email, password: "correct horse battery" },
  });
  assertEquals(res.status, 200);
  return res.json;
}

const REDIRECT = "https://client.test/callback";

async function createClient(app: SupabaseAuthApp, extra: Json = {}): Promise<Json> {
  const res = await admin(app, "/admin/oauth/clients", {
    body: { client_name: "Client", redirect_uris: [REDIRECT], ...extra },
  });
  assertEquals(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "openid email",
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
    nonce: "n-0S6",
    ...extra,
  });
  return `/oauth/authorize?${query}`;
}

/** authorize → consent page → approve → the code. */
async function approvedCode(
  app: SupabaseAuthApp,
  clientId: string,
  userToken: string,
  challenge: string,
): Promise<string> {
  const start = await api(app, authorizeUrl(clientId, challenge), { apikey: null });
  assertEquals(start.status, 302);
  const consentPage = new URL(start.headers.get("location")!);
  assertEquals(consentPage.origin + consentPage.pathname, `${ORIGIN}/oauth/consent`);
  const id = consentPage.searchParams.get("authorization_id")!;
  const details = await api(app, `/oauth/authorizations/${id}`, { token: userToken });
  if (details.json.redirect_url) {
    return new URL(details.json.redirect_url).searchParams.get("code")!;
  }
  assertEquals(details.status, 200, JSON.stringify(details.json));
  const approved = await api(app, `/oauth/authorizations/${id}/consent`, {
    token: userToken,
    body: { action: "approve" },
  });
  assertEquals(approved.status, 200);
  const landing = new URL(approved.json.redirect_url);
  assertEquals(landing.origin + landing.pathname, REDIRECT);
  assertEquals(landing.searchParams.get("state"), "xyz");
  assertEquals(landing.searchParams.get("iss"), `${ORIGIN}/auth/v1`);
  return landing.searchParams.get("code")!;
}

function claimsOf(token: string): Json {
  const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4)));
}

Deno.test("oauth clients: admin CRUD; the secret is shown on create / regenerate only", async () => {
  await withApp(async (app) => {
    const created = await createClient(app, { scope: "openid email" });
    assertExists(created.client_secret);
    assertEquals(created.client_type, "confidential");
    assertEquals(created.token_endpoint_auth_method, "client_secret_basic");
    assertEquals(created.grant_types, ["authorization_code", "refresh_token"]);
    const read = await admin(app, `/admin/oauth/clients/${created.client_id}`);
    assertEquals(read.json.client_secret, undefined);
    const list = await admin(app, "/admin/oauth/clients?page=1&per_page=10");
    assertEquals(list.json.clients.length, 1);
    assertEquals(list.headers.get("x-total-count"), "1");
    const updated = await admin(app, `/admin/oauth/clients/${created.client_id}`, {
      method: "PUT",
      body: { client_name: "Renamed", logo_uri: "https://client.test/logo.png" },
    });
    assertEquals(updated.json.client_name, "Renamed");
    assertEquals(updated.json.client_secret, undefined);
    const regenerated = await admin(
      app,
      `/admin/oauth/clients/${created.client_id}/regenerate_secret`,
      { method: "POST" },
    );
    assertNotEquals(regenerated.json.client_secret, created.client_secret);
    // Bad registrations.
    for (
      const body of [
        { client_name: "x", redirect_uris: ["http://evil.test/cb"] },
        { client_name: "x", redirect_uris: ["https://a.test/cb#frag"] },
        { client_name: "x", redirect_uris: ["javascript:alert(1)"] },
        { client_name: "x", redirect_uris: [] },
        { client_name: "x", redirect_uris: [REDIRECT], scope: "admin" },
        { client_name: "x", redirect_uris: [REDIRECT], grant_types: ["password"] },
      ]
    ) {
      assertEquals((await admin(app, "/admin/oauth/clients", { body })).status, 400);
    }
    // Without the service role.
    assertEquals((await api(app, "/admin/oauth/clients")).status, 403);
    const deleted = await admin(app, `/admin/oauth/clients/${created.client_id}`, {
      method: "DELETE",
    });
    assertEquals(deleted.status, 204);
    assertEquals((await admin(app, `/admin/oauth/clients/${created.client_id}`)).status, 404);
  });
});

Deno.test("oauth server: off unless configured", async () => {
  await withApp(async (app) => {
    assertEquals((await admin(app, "/admin/oauth/clients")).status, 404);
    assertEquals((await api(app, "/oauth/authorize?client_id=x")).status, 404);
  }, {});
});

Deno.test("oauth server: code flow, confidential client, refresh rotation, id_token", async () => {
  await withApp(async (app) => {
    const client = await createClient(app);
    const user = await signIn(app);
    const { verifier, challenge } = await pkce();
    const code = await approvedCode(app, client.client_id, user.access_token, challenge);
    const exchange = (form: Record<string, string>, basic = true) =>
      api(app, "/oauth/token", {
        apikey: null,
        form: { grant_type: "authorization_code", code, redirect_uri: REDIRECT, ...form },
        ...(basic ? { basic: [client.client_id, client.client_secret] as [string, string] } : {}),
      });
    // Wrong client authentication is refused without touching the code.
    const noAuth = await exchange({ code_verifier: verifier }, false);
    assertEquals(noAuth.status, 401);
    assertEquals(noAuth.json.error, "invalid_client");
    const tokens = await exchange({ code_verifier: verifier });
    assertEquals(tokens.status, 200, JSON.stringify(tokens.json));
    assertEquals(tokens.json.token_type, "bearer");
    assertEquals(tokens.json.scope, "openid email");
    assertEquals(tokens.json.user, undefined);
    const claims = claimsOf(tokens.json.access_token);
    assertEquals(claims.client_id, client.client_id);
    assertEquals(claims.scope, "openid email");
    assertEquals(claims.role, "authenticated");
    assertEquals(claims.sub, user.user.id);
    assertEquals(claims.amr[0].method, "oauth_provider/authorization_code");
    const idToken = claimsOf(tokens.json.id_token);
    assertEquals(idToken.aud, client.client_id);
    assertEquals(idToken.nonce, "n-0S6");
    assertEquals(idToken.email, "ada@example.com");
    // The code is single-use; its replay revokes the tokens it was exchanged for.
    const replay = await exchange({ code_verifier: verifier });
    assertEquals(replay.json.error, "invalid_grant");
    const after = await api(app, "/user", { token: tokens.json.access_token });
    assertEquals(after.status, 403, "the replayed code's session is revoked");
  });
});

Deno.test("oauth server: refresh rotates, detects reuse, and is bound to its client", async () => {
  await withApp(async (app) => {
    const client = await createClient(app, { token_endpoint_auth_method: "client_secret_post" });
    const other = await createClient(app, { token_endpoint_auth_method: "client_secret_post" });
    const user = await signIn(app);
    const { verifier, challenge } = await pkce();
    const code = await approvedCode(app, client.client_id, user.access_token, challenge);
    const secretPost = { client_id: client.client_id, client_secret: client.client_secret };
    const tokens = await api(app, "/oauth/token", {
      apikey: null,
      form: {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        ...secretPost,
      },
    });
    assertEquals(tokens.status, 200, JSON.stringify(tokens.json));
    const refresh = (token: string, auth = secretPost) =>
      api(app, "/oauth/token", {
        apikey: null,
        form: { grant_type: "refresh_token", refresh_token: token, ...auth },
      });
    // Another client can't use it; nor can the first-party /token endpoint.
    const foreign = await refresh(tokens.json.refresh_token, {
      client_id: other.client_id,
      client_secret: other.client_secret,
    });
    assertEquals(foreign.json.error, "invalid_grant");
    const firstParty = await api(app, "/token?grant_type=refresh_token", {
      body: { refresh_token: tokens.json.refresh_token },
    });
    assertEquals(firstParty.status, 400);
    const rotated = await refresh(tokens.json.refresh_token);
    assertEquals(rotated.status, 200);
    assertNotEquals(rotated.json.refresh_token, tokens.json.refresh_token);
    assertEquals(claimsOf(rotated.json.access_token).client_id, client.client_id);
    const second = await refresh(rotated.json.refresh_token);
    assertEquals(second.status, 200);
    // The first token, two generations old: a replay — the family is revoked.
    const reused = await refresh(tokens.json.refresh_token);
    assertEquals(reused.json.error, "invalid_grant");
    assertEquals((await refresh(second.json.refresh_token)).json.error, "invalid_grant");
  });
});

Deno.test("oauth authorize: refuses bad clients, redirects and PKCE", async () => {
  await withApp(async (app) => {
    const client = await createClient(app);
    const { challenge } = await pkce();
    // Unknown client, unregistered redirect: answered here, never redirected.
    const unknown = await api(app, authorizeUrl("nope", challenge), { apikey: null });
    assertEquals(unknown.status, 400);
    const evil = await api(
      app,
      authorizeUrl(client.client_id, challenge, { redirect_uri: "https://evil.test/cb" }),
      { apikey: null },
    );
    assertEquals(evil.status, 400);
    assertEquals(evil.headers.get("location"), null);
    // PKCE is mandatory, S256 only; the error goes to the (registered) redirect.
    const cases: Array<Record<string, string>> = [
      { code_challenge: "" },
      { code_challenge_method: "plain" },
      { response_type: "token" },
      { scope: "openid admin" },
    ];
    for (const extra of cases) {
      const res = await api(app, authorizeUrl(client.client_id, challenge, extra), {
        apikey: null,
      });
      assertEquals(res.status, 302);
      const landing = new URL(res.headers.get("location")!);
      assertEquals(landing.origin + landing.pathname, REDIRECT);
      assertExists(landing.searchParams.get("error"));
      assertEquals(landing.searchParams.get("state"), "xyz");
    }
  });
});

Deno.test("oauth consent: bound to one user, settled once; deny; wrong verifier", async () => {
  await withApp(async (app) => {
    const client = await createClient(app);
    const ada = await signIn(app, "ada@example.com");
    const eve = await signIn(app, "eve@example.com");
    const { challenge } = await pkce();
    const start = await api(app, authorizeUrl(client.client_id, challenge), { apikey: null });
    const id = new URL(start.headers.get("location")!).searchParams.get("authorization_id")!;
    assertEquals(
      (await api(app, `/oauth/authorizations/${id}`, { token: ada.access_token })).status,
      200,
    );
    // Eve can't read or settle Ada's request.
    assertEquals(
      (await api(app, `/oauth/authorizations/${id}`, { token: eve.access_token })).status,
      404,
    );
    const eveApprove = await api(app, `/oauth/authorizations/${id}/consent`, {
      token: eve.access_token,
      body: { action: "approve" },
    });
    assertEquals(eveApprove.status, 404);
    const denied = await api(app, `/oauth/authorizations/${id}/consent`, {
      token: ada.access_token,
      body: { action: "deny" },
    });
    assertEquals(new URL(denied.json.redirect_url).searchParams.get("error"), "access_denied");
    const again = await api(app, `/oauth/authorizations/${id}/consent`, {
      token: ada.access_token,
      body: { action: "approve" },
    });
    assertEquals(again.status, 404, "a settled request can't be settled again");
    // A wrong verifier burns the code.
    const second = await pkce();
    const code = await approvedCode(app, client.client_id, ada.access_token, second.challenge);
    const exchange = (verifier: string) =>
      api(app, "/oauth/token", {
        apikey: null,
        basic: [client.client_id, client.client_secret],
        form: {
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        },
      });
    assertEquals((await exchange((await pkce()).verifier)).json.error, "invalid_grant");
    assertEquals((await exchange(second.verifier)).json.error, "invalid_grant");
  });
});

Deno.test("oauth grants: auto-approval within a grant; list; revoke ends the tokens", async () => {
  await withApp(async (app) => {
    const client = await createClient(app, { token_endpoint_auth_method: "none" });
    assertEquals(client.client_secret, undefined, "a public client has no secret");
    const user = await signIn(app);
    const first = await pkce();
    const code = await approvedCode(app, client.client_id, user.access_token, first.challenge);
    const tokens = await api(app, "/oauth/token", {
      apikey: null,
      form: {
        grant_type: "authorization_code",
        client_id: client.client_id,
        code,
        redirect_uri: REDIRECT,
        code_verifier: first.verifier,
      },
    });
    assertEquals(tokens.status, 200, JSON.stringify(tokens.json));
    // A second request within the granted scopes is approved without asking.
    const second = await pkce();
    const start = await api(app, authorizeUrl(client.client_id, second.challenge), {
      apikey: null,
    });
    const id = new URL(start.headers.get("location")!).searchParams.get("authorization_id")!;
    const auto = await api(app, `/oauth/authorizations/${id}`, { token: user.access_token });
    assertExists(auto.json.redirect_url);
    const grants = await api(app, "/user/oauth/grants", { token: user.access_token });
    assertEquals(grants.json.length, 1);
    assertEquals(grants.json[0].client.id, client.client_id);
    assertEquals(grants.json[0].scopes, ["openid", "email"]);
    // An OAuth client's token: GET /user yes; the user's grants, password, consent — no.
    const clientToken = tokens.json.access_token;
    assertEquals((await api(app, "/user", { token: clientToken })).status, 200);
    assertEquals((await api(app, "/user/oauth/grants", { token: clientToken })).status, 403);
    assertEquals(
      (await api(app, "/user", {
        method: "PUT",
        token: clientToken,
        body: { password: "x".repeat(12) },
      }))
        .status,
      403,
    );
    const info = await api(app, "/oauth/userinfo", { token: clientToken, apikey: null });
    assertEquals(info.json.sub, user.user.id);
    assertEquals(info.json.email, "ada@example.com");
    assertEquals(info.json.phone_number, undefined);
    // Revoke: the grant goes, and so does every token the client holds.
    const revoked = await api(app, `/user/oauth/grants?client_id=${client.client_id}`, {
      method: "DELETE",
      token: user.access_token,
    });
    assertEquals(revoked.status, 204);
    assertEquals((await api(app, "/user/oauth/grants", { token: user.access_token })).json, []);
    assertEquals((await api(app, "/user", { token: clientToken })).status, 403);
    const refresh = await api(app, "/oauth/token", {
      apikey: null,
      form: {
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: tokens.json.refresh_token,
      },
    });
    assertEquals(refresh.json.error, "invalid_grant");
    // The user's own session is untouched.
    assertEquals((await api(app, "/user", { token: user.access_token })).status, 200);
  });
});

Deno.test("oauth consent: a session still owing its second factor can't answer", async () => {
  await withApp(async (app) => {
    const client = await createClient(app);
    const first = await signIn(app);
    const enrolled = await api(app, "/factors", {
      token: first.access_token,
      body: { factor_type: "totp" },
    });
    assertEquals(enrolled.status, 200, JSON.stringify(enrolled.json));
    const challenge = await api(app, `/factors/${enrolled.json.id}/challenge`, {
      token: first.access_token,
      body: {},
    });
    const verified = await api(app, `/factors/${enrolled.json.id}/verify`, {
      token: first.access_token,
      body: { challenge_id: challenge.json.id, code: await totpCode(enrolled.json.totp.secret) },
    });
    assertEquals(verified.status, 200, JSON.stringify(verified.json));
    // A password alone now yields an aal1 session that owes the factor.
    const passwordOnly = await api(app, "/token?grant_type=password", {
      body: { email: "ada@example.com", password: "correct horse battery" },
    });
    const { challenge: pkceChallenge } = await pkce();
    const start = await api(app, authorizeUrl(client.client_id, pkceChallenge), { apikey: null });
    const id = new URL(start.headers.get("location")!).searchParams.get("authorization_id")!;
    const refused = await api(app, `/oauth/authorizations/${id}`, {
      token: passwordOnly.json.access_token,
    });
    assertEquals(refused.status, 403);
    assertEquals(refused.json.error_code, "insufficient_aal");
    // The aal2 session may.
    const allowed = await api(app, `/oauth/authorizations/${id}`, {
      token: verified.json.access_token,
    });
    assertEquals(allowed.status, 200, JSON.stringify(allowed.json));
  });
});

Deno.test("oauth server: a single-redirect client may omit redirect_uri at both steps", async () => {
  await withApp(async (app) => {
    const client = await createClient(app);
    const user = await signIn(app);
    const { verifier, challenge } = await pkce();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      scope: "email",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const start = await api(app, `/oauth/authorize?${query}`, { apikey: null });
    const id = new URL(start.headers.get("location")!).searchParams.get("authorization_id")!;
    const approved = await api(app, `/oauth/authorizations/${id}/consent`, {
      token: user.access_token,
      body: { action: "approve" },
    });
    const code = new URL(approved.json.redirect_url).searchParams.get("code")!;
    const tokens = await api(app, "/oauth/token", {
      apikey: null,
      basic: [client.client_id, client.client_secret],
      form: { grant_type: "authorization_code", code, code_verifier: verifier },
    });
    assertEquals(tokens.status, 200, JSON.stringify(tokens.json));
    assertEquals(tokens.json.id_token, undefined, "no openid scope, no id_token");
  });
});

Deno.test("oauth server: discovery metadata and deleting a client revokes its tokens", async () => {
  await withApp(async (app) => {
    const meta = await api(app, "/.well-known/oauth-authorization-server", { apikey: null });
    assertEquals(meta.json.issuer, `${ORIGIN}/auth/v1`);
    assertEquals(meta.json.code_challenge_methods_supported, ["S256"]);
    const oidc = await api(app, "/.well-known/openid-configuration", { apikey: null });
    assertEquals(oidc.json.token_endpoint, `${ORIGIN}/auth/v1/oauth/token`);
    const client = await createClient(app);
    const user = await signIn(app);
    const { verifier, challenge } = await pkce();
    const code = await approvedCode(app, client.client_id, user.access_token, challenge);
    const tokens = await api(app, "/oauth/token", {
      apikey: null,
      basic: [client.client_id, client.client_secret],
      form: {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
    });
    assert(tokens.json.access_token);
    await admin(app, `/admin/oauth/clients/${client.client_id}`, { method: "DELETE" });
    assertEquals((await api(app, "/user", { token: tokens.json.access_token })).status, 403);
  }, { oauthServer: { authorizationPath: "/oauth/consent" } });
});
