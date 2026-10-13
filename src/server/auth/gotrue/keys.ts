/**
 * Supabase-compatible API keys and JWTs — the key material behind `backend({ supabase })`.
 *
 * Two kinds of credential reach the server:
 * - **API keys** (the `apikey` header, or `Authorization: Bearer <key>`): the opaque
 *   publishable key (`sb_publishable_…`, the `anon` role) and secret key (`sb_secret_…`, the
 *   `service_role`), and the legacy JWT keys — an `anon` / `service_role` JWT signed HS256 with
 *   the legacy JWT secret.
 * - **Access tokens**: JWTs this server mints for a signed-in user, with Supabase's claim
 *   shape. ES256 under the current signing key (published at
 *   `/auth/v1/.well-known/jwks.json`), or HS256 under the legacy secret when no signing key is
 *   configured.
 *
 * Verification is strict: the `alg` must be ES256 (an EC P-256 key) or HS256 (only while a
 * legacy secret is configured) — never `none`, never an algorithm the key wasn't made for, so
 * a public key can't be replayed as an HMAC secret. `exp` is required. Only the three roles
 * Supabase defines (`anon`, `authenticated`, `service_role`) are accepted. API keys are
 * compared in constant time over their SHA-256, so neither their content nor their length
 * leaks through timing.
 *
 * @module
 */

import { timingSafeEqual } from "node:crypto";
import { base64UrlDecode, base64UrlEncode } from "../oauth.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The roles a Supabase JWT or API key can carry. */
export type SupabaseRole = "anon" | "authenticated" | "service_role";

/** Environment variables the keys default to. */
export const SUPABASE_KEY_ENV = {
  publishableKey: "DENEXT_PUBLISHABLE_KEY",
  secretKey: "DENEXT_SECRET_KEY",
  jwtSecret: "DENEXT_JWT_SECRET",
  signingKeys: "DENEXT_JWT_SIGNING_KEYS",
} as const;

/** The key material for `backend({ supabase })`. Every field defaults to its environment variable. */
export interface SupabaseKeysConfig {
  /**
   * The publishable key(s) — the `anon` role, safe to ship in a browser bundle. Several to
   * rotate (any one is accepted). Default: `DENEXT_PUBLISHABLE_KEY` (comma-separated).
   */
  publishableKey?: string | string[];
  /**
   * The secret key(s) — the `service_role`, which bypasses row-level security. Server-side
   * only. Default: `DENEXT_SECRET_KEY` (comma-separated).
   */
  secretKey?: string | string[];
  /**
   * The legacy JWT secret (≥ 32 characters): verifies HS256 JWTs — the legacy `anon` /
   * `service_role` keys and access tokens signed with it — and signs access tokens when no
   * {@link signingKeys} are configured. Default: `DENEXT_JWT_SECRET`.
   */
  jwtSecret?: string;
  /**
   * ES256 signing keys as private JWKs (EC P-256 with `d`), current first: the first signs new
   * access tokens; all of them verify, and their public halves are published as the JWKS.
   * Default: `DENEXT_JWT_SIGNING_KEYS` (a JSON JWK, or a JSON array of them).
   */
  signingKeys?: JsonWebKey | JsonWebKey[];
}

/** One ES256 key: its id, the private key (signing) and the public JWK (JWKS + verifying). */
export interface SupabaseSigningKey {
  /** The key id (`kid`). */
  kid: string;
  /** The private key, or `null` for a verify-only key. */
  privateKey: CryptoKey | null;
  /** The public key. */
  publicKey: CryptoKey;
  /** The public JWK, as the JWKS publishes it. */
  publicJwk: JsonWebKey & { kid: string; alg: "ES256"; use: "sig" };
}

/** Resolved key material. Build it with {@linkcode resolveSupabaseKeys}. */
export interface SupabaseKeys {
  /** SHA-256 digests of the accepted publishable keys. */
  readonly publishable: Uint8Array[];
  /** SHA-256 digests of the accepted secret keys. */
  readonly secret: Uint8Array[];
  /** The HMAC key for HS256, when a legacy secret is configured. */
  readonly hmac: CryptoKey | null;
  /** The ES256 keys, current first. */
  readonly ec: SupabaseSigningKey[];
}

/** Why a token or key was refused — GoTrue / PostgREST-shaped codes. */
export type SupabaseKeyErrorCode = "bad_jwt" | "jwt_expired" | "invalid_api_key";

/** A refused token or API key. Its message never contains the presented value. */
export class SupabaseKeyError extends Error {
  /** The machine-readable reason. */
  readonly code: SupabaseKeyErrorCode;
  /**
   * Create the error.
   *
   * @param code The reason.
   * @param message A human-readable description.
   */
  constructor(code: SupabaseKeyErrorCode, message: string) {
    super(message);
    this.name = "SupabaseKeyError";
    this.code = code;
  }
}

/** Verified JWT claims. */
export interface SupabaseJwtClaims {
  /** The role — one of the three Supabase roles. */
  role: SupabaseRole;
  /** The user id (`authenticated` tokens). */
  sub?: string;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Issue time, epoch seconds. */
  iat?: number;
  /** Any other claim. */
  [claim: string]: unknown;
}

function list(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const all = Array.isArray(value) ? value : value.split(",");
  return all.map((v) => v.trim()).filter((v) => v !== "");
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** Whether `candidate` (a digest) equals any of `accepted`, comparing every entry. */
function anyEqual(candidate: Uint8Array, accepted: Uint8Array[]): boolean {
  let found = false;
  for (const entry of accepted) {
    if (timingSafeEqual(candidate, entry)) found = true;
  }
  return found;
}

/** The RFC 7638 thumbprint of an EC public key — the `kid` when the JWK names none. */
async function thumbprint(jwk: JsonWebKey): Promise<string> {
  const canonical = `{"crv":"${jwk.crv}","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
  return base64UrlEncode(await digest(canonical));
}

async function importSupabaseSigningKey(jwk: JsonWebKey): Promise<SupabaseSigningKey> {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new TypeError("supabase keys: a signing key must be an EC P-256 JWK");
  }
  const named = jwk as JsonWebKey & { kid?: string };
  const kid = typeof named.kid === "string" && named.kid !== "" ? named.kid : await thumbprint(jwk);
  const params = { name: "ECDSA", namedCurve: "P-256" } as const;
  const publicJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  const publicKey = await crypto.subtle.importKey("jwk", publicJwk, params, false, ["verify"]);
  const privateKey = jwk.d
    ? await crypto.subtle.importKey(
      "jwk",
      { ...publicJwk, d: jwk.d },
      params,
      false,
      ["sign"],
    )
    : null;
  return {
    kid,
    privateKey,
    publicKey,
    publicJwk: { ...publicJwk, kid, alg: "ES256", use: "sig" },
  };
}

function parseSigningKeys(value: string): JsonWebKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError(`supabase keys: ${SUPABASE_KEY_ENV.signingKeys} is not valid JSON`);
  }
  return Array.isArray(parsed) ? parsed as JsonWebKey[] : [parsed as JsonWebKey];
}

/**
 * Resolve the configured key material (each field falling back to its environment variable).
 *
 * @param config The configured keys.
 * @param env Reads an environment variable.
 * @returns The resolved keys.
 * @throws {TypeError} For a malformed signing key or a legacy secret under 32 characters.
 */
export async function resolveSupabaseKeys(
  config: SupabaseKeysConfig = {},
  env: (name: string) => string | undefined = () => undefined,
): Promise<SupabaseKeys> {
  const publishable = list(config.publishableKey ?? env(SUPABASE_KEY_ENV.publishableKey));
  const secret = list(config.secretKey ?? env(SUPABASE_KEY_ENV.secretKey));
  const overlap = publishable.filter((key) => secret.includes(key));
  if (overlap.length > 0) {
    throw new TypeError("supabase keys: a key cannot be both publishable and secret");
  }
  const jwtSecret = config.jwtSecret ?? env(SUPABASE_KEY_ENV.jwtSecret);
  if (jwtSecret !== undefined && jwtSecret.length < 32) {
    throw new TypeError("supabase keys: the JWT secret must be at least 32 characters");
  }
  const rawSigning = config.signingKeys ?? (() => {
    const fromEnv = env(SUPABASE_KEY_ENV.signingKeys);
    return fromEnv ? parseSigningKeys(fromEnv) : [];
  })();
  const signing = Array.isArray(rawSigning) ? rawSigning : [rawSigning];
  const ec = await Promise.all(signing.map(importSupabaseSigningKey));
  if (ec.length > 0 && !ec[0].privateKey) {
    throw new TypeError("supabase keys: the first signing key must be a private JWK (with `d`)");
  }
  const hmac = jwtSecret
    ? await crypto.subtle.importKey(
      "raw",
      encoder.encode(jwtSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    )
    : null;
  return {
    publishable: await Promise.all(publishable.map(digest)),
    secret: await Promise.all(secret.map(digest)),
    hmac,
    ec,
  };
}

/**
 * Whether these keys can mint access tokens (a signing key or a legacy secret).
 *
 * @param keys The resolved keys.
 * @returns `true` when {@linkcode signSupabaseJwt} can sign.
 */
export function canSign(keys: SupabaseKeys): boolean {
  return keys.ec.length > 0 || keys.hmac !== null;
}

/**
 * The JWKS document — the public halves of the ES256 keys (empty under HS256 only: a
 * symmetric secret is never published).
 *
 * @param keys The resolved keys.
 * @returns `{ keys: [...] }`.
 */
export function supabaseJwks(keys: SupabaseKeys): { keys: JsonWebKey[] } {
  return { keys: keys.ec.map((key) => ({ ...key.publicJwk })) };
}

/**
 * Sign claims as a compact JWT: ES256 under the current signing key, else HS256 under the
 * legacy secret.
 *
 * @param keys The resolved keys.
 * @param claims The claims (`exp` must be set by the caller).
 * @returns The JWT.
 * @throws {Error} When no signing material is configured.
 */
export async function signSupabaseJwt(
  keys: SupabaseKeys,
  claims: Record<string, unknown>,
): Promise<string> {
  const ec = keys.ec[0];
  const header = ec?.privateKey
    ? { alg: "ES256", kid: ec.kid, typ: "JWT" }
    : keys.hmac
    ? { alg: "HS256", typ: "JWT" }
    : null;
  if (!header) {
    throw new Error(
      "supabase keys: no signing key — set DENEXT_JWT_SIGNING_KEYS (or DENEXT_JWT_SECRET); " +
        "`denext backend keys` generates them",
    );
  }
  const input = `${base64UrlEncode(encoder.encode(JSON.stringify(header)))}.${
    base64UrlEncode(encoder.encode(JSON.stringify(claims)))
  }`;
  const signature = header.alg === "ES256"
    ? await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      ec.privateKey!,
      encoder.encode(input),
    )
    : await crypto.subtle.sign("HMAC", keys.hmac!, encoder.encode(input));
  return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Whether a string has the shape of a compact JWS (three base64url segments). */
export function looksLikeJwt(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(value);
}

function bad(message: string): SupabaseKeyError {
  return new SupabaseKeyError("bad_jwt", message);
}

interface Parsed {
  header: { alg?: unknown; kid?: unknown; typ?: unknown };
  claims: Record<string, unknown>;
  input: Uint8Array;
  signature: Uint8Array;
}

function parse(token: string): Parsed {
  if (token.length > 16384 || !looksLikeJwt(token)) throw bad("invalid JWT: malformed");
  const [h, p, s] = token.split(".");
  try {
    const header = JSON.parse(decoder.decode(base64UrlDecode(h)));
    const claims = JSON.parse(decoder.decode(base64UrlDecode(p)));
    if (!header || typeof header !== "object" || !claims || typeof claims !== "object") {
      throw new Error("not objects");
    }
    if (Array.isArray(claims)) throw new Error("array claims");
    return {
      header,
      claims,
      input: encoder.encode(`${h}.${p}`),
      signature: base64UrlDecode(s),
    };
  } catch {
    throw bad("invalid JWT: malformed");
  }
}

async function verifySignature(keys: SupabaseKeys, parsed: Parsed): Promise<boolean> {
  const { header, input, signature } = parsed;
  if (header.alg === "HS256") {
    if (!keys.hmac) return false;
    return await crypto.subtle.verify(
      "HMAC",
      keys.hmac,
      signature as BufferSource,
      input as BufferSource,
    );
  }
  if (header.alg !== "ES256") return false;
  // A raw P-256 ECDSA signature is exactly 64 bytes (r || s).
  if (signature.byteLength !== 64) return false;
  const candidates = typeof header.kid === "string"
    ? keys.ec.filter((key) => key.kid === header.kid)
    : keys.ec;
  for (const key of candidates) {
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key.publicKey,
      signature as BufferSource,
      input as BufferSource,
    );
    if (ok) return true;
  }
  return false;
}

const ROLES = new Set<SupabaseRole>(["anon", "authenticated", "service_role"]);

/** Options for {@linkcode verifySupabaseJwt}. */
export interface VerifySupabaseJwtOptions {
  /** Now, epoch milliseconds (tests). */
  now?: number;
  /** Clock-skew tolerance, seconds (default 30). */
  leeway?: number;
}

/**
 * Verify a JWT signed by these keys: the signature (ES256 by `kid`, or HS256 under the legacy
 * secret), `exp` (required), `nbf` / `iat` (not in the future) and the `role` (one of
 * Supabase's three; an `authenticated` token needs a `sub`).
 *
 * @param keys The resolved keys.
 * @param token The compact JWT.
 * @param options The clock.
 * @returns The verified claims.
 * @throws {SupabaseKeyError} `bad_jwt` or `jwt_expired`.
 */
export async function verifySupabaseJwt(
  keys: SupabaseKeys,
  token: string,
  options: VerifySupabaseJwtOptions = {},
): Promise<SupabaseJwtClaims> {
  const parsed = parse(token);
  const typ = typeof parsed.header.typ === "string" ? parsed.header.typ.toUpperCase() : undefined;
  if (typ !== undefined && typ !== "JWT") throw bad("invalid JWT: unexpected typ");
  if (!(await verifySignature(keys, parsed))) {
    throw bad("invalid JWT: unable to parse or verify signature");
  }
  assertTimeClaims(parsed.claims, options);
  assertRole(parsed.claims);
  return parsed.claims as SupabaseJwtClaims;
}

/** `exp` (required), `nbf` and `iat`, with leeway. */
function assertTimeClaims(
  claims: Record<string, unknown>,
  options: VerifySupabaseJwtOptions,
): void {
  const now = (options.now ?? Date.now()) / 1000;
  const leeway = options.leeway ?? 30;
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    throw bad("invalid JWT: missing exp");
  }
  if (claims.exp + leeway < now) {
    throw new SupabaseKeyError("jwt_expired", "invalid JWT: token is expired");
  }
  if (typeof claims.nbf === "number" && claims.nbf - leeway > now) {
    throw bad("invalid JWT: token is not valid yet");
  }
  if (typeof claims.iat === "number" && claims.iat - leeway > now) {
    throw bad("invalid JWT: token used before issued");
  }
}

/** One of Supabase's three roles; an `authenticated` token names its user. */
function assertRole(claims: Record<string, unknown>): void {
  if (typeof claims.role !== "string" || !ROLES.has(claims.role as SupabaseRole)) {
    throw bad("invalid JWT: unsupported role");
  }
  if (claims.role === "authenticated" && (typeof claims.sub !== "string" || claims.sub === "")) {
    throw bad("invalid JWT: missing sub");
  }
}

/**
 * The role an opaque API key grants: `anon` for a publishable key, `service_role` for a secret
 * key, `null` for anything else (a JWT included — verify those with
 * {@linkcode verifySupabaseJwt}). Constant-time over the key's SHA-256.
 *
 * @param keys The resolved keys.
 * @param value The presented key.
 * @returns The role, or `null`.
 */
export async function opaqueKeyRole(
  keys: SupabaseKeys,
  value: string,
): Promise<"anon" | "service_role" | null> {
  const candidate = await digest(value);
  const isPublishable = anyEqual(candidate, keys.publishable);
  const isSecret = anyEqual(candidate, keys.secret);
  return isSecret ? "service_role" : isPublishable ? "anon" : null;
}

/**
 * The role an API key grants — an opaque publishable / secret key, or a legacy `anon` /
 * `service_role` JWT signed by these keys. A user's access token is not an API key.
 *
 * @param keys The resolved keys.
 * @param value The presented key.
 * @param options The clock.
 * @returns `anon` or `service_role`.
 * @throws {SupabaseKeyError} `invalid_api_key` for anything else.
 */
export async function apiKeyRole(
  keys: SupabaseKeys,
  value: string,
  options: VerifySupabaseJwtOptions = {},
): Promise<"anon" | "service_role"> {
  if (looksLikeJwt(value)) {
    try {
      const claims = await verifySupabaseJwt(keys, value, options);
      if (claims.role === "anon" || claims.role === "service_role") return claims.role;
    } catch {
      // Fall through: refused below, without saying why.
    }
    throw new SupabaseKeyError("invalid_api_key", "Invalid API key");
  }
  const role = await opaqueKeyRole(keys, value);
  if (role === null) throw new SupabaseKeyError("invalid_api_key", "Invalid API key");
  return role;
}

/** A freshly generated key set, as {@linkcode generateSupabaseKeys} returns it. */
export interface GeneratedSupabaseKeys {
  /** `sb_publishable_…` — the anon key for clients. */
  publishableKey: string;
  /** `sb_secret_…` — the service-role key, server-side only. */
  secretKey: string;
  /** A private ES256 JWK (with `kid`) that signs access tokens. */
  signingKey: JsonWebKey & { kid: string };
  /** A legacy HS256 secret (only with `legacy: true`). */
  jwtSecret?: string;
  /** The legacy `anon` JWT (only with `legacy: true`). */
  anonKey?: string;
  /** The legacy `service_role` JWT (only with `legacy: true`). */
  serviceRoleKey?: string;
}

function randomKey(prefix: string): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return prefix + base64UrlEncode(bytes);
}

/**
 * Generate a new key set: a publishable key, a secret key and an ES256 signing key — plus,
 * with `legacy`, a JWT secret and the `anon` / `service_role` JWTs signed with it (valid ten
 * years, like Supabase's).
 *
 * @param options `legacy`: also mint the HS256 keys.
 * @returns The keys. Store them as environment secrets; never commit them.
 */
export async function generateSupabaseKeys(
  options: { legacy?: boolean } = {},
): Promise<GeneratedSupabaseKeys> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const kid = await thumbprint(jwk);
  const signingKey = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d, kid };
  const out: GeneratedSupabaseKeys = {
    publishableKey: randomKey("sb_publishable_"),
    secretKey: randomKey("sb_secret_"),
    signingKey,
  };
  if (!options.legacy) return out;
  const secretBytes = new Uint8Array(48);
  crypto.getRandomValues(secretBytes);
  const jwtSecret = base64UrlEncode(secretBytes);
  const legacy = await resolveSupabaseKeys({ jwtSecret });
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 10 * 365 * 24 * 3600;
  return {
    ...out,
    jwtSecret,
    anonKey: await signSupabaseJwt(legacy, { iss: "supabase", role: "anon", iat, exp }),
    serviceRoleKey: await signSupabaseJwt(legacy, {
      iss: "supabase",
      role: "service_role",
      iat,
      exp,
    }),
  };
}

const KEYS_SLOT = Symbol.for("denext.supabase.keys");
type KeysHolder = { [KEYS_SLOT]?: SupabaseKeys };

/**
 * Install the process's key material (`backend({ supabase })` does at setup), or clear it with
 * `undefined`. Process-global, so a bundled copy of this module sees the same keys.
 *
 * @param keys The resolved keys.
 */
export function installSupabaseKeys(keys: SupabaseKeys | undefined): void {
  (globalThis as KeysHolder)[KEYS_SLOT] = keys;
}

/**
 * The installed key material, or `undefined` when `backend({ supabase })` is not configured.
 *
 * @returns The keys.
 */
export function installedSupabaseKeys(): SupabaseKeys | undefined {
  return (globalThis as KeysHolder)[KEYS_SLOT];
}
