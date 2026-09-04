// Provider presets and the app callbacks: the `profile` mappers (verified-email
// handling), the non-OIDC OAuth callback path (userinfo + emails, no id_token), the
// signIn / session callbacks on both flows, and requireAuth's authenticated pass-through.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { denextAuth, requireAuth } from "../src/server/auth/mod.ts";
import { credentials, github, google, oidc } from "../src/server/auth/providers.ts";
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
