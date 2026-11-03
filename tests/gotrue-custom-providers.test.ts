// Stored OAuth / OIDC providers for `/auth/v1` over raw HTTP: the admin API
// (`/admin/custom-providers`: validation, the secret sealed at rest and never returned, OIDC
// discovery at save with the issuer checked), and `signInWithOAuth({ provider: "custom:…" })`
// through `/authorize` → the identity provider → `/auth/v1/callback`, for an OAuth 2.0 provider
// (userinfo + attribute mapping) and an OIDC one (a verified id_token with its nonce).

import { assert, assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { customProviderStoreOf } from "../src/server/auth/adapter-oauth-server.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { base64UrlEncode } from "../src/server/auth/oauth.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import { ORIGIN, type SupabaseAuthApp, supabaseAuthApp } from "./_supabase-auth-app.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

async function api(
  app: SupabaseAuthApp,
  path: string,
  call: { method?: string; body?: unknown; admin?: boolean; cookie?: string } = {},
) {
  const key = call.admin ? app.secretKey : app.publishableKey;
  const headers: Record<string, string> = { apikey: key };
  if (call.admin) headers.authorization = `Bearer ${key}`;
  if (call.cookie) headers.cookie = call.cookie;
  if (call.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.fetch(path.startsWith("http") ? path : `${ORIGIN}/auth/v1${path}`, {
    method: call.method ?? (call.body === undefined ? "GET" : "POST"),
    headers,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
    redirect: "manual",
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : {}) as Json };
}

/** A fake identity provider at https://idp.test (discovery, token, JWKS, userinfo). */
async function fakeIdp() {
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
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "k1",
    alg: "RS256",
  };
  const state = { nonce: "", tokenRequests: [] as URLSearchParams[], userinfo: {} as Json };
  const enc = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
  const idToken = async () => {
    const now = Math.floor(Date.now() / 1000);
    const input = `${enc({ alg: "RS256", kid: "k1", typ: "JWT" })}.${
      enc({
        iss: "https://idp.test",
        aud: "idp-client",
        sub: "oidc-1",
        email: "oidc@example.com",
        email_verified: true,
        name: "Oidc",
        nonce: state.nonce,
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
  };
  const handle = async (url: URL, init?: RequestInit): Promise<Response> => {
    // Any issuer path answers with https://idp.test's document (a mismatched issuer).
    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer: "https://idp.test",
        authorization_endpoint: "https://idp.test/authorize",
        token_endpoint: "https://idp.test/token",
        jwks_uri: "https://idp.test/jwks",
        userinfo_endpoint: "https://idp.test/userinfo",
      });
    }
    if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
    if (url.pathname === "/token") {
      state.tokenRequests.push(new URLSearchParams(String(init?.body ?? "")));
      return Response.json({
        access_token: "idp-at",
        token_type: "bearer",
        id_token: await idToken(),
      });
    }
    return Response.json(state.userinfo);
  };
  return { state, handle };
}

async function withApp(
  fn: (app: SupabaseAuthApp, idp: Awaited<ReturnType<typeof fakeIdp>>) => Promise<void>,
) {
  const idp = await fakeIdp();
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.host === "idp.test" ? idp.handle(url, init) : original(input, init);
  }) as typeof fetch;
  const app = await supabaseAuthApp({
    adapter: inMemoryAuthAdapter(),
    authConfig: { dangerouslyAllowInsecureProviders: true } as Partial<AuthConfig>,
    withClient: false,
  });
  try {
    await fn(app, idp);
  } finally {
    globalThis.fetch = original;
    await app.close();
  }
}

const OAUTH2 = {
  provider_type: "oauth2",
  identifier: "custom:acme",
  name: "Acme",
  client_id: "idp-client",
  client_secret: "idp-secret-value",
  authorization_url: "https://idp.test/authorize",
  token_url: "https://idp.test/token",
  userinfo_url: "https://idp.test/userinfo",
  scopes: ["read:user"],
  attribute_mapping: { sub: "uid", email: "mail", name: "displayName" },
};

/** `/authorize` → the IdP → `/auth/v1/callback`, as a browser would. */
async function signInRound(
  app: SupabaseAuthApp,
  provider: string,
  idp: Awaited<ReturnType<typeof fakeIdp>>,
) {
  const started = await api(app, `/authorize?provider=${provider}&redirect_to=${ORIGIN}/after`);
  assertEquals(started.status, 302, JSON.stringify(started.json));
  const idpUrl = new URL(started.headers.get("location")!);
  idp.state.nonce = idpUrl.searchParams.get("nonce") ?? "";
  const cookie = started.headers.get("set-cookie")!.split(";")[0];
  const back = await api(
    app,
    `/callback?code=c&state=${encodeURIComponent(idpUrl.searchParams.get("state")!)}`,
    { cookie },
  );
  return { idpUrl, back };
}

Deno.test("custom providers: admin CRUD, validation; the secret is sealed and never returned", async () => {
  await withApp(async (app) => {
    const created = await api(app, "/admin/custom-providers", { admin: true, body: OAUTH2 });
    assertEquals(created.status, 201, JSON.stringify(created.json));
    assertEquals(created.json.identifier, "custom:acme");
    assertEquals(created.json.client_secret, undefined);
    assertEquals(created.json.enabled, true);
    const stored = await customProviderStoreOf(app.config.adapter)!.getCustomProvider(
      "custom:acme",
    );
    assert(stored!.clientSecretSealed.startsWith("cps.v1."));
    assert(!JSON.stringify(stored).includes("idp-secret-value"), "sealed at rest");
    const dup = await api(app, "/admin/custom-providers", { admin: true, body: OAUTH2 });
    assertEquals(dup.status, 422);
    for (
      const bad of [
        { ...OAUTH2, identifier: "custom:other", provider_type: "saml" },
        { ...OAUTH2, identifier: "custom:bad id" },
        { ...OAUTH2, identifier: "custom:other", token_url: "ftp://idp.test/token" },
        { ...OAUTH2, identifier: "custom:other", userinfo_url: undefined },
        { ...OAUTH2, identifier: "custom:other", client_secret: "" },
      ]
    ) {
      assertEquals(
        (await api(app, "/admin/custom-providers", { admin: true, body: bad })).status,
        400,
      );
    }
    const list = await api(app, "/admin/custom-providers?type=oauth2", { admin: true });
    assertEquals(list.json.providers.length, 1);
    assertEquals(
      (await api(app, "/admin/custom-providers?type=oidc", { admin: true })).json.providers,
      [],
    );
    const updated = await api(app, "/admin/custom-providers/custom:acme", {
      admin: true,
      method: "PUT",
      body: { name: "Acme 2", enabled: false, client_secret: "rotated" },
    });
    assertEquals(updated.json.name, "Acme 2");
    assertEquals(updated.json.enabled, false);
    assertStringIncludes(JSON.stringify(updated.json), "Acme 2");
    assert(!JSON.stringify(updated.json).includes("rotated"));
    const fixed = await api(app, "/admin/custom-providers/custom:acme", {
      admin: true,
      method: "PUT",
      body: { provider_type: "oidc" },
    });
    assertEquals(fixed.status, 400, "provider_type is immutable");
    // Without the service role.
    assertEquals((await api(app, "/admin/custom-providers")).status, 403);
    // A disabled provider can't be signed in with.
    const disabled = await api(app, "/authorize?provider=custom:acme");
    assertEquals(disabled.status, 400);
    assertEquals(
      (await api(app, "/admin/custom-providers/custom:acme", { admin: true, method: "DELETE" }))
        .status,
      204,
    );
    assertEquals(
      (await api(app, "/admin/custom-providers/custom:acme", { admin: true })).status,
      404,
    );
  });
});

Deno.test("custom providers: an OAuth 2.0 provider signs in through /auth/v1/callback", async () => {
  await withApp(async (app, idp) => {
    await api(app, "/admin/custom-providers", { admin: true, body: OAUTH2 });
    idp.state.userinfo = { uid: 42, mail: "acme@example.com", displayName: "Acme User" };
    const { idpUrl, back } = await signInRound(app, "custom:acme", idp);
    assertEquals(idpUrl.searchParams.get("redirect_uri"), `${ORIGIN}/auth/v1/callback`);
    assertEquals(idpUrl.searchParams.get("scope"), "read:user");
    assertExists(idpUrl.searchParams.get("code_challenge"));
    assertEquals(back.status, 303, JSON.stringify(back.json));
    const landing = new URL(back.headers.get("location")!);
    assertEquals(landing.pathname, "/after");
    const fragment = new URLSearchParams(landing.hash.slice(1));
    const token = fragment.get("access_token");
    assertExists(token, landing.href);
    // The token exchange carried the stored (opened) secret and the same redirect URI.
    const exchange = idp.state.tokenRequests.at(-1)!;
    assertEquals(exchange.get("redirect_uri"), `${ORIGIN}/auth/v1/callback`);
    const me = await app.fetch(`${ORIGIN}/auth/v1/user`, {
      headers: { apikey: app.publishableKey, authorization: `Bearer ${token}` },
    });
    const json = await me.json();
    assertEquals(json.email, "acme@example.com");
    assert(
      json.identities.some((i: Json) =>
        i.provider === "custom:acme" && i.identity_data.sub === "42"
      ),
    );
    // A forged state (no transaction) lands with an error, never a session.
    const forged = await api(app, "/callback?code=c&state=acme.forged");
    assertEquals(forged.status, 303);
    assertStringIncludes(forged.headers.get("location")!, "error");
  });
});

Deno.test("custom providers: OIDC — discovery at save, id_token verified with its nonce", async () => {
  await withApp(async (app, idp) => {
    const created = await api(app, "/admin/custom-providers", {
      admin: true,
      body: {
        provider_type: "oidc",
        identifier: "corp",
        name: "Corp",
        client_id: "idp-client",
        client_secret: "s3cret",
        issuer: "https://idp.test",
      },
    });
    assertEquals(created.status, 201, JSON.stringify(created.json));
    assertEquals(created.json.identifier, "custom:corp");
    assertEquals(created.json.discovery_document.token_endpoint, "https://idp.test/token");
    const mismatched = await api(app, "/admin/custom-providers", {
      admin: true,
      body: {
        provider_type: "oidc",
        identifier: "corp2",
        name: "Corp",
        client_id: "x",
        client_secret: "y",
        issuer: "https://idp.test/other",
      },
    });
    assertEquals(mismatched.status, 400, "the document's issuer must match");
    // The discovered userinfo_endpoint is read too; a conformant one names the id_token's
    // subject (OIDC Core 5.3.2: `sub` MUST be in the response and MUST match).
    idp.state.userinfo = { sub: "oidc-1", name: "Oidc" };
    const { back } = await signInRound(app, "custom:corp", idp);
    assertEquals(back.status, 303);
    const fragment = new URLSearchParams(new URL(back.headers.get("location")!).hash.slice(1));
    assertExists(fragment.get("access_token"), back.headers.get("location")!);
    // A wrong nonce is refused.
    const started = await api(app, `/authorize?provider=custom:corp&redirect_to=${ORIGIN}/after`);
    const idpUrl = new URL(started.headers.get("location")!);
    idp.state.nonce = "not-the-nonce";
    const refused = await api(
      app,
      `/callback?code=c&state=${encodeURIComponent(idpUrl.searchParams.get("state")!)}`,
      { cookie: started.headers.get("set-cookie")!.split(";")[0] },
    );
    assertEquals(
      new URLSearchParams(new URL(refused.headers.get("location")!).hash.slice(1)).get(
        "access_token",
      ),
      null,
    );
    // A userinfo about another subject than the verified id_token's is refused.
    idp.state.userinfo = { sub: "someone-else", email: "other@example.com" };
    const other = await signInRound(app, "custom:corp", idp);
    const otherFragment = new URLSearchParams(
      new URL(other.back.headers.get("location")!).hash.slice(1),
    );
    assertEquals(otherFragment.get("access_token"), null);
    assertEquals(otherFragment.get("error"), "server_error");
  });
});

Deno.test("custom providers: an OIDC callback whose `iss` names another issuer is refused", async () => {
  await withApp(async (app, idp) => {
    await api(app, "/admin/custom-providers", {
      admin: true,
      body: {
        provider_type: "oidc",
        identifier: "corp",
        name: "Corp",
        client_id: "idp-client",
        client_secret: "s3cret",
        issuer: "https://idp.test",
      },
    });
    // (The accepting case is the provider-flow suite's; here a second key would be throttled.)
    /** One round with `iss` in the authorization response; the landing's fragment. */
    const round = async (iss: string) => {
      const started = await api(app, `/authorize?provider=custom:corp&redirect_to=${ORIGIN}/a`);
      const idpUrl = new URL(started.headers.get("location")!);
      idp.state.nonce = idpUrl.searchParams.get("nonce") ?? "";
      const state = encodeURIComponent(idpUrl.searchParams.get("state")!);
      const back = await api(
        app,
        `/callback?code=c&state=${state}&iss=${encodeURIComponent(iss)}`,
        {
          cookie: started.headers.get("set-cookie")!.split(";")[0],
        },
      );
      return new URLSearchParams(new URL(back.headers.get("location")!).hash.slice(1));
    };
    const before = idp.state.tokenRequests.length;
    assertEquals((await round("https://evil.example")).get("access_token"), null);
    assertEquals(idp.state.tokenRequests.length, before, "the code is never redeemed");
  });
});
