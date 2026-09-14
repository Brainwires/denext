// Provider presets and the app callbacks: the `profile` mappers (verified-email
// handling), the non-OIDC OAuth callback path (userinfo + emails, no id_token), the
// signIn / session callbacks on both flows, and requireAuth's authenticated pass-through.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { denextAuth, requireAuth } from "../src/server/auth/mod.ts";
import {
  apple,
  auth0,
  credentials,
  discord,
  facebook,
  github,
  gitlab,
  google,
  keycloak,
  microsoftEntra,
  oidc,
  okta,
  slack,
} from "../src/server/auth/providers.ts";
import type {
  Auth0Options,
  GitLabOptions,
  KeycloakOptions,
  MicrosoftEntraOptions,
  OktaOptions,
} from "../src/server/auth/providers.ts";
import type { AuthConfig, OAuthProvider } from "../src/server/auth/types.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";

// ---- profile mappers --------------------------------------------------------

Deno.test("google profile: maps OIDC claims; drops the email when email_verified is false", () => {
  const p = google({ clientId: "id", clientSecret: "s" });
  const verified = p.profile({
    tokens: {},
    claims: { sub: "g1", name: "G", email: "g@x.test", email_verified: true, picture: "p.png" },
  });
  assertEquals(verified, {
    id: "g1",
    name: "G",
    email: "g@x.test",
    emailVerified: true,
    image: "p.png",
  });
  const unverified = p.profile({
    tokens: {},
    claims: { sub: "g2", email: "victim@x.test", email_verified: false },
  });
  assertEquals(unverified.email, undefined, "an unverified address is never exposed");
  assertEquals(unverified.emailVerified, false);
  assertEquals(p.profile({ tokens: {} }).id, "", "no claims → empty id (rejected upstream)");
});

Deno.test("github profile: only a verified email (primary preferred); name falls back to login", () => {
  const p = github({ clientId: "id", clientSecret: "s" });
  const userinfo = { id: 7, login: "octo", avatar_url: "a.png", email: "chosen@x.test" };
  const primary = p.profile({
    tokens: {},
    userinfo,
    emails: [
      { email: "old@x.test", verified: true, primary: false },
      { email: "main@x.test", verified: true, primary: true },
    ],
  });
  assertEquals(primary, {
    id: "7",
    name: "octo",
    email: "main@x.test",
    emailVerified: true,
    image: "a.png",
  });
  const secondary = p.profile({
    tokens: {},
    userinfo: { ...userinfo, name: "Octo Cat" },
    emails: [{ email: "unv@x.test", verified: false, primary: true }, {
      email: "ok@x.test",
      verified: true,
    }],
  });
  assertEquals(secondary.email, "ok@x.test", "a verified non-primary beats an unverified primary");
  assertEquals(secondary.name, "Octo Cat");
  const none = p.profile({ tokens: {}, userinfo });
  assertEquals(none.email, undefined, "userinfo.email alone (unverified) is never used");
  assertEquals(none.emailVerified, undefined);
});

Deno.test("oidc profile: merges userinfo + claims (claims win), honors email_verified, custom mapper", () => {
  const base = {
    issuer: "https://idp.test",
    authorizationUrl: "https://idp.test/a",
    tokenUrl: "https://idp.test/t",
    jwksUrl: "https://idp.test/j",
    clientId: "c",
    clientSecret: "s",
  };
  const p = oidc(base);
  assertEquals(p.id, "oidc");
  const u = p.profile({
    tokens: {},
    userinfo: { sub: "ui", name: "From userinfo", email: "u@x.test" },
    claims: { sub: "cl", email_verified: true, picture: "c.png" },
  });
  assertEquals(u, {
    id: "cl",
    name: "From userinfo",
    email: "u@x.test",
    emailVerified: true,
    image: "c.png",
  });
  const dropped = p.profile({
    tokens: {},
    claims: { sub: "x", email: "e", email_verified: false },
  });
  assertEquals(dropped.email, undefined);
  const custom = oidc({
    ...base,
    id: "corp",
    profile: ({ claims }) => ({ id: `corp:${claims?.sub}` }),
  });
  assertEquals(custom.id, "corp");
  assertEquals(custom.profile({ tokens: {}, claims: { sub: "1" } }).id, "corp:1");
});

Deno.test("credentials(): default and custom ids", () => {
  const authorize = () => null;
  assertEquals(credentials({ authorize }).id, "credentials");
  assertEquals(credentials({ id: "ldap", authorize }).type, "credentials");
  assertEquals(credentials({ id: "ldap", authorize }).id, "ldap");
});

// ---- the non-OIDC OAuth callback path ------------------------------------------

function oauthProvider(): OAuthProvider {
  return {
    ...github({ clientId: "gh-id", clientSecret: "gh-secret" }),
    id: "gh",
    authorizationUrl: "https://gh.test/authorize",
    tokenUrl: "https://gh.test/token",
    userinfoUrl: "https://gh.test/user",
    userEmailsUrl: "https://gh.test/user/emails",
  };
}

/** Stub `fetch` for the OAuth provider; `emailsStatus` lets a test break the emails call. */
function ghResponder(emailsStatus = 200): (url: string) => Response {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return (url) => {
    if (url === "https://gh.test/token") return json({ access_token: "at", token_type: "bearer" });
    if (url === "https://gh.test/user") return json({ id: 99, login: "octo", email: "unv@x.test" });
    if (url === "https://gh.test/user/emails") {
      return json([{ email: "real@x.test", verified: true, primary: true }], emailsStatus);
    }
    return new Response("nope", { status: 404 });
  };
}

/** Drive signin → callback for `config` under a stubbed fetch; returns the callback result. */
async function oauthLogin(
  config: AuthConfig,
  responder: (url: string) => Response,
): Promise<{ location: string; sessionCookie: string | undefined }> {
  const signinReq = new Request(`${ORIGIN}/auth/signin/gh`);
  const signinCtx = createRequestContext(signinReq);
  const signin = (await runWithContext(signinCtx, () => handleAuthRequest(signinReq, config)))!;
  const state = new URL(signin.headers.get("location")!).searchParams.get("state")!;
  const tx = signinCtx.outgoingHeaders.getSetCookie()
    .find((c) => c.startsWith("__Host-denext_auth_tx="))!.split(";")[0];

  const cbReq = new Request(`${ORIGIN}/auth/callback/gh?code=c0de&state=${state}`, {
    headers: { cookie: tx },
  });
  const cbCtx = createRequestContext(cbReq);
  const realFetch = globalThis.fetch;
  globalThis.fetch =
    ((input: string | URL | Request) => Promise.resolve(responder(String(input)))) as typeof fetch;
  try {
    const cb = (await runWithContext(cbCtx, () => handleAuthRequest(cbReq, config)))!;
    const sessionCookie = cbCtx.outgoingHeaders.getSetCookie()
      .find((c) => c.startsWith("__Host-denext_auth=") && !c.startsWith("__Host-denext_auth=;"));
    return { location: cb.headers.get("location")!, sessionCookie };
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** The `/auth/session` user for a cookie. */
async function whoAmI(config: AuthConfig, cookie: string): Promise<Record<string, unknown> | null> {
  const req = new Request(`${ORIGIN}/auth/session`, {
    headers: { accept: "application/json", cookie: cookie.split(";")[0] },
  });
  const res =
    (await runWithContext(createRequestContext(req), () => handleAuthRequest(req, config)))!;
  return (await res.json()).user;
}

function oauthConfig(extra: Partial<AuthConfig> = {}): AuthConfig {
  return {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    dangerouslyAllowInsecureProviders: true, // route provider calls through the stubbed fetch
    providers: [oauthProvider()],
    pages: { signIn: "/login", afterSignIn: "/home" },
    ...extra,
  };
}

Deno.test("OAuth (non-OIDC) callback: token → userinfo → verified emails → session, no id_token", async () => {
  const config = oauthConfig();
  const { location, sessionCookie } = await oauthLogin(config, ghResponder());
  assertEquals(location, "/home");
  assert(sessionCookie, "a session was issued without any id_token");
  const user = await whoAmI(config, sessionCookie);
  assertEquals(user?.id, "99");
  assertEquals(user?.email, "real@x.test", "the verified address from /user/emails, not userinfo");
});

Deno.test("OAuth callback: a failing emails endpoint fails the login (no unverified fallback)", async () => {
  const { location, sessionCookie } = await oauthLogin(oauthConfig(), ghResponder(500));
  assertStringIncludes(location, "/login?error=oauth_failed");
  assertEquals(sessionCookie, undefined);
});

// ---- signIn / session callbacks ------------------------------------------------

Deno.test("signIn callback: false denies (OAuth → access_denied; credentials → 403), an object enriches", async () => {
  const denied = await oauthLogin(
    oauthConfig({ callbacks: { signIn: () => false } }),
    ghResponder(),
  );
  assertStringIncludes(denied.location, "error=access_denied");
  assertEquals(denied.sessionCookie, undefined);

  const enriched = oauthConfig({
    callbacks: { signIn: (user, provider) => ({ ...user, name: `${user.name}@${provider}` }) },
  });
  const ok = await oauthLogin(enriched, ghResponder());
  assertEquals((await whoAmI(enriched, ok.sessionCookie!))?.name, "octo@gh");

  const credConfig: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    rateLimit: false,
    providers: [credentials({ authorize: () => ({ id: "u1" }) })],
    callbacks: { signIn: (user) => user.id !== "u1" },
  };
  const req = new Request(`${ORIGIN}/auth/callback/credentials`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", origin: ORIGIN },
    body: "{}",
  });
  const res =
    (await runWithContext(createRequestContext(req), () => handleAuthRequest(req, credConfig)))!;
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error, "access denied");
});

Deno.test("session callback: adjusts the issued payload before it is signed", async () => {
  const config = oauthConfig({
    callbacks: {
      session: (s) => ({ ...s, user: { ...s.user, name: "Renamed" }, expiresAt: s.expiresAt - 1 }),
    },
  });
  const { sessionCookie } = await oauthLogin(config, ghResponder());
  assertEquals((await whoAmI(config, sessionCookie!))?.name, "Renamed");
});

// ---- requireAuth pass-through ----------------------------------------------------

Deno.test("requireAuth returns null (continue) for an authenticated request", async () => {
  const config = oauthConfig();
  denextAuth(config);
  const { sessionCookie } = await oauthLogin(config, ghResponder());
  const request = new Request(`${ORIGIN}/dashboard`, {
    headers: { cookie: sessionCookie!.split(";")[0] },
  });
  const res = await runWithContext(createRequestContext(request), () => requireAuth(request));
  assertEquals(res, null, "signed in → the middleware lets the request through");
});

// ---- the nine built-in presets ------------------------------------------------
// (imported through `providers.ts`, which re-exports `providers-presets.ts` — the same
// path `denext/server` takes.)

const CRED = { clientId: "cid", clientSecret: "csecret" };

// The per-provider option types are the public config surface an app writes against.
const ENTRA_OPTS: MicrosoftEntraOptions = {
  ...CRED,
  tenant: "11111111-2222-3333-4444-555555555555",
};
const GITLAB_OPTS: GitLabOptions = { ...CRED, baseUrl: "https://git.example.com" };
const AUTH0_OPTS: Auth0Options = { ...CRED, domain: "acme.eu.auth0.com" };
const OKTA_OPTS: OktaOptions = { ...CRED, domain: "dev-1234.okta.com" };
const KEYCLOAK_OPTS: KeycloakOptions = {
  ...CRED,
  baseUrl: "https://sso.example.com",
  realm: "acme",
};

/** Every built-in OAuth/OIDC preset, built with the same throwaway credentials. */
function allPresets(): OAuthProvider[] {
  return [
    google(CRED),
    github(CRED),
    microsoftEntra(ENTRA_OPTS),
    apple(CRED),
    discord(CRED),
    gitlab(CRED),
    slack(CRED),
    auth0(AUTH0_OPTS),
    okta(OKTA_OPTS),
    keycloak(KEYCLOAK_OPTS),
    facebook(CRED),
  ];
}

Deno.test("presets: unique ids, non-empty scopes, https endpoints, default strictAudience", () => {
  const presets = allPresets();
  const ids = presets.map((p) => p.id);
  assertEquals(new Set(ids).size, ids.length, `duplicate provider id in ${ids.join(", ")}`);
  for (const p of presets) {
    assert(/^[a-z0-9-]+$/.test(p.id), `${p.id} is not a URL-safe route segment`);
    assert(p.scopes.length > 0, `${p.id} requests no scopes`);
    assertEquals(p.clientId, "cid");
    assertEquals(
      p.strictAudience,
      undefined,
      `${p.id} must leave strictAudience at the (strict) default`,
    );
    for (const url of [p.authorizationUrl, p.tokenUrl, p.userinfoUrl, p.jwksUrl]) {
      if (url) assertEquals(new URL(url).protocol, "https:", `${p.id}: ${url} is not https`);
    }
  }
});

Deno.test("presets: every OIDC preset carries a matching discovery issuer; OAuth ones don't", () => {
  for (const p of allPresets()) {
    if (p.type === "oidc") {
      assert(p.issuer, `${p.id} has no issuer`);
      assert(p.jwksUrl, `${p.id} has no jwksUrl`);
      // `google` keeps its long-standing static endpoints (no behavior change); the nine
      // new presets publish the issuer so discovery can refresh/verify the URLs.
      if (p.id !== "google") {
        assertEquals(p.discovery?.issuer, p.issuer, `${p.id} discovery issuer mismatch`);
      }
    } else {
      assertEquals(p.discovery, undefined, `${p.id} is not OIDC but advertises discovery`);
    }
  }
});

Deno.test("preset endpoints: tenant / domain / realm land in the documented URLs", () => {
  const entra = microsoftEntra({ ...CRED, tenant: "contoso.com" });
  assertEquals(entra.issuer, "https://login.microsoftonline.com/contoso.com/v2.0");
  assertEquals(
    entra.authorizationUrl,
    "https://login.microsoftonline.com/contoso.com/oauth2/v2.0/authorize",
  );
  assertEquals(entra.tokenUrl, "https://login.microsoftonline.com/contoso.com/oauth2/v2.0/token");
  assertEquals(entra.jwksUrl, "https://login.microsoftonline.com/contoso.com/discovery/v2.0/keys");
  assertEquals(entra.userinfoUrl, undefined, "claims come from the verified id_token");

  // Auth0's issuer keeps its trailing slash — `iss` is compared byte-for-byte.
  const a0 = auth0({ ...CRED, domain: "acme.eu.auth0.com" });
  assertEquals(a0.issuer, "https://acme.eu.auth0.com/");
  assertEquals(a0.authorizationUrl, "https://acme.eu.auth0.com/authorize");
  assertEquals(a0.jwksUrl, "https://acme.eu.auth0.com/.well-known/jwks.json");

  assertEquals(
    okta({ ...CRED, domain: "dev-1234.okta.com" }).issuer,
    "https://dev-1234.okta.com/oauth2/default",
  );
  assertEquals(
    okta({ ...CRED, domain: "dev-1234.okta.com", authorizationServer: "aus1x" }).tokenUrl,
    "https://dev-1234.okta.com/oauth2/aus1x/v1/token",
  );

  const kc = keycloak(KEYCLOAK_OPTS);
  assertEquals(kc.issuer, "https://sso.example.com/realms/acme");
  assertEquals(
    kc.authorizationUrl,
    "https://sso.example.com/realms/acme/protocol/openid-connect/auth",
  );
  assertEquals(kc.jwksUrl, "https://sso.example.com/realms/acme/protocol/openid-connect/certs");

  assertEquals(gitlab(CRED).issuer, "https://gitlab.com");
  assertEquals(
    gitlab(GITLAB_OPTS).tokenUrl,
    "https://git.example.com/oauth/token",
  );
  assertEquals(slack(CRED).tokenUrl, "https://slack.com/api/openid.connect.token");
});

Deno.test("preset OIDC mapper: shared across the presets; an unverified email never surfaces", () => {
  for (const p of [slack(CRED), auth0({ ...CRED, domain: "acme.auth0.com" })]) {
    assertEquals(
      p.profile({
        tokens: {},
        claims: { sub: "u1", name: "U", email: "u@x.test", email_verified: true, picture: "p.png" },
      }),
      { id: "u1", name: "U", email: "u@x.test", emailVerified: true, image: "p.png" },
    );
    // The STRING "false" some IdPs ship must not read as "verified".
    const dropped = p.profile({
      tokens: {},
      claims: { sub: "u2", email: "victim@x.test", email_verified: "false" },
    });
    assertEquals(dropped.email, undefined);
    assertEquals(dropped.emailVerified, false);
    // No claim at all → no assertion either way (an adapter refuses to link on that).
    assertEquals(
      p.profile({ tokens: {}, claims: { sub: "u3", email: "e@x.test" } }).emailVerified,
      undefined,
    );
  }
});

Deno.test("discord profile: the `verified` flag gates the email; avatar becomes a CDN URL", () => {
  const p = discord(CRED);
  const full = p.profile({
    tokens: {},
    userinfo: {
      id: "1234",
      username: "octo",
      global_name: "Octo Cat",
      email: "octo@x.test",
      verified: true,
      avatar: "abc123",
    },
  });
  assertEquals(full, {
    id: "1234",
    name: "Octo Cat",
    email: "octo@x.test",
    emailVerified: true,
    image: "https://cdn.discordapp.com/avatars/1234/abc123.png",
  });
  const unverified = p.profile({
    tokens: {},
    userinfo: { id: "9", username: "u", email: "victim@x.test", verified: false },
  });
  assertEquals(unverified.email, undefined, "an unverified Discord address is dropped");
  assertEquals(unverified.emailVerified, false);
  assertEquals(unverified.name, "u", "username is the fallback display name");
  assertEquals(unverified.image, undefined);
  assertEquals(p.profile({ tokens: {}, userinfo: { id: "9" } }).emailVerified, undefined);
});

Deno.test("facebook profile: Graph fields; the Graph API never asserts email verification", () => {
  const p = facebook(CRED);
  const mapped = p.profile({
    tokens: {},
    userinfo: {
      id: "42",
      name: "Zed",
      email: "zed@x.test",
      picture: { data: { url: "https://cdn.x.test/z.jpg" } },
    },
  });
  assertEquals(mapped, {
    id: "42",
    name: "Zed",
    email: "zed@x.test",
    image: "https://cdn.x.test/z.jpg",
  });
  assertEquals(mapped.emailVerified, undefined, "Graph makes no verification claim");
  // Phone-registered accounts (or a revoked permission) simply omit the email.
  assertEquals(p.profile({ tokens: {}, userinfo: { id: "43" } }).email, undefined);
  assertStringIncludes(p.userinfoUrl!, "fields=id,name,email,picture");
});

Deno.test("apple: `openid` only — name/email need response_mode=form_post (documented limitation)", () => {
  const p = apple(CRED);
  assertEquals(p.scopes, ["openid"]);
  assertEquals(p.issuer, "https://appleid.apple.com");
  assertThrows(
    () => apple({ ...CRED, scopes: ["openid", "email"] }),
    TypeError,
    "form_post",
  );
  assertThrows(() => apple({ ...CRED, scopes: ["name"] }), TypeError);
});

Deno.test("microsoftEntra: the multi-tenant aliases are refused (template issuer can't be verified)", () => {
  for (const tenant of ["common", "organizations", "consumers", "COMMON"]) {
    assertThrows(
      () => microsoftEntra({ ...CRED, tenant }),
      TypeError,
      "specific tenant",
    );
  }
  assertThrows(() => microsoftEntra({ ...CRED, tenant: "contoso.com/evil" }), TypeError);
  assertThrows(() => microsoftEntra({ ...CRED, tenant: "" }), TypeError);
});

Deno.test("preset inputs are validated: http, paths, credentials and separators are refused", () => {
  for (
    const domain of [
      "http://acme.eu.auth0.com",
      "acme.eu.auth0.com/evil.test",
      "https://user:pw@acme.eu.auth0.com",
      "acme.eu.auth0.com?x=1",
      "acme.eu.auth0.com#f",
      "",
    ]
  ) {
    assertThrows(() => auth0({ ...CRED, domain }), TypeError, "auth0 domain");
  }
  assertThrows(
    () => keycloak({ ...CRED, baseUrl: "http://sso.example.com", realm: "acme" }),
    TypeError,
    "keycloak baseUrl",
  );
  assertThrows(
    () => keycloak({ ...CRED, baseUrl: "https://sso.example.com", realm: "../master" }),
    TypeError,
    "keycloak realm",
  );
  assertThrows(
    () => okta({ ...CRED, domain: "dev-1234.okta.com", authorizationServer: "a/b" }),
    TypeError,
    "okta authorizationServer",
  );
  assertThrows(() => gitlab({ ...CRED, baseUrl: "http://git.example.com" }), TypeError);
  // A host with an explicit port is fine (self-managed instances run on one).
  assertEquals(
    keycloak({ ...CRED, baseUrl: "https://sso.example.com:8443", realm: "acme" }).issuer,
    "https://sso.example.com:8443/realms/acme",
  );
  // An empty scope override is refused rather than sent as an empty `scope=` param.
  assertThrows(() => slack({ ...CRED, scopes: [] }), TypeError, "at least one scope");
  assertEquals(discord({ ...CRED, scopes: ["identify"] }).scopes, ["identify"]);
});

Deno.test("oidc(): issuer-only discovery form, explicit form, and the refused half-configured one", () => {
  const discovered = oidc({ issuer: "https://idp.test", clientId: "c", clientSecret: "s" });
  assertEquals(discovered.discovery?.issuer, "https://idp.test");
  assertEquals(discovered.scopes, ["openid", "email", "profile"]);
  // Until discovery resolves them the endpoints point at the issuer's own discovery
  // document — never at an invented path — which also pins safeFetch to the issuer host.
  const wellKnown = "https://idp.test/.well-known/openid-configuration";
  assertEquals(discovered.authorizationUrl, wellKnown);
  assertEquals(discovered.tokenUrl, wellKnown);
  assertEquals(discovered.jwksUrl, wellKnown);
  assertEquals(
    oidc({ issuer: "https://idp.test/", clientId: "c", clientSecret: "s" }).jwksUrl,
    wellKnown,
    "a trailing slash on the issuer never doubles up in the discovery URL",
  );

  // The four-URL form is unchanged and never triggers discovery.
  const explicit = oidc({
    id: "corp",
    issuer: "https://idp.test",
    authorizationUrl: "https://idp.test/a",
    tokenUrl: "https://idp.test/t",
    jwksUrl: "https://idp.test/j",
    clientId: "c",
    clientSecret: "s",
  });
  assertEquals(explicit.discovery, undefined);
  assertEquals(explicit.authorizationUrl, "https://idp.test/a");
  assertEquals(explicit.id, "corp");

  assertThrows(
    () =>
      oidc({
        issuer: "https://idp.test",
        tokenUrl: "https://idp.test/t",
        clientId: "c",
        clientSecret: "s",
      }),
    TypeError,
    "issuer-only OIDC discovery",
  );
});
