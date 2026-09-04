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
  /** RSA modulus (base64url) — RSA keys. */
  n?: string;
  /** RSA public exponent (base64url) — RSA keys. */
  e?: string;
  /** EC curve name (`P-256`/`P-384`/`P-521`) — EC keys. */
  crv?: string;
  /** EC public x coordinate (base64url) — EC keys. */
  x?: string;
  /** EC public y coordinate (base64url) — EC keys. */
  y?: string;
  alg?: string;
  use?: string;
}

/** Decoded `id_token` claims (standard OIDC set plus provider extras). */
export interface IdTokenClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
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

/** The WebCrypto import + verify parameters and expected key type for a JWS `alg`. */
interface AlgParams {
  /** The JWK `kty` a key must have to be usable with this `alg`. */
  kty: "RSA" | "EC";
  /** Parameters for `crypto.subtle.importKey`. */
  importAlgo: RsaHashedImportParams | EcKeyImportParams;
  /** Parameters for `crypto.subtle.verify`. */
  verifyAlgo: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
}

/**
 * Map a JWS `alg` to its WebCrypto parameters. Covers the OIDC-relevant families:
 * RSASSA-PKCS1-v1_5 (`RS256/384/512`), RSA-PSS (`PS256/384/512`), and ECDSA
 * (`ES256/384/512`). Returns `null` for an unsupported/none alg (rejected by the caller).
 */
function algParams(alg: string): AlgParams | null {
  switch (alg) {
    case "RS256":
      return {
        kty: "RSA",
        importAlgo: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        verifyAlgo: { name: "RSASSA-PKCS1-v1_5" },
      };
    case "RS384":
      return {
        kty: "RSA",
        importAlgo: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" },
        verifyAlgo: { name: "RSASSA-PKCS1-v1_5" },
      };
    case "RS512":
      return {
        kty: "RSA",
        importAlgo: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" },
        verifyAlgo: { name: "RSASSA-PKCS1-v1_5" },
      };
    case "PS256":
      return {
        kty: "RSA",
        importAlgo: { name: "RSA-PSS", hash: "SHA-256" },
        verifyAlgo: { name: "RSA-PSS", saltLength: 32 },
      };
    case "PS384":
      return {
        kty: "RSA",
        importAlgo: { name: "RSA-PSS", hash: "SHA-384" },
        verifyAlgo: { name: "RSA-PSS", saltLength: 48 },
      };
    case "PS512":
      return {
        kty: "RSA",
        importAlgo: { name: "RSA-PSS", hash: "SHA-512" },
        verifyAlgo: { name: "RSA-PSS", saltLength: 64 },
      };
    case "ES256":
      return {
        kty: "EC",
        importAlgo: { name: "ECDSA", namedCurve: "P-256" },
        verifyAlgo: { name: "ECDSA", hash: "SHA-256" },
      };
    case "ES384":
      return {
        kty: "EC",
        importAlgo: { name: "ECDSA", namedCurve: "P-384" },
        verifyAlgo: { name: "ECDSA", hash: "SHA-384" },
      };
    case "ES512":
      return {
        kty: "EC",
        importAlgo: { name: "ECDSA", namedCurve: "P-521" },
        verifyAlgo: { name: "ECDSA", hash: "SHA-512" },
      };
    default:
      return null;
  }
}

/** Import a JWK (RSA or EC) as a verification key for the given `alg` parameters. */
function importJwk(jwk: Jwk, params: AlgParams): Promise<CryptoKey> {
  const keyData: JsonWebKey = params.kty === "EC"
    ? { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true }
    : { kty: "RSA", n: jwk.n, e: jwk.e, ext: true };
  return crypto.subtle.importKey("jwk", keyData, params.importAlgo, false, ["verify"]);
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
 * Verify an OIDC `id_token`: signature against the matching JWKS key, then
 * `iss` / `aud` / `exp` / `nonce`. Accepts the RSASSA-PKCS1-v1_5 (`RS256/384/512`),
 * RSA-PSS (`PS256/384/512`), and ECDSA (`ES256/384/512`) families; any other `alg`
 * (including `none`) is rejected. Returns the validated claims or throws.
 *
 * @param options {@link VerifyIdTokenOptions}.
 * @returns The verified {@link IdTokenClaims}.
 */
export async function verifyIdToken(options: VerifyIdTokenOptions): Promise<IdTokenClaims> {
  const { header, claims, signingInput, signature } = parseJws(options.idToken);
  const params = header.alg ? algParams(header.alg) : null;
  if (!params) throw new Error(`unsupported id_token alg: ${header.alg}`);
  // Pin the token type: an id_token is `typ:"JWT"` (or unset, or `id_token+jwt`).
  // Rejecting a different JWT class (e.g. an access token `at+jwt`) minted from the
  // same issuer/JWKS blocks token-type-confusion substitution.
  const typ = header.typ?.toLowerCase();
  if (typ && typ !== "jwt" && typ !== "id_token+jwt") {
    throw new Error(`unexpected id_token typ: ${header.typ}`);
  }
  // Select the key by `kid`; fall back to the sole key when the token omits one.
  const candidates = header.kid ? options.jwks.filter((k) => k.kid === header.kid) : options.jwks;
  if (candidates.length === 0) throw new Error("no matching JWKS key for id_token");
  if (!(await anyKeyVerifies(candidates, params, signingInput, signature))) {
    throw new Error("id_token signature verification failed");
  }
  assertIdTokenClaims(claims, options);
  return claims;
}

/**
 * Whether any candidate key (of the alg's key type) verifies the signature. A malformed /
 * curve-mismatched candidate (e.g. mid-rollover two keys share a `kid`) is skipped rather
 * than aborting a valid token.
 */
async function anyKeyVerifies(
  candidates: VerifyIdTokenOptions["jwks"],
  params: NonNullable<ReturnType<typeof algParams>>,
  signingInput: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  for (const jwk of candidates) {
    if (jwk.kty !== params.kty) continue; // key type must match the alg family
    try {
      const key = await importJwk(jwk, params);
      const ok = await crypto.subtle.verify(
        params.verifyAlgo,
        key,
        signature as BufferSource,
        signingInput as BufferSource,
      );
      if (ok) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * `iss` / `aud` / `nonce` / `exp` (required — a token that omits it is rejected, not
 * treated as non-expiring) / `nbf`, with clock tolerance.
 */
function assertIdTokenClaims(claims: IdTokenClaims, options: VerifyIdTokenOptions): void {
  if (claims.iss !== options.issuer) throw new Error("id_token issuer mismatch");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(options.audience)) throw new Error("id_token audience mismatch");
  if (options.nonce !== undefined && claims.nonce !== options.nonce) {
    throw new Error("id_token nonce mismatch");
  }
  const now = options.now ?? Date.now();
  const tolerance = (options.clockToleranceSec ?? 60) * 1000;
  if (typeof claims.exp !== "number") throw new Error("id_token missing exp");
  if (claims.exp * 1000 + tolerance < now) throw new Error("id_token expired");
  if (typeof claims.nbf === "number" && claims.nbf * 1000 - tolerance > now) {
    throw new Error("id_token not yet valid");
  }
}
