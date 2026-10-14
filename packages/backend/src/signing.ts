// HMAC-SHA256 capabilities for the storage plugin's own URLs and tokens: an expiring download
// URL, an expiring upload URL (fs driver), and the upload token the client hands back to
// complete or abort an upload. A signature covers every parameter that changes what the URL
// does (method, bucket, key, expiry, content type, size cap, transform), so none can be edited
// without invalidating it. Verification is constant-time (`crypto.subtle.verify`).

import { StorageError } from "./errors.ts";

/** The MAC domain: a storage token can never verify as any other denext token on one secret. */
const DOMAIN = "denext.backend.storage.v1";
/** Minimum secret length (characters). */
const MIN_SECRET_LENGTH = 32;
/** The env var the secret is read from when the config sets none. */
export const SECRET_ENV = "DENEXT_STORAGE_SECRET";

const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function keyFor(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    keys.set(secret, key);
  }
  return key;
}

/**
 * Encode bytes as unpadded base64url.
 *
 * @param bytes The bytes.
 * @returns The text.
 */
export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Decode unpadded base64url, or `null` when it is not valid base64url.
 *
 * @param text The text.
 * @returns The bytes, or `null`.
 */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Sign `payload` with the first (current) secret.
 *
 * @param payload The canonical string.
 * @param secrets The secrets, current first.
 * @returns The signature, base64url.
 */
export async function signPayload(payload: string, secrets: readonly string[]): Promise<string> {
  const data = encoder.encode(`${DOMAIN}\0${payload}`);
  return toBase64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", await keyFor(secrets[0]), data)),
  );
}

/**
 * Verify `signature` over `payload` against any of `secrets` (a rotated-out secret keeps
 * verifying while it is listed).
 *
 * @param payload The canonical string.
 * @param signature The base64url signature.
 * @param secrets The secrets.
 * @returns Whether it verifies.
 */
export async function verifyPayload(
  payload: string,
  signature: string,
  secrets: readonly string[],
): Promise<boolean> {
  const sig = fromBase64Url(signature);
  if (!sig || sig.byteLength !== 32) return false;
  const data = encoder.encode(`${DOMAIN}\0${payload}`);
  for (const secret of secrets) {
    if (await crypto.subtle.verify("HMAC", await keyFor(secret), sig as BufferSource, data)) {
      return true;
    }
  }
  return false;
}

/**
 * The signing secrets: the config's `secret` (one, or a rotation list current-first), else
 * `DENEXT_STORAGE_SECRET`. Under `denext dev` a missing secret becomes a random per-process one
 * (URLs stop working on restart); anywhere else it is an error at first use.
 *
 * @param configured The config's `secret`.
 * @param env The env reader.
 * @param dev Whether this is `denext dev`.
 * @returns The secrets, or `null` when none is configured outside dev.
 */
export function resolveSecrets(
  configured: string | readonly string[] | undefined,
  env: (name: string) => string | undefined,
  dev: boolean,
): string[] | null {
  const list = configured === undefined
    ? [env(SECRET_ENV)].filter((s): s is string => !!s)
    : typeof configured === "string"
    ? [configured]
    : [...configured];
  for (const secret of list) {
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new StorageError(
        "not_configured",
        `storage secret must be at least ${MIN_SECRET_LENGTH} characters`,
      );
    }
  }
  if (list.length > 0) return list;
  if (!dev) return null;
  return [toBase64Url(crypto.getRandomValues(new Uint8Array(32)))];
}

/** Seconds since the epoch. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Check a signed expiry: an integer in the future.
 *
 * @param exp The `exp` parameter.
 * @returns The expiry as a number.
 * @throws {StorageError} `bad_signature` (malformed) or `expired`.
 */
export function checkExpiry(exp: string | null): number {
  if (exp === null || !/^\d{1,12}$/.test(exp)) {
    throw new StorageError("bad_signature", "missing or malformed expiry");
  }
  const value = Number(exp);
  if (value <= nowSeconds()) throw new StorageError("expired", "this URL has expired");
  return value;
}

/** A signed upload capability, round-tripped by the client to complete or abort the upload. */
export interface UploadGrant {
  /** Bucket. */
  b: string;
  /** Key. */
  k: string;
  /** Declared content type. */
  ct: string;
  /** Exact size, when declared. */
  n?: number;
  /** Size cap. */
  max: number;
  /** Multipart upload id (S3). */
  u?: string;
  /** The owner to record (the signing caller's user id). */
  o?: string | null;
  /**
   * Pinned (a policy-checked signer): the version the object had when the upload was authorized
   * (`null`: none). The upload records its row only while the object is still at it.
   */
  cv?: string | null;
  /**
   * The version the upload writes: the client's bytes go to its staging place
   * (`.denext-staging/<bucket>/<v>`) and reach the key only when the completion writes the row.
   */
  v: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

/**
 * Seal a grant into an opaque `<payload>.<signature>` token.
 *
 * @param grant The grant.
 * @param secrets The secrets.
 * @returns The token.
 */
export async function sealGrant(grant: UploadGrant, secrets: readonly string[]): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(grant)));
  return `${body}.${await signPayload("grant\n" + body, secrets)}`;
}

/**
 * Open a token sealed by {@link sealGrant}, checking its signature and expiry.
 *
 * @param token The token.
 * @param secrets The secrets.
 * @returns The grant.
 * @throws {StorageError} `bad_signature` or `expired`.
 */
export async function openGrant(token: unknown, secrets: readonly string[]): Promise<UploadGrant> {
  const [body, sig, extra] = typeof token === "string" ? token.split(".") : [];
  if (!body || !sig || extra !== undefined) {
    throw new StorageError("bad_signature", "malformed upload token");
  }
  if (!(await verifyPayload("grant\n" + body, sig, secrets))) {
    throw new StorageError("bad_signature", "upload token signature mismatch");
  }
  const grant = JSON.parse(new TextDecoder().decode(fromBase64Url(body)!)) as UploadGrant;
  checkExpiry(String(grant.exp));
  return grant;
}

/**
 * Seal a JSON payload into a token (`<base64url body>.<HMAC>`), bound to `kind` so a token minted
 * for one purpose (a signed download) is never accepted for another (a signed upload). The payload
 * must carry `exp` (epoch seconds).
 *
 * @param kind What the token is for.
 * @param payload The payload.
 * @param secrets The signing secrets (current first).
 * @returns The token.
 */
export async function sealToken(
  kind: string,
  payload: { exp: number } & Record<string, unknown>,
  secrets: readonly string[],
): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await signPayload(`token:${kind}\n${body}`, secrets)}`;
}

/**
 * Open a token sealed by {@linkcode sealToken} for `kind`: the signature (constant-time, any
 * listed secret) and the expiry are checked.
 *
 * @param kind What the token must be for.
 * @param token The token.
 * @param secrets The signing secrets.
 * @returns The payload.
 * @throws {StorageError} `bad_signature` or `expired`.
 */
export async function openToken<T extends { exp: number }>(
  kind: string,
  token: unknown,
  secrets: readonly string[],
): Promise<T> {
  const [body, sig, extra] = typeof token === "string" ? token.split(".") : [];
  if (!body || !sig || extra !== undefined) {
    throw new StorageError("bad_signature", "malformed token");
  }
  if (!(await verifyPayload(`token:${kind}\n${body}`, sig, secrets))) {
    throw new StorageError("bad_signature", "invalid signature");
  }
  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body)!)) as T;
  checkExpiry(String(payload.exp));
  return payload;
}
