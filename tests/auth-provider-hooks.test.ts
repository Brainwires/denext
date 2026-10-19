// The provider hooks the non-standard OAuth providers need, through the real sign-in and callback
// routes: extra token-request parameters (TikTok's `client_key`) that can't replace the flow's
// own, a userinfo request of the provider's own shape on the pinned fetch, and an `id_token`
// signed HS256 under the client secret (LINE) — accepted only from a provider configured for it,
// and only HS256.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { denextAuth } from "../src/server/auth/mod.ts";
import { base64UrlEncode } from "../src/server/auth/oauth.ts";
import { oauthPreset } from "../src/server/auth/providers-presets.ts";
import { oidc } from "../src/server/auth/providers.ts";
import { verifyIdToken } from "../src/server/auth/jwt.ts";
import type { OAuthProvider } from "../src/server/auth/types.ts";
import { appConfig, callback, signedIn, start, txData } from "./helpers/oauth-flow-harness.ts";

/** What the stubbed provider saw. */
interface Seen {
  token: URLSearchParams[];
  other: { url: string; method: string; headers: Headers }[];
}

/** Stub `idp.test`: the token endpoint answers `tokens`; anything else `{ id: "u-1" }`. */
async function withIdp<T>(
  tokens: () => Promise<Record<string, unknown>>,
  body: (seen: Seen) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const seen: Seen = { token: [], other: [] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host !== "idp.test") return new Response("unknown host", { status: 404 });
    if (url.pathname === "/token") {
      seen.token.push(new URLSearchParams(String(init?.body ?? "")));
      return Response.json(await tokens());
    }
    seen.other.push({
      url: url.href,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers as HeadersInit),
    });
    return Response.json({ id: "u-1" });
  }) as typeof fetch;
  try {
    return await body(seen);
  } finally {
    globalThis.fetch = original;
  }
}

function plain(extra: Partial<OAuthProvider> = {}): OAuthProvider {
  return {
    ...oauthPreset({
      id: "plain",
      type: "oauth",
      authorizationUrl: "https://idp.test/authorize",
      tokenUrl: "https://idp.test/token",
      userinfoUrl: "https://idp.test/me",
      scopes: ["read"],
      profile: (input) => ({ id: String(input.userinfo?.id ?? "") }),
    }, { clientId: "client-plain", clientSecret: "shh" }),
    ...extra,
  };
}

/** One full sign-in against the stub. */
async function signIn(provider: OAuthProvider, tokens: () => Promise<Record<string, unknown>>) {
  const config = appConfig(provider);
  const { authorize, pair } = await start(config, provider.id);
  return await withIdp(tokens, async (seen) => {
    const res = await callback(config, provider.id, pair, authorize.searchParams.get("state")!);
    return { ok: signedIn(res), seen, pair };
  });
}

const bearer = () => Promise.resolve({ access_token: "at", token_type: "bearer", uid: "u 1" });

Deno.test("hooks: tokenRequestParams ride the token request but never replace the flow's", async () => {
  const { ok, seen } = await signIn(
    plain({
      tokenRequestParams: { client_key: "client-plain", code: "forged", grant_type: "x" },
      tokenEndpointAuthMethod: "client_secret_post",
    }),
    bearer,
  );
  assert(ok);
  const form = seen.token[0];
  assertEquals(form.get("client_key"), "client-plain");
  assertEquals(form.get("code"), "the-code");
  assertEquals(form.get("grant_type"), "authorization_code");
  assertEquals(form.getAll("code").length, 1);
});

Deno.test("hooks: userinfoRequest replaces the Bearer GET, on the provider's pinned fetch", async () => {
  const calls: { url?: string; tokens: Record<string, unknown> }[] = [];
  const { ok, seen } = await signIn(
    plain({
      userinfoRequest: async ({ tokens, fetch, url }) => {
        calls.push({ url, tokens });
        const res = await fetch(
          `https://idp.test/users/${encodeURIComponent(String(tokens.uid))}`,
          {
            method: "POST",
            headers: { "x-api-key": "k" },
          },
        );
        return await res.json();
      },
    }),
    bearer,
  );
  assert(ok, "signed in with the profile the hook returned");
  assertEquals(calls[0].url, "https://idp.test/me");
  assertEquals(calls[0].tokens.uid, "u 1");
  assertEquals(seen.other.map((r) => [r.url, r.method]), [[
    "https://idp.test/users/u%201",
    "POST",
  ]]);
  assertEquals(seen.other[0].headers.get("x-api-key"), "k");
  // The fetch it gets is the pinned one: another host is refused, and the sign-in fails.
  const { ok: pinned } = await signIn(
    plain({
      userinfoRequest: async ({ fetch }) =>
        await (await fetch("https://elsewhere.test/me", { method: "GET", headers: {} })).json(),
    }),
    bearer,
  );
  assert(!pinned);
});

/** An HS256 `id_token` signed under `secret`. */
async function hs256(claims: Record<string, unknown>, secret: string, alg = "HS256") {
  const seg = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
  const signing = `${seg({ alg, typ: "JWT" })}.${seg(claims)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signing));
  return `${signing}.${base64UrlEncode(new Uint8Array(sig))}`;
}

function line(extra: Partial<OAuthProvider> = {}): OAuthProvider {
  return {
    ...oidc({
      id: "line",
      issuer: "https://idp.test",
      authorizationUrl: "https://idp.test/authorize",
      tokenUrl: "https://idp.test/token",
      jwksUrl: "https://idp.test/jwks",
      clientId: "line-channel",
      clientSecret: "line-channel-secret",
    }),
    idTokenAlg: "HS256",
    ...extra,
  };
}

const claims = (extra: Record<string, unknown> = {}) => ({
  iss: "https://idp.test",
  aud: "line-channel",
  sub: "U123",
  exp: Math.floor(Date.now() / 1000) + 600,
  ...extra,
});

Deno.test("hooks: an HS256 id_token verifies under the client secret, with its nonce", async () => {
  const config = appConfig(line());
  const { authorize, pair } = await start(config, "line");
  const nonce = txData(pair).nonce;
  assert(nonce, "an OIDC provider still sends its nonce");
  const ok = await withIdp(
    async () => ({
      access_token: "at",
      id_token: await hs256(claims({ nonce }), "line-channel-secret"),
    }),
    async () =>
      signedIn(await callback(config, "line", pair, authorize.searchParams.get("state")!)),
  );
  assert(ok);
});

Deno.test("hooks: an HS256 id_token is refused under another secret, alg, nonce or provider", async () => {
  const cases: [OAuthProvider, (nonce?: string) => Promise<string>][] = [
    [line(), (nonce) => hs256(claims({ nonce }), "not-the-secret")],
    [line(), (nonce) => hs256(claims({ nonce }), "line-channel-secret", "HS512")],
    [line(), (nonce) => hs256(claims({ nonce }), "line-channel-secret", "none")],
    [line(), () => hs256(claims({ nonce: "another" }), "line-channel-secret")],
    [line(), (nonce) => hs256(claims({ nonce, aud: "someone-else" }), "line-channel-secret")],
    // A provider verified by JWKS never takes an HMAC token signed with its own secret.
    [line({ idTokenAlg: undefined }), (nonce) => hs256(claims({ nonce }), "line-channel-secret")],
  ];
  for (const [provider, mint] of cases) {
    const config = appConfig(provider);
    const { authorize, pair } = await start(config, "line");
    const ok = await withIdp(
      async () => ({
        access_token: "at",
        id_token: await mint(txData(pair).nonce),
      }),
      async () =>
        signedIn(await callback(config, "line", pair, authorize.searchParams.get("state")!)),
    );
    assert(!ok);
  }
});

Deno.test("hooks: verifyIdToken's hmacSecret takes HS256 only, and never an empty secret", async () => {
  const token = await hs256(claims(), "s3cret");
  const base = { idToken: token, jwks: [], issuer: "https://idp.test", audience: "line-channel" };
  assertEquals((await verifyIdToken({ ...base, hmacSecret: "s3cret" })).sub, "U123");
  for (const hmacSecret of ["", "wrong"]) {
    let failed = false;
    await verifyIdToken({ ...base, hmacSecret }).catch(() => failed = true);
    assert(failed, `secret ${JSON.stringify(hmacSecret)}`);
  }
  let refused = false;
  await verifyIdToken(base).catch(() => refused = true);
  assert(refused, "without hmacSecret an HS256 token is refused");
});

Deno.test("hooks: idTokenAlg is HS256 on an OIDC provider only", () => {
  for (
    const provider of [line({ idTokenAlg: "RS256" as "HS256" }), plain({ idTokenAlg: "HS256" })]
  ) {
    assertThrows(() => denextAuth(appConfig(provider)), Error, "idTokenAlg");
  }
});
