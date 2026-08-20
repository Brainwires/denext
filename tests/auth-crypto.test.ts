// Auth crypto primitives: PKCE, state/nonce tokens, the authorization-URL builder,
// and RS256 id_token verification against a locally-generated RSA key + JWKS.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  base64UrlDecode,
  base64UrlEncode,
  buildAuthorizationUrl,
  generatePkce,
  randomToken,
} from "../src/server/auth/oauth.ts";
import { type Jwk, verifyIdToken } from "../src/server/auth/jwt.ts";

// ---- PKCE + tokens ---------------------------------------------------------

Deno.test("generatePkce: challenge is BASE64URL(SHA256(verifier))", async () => {
  const { verifier, challenge } = await generatePkce();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  assertEquals(challenge, base64UrlEncode(new Uint8Array(digest)));
  assert(!challenge.includes("=") && !challenge.includes("+") && !challenge.includes("/"));
});

Deno.test("randomToken: url-safe, distinct, right length", () => {
  const a = randomToken(32), b = randomToken(32);
  assert(a !== b, "tokens are random");
  assert(/^[A-Za-z0-9_-]+$/.test(a), "url-safe alphabet");
});

Deno.test("base64url round-trips arbitrary bytes", () => {
  const bytes = new Uint8Array([0, 1, 250, 128, 63, 64, 255]);
  assertEquals([...base64UrlDecode(base64UrlEncode(bytes))], [...bytes]);
});

Deno.test("buildAuthorizationUrl: PKCE + state + nonce + extras", () => {
  const url = new URL(buildAuthorizationUrl({
    authorizationUrl: "https://accounts.example.com/authorize",
    clientId: "abc",
    redirectUri: "https://app.example.com/auth/callback/oidc",
    scope: "openid email profile",
    state: "st4te",
    codeChallenge: "chal",
    nonce: "n0nce",
    extra: { access_type: "offline" },
  }));
  assertEquals(url.searchParams.get("response_type"), "code");
  assertEquals(url.searchParams.get("client_id"), "abc");
  assertEquals(url.searchParams.get("code_challenge_method"), "S256");
  assertEquals(url.searchParams.get("code_challenge"), "chal");
  assertEquals(url.searchParams.get("state"), "st4te");
  assertEquals(url.searchParams.get("nonce"), "n0nce");
  assertEquals(url.searchParams.get("scope"), "openid email profile");
  assertEquals(url.searchParams.get("access_type"), "offline");
});

// ---- RS256 id_token verification -------------------------------------------

function b64url(bytes: Uint8Array): string {
  return base64UrlEncode(bytes);
}
function jsonSeg(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

/** Mint an RS256 id_token from a generated key pair and export its public JWKS. */
async function mintIdToken(
  claims: Record<string, unknown>,
  kid = "test-key",
): Promise<{ token: string; jwks: Jwk[] }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const header = jsonSeg({ alg: "RS256", typ: "JWT", kid });
  const payload = jsonSeg(claims);
  const signingInput = new TextEncoder().encode(`${header}.${payload}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, signingInput);
  const token = `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
  return { token, jwks: [{ kty: "RSA", kid, n: jwk.n, e: jwk.e, alg: "RS256" }] };
}

const BASE = {
  iss: "https://accounts.example.com",
  aud: "client-123",
  sub: "user-1",
  nonce: "n0nce",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

Deno.test("verifyIdToken: accepts a valid token", async () => {
  const { token, jwks } = await mintIdToken(BASE);
  const claims = await verifyIdToken({
    idToken: token,
    jwks,
    issuer: BASE.iss,
    audience: BASE.aud,
    nonce: BASE.nonce,
  });
  assertEquals(claims.sub, "user-1");
});

Deno.test("verifyIdToken: rejects a tampered payload (bad signature)", async () => {
  const { token, jwks } = await mintIdToken(BASE);
  const [h, _p, s] = token.split(".");
  const forged = `${h}.${jsonSeg({ ...BASE, sub: "admin" })}.${s}`;
  await assertRejects(
    () =>
      verifyIdToken({
        idToken: forged,
        jwks,
        issuer: BASE.iss,
        audience: BASE.aud,
        nonce: BASE.nonce,
      }),
    Error,
    "signature",
  );
});

Deno.test("verifyIdToken: rejects issuer / audience / nonce / exp mismatches", async () => {
  const { token, jwks } = await mintIdToken(BASE);
  const base = { idToken: token, jwks, issuer: BASE.iss, audience: BASE.aud, nonce: BASE.nonce };
  await assertRejects(() => verifyIdToken({ ...base, issuer: "https://evil" }), Error, "issuer");
  await assertRejects(() => verifyIdToken({ ...base, audience: "other" }), Error, "audience");
  await assertRejects(() => verifyIdToken({ ...base, nonce: "wrong" }), Error, "nonce");
  const expired = await mintIdToken({ ...BASE, exp: Math.floor(Date.now() / 1000) - 3600 });
  await assertRejects(
    () =>
      verifyIdToken({
        idToken: expired.token,
        jwks: expired.jwks,
        issuer: BASE.iss,
        audience: BASE.aud,
        nonce: BASE.nonce,
      }),
    Error,
    "expired",
  );
});

Deno.test("verifyIdToken: rejects a token missing exp, and one not yet valid (nbf)", async () => {
  // OIDC requires exp — a token that omits it must be rejected, not treated as
  // non-expiring (the pre-fix `typeof` guard let a no-exp token through).
  const noExp = await mintIdToken({
    iss: BASE.iss,
    aud: BASE.aud,
    sub: BASE.sub,
    nonce: BASE.nonce,
  });
  await assertRejects(
    () =>
      verifyIdToken({
        idToken: noExp.token,
        jwks: noExp.jwks,
        issuer: BASE.iss,
        audience: BASE.aud,
        nonce: BASE.nonce,
      }),
    Error,
    "missing exp",
  );
  const future = await mintIdToken({ ...BASE, nbf: Math.floor(Date.now() / 1000) + 3600 });
  await assertRejects(
    () =>
      verifyIdToken({
        idToken: future.token,
        jwks: future.jwks,
        issuer: BASE.iss,
        audience: BASE.aud,
        nonce: BASE.nonce,
      }),
    Error,
    "not yet valid",
  );
});

Deno.test("verifyIdToken: rejects when no JWKS key matches the kid", async () => {
  const { token } = await mintIdToken(BASE, "key-A");
  const other = await mintIdToken(BASE, "key-B");
  await assertRejects(
    () =>
      verifyIdToken({
        idToken: token,
        jwks: other.jwks,
        issuer: BASE.iss,
        audience: BASE.aud,
        nonce: BASE.nonce,
      }),
    Error,
  );
});
