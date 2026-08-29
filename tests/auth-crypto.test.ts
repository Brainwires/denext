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

// ---- alg families beyond RS256 (ES*, PS*, RS384/512) -----------------------

/** Mint an id_token signed with `alg` (an ES, PS, or RS family alg) + its public JWKS. */
async function mintWithAlg(
  alg: string,
  claims: Record<string, unknown>,
  kid = "k",
): Promise<{ token: string; jwks: Jwk[] }> {
  let keyAlgo: EcKeyGenParams | RsaHashedKeyGenParams;
  let signAlgo: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
  if (alg.startsWith("ES")) {
    const curve = alg === "ES256" ? "P-256" : alg === "ES384" ? "P-384" : "P-521";
    const hash = alg === "ES256" ? "SHA-256" : alg === "ES384" ? "SHA-384" : "SHA-512";
    keyAlgo = { name: "ECDSA", namedCurve: curve };
    signAlgo = { name: "ECDSA", hash };
  } else {
    const hash = alg.endsWith("256") ? "SHA-256" : alg.endsWith("384") ? "SHA-384" : "SHA-512";
    const name = alg.startsWith("PS") ? "RSA-PSS" : "RSASSA-PKCS1-v1_5";
    keyAlgo = { name, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash };
    signAlgo = alg.startsWith("PS")
      ? { name: "RSA-PSS", saltLength: hash === "SHA-256" ? 32 : hash === "SHA-384" ? 48 : 64 }
      : { name: "RSASSA-PKCS1-v1_5" };
  }
  const pair = await crypto.subtle.generateKey(keyAlgo, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const header = jsonSeg({ alg, typ: "JWT", kid });
  const payload = jsonSeg(claims);
  const signingInput = new TextEncoder().encode(`${header}.${payload}`);
  const sig = await crypto.subtle.sign(signAlgo, pair.privateKey, signingInput);
  const token = `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
  const pub: Jwk = jwk.kty === "EC"
    ? { kty: "EC", kid, crv: jwk.crv, x: jwk.x, y: jwk.y, alg }
    : { kty: "RSA", kid, n: jwk.n, e: jwk.e, alg };
  return { token, jwks: [pub] };
}

Deno.test("verifyIdToken: accepts ES256 / PS256 / RS384 tokens", async () => {
  for (const alg of ["ES256", "PS256", "RS384"]) {
    const { token, jwks } = await mintWithAlg(alg, BASE);
    const claims = await verifyIdToken({
      idToken: token,
      jwks,
      issuer: BASE.iss,
      audience: BASE.aud,
      nonce: BASE.nonce,
    });
    assertEquals(claims.sub, "user-1", `alg=${alg}`);
  }
});

Deno.test("verifyIdToken: an ES256 token needs an EC key (RSA key of same kid is skipped)", async () => {
  const es = await mintWithAlg("ES256", BASE, "shared");
  const rsa = await mintIdToken(BASE, "shared"); // RSA JWKS, same kid, wrong key type
  await assertRejects(
    () =>
      verifyIdToken({
        idToken: es.token,
        jwks: rsa.jwks,
        issuer: BASE.iss,
        audience: BASE.aud,
        nonce: BASE.nonce,
      }),
    Error,
    "signature",
  );
});

// ---- next-auth / Auth.js CVE parity: JWT confusion & token substitution -----
// denext ships its OWN OIDC/JWT layer (not next-auth), so the jsonwebtoken and
// next-auth CVE classes are a question of whether OUR verifier shares the flaw.

// CVE-2022-23540 — jsonwebtoken ≤8.5.1 defaulted to the `none` algorithm in
// verify(), accepting UNSIGNED tokens (signature-validation bypass, CWE-347).
// denext allowlists only the RS/PS/ES signature families (jwt.ts `algParams`), so a
// forged `alg:none` (or `HS*`) token is refused before any key/signature handling.
Deno.test("CVE-2022-23540: verifyIdToken rejects alg:none / unsigned id_tokens", async () => {
  const { jwks } = await mintIdToken(BASE); // a real JWKS to offer the verifier
  const base = { jwks, issuer: BASE.iss, audience: BASE.aud, nonce: BASE.nonce };
  // `alg:none` with an empty signature segment (the canonical unsigned-JWT exploit).
  const none = `${jsonSeg({ alg: "none", typ: "JWT" })}.${jsonSeg({ ...BASE, sub: "admin" })}.`;
  await assertRejects(
    () => verifyIdToken({ idToken: none, ...base }),
    Error,
    "unsupported id_token alg",
  );
  // A two-segment (structurally unsigned) token is malformed and also refused.
  const twoSeg = `${jsonSeg({ alg: "none" })}.${jsonSeg(BASE)}`;
  await assertRejects(
    () => verifyIdToken({ idToken: twoSeg, ...base }),
    Error,
    "malformed JWT",
  );
});

// CVE-2022-23541 — RS256→HS256 algorithm confusion: an attacker mints an HS256
// token, HMAC-signing it with the RSA PUBLIC key material as the shared secret.
// A verifier that picks the algorithm from the token header would treat the
// public key as an HMAC secret and accept the forgery. denext never reads `alg`
// from the header to choose the algorithm — RS256 + RSASSA-PKCS1 key import are
// hardcoded (jwt.ts:71-79,108) — so even a correctly-HMAC'd forgery is refused.
Deno.test("CVE-2022-23541: verifyIdToken rejects an RS256->HS256 algorithm-confusion forgery", async () => {
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
  const jwks: Jwk[] = [{ kty: "RSA", kid: "rsa", n: jwk.n, e: jwk.e, alg: "RS256" }];

  // Sign an HS256 token using the public modulus as the HMAC secret — a genuine
  // confusion forgery, not just a mislabeled header.
  const secret = new TextEncoder().encode(jwk.n!);
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const header = jsonSeg({ alg: "HS256", typ: "JWT", kid: "rsa" });
  const payload = jsonSeg({ ...BASE, sub: "admin" });
  const sig = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  const forged = `${header}.${payload}.${b64url(new Uint8Array(sig))}`;

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
    "unsupported id_token alg",
  );
});

// id_token audience/issuer binding — the jsonwebtoken aud/iss surface behind OIDC
// token-substitution / confused-deputy attacks. A validly-signed token minted for
// a DIFFERENT relying party, a different issuer, or without the login's nonce must
// not be accepted at OUR client.
Deno.test("id_token binding: wrong issuer / foreign audience / missing nonce are rejected", async () => {
  // A trailing-slash issuer is a DIFFERENT issuer — no normalization.
  const trailing = await mintIdToken({ ...BASE, iss: "https://accounts.example.com/" });
  await assertRejects(
    () =>
      verifyIdToken({
        idToken: trailing.token,
        jwks: trailing.jwks,
        issuer: BASE.iss,
        audience: BASE.aud,
        nonce: BASE.nonce,
      }),
    Error,
    "issuer",
  );
  // A token minted for another RP (aud array without our client id) is refused —
  // an attacker can't substitute an id_token issued to a different application.
  const foreignAud = await mintIdToken({ ...BASE, aud: ["client-999", "attacker-rp"] });
  await assertRejects(
    () =>
      verifyIdToken({
        idToken: foreignAud.token,
        jwks: foreignAud.jwks,
        issuer: BASE.iss,
        audience: BASE.aud,
        nonce: BASE.nonce,
      }),
    Error,
    "audience",
  );
  // An OIDC token that OMITS `nonce` while a nonce was issued is refused (replay of
  // a token minted outside this login's nonce).
  const noNonce = await mintIdToken({ iss: BASE.iss, aud: BASE.aud, sub: BASE.sub, exp: BASE.exp });
  await assertRejects(
    () =>
      verifyIdToken({
        idToken: noNonce.token,
        jwks: noNonce.jwks,
        issuer: BASE.iss,
        audience: BASE.aud,
        nonce: BASE.nonce,
      }),
    Error,
    "nonce",
  );
  // Documented boundary: a multi-valued `aud` that DOES contain our client id is
  // accepted (denext enforces membership, not single-aud/`azp` strictness). Noted
  // in CVE-DEFENSE-GUIDE.md as accepted behavior.
  const multiAud = await mintIdToken({ ...BASE, aud: ["client-123", "another-rp"] });
  const claims = await verifyIdToken({
    idToken: multiAud.token,
    jwks: multiAud.jwks,
    issuer: BASE.iss,
    audience: BASE.aud,
    nonce: BASE.nonce,
  });
  assertEquals(claims.sub, "user-1");
});
