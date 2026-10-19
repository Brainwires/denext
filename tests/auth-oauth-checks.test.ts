// A provider's `checks` (Auth.js's per-provider protections): PKCE and the OIDC `nonce` run
// exactly where the list names them — unset keeps PKCE, plus a nonce for OIDC — and `state` is
// sent and verified on every combination, `"none"` included. Each combination is driven through
// the real sign-in and callback routes against a stubbed provider: the authorization URL, the
// token request's body, and whether the id_token's nonce is required.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { denextAuth } from "../src/server/auth/mod.ts";
import { oauthPreset } from "../src/server/auth/providers-presets.ts";
import { oidc } from "../src/server/auth/providers.ts";
import { buildAuthorizationUrl, flowChecks } from "../src/server/auth/oauth.ts";
import {
  appConfig,
  callback,
  type Idp,
  makeIdp,
  ORIGIN,
  signedIn,
  start,
  txData,
} from "./helpers/oauth-flow-harness.ts";
import type { OAuthCheck, OAuthProvider } from "../src/server/auth/types.ts";

/** One key for the file: the JWKS cache throttles a refetch for an unknown `kid`. */
const IDP: Idp = await makeIdp();

/** Stub `idp.test`: token, JWKS and userinfo; returns the token-request bodies. */
async function withIdp<T>(
  idp: Idp,
  idToken: (() => Promise<string>) | undefined,
  body: (tokenRequests: URLSearchParams[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const tokenRequests: URLSearchParams[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host !== "idp.test") return new Response("unknown host", { status: 404 });
    if (url.pathname === "/token") {
      tokenRequests.push(new URLSearchParams(String(init?.body ?? "")));
      return Response.json({
        access_token: "at",
        token_type: "bearer",
        ...(idToken ? { id_token: await idToken() } : {}),
      });
    }
    if (url.pathname === "/jwks") return Response.json(idp.jwks);
    if (url.pathname === "/me") return Response.json({ id: "u-1", email: "ada@example.com" });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    return await body(tokenRequests);
  } finally {
    globalThis.fetch = original;
  }
}

function oauthProvider(checks?: OAuthCheck[]): OAuthProvider {
  const provider = oauthPreset({
    id: "plain",
    type: "oauth",
    authorizationUrl: "https://idp.test/authorize",
    tokenUrl: "https://idp.test/token",
    userinfoUrl: "https://idp.test/me",
    scopes: ["read"],
    profile: (input) => ({ id: String(input.userinfo?.id ?? "") }),
  }, { clientId: "client-plain", clientSecret: "shh" });
  return checks ? { ...provider, checks } : provider;
}

function oidcProvider(checks?: OAuthCheck[]): OAuthProvider {
  const provider = oidc({
    id: "idc",
    issuer: "https://idp.test",
    authorizationUrl: "https://idp.test/authorize",
    tokenUrl: "https://idp.test/token",
    jwksUrl: "https://idp.test/jwks",
    clientId: "client-idc",
    clientSecret: "shh",
  });
  return checks ? { ...provider, checks } : provider;
}

/** Which of state / PKCE / nonce an OAuth combination sends, and that the flow completes. */
async function oauthCase(checks: OAuthCheck[] | undefined, pkce: boolean) {
  const idp = IDP;
  const config = appConfig(oauthProvider(checks));
  const { authorize, pair } = await start(config, "plain");
  const state = authorize.searchParams.get("state")!;
  assert(state, `${JSON.stringify(checks)}: state is always sent`);
  assertEquals(authorize.searchParams.has("code_challenge"), pkce, JSON.stringify(checks));
  assertEquals(authorize.searchParams.has("code_challenge_method"), pkce);
  assertEquals(authorize.searchParams.get("nonce"), null, "a plain OAuth flow has no nonce");
  await withIdp(idp, undefined, async (tokenRequests) => {
    const res = await callback(config, "plain", pair, state);
    assert(signedIn(res), `${JSON.stringify(checks)}: signed in`);
    assertEquals(tokenRequests[0].has("code_verifier"), pkce, JSON.stringify(checks));
    if (pkce) assertEquals(tokenRequests[0].get("code_verifier"), txData(pair).verifier);
  });
  // `state` is verified whatever the checks say: a forged one is refused.
  const again = await start(config, "plain");
  await withIdp(idp, undefined, async (tokenRequests) => {
    const res = await callback(config, "plain", again.pair, "forged");
    assertEquals(
      new URL(res.headers.get("location")!, ORIGIN).searchParams.get("error"),
      "invalid_state",
    );
    assertEquals(tokenRequests.length, 0);
  });
}

Deno.test("checks: an OAuth provider runs PKCE unless its checks leave it out; state always", async () => {
  await oauthCase(undefined, true);
  await oauthCase(["pkce"], true);
  await oauthCase(["pkce", "state"], true);
  await oauthCase(["state"], false);
  await oauthCase(["none"], false);
  await oauthCase([], false);
  // A nonce is an OIDC protection: listed on a plain OAuth provider it changes nothing.
  await oauthCase(["nonce"], false);
});

/** An OIDC combination: PKCE and nonce on the wire, and whether the nonce is enforced. */
async function oidcCase(checks: OAuthCheck[] | undefined, pkce: boolean, nonce: boolean) {
  const idp = IDP;
  const label = JSON.stringify(checks);
  const config = appConfig(oidcProvider(checks));
  const claims = (extra: Record<string, unknown>) => ({
    iss: "https://idp.test",
    aud: "client-idc",
    sub: "user-1",
    exp: Math.floor(Date.now() / 1000) + 600,
    ...extra,
  });
  const first = await start(config, "idc");
  const state = first.authorize.searchParams.get("state")!;
  assert(state, `${label}: state`);
  assertEquals(first.authorize.searchParams.has("code_challenge"), pkce, label);
  assertEquals(first.authorize.searchParams.has("nonce"), nonce, label);
  assertEquals(txData(first.pair).nonce !== undefined, nonce, label);
  const issued = txData(first.pair).nonce;
  await withIdp(idp, () => idp.mint(claims(issued ? { nonce: issued } : {})), async (seen) => {
    assert(signedIn(await callback(config, "idc", first.pair, state)), `${label}: signed in`);
    assertEquals(seen[0].has("code_verifier"), pkce, label);
  });
  // With a nonce in play, an id_token carrying another one is refused; without, nothing reads it.
  const second = await start(config, "idc");
  const secondState = second.authorize.searchParams.get("state")!;
  await withIdp(idp, () => idp.mint(claims({ nonce: "someone-elses" })), async () => {
    const res = await callback(config, "idc", second.pair, secondState);
    assertEquals(signedIn(res), !nonce, `${label}: a foreign nonce`);
  });
}

Deno.test("checks: an OIDC provider sends a nonce unless its checks leave it out", async () => {
  await oidcCase(undefined, true, true);
  await oidcCase(["pkce", "state", "nonce"], true, true);
  await oidcCase(["nonce", "state"], false, true);
  await oidcCase(["nonce"], false, true);
  await oidcCase(["pkce", "state"], true, false);
  await oidcCase(["state"], false, false);
  await oidcCase(["none"], false, false);
});

Deno.test("checks: flowChecks and the authorization URL without a challenge", () => {
  assertEquals(flowChecks({ type: "oauth" }), { pkce: true, nonce: false });
  assertEquals(flowChecks({ type: "oidc" }), { pkce: true, nonce: true });
  assertEquals(flowChecks({ type: "oidc", checks: ["state"] }), { pkce: false, nonce: false });
  const url = new URL(buildAuthorizationUrl({
    authorizationUrl: "https://idp.test/authorize",
    clientId: "c",
    redirectUri: `${ORIGIN}/cb`,
    scope: "read",
    state: "s",
  }));
  assertEquals(url.searchParams.get("code_challenge"), null);
  assertEquals(url.searchParams.get("code_challenge_method"), null);
  assertEquals(url.searchParams.get("state"), "s");
});

Deno.test("checks: an unknown check is a config error, not PKCE silently off", () => {
  for (const checks of [["pkce", "stat"], "pkce", [null]]) {
    assertThrows(
      () => denextAuth(appConfig({ ...oauthProvider(), checks } as unknown as OAuthProvider)),
      Error,
      "unknown check",
    );
  }
  denextAuth(appConfig(oauthProvider(["none"])));
});

Deno.test("checks: a transaction without the verifier its provider needs is refused", async () => {
  // A sign-in started while the provider skipped PKCE, finished after it requires it.
  const idp = IDP;
  const failures: string[] = [];
  const { authorize, pair } = await start(appConfig(oauthProvider(["state"])), "plain");
  const strict = appConfig(oauthProvider(), failures);
  await withIdp(idp, undefined, async (tokenRequests) => {
    const res = await callback(strict, "plain", pair, authorize.searchParams.get("state")!);
    assert(!signedIn(res));
    assertEquals(tokenRequests.length, 0, "no code is redeemed without its verifier");
  });
});
