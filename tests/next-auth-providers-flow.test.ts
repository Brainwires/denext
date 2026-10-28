// Fifteen of the `next-auth/providers/*` modules driven end to end through denext's sign-in and
// callback routes against a stubbed identity provider: the authorization URL (endpoint, scopes,
// state, the OIDC nonce, PKCE S256 when the provider's checks ask for it, form_post), the token
// request (grant, code, the exact redirect_uri, the code_verifier, client authentication), the
// profile the app's callbacks see, and — for the OIDC ones — id_token validation. Each provider
// also refuses a mismatched state, and each OIDC one a forged issuer (in the id_token or in the
// RFC 9207 `iss` response parameter), a foreign audience, an expired token and a replayed nonce.

import { assert, assertEquals } from "@std/assert";
import { translateConfig } from "../packages/auth/next-auth/config.ts";
import type { Provider } from "../packages/auth/next-auth/types.ts";
import {
  createRequestContext,
  type RequestContext,
  runWithContext,
} from "../src/server/request-context.ts";
import { handleAuthRequest } from "../packages/auth/src/routes.ts";
import { base64UrlEncode } from "../packages/auth/src/oauth.ts";
import type { AuthConfig, AuthUser, OAuthProvider } from "../packages/auth/src/types.ts";
import { appConfig, type Idp, makeIdp, ORIGIN, txData } from "./helpers/oauth-flow-harness.ts";
import Apple from "../packages/auth/next-auth/providers/apple.ts";
import Auth0 from "../packages/auth/next-auth/providers/auth0.ts";
import Discord from "../packages/auth/next-auth/providers/discord.ts";
import GitHub from "../packages/auth/next-auth/providers/github.ts";
import Google from "../packages/auth/next-auth/providers/google.ts";
import Keycloak from "../packages/auth/next-auth/providers/keycloak.ts";
import LinkedIn from "../packages/auth/next-auth/providers/linkedin.ts";
import MicrosoftEntraID from "../packages/auth/next-auth/providers/microsoft-entra-id.ts";
import Okta from "../packages/auth/next-auth/providers/okta.ts";
import Reddit from "../packages/auth/next-auth/providers/reddit.ts";
import Slack from "../packages/auth/next-auth/providers/slack.ts";
import Spotify from "../packages/auth/next-auth/providers/spotify.ts";
import Twitch from "../packages/auth/next-auth/providers/twitch.ts";
import Twitter from "../packages/auth/next-auth/providers/twitter.ts";
import Zoom from "../packages/auth/next-auth/providers/zoom.ts";

const IDP: Idp = await makeIdp();
const TX = "__Host-denext_auth_tx";
const TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

/** One provider's row: how it is built, and what the flow must look like. */
interface Row {
  /** The next-auth provider (a module's default export, called or not). */
  provider: Provider;
  /** The authorization endpoint (origin + path). */
  authorize: string;
  /** The `scope` parameter. */
  scope: string;
  /** Whether PKCE (S256) runs. */
  pkce: boolean;
  /** `client_secret_basic` (else the credentials ride the body). */
  basic: boolean;
  /** Extra authorization parameters the provider adds. */
  params?: Record<string, string>;
  /** Apple: the authorization response is POSTed (`response_mode=form_post`). */
  formPost?: boolean;
  /** The userinfo body (OAuth providers), or extra id_token claims (OIDC). */
  userinfo?: Record<string, unknown>;
  claims?: Record<string, unknown>;
  /** GitHub's email list. */
  emails?: unknown[];
  /** The form fields Apple posts besides `code` / `state`. */
  postFields?: Record<string, string>;
  /** The user the app's `signIn` callback receives. */
  user: AuthUser;
}

const ROWS: Record<string, Row> = {
  apple: {
    provider: Apple,
    authorize: "https://appleid.apple.com/auth/authorize",
    scope: "openid name email",
    pkce: true,
    basic: false,
    formPost: true,
    claims: { email: "ada@privaterelay.appleid.com", email_verified: "true" },
    postFields: { user: JSON.stringify({ name: { firstName: "Ada", lastName: "Lovelace" } }) },
    user: {
      id: "sub-1",
      name: "Ada Lovelace",
      email: "ada@privaterelay.appleid.com",
      emailVerified: true,
    },
  },
  "microsoft-entra-id": {
    provider: MicrosoftEntraID({ issuer: `https://login.microsoftonline.com/${TENANT}/v2.0` }),
    authorize: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
    scope: "openid email profile",
    pkce: true,
    basic: false,
    claims: { tid: TENANT, name: "Ada", email: "ada@contoso.com" },
    user: { id: "sub-1", name: "Ada", email: "ada@contoso.com" },
  },
  twitter: {
    provider: Twitter,
    authorize: "https://x.com/i/oauth2/authorize",
    scope: "users.read tweet.read offline.access",
    pkce: true,
    basic: true,
    userinfo: { data: { id: "x-1", name: "Ada", profile_image_url: "https://pbs.twimg.com/a" } },
    user: { id: "x-1", name: "Ada", image: "https://pbs.twimg.com/a" },
  },
  reddit: {
    provider: Reddit,
    authorize: "https://www.reddit.com/api/v1/authorize",
    scope: "identity",
    pkce: false, // Auth.js's Reddit runs `checks: ["state"]`
    basic: true,
    userinfo: { id: "t2_x", name: "ada" },
    user: { id: "t2_x", name: "ada" },
  },
  github: {
    provider: GitHub,
    authorize: "https://github.com/login/oauth/authorize",
    scope: "read:user user:email",
    pkce: true,
    basic: false,
    userinfo: { id: 7, login: "ada", avatar_url: "https://avatars.example/7" },
    emails: [
      { email: "spoof@example.com", primary: false, verified: false },
      { email: "ada@example.com", primary: true, verified: true },
    ],
    user: {
      id: "7",
      name: "ada",
      email: "ada@example.com",
      emailVerified: true,
      image: "https://avatars.example/7",
    },
  },
  google: {
    provider: Google,
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    scope: "openid email profile",
    pkce: true,
    basic: false,
    claims: { email: "ada@gmail.com", email_verified: true, name: "Ada", picture: "https://g/p" },
    user: {
      id: "sub-1",
      name: "Ada",
      email: "ada@gmail.com",
      emailVerified: true,
      image: "https://g/p",
    },
  },
  discord: {
    provider: Discord,
    authorize: "https://discord.com/api/oauth2/authorize",
    scope: "identify email",
    pkce: true,
    basic: false,
    userinfo: { id: "80", username: "ada", email: "ada@example.com", verified: false },
    user: { id: "80", name: "ada", emailVerified: false },
  },
  slack: {
    provider: Slack,
    authorize: "https://slack.com/openid/connect/authorize",
    scope: "openid profile email",
    pkce: true,
    basic: false,
    claims: { email: "ada@example.com", email_verified: true, name: "Ada" },
    user: { id: "sub-1", name: "Ada", email: "ada@example.com", emailVerified: true },
  },
  keycloak: {
    provider: Keycloak({ issuer: "https://kc.example.com/realms/main" }),
    authorize: "https://kc.example.com/realms/main/protocol/openid-connect/auth",
    scope: "openid email profile",
    pkce: true,
    basic: false,
    claims: { email: "ada@example.com", email_verified: false, name: "Ada" },
    user: { id: "sub-1", name: "Ada", emailVerified: false },
  },
  auth0: {
    provider: Auth0({ issuer: "https://tenant.auth0.example" }),
    authorize: "https://tenant.auth0.example/authorize",
    scope: "openid email profile",
    pkce: true,
    basic: false,
    claims: { email: "ada@example.com", email_verified: true, name: "Ada" },
    user: { id: "sub-1", name: "Ada", email: "ada@example.com", emailVerified: true },
  },
  okta: {
    provider: Okta({ issuer: "https://dev-1.okta.example/oauth2/default" }),
    authorize: "https://dev-1.okta.example/oauth2/default/v1/authorize",
    scope: "openid email profile",
    pkce: true,
    basic: false,
    claims: { email: "ada@example.com", email_verified: true, name: "Ada" },
    user: { id: "sub-1", name: "Ada", email: "ada@example.com", emailVerified: true },
  },
  linkedin: {
    provider: LinkedIn,
    authorize: "https://www.linkedin.com/oauth/v2/authorization",
    scope: "openid profile email",
    pkce: true,
    basic: false,
    claims: { email: "ada@example.com", email_verified: true, name: "Ada", picture: "https://l/p" },
    user: {
      id: "sub-1",
      name: "Ada",
      email: "ada@example.com",
      emailVerified: true,
      image: "https://l/p",
    },
  },
  spotify: {
    provider: Spotify,
    authorize: "https://accounts.spotify.com/authorize",
    scope: "user-read-email",
    pkce: true,
    basic: false,
    userinfo: {
      id: "sp-1",
      display_name: "Ada",
      email: "ada@example.com",
      images: [{ url: "https://i.scdn.co/a" }],
    },
    user: { id: "sp-1", name: "Ada", email: "ada@example.com", image: "https://i.scdn.co/a" },
  },
  twitch: {
    provider: Twitch,
    authorize: "https://id.twitch.tv/oauth2/authorize",
    scope: "openid user:read:email",
    pkce: true,
    basic: false,
    params: {
      claims: JSON.stringify({
        id_token: { email: null, email_verified: null, picture: null, preferred_username: null },
      }),
    },
    claims: {
      preferred_username: "ada",
      email: "ada@example.com",
      email_verified: true,
      picture: "https://t/p",
    },
    user: {
      id: "sub-1",
      name: "ada",
      email: "ada@example.com",
      emailVerified: true,
      image: "https://t/p",
    },
  },
  zoom: {
    provider: Zoom,
    authorize: "https://zoom.us/oauth/authorize",
    scope: "",
    pkce: true,
    basic: true,
    userinfo: {
      id: "z-1",
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.com",
      pic_url: "https://z/p",
    },
    user: { id: "z-1", name: "Ada Lovelace", email: "ada@example.com", image: "https://z/p" },
  },
};

/** Build a next-auth provider the way `NextAuth()` does, with fixed client credentials. */
function build(provider: Provider): OAuthProvider {
  const reader = (name: string) =>
    name.endsWith("_ID") ? "cid" : name.endsWith("_SECRET") ? "c:secret/+" : undefined;
  const active = translateConfig({ secret: "x".repeat(40), providers: [provider] }, reader);
  return active.denext.providers[0] as OAuthProvider;
}

/** What one stubbed identity provider saw. */
interface Seen {
  token: { body: URLSearchParams; headers: Headers }[];
}

/** How the id_token (and the response) misbehaves in a refusal case. */
interface Tamper {
  iss?: string;
  aud?: string;
  exp?: number;
  nonce?: string;
  /** The discovery document advertises RFC 9207 `iss` support. */
  issAdvertised?: boolean;
}

/** Stub every endpoint `p` names; `nonce` is read when the id_token is minted. */
function stubIdp(p: OAuthProvider, row: Row, nonce: () => string | undefined, tamper: Tamper) {
  const seen: Seen = { token: [] };
  const issuer = p.discovery?.issuer ?? p.issuer;
  const noQuery = (u: string) => u.split("?")[0];
  /** The id_token the token endpoint returns (OIDC only), tampered as asked. */
  const idToken = () => {
    const now = Math.floor(Date.now() / 1000);
    const n = nonce();
    return IDP.mint({
      iss: tamper.iss ?? issuer,
      aud: tamper.aud ?? "cid",
      sub: "sub-1",
      iat: now,
      exp: tamper.exp ?? now + 300,
      ...(n === undefined ? {} : { nonce: tamper.nonce ?? n }),
      ...row.claims,
    });
  };
  const token = async (init?: RequestInit) => {
    seen.token.push({
      body: new URLSearchParams(String(init?.body ?? "")),
      headers: new Headers(init?.headers),
    });
    const extra = p.type === "oidc" ? { id_token: await idToken() } : {};
    return Response.json({ access_token: "at", token_type: "bearer", ...extra });
  };
  const routes = new Map<string, (init?: RequestInit) => Response | Promise<Response>>([
    [noQuery(p.tokenUrl), token],
    [noQuery(p.jwksUrl ?? "-"), () => Response.json(IDP.jwks)],
    [noQuery(p.userEmailsUrl ?? "-"), () => Response.json(row.emails)],
    [noQuery(p.userinfoUrl ?? "-"), () => Response.json(row.userinfo ?? {})],
  ]);
  if (issuer) {
    routes.set(
      `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
      () =>
        Response.json({
          issuer,
          authorization_endpoint: p.authorizationUrl,
          token_endpoint: p.tokenUrl,
          jwks_uri: p.jwksUrl,
          ...(p.userinfoUrl ? { userinfo_endpoint: p.userinfoUrl } : {}),
          ...(tamper.issAdvertised ? { authorization_response_iss_parameter_supported: true } : {}),
        }),
    );
  }
  const fetchStub = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = noQuery(String(input instanceof Request ? input.url : input));
    const route = routes.get(url);
    return Promise.resolve(route ? route(init) : new Response(`unstubbed ${url}`, { status: 404 }));
  };
  return { seen, fetchStub };
}

/** Run the auth routes on `request` in a fresh request context. */
async function run(request: Request, config: AuthConfig) {
  const ctx: RequestContext = createRequestContext(request);
  const res = await runWithContext(ctx, () => handleAuthRequest(request, config));
  assert(res);
  return { res, ctx };
}

/** The transaction cookie a response set, as `name=value`. */
function txPair(ctx: RequestContext): string {
  return ctx.outgoingHeaders.getSetCookie().find((c) =>
    c.startsWith(`${TX}=`) && !c.startsWith(`${TX}=;`)
  )!.split(";")[0];
}

/** The base64url SHA-256 of `verifier` (the S256 code challenge). */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** One sign-in through `row`, optionally tampered; returns the outcome. */
async function signIn(
  id: string,
  row: Row,
  tamper: Tamper & { state?: string; issParam?: string } = {},
) {
  const p = build(row.provider);
  const users: AuthUser[] = [];
  const failures: string[] = [];
  const config: AuthConfig = {
    ...appConfig(p, failures),
    callbacks: { signIn: (user) => users.push(user) > 0 },
  };
  let nonce: string | undefined;
  const { seen, fetchStub } = stubIdp(p, row, () => nonce, tamper);
  const original = globalThis.fetch;
  globalThis.fetch = fetchStub as typeof fetch;
  try {
    const started = await run(new Request(`${ORIGIN}/auth/signin/${id}`), config);
    assertEquals(started.res.status, 303, `${id}: sign-in start`);
    const authorize = new URL(started.res.headers.get("location")!);
    const pair = txPair(started.ctx);
    const tx = txData(pair);
    nonce = tx.nonce;
    const fields: Record<string, string> = {
      code: "the-code",
      state: tamper.state ?? tx.state,
      ...(tamper.issParam ? { iss: tamper.issParam } : {}),
      ...row.postFields,
    };
    const request = row.formPost
      ? new Request(`${ORIGIN}/auth/callback/${id}`, {
        method: "POST",
        headers: { cookie: pair, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      })
      : new Request(`${ORIGIN}/auth/callback/${id}?${new URLSearchParams(fields)}`, {
        headers: { cookie: pair },
      });
    const { res } = await run(request, config);
    return { p, authorize, tx, res, seen, users, failures };
  } finally {
    globalThis.fetch = original;
  }
}

/** Whether a callback signed in (landing on `/`). */
function signedIn(res: Response): boolean {
  return res.status === 303 && res.headers.get("location") === "/";
}

for (const [id, row] of Object.entries(ROWS)) {
  Deno.test(`next-auth provider flow: ${id} — authorization URL, token request, profile`, async () => {
    const { p, authorize, tx, res, seen, users, failures } = await signIn(id, row);
    // The authorization request.
    assertEquals(authorize.origin + authorize.pathname, row.authorize);
    const q = authorize.searchParams;
    assertEquals(q.get("response_type"), "code");
    assertEquals(q.get("client_id"), "cid");
    assertEquals(q.get("redirect_uri"), `${ORIGIN}/auth/callback/${id}`);
    assertEquals(q.get("scope") ?? "", row.scope);
    assertEquals(q.get("state"), tx.state);
    assert(tx.state.length >= 32, "state carries enough entropy");
    if (row.pkce) {
      assertEquals(q.get("code_challenge_method"), "S256");
      assertEquals(q.get("code_challenge"), await s256(tx.verifier));
    } else {
      assertEquals(q.get("code_challenge"), null);
      assertEquals(tx.verifier, "");
    }
    assertEquals(q.get("nonce"), p.type === "oidc" ? tx.nonce : null);
    assertEquals(q.get("response_mode"), row.formPost ? "form_post" : null);
    for (const [k, v] of Object.entries(row.params ?? {})) assertEquals(q.get(k), v);

    // The sign-in completes, and the token request is exactly what the provider expects.
    assertEquals(failures, []);
    assert(signedIn(res), `${id}: ${res.status} ${res.headers.get("location")}`);
    assertEquals(seen.token.length, 1);
    const { body, headers } = seen.token[0];
    assertEquals(body.get("grant_type"), "authorization_code");
    assertEquals(body.get("code"), "the-code");
    assertEquals(body.get("redirect_uri"), `${ORIGIN}/auth/callback/${id}`);
    assertEquals(body.get("code_verifier"), row.pkce ? tx.verifier : null);
    if (row.basic) {
      // RFC 6749 §2.3.1: each half form-urlencoded before the base64.
      assertEquals(headers.get("authorization"), `Basic ${btoa("cid:c%3Asecret%2F%2B")}`);
      assertEquals([body.get("client_id"), body.get("client_secret")], [null, null]);
    } else {
      assertEquals(headers.get("authorization"), null);
      assertEquals([body.get("client_id"), body.get("client_secret")], ["cid", "c:secret/+"]);
    }

    // The profile the app sees.
    assertEquals(users.length, 1);
    const user = Object.fromEntries(
      Object.entries(users[0]).filter(([, v]) => v !== undefined),
    );
    assertEquals(user, { ...row.user });
  });

  Deno.test(`next-auth provider flow: ${id} — a mismatched state is refused`, async () => {
    const { res, seen, users, failures } = await signIn(id, row, { state: "forged-state" });
    assert(!signedIn(res));
    assertEquals(failures, ["invalid_state"]);
    assertEquals(seen.token.length, 0, "no code is redeemed for a forged state");
    assertEquals(users, []);
  });

  if (build(row.provider).type !== "oidc") continue;

  const refusals: [string, Tamper & { issParam?: string }][] = [
    ["an id_token from another issuer", { iss: "https://evil.example" }],
    ["an id_token for another client", { aud: "someone-else" }],
    ["an expired id_token", { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ["an id_token with another nonce", { nonce: "replayed-nonce" }],
    ["an `iss` response parameter naming another issuer", { issParam: "https://evil.example" }],
  ];
  for (const [what, tamper] of refusals) {
    Deno.test(`next-auth provider flow: ${id} — ${what} is refused`, async () => {
      const { res, users, failures } = await signIn(id, row, tamper);
      assert(!signedIn(res), `${id} accepted ${what}`);
      assertEquals(users, []);
      assertEquals(failures.length, 1);
    });
  }
}

Deno.test("next-auth provider flow: an `iss` response parameter naming the issuer is accepted", async () => {
  const row = ROWS.google;
  const { res, failures } = await signIn("google", row, {
    issParam: "https://accounts.google.com",
  });
  assertEquals(failures, []);
  assert(signedIn(res));
});

/**
 * A Keycloak row on its own issuer: the discovery document is cached per issuer for an hour, so
 * each RFC 9207 case needs an issuer no other test has resolved.
 */
function issRow(realm: string): Row {
  const issuer = `https://kc-iss.example.com/realms/${realm}`;
  return {
    ...ROWS.keycloak,
    provider: Keycloak({ issuer }),
    authorize: `${issuer}/protocol/openid-connect/auth`,
  };
}

Deno.test("next-auth provider flow: a missing `iss` is refused when discovery advertises RFC 9207 support", async () => {
  const { res, users, failures } = await signIn("keycloak", issRow("adv-missing"), {
    issAdvertised: true,
  });
  assert(!signedIn(res));
  assertEquals(users, []);
  assertEquals(failures.length, 1);
});

Deno.test("next-auth provider flow: a missing `iss` is accepted when discovery does not advertise it", async () => {
  const { res, failures } = await signIn("keycloak", issRow("plain"), { issAdvertised: false });
  assertEquals(failures, []);
  assert(signedIn(res));
});

Deno.test("next-auth provider flow: a correct `iss` is accepted when discovery advertises RFC 9207 support", async () => {
  const { res, failures } = await signIn("keycloak", issRow("adv-ok"), {
    issAdvertised: true,
    issParam: "https://kc-iss.example.com/realms/adv-ok",
  });
  assertEquals(failures, []);
  assert(signedIn(res));
});
