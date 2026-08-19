/**
 * OIDC `id_token` verification: parse a compact JWS, select the signing key from a
 * JWKS by `kid`, verify the RS256 signature via `crypto.subtle`, and validate the
 * standard claims (`iss`, `aud`, `exp`, `nonce`). JWKS **fetching** is the caller's
 * job (it goes through the SSRF-safe `safeFetch`), so this module stays pure and
 * unit-testable against a locally-generated key.
 *
 * @module
 */

import { base64UrlDecode } from "./oauth.ts";

const decoder = new TextDecoder();

/** A JSON Web Key (only the RSA fields denext reads). */
export interface Jwk {
  kty: string;
  kid?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

/** Decoded `id_token` claims (standard OIDC set plus provider extras). */
export interface IdTokenClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  [claim: string]: unknown;
}

interface ParsedJws {
  header: { alg?: string; kid?: string; typ?: string };
  claims: IdTokenClaims;
  /** The `${headerB64}.${payloadB64}` bytes the signature covers. */
  signingInput: Uint8Array;
  signature: Uint8Array;
}

/** Parse a compact JWS into its header, claims, signing input, and signature. */
function parseJws(token: string): ParsedJws {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  const [h, p, s] = parts;
  let header: ParsedJws["header"];
  let claims: IdTokenClaims;
  try {
    header = JSON.parse(decoder.decode(base64UrlDecode(h)));
    claims = JSON.parse(decoder.decode(base64UrlDecode(p)));
  } catch {
    throw new Error("malformed JWT segments");
  }
  return {
    header,
    claims,
    signingInput: new TextEncoder().encode(`${h}.${p}`),
    signature: base64UrlDecode(s),
  };
}

/** Import an RSA JWK as an RS256 verification key. */
function importRsaJwk(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true } as JsonWebKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

/** Options for {@link verifyIdToken}. */
export interface VerifyIdTokenOptions {
  /** The compact `id_token`. */
  idToken: string;
  /** The provider's JWKS keys (already fetched via `safeFetch`). */
  jwks: Jwk[];
  /** Expected `iss` (issuer). */
  issuer: string;
  /** Expected `aud` (the OAuth client id). */
  audience: string;
  /** The `nonce` issued at authorization time (must match the token's). */
  nonce?: string;
  /** Clock-skew tolerance in seconds for `exp` (default 60). */
  clockToleranceSec?: number;
  /** Current time in ms (injectable for tests; defaults to `Date.now()`). */
  now?: number;
}

/**
 * Verify an OIDC `id_token`: RS256 signature against the matching JWKS key, then
 * `iss` / `aud` / `exp` / `nonce`. Returns the validated claims or throws.
 *
 * @param options {@link VerifyIdTokenOptions}.
 * @returns The verified {@link IdTokenClaims}.
 */
export async function verifyIdToken(options: VerifyIdTokenOptions): Promise<IdTokenClaims> {
  const { header, claims, signingInput, signature } = parseJws(options.idToken);
  if (header.alg !== "RS256") throw new Error(`unsupported id_token alg: ${header.alg}`);

  // Select the key by `kid`; fall back to the sole key when the token omits one.
  const candidates = header.kid ? options.jwks.filter((k) => k.kid === header.kid) : options.jwks;
  if (candidates.length === 0) throw new Error("no matching JWKS key for id_token");

  let verified = false;
  for (const jwk of candidates) {
    if (jwk.kty !== "RSA") continue;
    const key = await importRsaJwk(jwk);
    if (
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        signature as BufferSource,
        signingInput as BufferSource,
      )
    ) {
      verified = true;
      break;
    }
  }
  if (!verified) throw new Error("id_token signature verification failed");

  if (claims.iss !== options.issuer) throw new Error("id_token issuer mismatch");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(options.audience)) throw new Error("id_token audience mismatch");
  if (options.nonce !== undefined && claims.nonce !== options.nonce) {
    throw new Error("id_token nonce mismatch");
  }
  const now = options.now ?? Date.now();
  const tolerance = (options.clockToleranceSec ?? 60) * 1000;
  if (typeof claims.exp === "number" && claims.exp * 1000 + tolerance < now) {
    throw new Error("id_token expired");
  }
  return claims;
}
