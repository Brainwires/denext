// The generated `next-auth/providers/*` modules: the drift gate (the checked-in manifest covers
// exactly the pinned `@auth/core`'s provider list, and the modules, the list and `deno.json` are
// what the generator renders from it), and the behaviour of the generated runtime — Auth.js's
// defaults, option templates, issuers, and the profile mappings traced off Auth.js's own.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  AUTHJS_CORE_VERSION,
  HAND_WRITTEN,
  UNSUPPORTED,
} from "../scripts/auth-providers/classify.ts";
import {
  type ProviderManifest,
  providerModules,
  PROVIDERS_DIR,
} from "../scripts/auth-providers/render.ts";
import { expectedFiles, extract, MANIFEST, Unexpressible } from "../scripts/gen-auth-providers.ts";
import { translateConfig } from "../src/compat/next-auth/config.ts";
import { mapProfile } from "../src/compat/next-auth/providers/generated.ts";
import { NEXT_AUTH_PROVIDER_MODULES } from "../src/compat/next-auth/providers/list.ts";
import { signInRecord } from "../src/compat/next-auth/state.ts";
import { inRequest, Jar, request } from "./helpers/next-auth-harness.ts";
import Descope from "../src/compat/next-auth/providers/descope.ts";
import Dribbble from "../src/compat/next-auth/providers/dribbble.ts";
import Eventbrite from "../src/compat/next-auth/providers/eventbrite.ts";
import EVEOnline from "../src/compat/next-auth/providers/eveonline.ts";
import FusionAuth from "../src/compat/next-auth/providers/fusionauth.ts";
import Kakao from "../src/compat/next-auth/providers/kakao.ts";
import Mattermost from "../src/compat/next-auth/providers/mattermost.ts";
import Reddit from "../src/compat/next-auth/providers/reddit.ts";
import Salesforce from "../src/compat/next-auth/providers/salesforce.ts";
import Webex from "../src/compat/next-auth/providers/webex.ts";
import WorkOS from "../src/compat/next-auth/providers/workos.ts";
import Zitadel from "../src/compat/next-auth/providers/zitadel.ts";
import AzureAD from "../src/compat/next-auth/providers/azure-ad.ts";
import type { Provider } from "../src/compat/next-auth/types.ts";
import type { AuthUser, OAuthProvider, ProfileInput } from "../src/server/auth/types.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const SECRET = "next-auth-generated-providers-secret-32+";

const manifest = JSON.parse(await Deno.readTextFile(join(ROOT, MANIFEST))) as ProviderManifest;

/** Build `providers` against `env`, returning the denext providers by id. */
function build(
  providers: Provider[],
  env: Record<string, string> = {},
): Record<string, OAuthProvider> {
  const reader = (name: string) =>
    env[name] ?? (name.endsWith("_ID") ? "cid" : name.endsWith("_SECRET") ? "csecret" : undefined);
  const active = translateConfig({ secret: SECRET, providers }, reader);
  return Object.fromEntries((active.denext.providers as OAuthProvider[]).map((p) => [p.id, p]));
}

/** Run a provider's profile mapper. */
async function profileOf(provider: OAuthProvider, input: Partial<ProfileInput>): Promise<AuthUser> {
  return await provider.profile({ tokens: {}, ...input });
}

Deno.test("generated providers: the manifest covers exactly the pinned @auth/core list", () => {
  assertEquals(manifest.authjsCore, AUTHJS_CORE_VERSION);
  const generated = Object.keys(manifest.generated);
  const unsupported = Object.keys(manifest.unsupported);
  const classified = [...manifest.handWritten, ...generated, ...unsupported].sort();
  assertEquals(classified, [...manifest.all].sort());
  assertEquals(new Set(classified).size, classified.length, "a provider is classified twice");
  assertEquals(manifest.handWritten, [...HAND_WRITTEN].sort());
  assertEquals(manifest.unsupported, UNSUPPORTED);
  for (const reason of Object.values(manifest.unsupported)) assert(reason.length > 20);
  assertEquals([...NEXT_AUTH_PROVIDER_MODULES], providerModules(manifest));
});

Deno.test("generated providers: every module, export and doc-lint entry is in place", async () => {
  const denoJson = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json"))) as {
    exports: Record<string, string>;
    tasks: Record<string, string>;
  };
  for (const id of providerModules(manifest)) {
    const path = `${PROVIDERS_DIR}/${id}.ts`;
    await Deno.stat(join(ROOT, path));
    assertEquals(denoJson.exports[`./next-auth/providers/${id}`], `./${path}`);
    assert(denoJson.tasks["doc-lint"].includes(` ${path} `), `doc-lint misses ${path}`);
  }
  for (const id of Object.keys(manifest.unsupported)) {
    assertEquals(denoJson.exports[`./next-auth/providers/${id}`], undefined);
  }
});

Deno.test("generated providers: the checked-in files are what the manifest renders", async () => {
  const files = await expectedFiles(manifest);
  for (const [path, src] of files) {
    assertEquals(
      await Deno.readTextFile(join(ROOT, path)),
      src,
      `${path} drifted from the manifest: run \`deno task gen:auth-providers\``,
    );
  }
});

Deno.test("generated providers: Auth.js's defaults — client auth, scopes, env", async () => {
  const p = build([Kakao, Reddit, Zitadel({ issuer: "https://zitadel.example.com" })], {
    AUTH_KAKAO_ID: "kakao-id",
  });
  assertEquals(p.kakao.clientId, "kakao-id");
  assertEquals(p.kakao.authorizationUrl, "https://kauth.kakao.com/oauth/authorize");
  assertEquals(p.kakao.tokenEndpointAuthMethod, "client_secret_post");
  assertEquals(p.kakao.scopes, []); // `?scope` with no value
  // No client auth named: HTTP Basic (Auth.js's default); no scope named: openid profile email.
  assertEquals(p.reddit.tokenEndpointAuthMethod, "client_secret_basic");
  assertEquals(p.reddit.scopes, ["identity"]);
  assertEquals(p.zitadel.type, "oidc");
  assertEquals(p.zitadel.discovery?.issuer, "https://zitadel.example.com");
  assertEquals(p.zitadel.scopes, ["openid", "profile", "email"]);
  // Reddit has no profile(): Auth.js's default mapping.
  assertEquals(
    await profileOf(p.reddit, { userinfo: { id: "t2_x", name: "ada", email: "a@x" } }),
    { id: "t2_x", name: "ada", email: "a@x" },
  );
});

Deno.test("generated providers: a definition's checks ride the provider; the app's win", () => {
  const p = build([
    Reddit,
    Salesforce,
    Kakao,
    FusionAuth({ issuer: "https://auth.example.com" }),
  ]);
  // Reddit refuses a code_verifier it didn't ask for: Auth.js's `checks: ["state"]`.
  assertEquals(p.reddit.checks, ["state"]);
  assertEquals(p.salesforce.checks, ["pkce", "state", "nonce"]);
  assertEquals(p.fusionauth.checks, ["pkce", "state"]);
  // A definition that names none: denext's default (PKCE, plus a nonce for OIDC).
  assertEquals(p.kakao.checks, undefined);
  const own = build([Reddit({ checks: ["pkce", "state"] }), Kakao({ checks: ["none"] })]);
  assertEquals(own.reddit.checks, ["pkce", "state"]);
  assertEquals(own.kakao.checks, ["none"]);
  assertThrows(() => build([Reddit({ checks: ["pkce", "sate"] })]), TypeError, "checks");
  assertThrows(
    () => build([Reddit({ checks: "pkce" as unknown as string[] })]),
    TypeError,
    "checks",
  );
  // The list is the provider's own copy, not the spec's.
  p.reddit.checks = [];
  assertEquals(build([Reddit]).reddit.checks, ["state"]);
});

Deno.test("generated providers: issuers and options fill the endpoint templates", () => {
  const p = build([
    WorkOS({ connection: "conn_1" }),
    Descope,
    Webex({ apiBaseUrl: "https://webex.example.com/v1" }),
    Mattermost({ issuer: "https://chat.example.com" }),
    Dribbble({ scope: "public upload" }),
  ], { AUTH_DESCOPE_ID: "P2abc" });
  assertEquals(p.workos.authorizationUrl, "https://api.workos.com/sso/authorize");
  assertEquals(p.workos.authorizationParams, { connection: "conn_1" });
  assertEquals(p.descope.discovery?.issuer, "https://api.descope.com/P2abc");
  assertEquals(p.webex.userinfoUrl, "https://webex.example.com/v1/people/me");
  assertEquals(p.mattermost.tokenUrl, "https://chat.example.com/oauth/access_token");
  assertEquals(p.dribbble.scopes, ["public", "upload"]);
  // An option left out drops its parameter; a default fills its URL.
  const bare = build([WorkOS, Webex]);
  assertEquals(bare.workos.authorizationParams, undefined);
  assertEquals(bare.webex.authorizationUrl, "https://webexapis.com/v1/authorize");
  // A provider whose endpoints sit under the issuer needs one, and an https one.
  assertThrows(() => build([Mattermost]), TypeError, "AUTH_MATTERMOST_ISSUER");
  assertThrows(() => build([Zitadel]), TypeError, "AUTH_ZITADEL_ISSUER");
  assertThrows(
    () => build([Mattermost({ issuer: "http://chat.example.com" })]),
    TypeError,
    "https",
  );
  const fromEnv = build([Mattermost], { AUTH_MATTERMOST_ISSUER: "https://m.example.com" });
  assertEquals(fromEnv.mattermost.userinfoUrl, "https://m.example.com/api/v4/users/me");
});

Deno.test("generated providers: an OIDC provider with idToken: false reads userinfo", () => {
  const p = build([Salesforce, FusionAuth({ issuer: "https://auth.example.com" })]);
  assertEquals(p.salesforce.discovery?.issuer, "https://login.salesforce.com");
  assert(p.salesforce.userinfoUrl, "asks the flow for userinfo");
  assertEquals(p.fusionauth.userinfoUrl, undefined);
  assertEquals(p.fusionauth.authorizationParams, undefined); // no tenantId: no parameter
  const tenant = build([FusionAuth({ issuer: "https://auth.example.com", tenantId: "t1" })]);
  assertEquals(tenant.fusionauth.authorizationParams, { tenantId: "t1" });
});

Deno.test("generated providers: the traced mappings agree with Auth.js's profile()", async () => {
  const p = build([
    Kakao,
    EVEOnline,
    Eventbrite,
    FusionAuth({ issuer: "https://auth.example.com" }),
  ]);
  assertEquals(
    await profileOf(p.kakao, {
      userinfo: {
        id: 42,
        kakao_account: { email: "k@x", profile: { nickname: "Kay", profile_image_url: "i" } },
      },
    }),
    { id: "42", name: "Kay", email: "k@x", image: "i" },
  );
  assertEquals(
    await profileOf(p.eveonline, { userinfo: { CharacterID: 9, CharacterName: "Eve" } }),
    { id: "9", name: "Eve", image: "https://image.eveonline.com/Character/9_128.jpg" },
  );
  // `String(undefined)` is not an id: the account is refused rather than named "undefined".
  assertEquals((await profileOf(p.eveonline, { userinfo: { CharacterName: "Eve" } })).id, "");
  const ev = await profileOf(p.eventbrite, {
    userinfo: {
      id: "1",
      name: "Ev",
      image_id: "7",
      emails: [{ email: "old@x", primary: false }, { email: "new@x", primary: true }],
    },
  });
  assertEquals(ev.email, "new@x");
  assertEquals(
    ev.image,
    "https://img.evbuc.com/https%3A%2F%2Fcdn.evbuc.com%2Fimages%2F7%2F1%2Foriginal.jpg",
  );
  // OIDC: the joined name fallback, and an address the provider marks unverified is dropped.
  const fa = await profileOf(p.fusionauth, {
    claims: { sub: "s", given_name: "Ada", family_name: "L", email: "a@x", email_verified: false },
  });
  assertEquals(fa, { id: "s", name: "Ada L" });
  const verified = await profileOf(p.fusionauth, {
    claims: { sub: "s", name: "Ada", email: "a@x", email_verified: true },
  });
  assertEquals(verified.emailVerified, true);
  // An OAuth provider's address is never taken as verified.
  assertEquals(
    (await profileOf(p.kakao, { userinfo: { id: 1, kakao_account: { email: "k@x" } } }))
      .emailVerified,
    undefined,
  );
});

Deno.test("generated providers: the Auth.js callbacks see the user Auth.js would map", async () => {
  const p = build([Kakao]);
  const jar = new Jar();
  const { value: record } = await inRequest(
    request(jar, "/api/auth/callback/kakao"),
    jar,
    async () => {
      await profileOf(p.kakao, {
        userinfo: { id: 7, kakao_account: { profile: { nickname: "Kay" } } },
        tokens: { access_token: "at", token_type: "bearer" },
      });
      return signInRecord();
    },
  );
  assertEquals(record?.user, { id: "7", name: "Kay" });
  assertEquals(record?.account?.provider, "kakao");
  assertEquals(record?.account?.access_token, "at");
});

Deno.test("generated providers: mapProfile follows ?? chains, joins and constants", () => {
  const roots = { p: { a: null, b: "B", list: ["x"] }, t: { id_token: "jwt" } };
  assertEquals(
    mapProfile({
      chain: [{ p: ["p", "a"] }, { p: ["p", "b"] }],
      none: [{ p: ["p", "zz"] }],
      nil: [{ p: ["p", "zz"] }, { c: null }],
      first: [{ p: ["p", "list", "0"] }],
      token: [{ p: ["t", "id_token"] }],
      joined: [{ join: [["p", "a"], ["p", "b"]], sep: "-" }],
      missingList: [{ find: ["p", "b"], where: "primary", pick: "email" }],
    }, roots),
    { chain: "B", nil: null, first: "x", token: "jwt", joined: "B" },
  );
});

Deno.test("azure-ad: Microsoft Entra ID under Auth.js's deprecated id and env", () => {
  const p = build([AzureAD], {
    AUTH_AZURE_AD_ID: "az-id",
    AUTH_AZURE_AD_ISSUER: "https://login.microsoftonline.com/contoso/v2.0",
  });
  assertEquals(p["azure-ad"].clientId, "az-id");
  assertEquals(p["azure-ad"].type, "oidc");
});

Deno.test("gen:auth-providers: extract reads an OAuth definition and traces its profile()", async () => {
  // deno-lint-ignore no-explicit-any
  const spec = await extract("acme", (options: any) => ({
    id: "acme",
    name: "Acme",
    type: "oauth",
    authorization: `https://acme.test/authorize?scope=read+write&prompt=consent`,
    token: "https://acme.test/token",
    userinfo: { url: "https://acme.test/me" },
    client: { token_endpoint_auth_method: "client_secret_post" },
    checks: ["state"],
    // deno-lint-ignore no-explicit-any
    profile(p: any, tokens: any) {
      return {
        id: p.data.id.toString(),
        name: p.nick ?? p.login ?? null,
        email: tokens.email,
        image: `https://cdn.acme.test/${p.avatar}.png`,
        role: "member",
      };
    },
    options,
  }));
  assertEquals(spec.scopes, ["read", "write"]);
  assertEquals(spec.params, { prompt: "consent" });
  assertEquals(spec.tokenAuth, "client_secret_post");
  assertEquals(spec.checks, ["state"]);
  assertEquals(spec.authorization, "https://acme.test/authorize");
  assertEquals(spec.profile, {
    id: [{ t: [["p", "data", "id"]] }],
    name: [{ p: ["p", "nick"] }, { p: ["p", "login"] }, { c: null }],
    email: [{ p: ["t", "email"] }],
    image: [{ t: ["https://cdn.acme.test/", ["p", "avatar"], ".png"] }],
    role: [{ c: "member" }],
  });
});

Deno.test("gen:auth-providers: extract reads OIDC issuers and refuses what data can't say", async () => {
  // An issuer from the options; `idToken: false` reads userinfo; no profile(): Auth.js's default.
  // deno-lint-ignore no-explicit-any
  const oidc = await extract("idp", (options: any) => ({
    id: "idp",
    name: "IdP",
    type: "oidc",
    wellKnown: `${options.issuer}/oidc/2/.well-known/openid-configuration`,
    idToken: false,
    options,
  }));
  assertEquals(oidc.issuer, "{issuer}/oidc/2");
  assertEquals(oidc.profileFromUserinfo, true);
  assertEquals(oidc.tokenAuth, "client_secret_basic");
  assertEquals(oidc.profile, undefined);
  assertEquals(oidc.checks, undefined, "no checks named: denext's default");
  const refusals: [string, (o: unknown) => unknown][] = [
    ["a userinfo request hook", () => ({
      id: "x",
      type: "oauth",
      authorization: "https://x.test/a",
      token: "https://x.test/t",
      userinfo: { url: "https://x.test/u", request: () => ({}) },
    })],
    // deno-lint-ignore no-explicit-any
    ["an option it doesn't declare", (o: any) => ({ id: "x", type: "oidc", issuer: o.tenant })],
    ["a non-OAuth type", () => ({ id: "x", type: "email" })],
    [
      "an unknown check",
      () => ({ id: "x", type: "oidc", issuer: "https://x.test", checks: ["dpop"] }),
    ],
    [
      "a signed userinfo",
      () => ({ id: "x", type: "oidc", client: { userinfo_signed_response_alg: "RS256" } }),
    ],
    ["a method call in profile()", () => ({
      id: "x",
      type: "oidc",
      // deno-lint-ignore no-explicit-any
      profile: (p: any) => ({ id: p.sub, name: p.name.split(" ")[0] }),
    })],
  ];
  for (const [what, factory] of refusals) {
    await assertRejects(() => extract("x", factory), Unexpressible, undefined, what);
  }
});
