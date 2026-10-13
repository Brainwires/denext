// The stock supabase-js client against the `/auth/v1` OAuth 2.1 server, stored providers and
// Web3 sign-in — part of the shared flows in tests/_supabase-auth-flows.ts (in-memory and
// Postgres suites). A third-party client's own calls (`/oauth/authorize`, `/oauth/token`) are
// raw HTTP, as such a client would make them; everything supabase-js exposes goes through it.

import { assert, assertEquals, assertExists, assertNotEquals } from "@std/assert";
import type { GoTrueOptions } from "../src/server/auth/gotrue/options.ts";
import { base64UrlEncode } from "../src/server/auth/oauth.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import { ORIGIN, type SupabaseAuthApp } from "./_supabase-auth-app.ts";
import { ethereumWallet, solanaWallet } from "./_web3-wallet.ts";

type Step = (app: SupabaseAuthApp) => Promise<void>;

/** A flow: name, step, `/auth/v1` options, extra auth config. */
export type OAuthFlow = [string, Step, GoTrueOptions?, Partial<AuthConfig>?];

const REDIRECT = "https://client.test/callback";

async function signedInClient(app: SupabaseAuthApp, email: string) {
  await app.admin().auth.admin.createUser({
    email,
    password: "pass phrase 1",
    email_confirm: true,
  });
  const supabase = app.client();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: "pass phrase 1",
  });
  assertEquals(error, null);
  return { supabase, session: data.session };
}

async function pkce() {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

async function form(app: SupabaseAuthApp, path: string, body: Record<string, string>) {
  const res = await app.fetch(`${ORIGIN}/auth/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  return { status: res.status, json: await res.json() };
}

const oauthServerFlow: Step = async (app) => {
  const admin = app.admin().auth.admin.oauth;
  const created = await admin.createClient({ client_name: "Partner", redirect_uris: [REDIRECT] });
  assertEquals(created.error, null);
  const client = created.data;
  assertExists(client.client_secret);
  const listed = await admin.listClients();
  assertEquals(listed.data.clients.length, 1);
  assertEquals(listed.data.clients[0].client_secret, undefined);
  assertEquals((await admin.getClient(client.client_id)).data.client_name, "Partner");
  assertEquals(
    (await admin.updateClient(client.client_id, { client_name: "Partner 2" })).data.client_name,
    "Partner 2",
  );
  const regenerated = await admin.regenerateClientSecret(client.client_id);
  assertNotEquals(regenerated.data.client_secret, client.client_secret);
  const secret = regenerated.data.client_secret;
  const { supabase } = await signedInClient(app, "grant@example.com");
  // The third party sends the user to /oauth/authorize; the app's consent page takes over.
  const { verifier, challenge } = await pkce();
  const authorize = await app.fetch(
    `${ORIGIN}/auth/v1/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      scope: "openid email",
      state: "s1",
      code_challenge: challenge,
      code_challenge_method: "S256",
    })}`,
    { redirect: "manual" },
  );
  assertEquals(authorize.status, 302);
  const id = new URL(authorize.headers.get("location")!).searchParams.get("authorization_id")!;
  const details = await supabase.auth.oauth.getAuthorizationDetails(id);
  assertEquals(details.error, null);
  assertEquals(details.data.client.name, "Partner 2");
  assertEquals(details.data.scope, "openid email");
  const approved = await supabase.auth.oauth.approveAuthorization(id, {
    skipBrowserRedirect: true,
  });
  assertEquals(approved.error, null);
  const code = new URL(approved.data.redirect_url).searchParams.get("code")!;
  const tokens = await form(app, "/oauth/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
    client_id: client.client_id,
    client_secret: secret,
  });
  assertEquals(tokens.status, 401, "registered for client_secret_basic, not _post");
  const basic = await app.fetch(`${ORIGIN}/auth/v1/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${btoa(`${client.client_id}:${secret}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }),
  });
  // The code was consumed by nothing: the refused attempt failed client authentication first.
  const issued = await basic.json();
  assertEquals(basic.status, 200, JSON.stringify(issued));
  assertExists(issued.id_token);
  const grants = await supabase.auth.oauth.listGrants();
  assertEquals(grants.data.length, 1);
  assertEquals(grants.data[0].client.id, client.client_id);
  const revoked = await supabase.auth.oauth.revokeGrant({ clientId: client.client_id });
  assertEquals(revoked.error, null);
  assertEquals((await supabase.auth.oauth.listGrants()).data, []);
  const dead = await app.client().auth.getUser(issued.access_token);
  assertExists(dead.error, "revoking the grant revoked the client's tokens");
  assertEquals((await admin.deleteClient(client.client_id)).error, null);
  assertEquals((await admin.listClients()).data.clients, []);
};

/** A fake OAuth 2.0 identity provider at https://idp.test, for the duration of `body`. */
async function withIdp<T>(userinfo: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== "idp.test") return original(input, init);
    if (url.pathname === "/token") {
      return Promise.resolve(Response.json({ access_token: "idp-at", token_type: "bearer" }));
    }
    return Promise.resolve(Response.json(userinfo));
  }) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

const customProviderFlow: Step = async (app) => {
  const admin = app.admin().auth.admin.customProviders;
  const created = await admin.createProvider({
    provider_type: "oauth2",
    identifier: "custom:acme",
    name: "Acme",
    client_id: "idp-client",
    client_secret: "idp-secret",
    authorization_url: "https://idp.test/authorize",
    token_url: "https://idp.test/token",
    userinfo_url: "https://idp.test/userinfo",
  });
  assertEquals(created.error, null);
  assertEquals(created.data.identifier, "custom:acme");
  assertEquals(created.data.client_secret, undefined);
  assertEquals((await admin.listProviders()).data.providers.length, 1);
  assertEquals((await admin.getProvider("custom:acme")).data.name, "Acme");
  assertEquals((await admin.updateProvider("custom:acme", { name: "Acme!" })).data.name, "Acme!");
  const supabase = app.client();
  const started = await supabase.auth.signInWithOAuth({
    provider: "custom:acme",
    options: { redirectTo: `${ORIGIN}/after`, skipBrowserRedirect: true },
  });
  assertEquals(started.error, null);
  const authorize = await app.fetch(started.data.url, { redirect: "manual" });
  assertEquals(authorize.status, 302);
  const idpUrl = new URL(authorize.headers.get("location")!);
  assertEquals(idpUrl.searchParams.get("redirect_uri"), `${ORIGIN}/auth/v1/callback`);
  const back = await withIdp(
    { sub: "acme-7", email: "acme@example.com", email_verified: true },
    () =>
      app.fetch(
        `${ORIGIN}/auth/v1/callback?code=c&state=${
          encodeURIComponent(idpUrl.searchParams.get("state")!)
        }`,
        {
          headers: { cookie: authorize.headers.get("set-cookie")!.split(";")[0] },
          redirect: "manual",
        },
      ),
  );
  const fragment = new URLSearchParams(new URL(back.headers.get("location")!).hash.slice(1));
  const user = await supabase.auth.getUser(fragment.get("access_token")!);
  assertEquals(user.error, null);
  assertEquals(user.data.user.email, "acme@example.com");
  assertEquals(user.data.user.app_metadata.provider, "custom:acme");
  assertEquals((await admin.deleteProvider("custom:acme")).error, null);
  assertEquals((await admin.listProviders()).data.providers, []);
};

const web3Flow: Step = async (app) => {
  const eth = ethereumWallet();
  const supabase = app.client();
  const signedIn = await supabase.auth.signInWithWeb3({
    chain: "ethereum",
    wallet: eth.provider,
    statement: "Sign in to the app",
    options: { url: `${ORIGIN}/`, signInWithEthereum: { nonce: "nonce12345" } },
  });
  assertEquals(signedIn.error, null);
  const identity = signedIn.data.user.identities[0];
  assertEquals(identity.provider, "web3:ethereum");
  assertEquals(identity.identity_data.address, eth.address.toLowerCase());
  // The same nonce again (a replayed signature, or a fresh one) is refused.
  const replay = await app.client().auth.signInWithWeb3({
    chain: "ethereum",
    wallet: eth.provider,
    statement: "Sign in to the app",
    options: { url: `${ORIGIN}/`, signInWithEthereum: { nonce: "nonce12345" } },
  });
  assertEquals(replay.error?.code, "validation_failed");
  const again = await app.client().auth.signInWithWeb3({
    chain: "ethereum",
    wallet: eth.provider,
    options: { url: `${ORIGIN}/` },
  });
  assertEquals(again.data.user.id, signedIn.data.user.id);
  const sol = await solanaWallet();
  const solana = await app.client().auth.signInWithWeb3({
    chain: "solana",
    wallet: sol.wallet,
    statement: "Sign in to the app",
    options: { url: `${ORIGIN}/` },
  });
  assertEquals(solana.error, null);
  assertEquals(solana.data.user.identities[0].provider, "web3:solana");
  assertEquals(solana.data.user.identities[0].identity_data.address, sol.address);
  // Another site's URL is refused.
  const foreign = await app.client().auth.signInWithWeb3({
    chain: "ethereum",
    wallet: eth.provider,
    options: { url: "https://evil.test/" },
  });
  assert(foreign.error);
};

/** The flows. */
export const OAUTH_FLOWS: OAuthFlow[] = [
  ["OAuth 2.1 server: admin.oauth clients, supabase.auth.oauth consent, grants", oauthServerFlow, {
    oauthServer: {},
  }],
  [
    "custom providers: admin.customProviders and signInWithOAuth({ provider: 'custom:…' })",
    customProviderFlow,
    {},
    {
      dangerouslyAllowInsecureProviders: true,
    },
  ],
  ["Web3: signInWithWeb3 with an Ethereum and a Solana wallet", web3Flow, {
    web3: { ethereum: { chainIds: [1] }, solana: {} },
  }],
];
