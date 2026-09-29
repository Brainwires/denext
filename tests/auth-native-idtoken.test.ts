// Native Apple / Google id_token sign-in (`POST {basePath}/native/:provider`): JWKS
// verification with an injected fetcher (no network), kid rotation, iss / aud (a SET of
// client ids) / azp / exp / nonce checks, the single-use server nonce, Apple's first-login
// name (the email only ever from the token), account linking, the MFA refusal, and the Apple
// code exchange that later lets account deletion revoke Apple's tokens.

import { assert, assertEquals, assertMatch } from "@std/assert";
import type { AuthAdapter } from "../src/server/auth/adapter.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { base64UrlEncode } from "../src/server/auth/oauth.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { sha256Hex } from "../src/server/auth/hash.ts";
import type { AuthConfig, AuthNativeConfig } from "../src/server/auth/types.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const APPLE_BUNDLE = "com.example.app";
const GOOGLE_IOS = "ios-client.apps.googleusercontent.com";
const GOOGLE_WEB = "web-client.apps.googleusercontent.com";

// ---- a local IdP ------------------------------------------------------------------------

interface Key {
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string; alg: string; use: string };
}

async function makeKey(kid: string): Promise<Key> {
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
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { ...pub, kid, alg: "RS256", use: "sig" } };
}

const enc = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

async function sign(key: Key, claims: Record<string, unknown>): Promise<string> {
  const input = `${enc({ alg: "RS256", kid: key.kid, typ: "JWT" })}.${enc(claims)}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64UrlEncode(new Uint8Array(sig))}`;
}

/** A fake IdP: serves the current key set, records every request (no network). */
class Idp {
  keys: Key[] = [];
  requests: Array<{ url: string; body?: string }> = [];
  jwksFetches = 0;
  appleTokenAnswer: Record<string, unknown> | null = null;
  revokeStatus = 200;
  fetch = (url: string, init: { method: string; body?: string }) => {
    this.requests.push({ url, body: init.body });
    if (url.endsWith("/keys") || url.includes("certs")) {
      this.jwksFetches++;
      return Promise.resolve(Response.json({ keys: this.keys.map((k) => k.jwk) }));
    }
    if (url === "https://appleid.apple.com/auth/token") {
      return Promise.resolve(
        this.appleTokenAnswer
          ? Response.json(this.appleTokenAnswer)
          : new Response("", { status: 400 }),
      );
    }
    if (url === "https://appleid.apple.com/auth/revoke") {
      return Promise.resolve(new Response(null, { status: this.revokeStatus }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
}

let urlCounter = 0;

/** Unique JWKS URLs per test, so the process-wide JWKS cache never leaks between tests. */
function freshUrls() {
  urlCounter++;
  return {
    apple: `https://appleid.test/${urlCounter}/keys`,
    google: `https://google.test/${urlCounter}/certs`,
  };
}

interface Harness {
  config: AuthConfig;
  adapter: AuthAdapter;
  idp: Idp;
  key: Key;
  events: string[];
}

async function setup(
  native: Partial<AuthNativeConfig> = {},
  overrides: Partial<AuthConfig> = {},
): Promise<Harness> {
  const idp = new Idp();
  const key = await makeKey(`k${urlCounter}`);
  idp.keys = [key];
  const urls = freshUrls();
  const adapter = inMemoryAuthAdapter();
  const events: string[] = [];
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    trustForwardedHeaders: false,
    providers: [{ id: "credentials", type: "credentials" }],
    adapter,
    rateLimit: false,
    native: {
      redirectUris: ["com.example.app://auth/callback"],
      apple: { clientIds: [APPLE_BUNDLE], jwksUrl: urls.apple, clientSecret: "apple-secret-jwt" },
      google: { clientIds: [GOOGLE_IOS, GOOGLE_WEB], jwksUrl: urls.google },
      fetch: idp.fetch,
      ...native,
    },
    events: {
      signIn: (p) => void events.push(`signIn:${p.provider}:${p.isNewUser}`),
      signInFailed: (p) => void events.push(`failed:${p.reason}`),
    },
    ...overrides,
  };
  return { config, adapter, idp, key, events };
}

async function post(h: Harness, path: string, body: Record<string, string>): Promise<Response> {
  const request = new Request(`${ORIGIN}/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await runWithContext(
    createRequestContext(request),
    () => handleAuthRequest(request, h.config),
  );
  assert(res, `${path} fell through`);
  return res;
}

async function nonce(h: Harness): Promise<string> {
  const res = await post(h, "/native/nonce", {});
  assertEquals(res.status, 200);
  return (await res.json()).nonce;
}

const now = () => Math.floor(Date.now() / 1000);

function appleClaims(extra: Record<string, unknown> = {}) {
  return {
    iss: "https://appleid.apple.com",
    aud: APPLE_BUNDLE,
    sub: "001234.apple-user",
    email: "relay@privaterelay.appleid.com",
    email_verified: "true",
    iat: now(),
    exp: now() + 600,
    ...extra,
  };
}

function googleClaims(extra: Record<string, unknown> = {}) {
  return {
    iss: "https://accounts.google.com",
    aud: GOOGLE_WEB,
    azp: GOOGLE_WEB,
    sub: "google-sub-1",
    email: "g@x.test",
    email_verified: true,
    name: "Gee",
    iat: now(),
    exp: now() + 600,
    ...extra,
  };
}

// ---- happy paths --------------------------------------------------------------------------

Deno.test("apple: a hashed-nonce id_token signs in; name from the first-login payload, email from the token", async () => {
  const h = await setup();
  const n = await nonce(h);
  const idToken = await sign(h.key, appleClaims({ nonce: await sha256Hex(n) }));
  const res = await post(h, "/native/apple", {
    id_token: idToken,
    nonce: n,
    name: "Tim\u0000 Apple",
    email: "attacker@evil.test",
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertMatch(body.access_token, /^nat_/);
  assertMatch(body.refresh_token, /^nrt_/);
  assertEquals(body.user.email, "relay@privaterelay.appleid.com", "never the client's email");
  assertEquals(body.user.name, "Tim Apple", "control characters stripped");
  const stored = await h.adapter.getUserByAccount({
    provider: "apple",
    providerAccountId: "001234.apple-user",
  });
  assertEquals(stored?.name, "Tim Apple");
  assertEquals(h.events, ["signIn:apple:true"]);
});

Deno.test("google: the iOS or the web client id is accepted; the bare issuer spelling too", async () => {
  const h = await setup();
  // A raw nonce; each sign-in consumes a fresh one.
  const n1 = await nonce(h);
  const t1 = await sign(h.key, googleClaims({ aud: GOOGLE_IOS, azp: GOOGLE_IOS, nonce: n1 }));
  assertEquals((await post(h, "/native/google", { id_token: t1, nonce: n1 })).status, 200);
  const n2 = await nonce(h);
  const t2 = await sign(h.key, googleClaims({ iss: "accounts.google.com", nonce: n2 }));
  assertEquals((await post(h, "/native/google", { id_token: t2, nonce: n2 })).status, 200);
  // Android: aud = the web (server) client id, azp = another configured id.
  const n3 = await nonce(h);
  const t3 = await sign(h.key, googleClaims({ aud: GOOGLE_WEB, azp: GOOGLE_IOS, nonce: n3 }));
  assertEquals((await post(h, "/native/google", { id_token: t3, nonce: n3 })).status, 200);
});

// ---- refusals -------------------------------------------------------------------------------

Deno.test("nonce: required, single-use, and must be one this server issued", async () => {
  const h = await setup();
  const n = await nonce(h);
  const idToken = await sign(h.key, appleClaims({ nonce: n }));
  assertEquals((await post(h, "/native/apple", { id_token: idToken })).status, 400, "missing");
  const forged = "nnc_" + "x".repeat(32);
  const withForged = await sign(h.key, appleClaims({ nonce: forged }));
  assertEquals(
    (await post(h, "/native/apple", { id_token: withForged, nonce: forged })).status,
    400,
  );
  assertEquals((await post(h, "/native/apple", { id_token: idToken, nonce: n })).status, 200);
  const replay = await post(h, "/native/apple", { id_token: idToken, nonce: n });
  assertEquals(replay.status, 400, "a captured id_token + nonce can't be replayed");
  assertEquals((await replay.json()).error, "invalid_nonce");
});

Deno.test("nonce mismatch, wrong aud, stray azp, multi-aud without azp, wrong iss, expired, bad sig", async () => {
  const h = await setup();
  const other = await makeKey("not-in-jwks");
  const cases: Array<[string, (n: string) => Promise<string>]> = [
    ["nonce mismatch", () => sign(h.key, appleClaims({ nonce: "nnc_someone-else" }))],
    ["wrong aud", (n) => sign(h.key, appleClaims({ aud: "com.evil.app", nonce: n }))],
    ["foreign azp", (n) => sign(h.key, appleClaims({ azp: "com.evil.app", nonce: n }))],
    ["multi aud, no azp", (n) => sign(h.key, appleClaims({ aud: [APPLE_BUNDLE, "x"], nonce: n }))],
    ["wrong iss", (n) => sign(h.key, appleClaims({ iss: "https://evil.test", nonce: n }))],
    ["expired", (n) => sign(h.key, appleClaims({ exp: now() - 3600, nonce: n }))],
    ["unknown key", (n) => sign(other, appleClaims({ nonce: n }))],
  ];
  for (const [label, make] of cases) {
    const n = await nonce(h);
    const res = await post(h, "/native/apple", { id_token: await make(n), nonce: n });
    assertEquals(res.status, 401, label);
    assertEquals((await res.json()).error, "invalid_token", label);
  }
  const n = await nonce(h);
  const [head, body] = (await sign(h.key, appleClaims({ nonce: n }))).split(".");
  const tampered = `${head}.${body}.${"A".repeat(342)}`;
  assertEquals((await post(h, "/native/apple", { id_token: tampered, nonce: n })).status, 401);
  assert(h.events.every((e) => e.startsWith("failed:")));
});

Deno.test("JWKS: cached across sign-ins, refetched once when the provider rotates to a new kid", async () => {
  const h = await setup();
  const sendWith = async (key: Key) => {
    const n = await nonce(h);
    return (await post(h, "/native/apple", {
      id_token: await sign(key, appleClaims({ nonce: n })),
      nonce: n,
    })).status;
  };
  assertEquals(await sendWith(h.key), 200);
  assertEquals(await sendWith(h.key), 200);
  assertEquals(h.idp.jwksFetches, 1, "the key set is cached");
  const rotated = await makeKey("rotated-kid");
  h.idp.keys = [rotated];
  assertEquals(await sendWith(rotated), 200, "an unknown kid triggers one refetch");
  assertEquals(h.idp.jwksFetches, 2);
});

Deno.test("an unconfigured provider, or native off, is a plain 404 (fall-through)", async () => {
  const h = await setup({ google: undefined });
  const request = new Request(`${ORIGIN}/auth/native/google`, { method: "POST", body: "{}" });
  const res = await runWithContext(
    createRequestContext(request),
    () => handleAuthRequest(request, h.config),
  );
  assertEquals(res, null);
  const unknown = new Request(`${ORIGIN}/auth/native/facebook`, { method: "POST", body: "{}" });
  assertEquals(
    await runWithContext(createRequestContext(unknown), () => handleAuthRequest(unknown, h.config)),
    null,
  );
});

// ---- linking, MFA ------------------------------------------------------------------------

Deno.test("linking: a verified local account links; an unverified one is refused", async () => {
  const h = await setup();
  const verified = await h.adapter.createUser({ email: "g@x.test", emailVerified: now() });
  const n = await nonce(h);
  const res = await post(h, "/native/google", {
    id_token: await sign(h.key, googleClaims({ nonce: n })),
    nonce: n,
  });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).user.id, verified.id);

  const h2 = await setup();
  await h2.adapter.createUser({ email: "g@x.test" }); // never verified
  const n2 = await nonce(h2);
  const refused = await post(h2, "/native/google", {
    id_token: await sign(h2.key, googleClaims({ nonce: n2 })),
    nonce: n2,
  });
  assertEquals(refused.status, 403);
  assertEquals((await refused.json()).error, "account_not_linked");
});

Deno.test("an MFA-enrolled user is told to use the browser flow (mfa_required)", async () => {
  const h = await setup({}, { mfa: { required: "always" } });
  const n = await nonce(h);
  const res = await post(h, "/native/google", {
    id_token: await sign(h.key, googleClaims({ nonce: n })),
    nonce: n,
  });
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error, "mfa_required");
});

// ---- Apple code exchange ---------------------------------------------------------------------

Deno.test("apple: the authorization_code is exchanged and Apple's refresh token stored", async () => {
  const h = await setup();
  const n = await nonce(h);
  h.idp.appleTokenAnswer = {
    refresh_token: "apple-refresh-1",
    id_token: await sign(h.key, appleClaims()),
  };
  const res = await post(h, "/native/apple", {
    id_token: await sign(h.key, appleClaims({ nonce: n })),
    nonce: n,
    authorization_code: "apple-code",
  });
  assertEquals(res.status, 200);
  const exchange = h.idp.requests.find((r) => r.url.endsWith("/auth/token"));
  assert(exchange);
  const form = new URLSearchParams(exchange.body);
  assertEquals(form.get("code"), "apple-code");
  assertEquals(form.get("client_id"), APPLE_BUNDLE);
  assertEquals(form.get("client_secret"), "apple-secret-jwt");
  const userId = (await res.json()).user.id;
  const [account] = await h.adapter.listAccounts!(userId);
  assertEquals(account.refreshToken, "apple-refresh-1");
});

Deno.test("apple: an exchange answering for another subject stores nothing (sign-in still works)", async () => {
  const h = await setup();
  const n = await nonce(h);
  h.idp.appleTokenAnswer = {
    refresh_token: "someone-elses",
    id_token: await sign(h.key, appleClaims({ sub: "another-user" })),
  };
  const res = await post(h, "/native/apple", {
    id_token: await sign(h.key, appleClaims({ nonce: n })),
    nonce: n,
    authorization_code: "apple-code",
  });
  assertEquals(res.status, 200);
  const [account] = await h.adapter.listAccounts!((await res.json()).user.id);
  assertEquals(account.refreshToken, undefined);
});
