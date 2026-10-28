// The `next-auth/providers/*` modules beyond the first nine: each builds the denext provider
// Auth.js's module describes — its id, endpoints, env defaults (`AUTH_<ID>_ID` / `_SECRET` /
// `_ISSUER`), token-endpoint authentication and profile mapping — and the issuer-taking ones
// refuse an issuer they can't place.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { translateConfig } from "../packages/auth/next-auth/config.ts";
import Auth0 from "../packages/auth/next-auth/providers/auth0.ts";
import Cognito from "../packages/auth/next-auth/providers/cognito.ts";
import Facebook from "../packages/auth/next-auth/providers/facebook.ts";
import GitLab from "../packages/auth/next-auth/providers/gitlab.ts";
import Keycloak from "../packages/auth/next-auth/providers/keycloak.ts";
import LinkedIn from "../packages/auth/next-auth/providers/linkedin.ts";
import Notion from "../packages/auth/next-auth/providers/notion.ts";
import Okta from "../packages/auth/next-auth/providers/okta.ts";
import Slack from "../packages/auth/next-auth/providers/slack.ts";
import Spotify from "../packages/auth/next-auth/providers/spotify.ts";
import Twitch from "../packages/auth/next-auth/providers/twitch.ts";
import Twitter from "../packages/auth/next-auth/providers/twitter.ts";
import Zoom from "../packages/auth/next-auth/providers/zoom.ts";
import type { Provider } from "../packages/auth/next-auth/types.ts";
import type { OAuthProvider } from "../packages/auth/src/types.ts";

const SECRET = "next-auth-providers-test-secret-at-least-32";

/** Build `providers` against `env`, returning the denext providers by id. */
function build(
  providers: Provider[],
  env: Record<string, string> = {},
): Record<string, OAuthProvider> {
  const reader = (name: string) =>
    env[name] ?? (name.endsWith("_ID") ? "cid" : name.endsWith("_SECRET") ? "csecret" : undefined);
  const active = translateConfig({ secret: SECRET, providers }, reader);
  return Object.fromEntries(
    (active.denext.providers as OAuthProvider[]).map((p) => [p.id, p]),
  );
}

Deno.test("next-auth providers: the presets denext already has, under Auth.js's ids and env", () => {
  const p = build([GitLab, Facebook, Slack, Auth0, Okta, Keycloak], {
    AUTH_GITLAB_ID: "gl-id",
    AUTH_AUTH0_ISSUER: "https://acme.eu.auth0.com",
    AUTH_OKTA_ISSUER: "https://dev-1.okta.com/oauth2/default",
    AUTH_KEYCLOAK_ISSUER: "https://sso.example.com/realms/acme",
  });
  assertEquals(p.gitlab.clientId, "gl-id");
  assertEquals(p.gitlab.authorizationUrl, "https://gitlab.com/oauth/authorize");
  assertEquals(p.facebook.type, "oauth");
  assertEquals(p.slack.issuer, "https://slack.com");
  assertEquals(p.auth0.issuer, "https://acme.eu.auth0.com/");
  assertEquals(p.okta.issuer, "https://dev-1.okta.com/oauth2/default");
  assertEquals(p.okta.authorizationUrl, "https://dev-1.okta.com/oauth2/default/v1/authorize");
  assertEquals(p.keycloak.issuer, "https://sso.example.com/realms/acme");
  assertEquals(
    p.keycloak.tokenUrl,
    "https://sso.example.com/realms/acme/protocol/openid-connect/token",
  );
});

Deno.test("next-auth providers: an issuer picks the deployment, or is refused", () => {
  const p = build([
    GitLab({ issuer: "https://git.example.com" }),
    Okta({ issuer: "https://dev-1.okta.com" }),
    Keycloak({ issuer: "https://old.example.com/auth/realms/acme" }),
  ]);
  assertEquals(p.gitlab.authorizationUrl, "https://git.example.com/oauth/authorize");
  // The Okta org server and a legacy Keycloak go through discovery from the issuer.
  assertEquals(p.okta.discovery?.issuer, "https://dev-1.okta.com");
  assertEquals(p.keycloak.discovery?.issuer, "https://old.example.com/auth/realms/acme");
  assertThrows(() => build([Auth0]), TypeError, "AUTH_AUTH0_ISSUER");
  assertThrows(() => build([Okta({ issuer: "http://dev-1.okta.com" })]), TypeError, "https");
  assertThrows(() => build([Okta({ issuer: "https://dev-1.okta.com/x/y" })]), TypeError);
  assertThrows(() => build([Cognito]), TypeError, "AUTH_COGNITO_ISSUER");
});

Deno.test("next-auth providers: Cognito discovers its endpoints on the pool's hosted domain", () => {
  const p = build([
    Cognito({ issuer: "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_AbC" }),
  ]);
  assertEquals(
    p.cognito.discovery?.issuer,
    "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_AbC",
  );
  assertEquals(p.cognito.allowedHosts, ["*.auth.eu-west-1.amazoncognito.com"]);
  const custom = build([
    Cognito({
      issuer: "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_AbC",
      allowedHosts: ["login.example.com"],
    }),
  ]);
  assertEquals(custom.cognito.allowedHosts, [
    "*.auth.eu-west-1.amazoncognito.com",
    "login.example.com",
  ]);
});

Deno.test("next-auth providers: X, Zoom and Notion authenticate at the token endpoint with Basic", () => {
  const p = build([Twitter, Zoom, Notion({ redirectUri: "https://ignored.example/cb" }), Spotify]);
  assertEquals(p.twitter.tokenEndpointAuthMethod, "client_secret_basic");
  assertEquals(p.zoom.tokenEndpointAuthMethod, "client_secret_basic");
  assertEquals(p.notion.tokenEndpointAuthMethod, "client_secret_basic");
  assertEquals(p.spotify.tokenEndpointAuthMethod, undefined, "client_secret_post");
  assertEquals(p.twitter.scopes, ["users.read", "tweet.read", "offline.access"]);
  assertEquals(p.zoom.scopes, [], "Zoom's scopes come from the app registration");
  assertEquals(p.notion.scopes, []);
  assertEquals(p.notion.authorizationParams?.owner, "user");
  const scoped = build([Zoom({ authorization: { params: { scope: "user:read" } } })]);
  assertEquals(scoped.zoom.scopes, ["user:read"]);
});

Deno.test("next-auth providers: each profile maps as Auth.js's does", async () => {
  const p = build([Twitter, LinkedIn, Twitch, Spotify, Zoom, Notion]);
  const x = await p.twitter.profile({
    tokens: {},
    userinfo: { data: { id: "42", name: "Ada", profile_image_url: "https://x/i.png" } },
  });
  assertEquals([x.id, x.name, x.email, x.image], ["42", "Ada", undefined, "https://x/i.png"]);
  const li = await p.linkedin.profile({
    tokens: {},
    claims: { sub: "li1", name: "Li", email: "li@example.com", email_verified: true },
  });
  assertEquals([li.id, li.email, li.emailVerified], ["li1", "li@example.com", true]);
  assertEquals(p.linkedin.issuer, "https://www.linkedin.com/oauth");
  const tw = await p.twitch.profile({
    tokens: {},
    claims: { sub: "t1", preferred_username: "streamer", email: "s@example.com" },
  });
  assertEquals([tw.id, tw.name, tw.email], ["t1", "streamer", "s@example.com"]);
  const claims = JSON.parse(p.twitch.authorizationParams!.claims);
  assert("email" in claims.id_token && "email_verified" in claims.id_token);
  const sp = await p.spotify.profile({
    tokens: {},
    userinfo: { id: "sp", display_name: "Spot", email: "sp@example.com", images: [{ url: "u" }] },
  });
  assertEquals([sp.id, sp.name, sp.image, sp.emailVerified], ["sp", "Spot", "u", undefined]);
  const zm = await p.zoom.profile({
    tokens: {},
    userinfo: { id: "z", first_name: "Zo", last_name: "Om", email: "z@example.com" },
  });
  assertEquals([zm.id, zm.name, zm.email], ["z", "Zo Om", "z@example.com"]);
  const owner = {
    object: "user",
    id: "n-user",
    name: "Notion User",
    avatar_url: "https://n/a.png",
    type: "person",
    person: { email: "n@example.com" },
  };
  const nt = await p.notion.profile({ tokens: { access_token: "a", owner: { user: owner } } });
  assertEquals([nt.id, nt.name, nt.email, nt.image], [
    "n-user",
    "Notion User",
    "n@example.com",
    "https://n/a.png",
  ]);
});

Deno.test("next-auth providers: Notion's profile() override receives the owner user", async () => {
  let seen: Record<string, unknown> | undefined;
  const p = build([
    Notion({
      profile: (profile) => {
        seen = profile;
        return { id: String(profile.id), email: "n@example.com" };
      },
    }),
  ]);
  const user = await p.notion.profile({
    tokens: { owner: { user: { id: "n-user", person: { email: "n@example.com" } } } },
  });
  assertEquals(seen?.id, "n-user");
  assertEquals(user.id, "n-user");
});

Deno.test("next-auth providers: a custom provider object may ask for client_secret_basic", () => {
  const p = build([{
    id: "acme",
    name: "Acme",
    type: "oauth",
    authorization: { url: "https://acme.test/authorize", params: { scope: "read" } },
    token: "https://acme.test/token",
    userinfo: "https://acme.test/me",
    client: { token_endpoint_auth_method: "client_secret_basic" },
  }]);
  assertEquals(p.acme.tokenEndpointAuthMethod, "client_secret_basic");
});

Deno.test('next-auth providers: v4\'s Twitter({ version: "2.0" }) builds the same OAuth 2.0 provider', () => {
  // NextAuth.js v4 apps opt in to X's OAuth 2.0 with `version: "2.0"`; denext runs nothing else.
  const v4 = build([Twitter({ clientId: "v4-id", clientSecret: "v4-secret", version: "2.0" })]);
  assertEquals(v4.twitter.clientId, "v4-id");
  assertEquals(v4.twitter.tokenUrl, "https://api.x.com/2/oauth2/token");
  assertEquals(v4.twitter.scopes, ["users.read", "tweet.read", "offline.access"]);
});
