/**
 * TOTP secrets at rest. A TOTP verifier needs the shared secret itself (RFC 6238 §5.1: "the
 * keys SHOULD be … stored securely"), so it can't be hashed like a password or a backup code.
 * Instead the MFA layer seals it before it reaches the adapter and opens it only to verify a
 * code, so a copied database file (a backup, a leaked volume) yields no usable factor without
 * the auth `secret` too.
 *
 * **The construction.** AES-256-GCM (NIST SP 800-38D) under a key derived per auth `secret`
 * with HKDF-SHA-256 (RFC 5869) and a dedicated `info` label, so the key is independent of the
 * HMAC key the same `secret` signs session cookies with (RFC 5869 §3.2). Each seal draws a fresh
 * random 96-bit nonce (SP 800-38D §8.2.2, the RBG-based construction; well under its 2^32
 * invocations per key). The additional authenticated data binds the version and the owner's
 * user id, so a sealed secret copied onto another user's row fails to open (SP 800-38D §5.2.1.1).
 * Web Crypto only.
 *
 * **The stored form** keeps the version, nonce and ciphertext together in one column:
 * `totp.v1.<nonce>.<ciphertext‖tag>` (both unpadded base64url). A base32 secret (RFC 4648 §6:
 * `A–Z`, `2–7`) can never contain a `.`, so a legacy plaintext row is told apart without a
 * schema change.
 *
 * **Rotation.** `secret` may be a list (current first), as for session cookies: opening tries
 * each, and a secret opened with an older one — or a legacy plaintext row — is reported
 * `stale`, so the caller re-seals it under the current one.
 *
 * **Failing closed.** A sealed value that no configured secret opens, a tampered one, an
 * unknown version, or anything that is neither sealed nor base32 opens to `{ ok: false }` —
 * never to the stored string. Nothing here logs or returns the secret except the opened value.
 *
 * **What it does not cover.** Sealing protects a copied database, not a writable one: a plain
 * base32 value always opens as a legacy row (there is no per-row marker that it was ever
 * sealed), so whoever can write the MFA table can replace a sealed secret with a plaintext one
 * they know. Someone with that access can equally rewrite password hashes or delete the MFA
 * row; guard write access to the auth tables as you would the `secret`.
 *
 * @module
 */

import { base64UrlDecode, base64UrlEncode } from "./oauth.ts";

/** The version tag every sealed secret starts with. */
const SEALED_PREFIX = "totp.v1.";
/** RFC 5869 `info`: names what the derived key is for, separating it from every other use. */
const HKDF_INFO = "denext auth: TOTP secret at-rest encryption (AES-256-GCM) v1";
/** RFC 5869 `salt`: fixed and public (§3.1 — a salt need not be secret). */
const HKDF_SALT = "denext.auth.totp-seal";
/** A 96-bit GCM nonce, the length SP 800-38D §5.2.1.1 recommends. */
const NONCE_BYTES = 12;
/** A GCM ciphertext is at least its 128-bit tag. */
const TAG_BYTES = 16;
/** An RFC 4648 base32 secret as denext (or an app) stored it before sealing existed. */
const LEGACY_BASE32 = /^[A-Z2-7]+=*$/i;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** The outcome of {@linkcode openTotpSecret}. */
export type OpenedTotpSecret =
  | {
    ok: true;
    /** The base32 TOTP secret. */
    secret: string;
    /**
     * The stored value should be re-sealed: it was plaintext (a pre-sealing row) or was
     * sealed under a secret other than the current one.
     */
    stale: boolean;
  }
  | { ok: false };

/**
 * The auth secrets as a list, current first — the same list the session cookie verifies
 * against.
 *
 * @param secret The `AuthConfig.secret` value.
 * @returns The secrets, current first.
 */
export function authSecrets(secret: string | string[]): string[] {
  return Array.isArray(secret) ? secret : [secret];
}

/** Derive the AES-256-GCM key for one auth secret (RFC 5869 HKDF-SHA-256). */
async function sealKey(secret: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(HKDF_SALT),
      info: encoder.encode(HKDF_INFO),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** The additional authenticated data: the version and the owner (SP 800-38D §5.2.1.1). */
function aad(userId: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${SEALED_PREFIX}${userId}`);
}

/**
 * Whether a stored value is in the sealed form (whether or not it opens).
 *
 * @param stored The stored `MfaRecord.secret`.
 * @returns `true` for a `totp.v1.…` value.
 */
export function isSealedTotpSecret(stored: string): boolean {
  return stored.startsWith(SEALED_PREFIX);
}

/**
 * Seal a TOTP secret for storage under the current (first) auth secret.
 *
 * @param secrets The auth secrets, current first ({@linkcode authSecrets}).
 * @param userId The owner — bound into the ciphertext, so it opens only on their row.
 * @param plaintext The base32 TOTP secret.
 * @returns `totp.v1.<nonce>.<ciphertext‖tag>`.
 */
export async function sealTotpSecret(
  secrets: string[],
  userId: string,
  plaintext: string,
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad(userId), tagLength: TAG_BYTES * 8 },
    await sealKey(secrets[0]),
    encoder.encode(plaintext),
  );
  return `${SEALED_PREFIX}${base64UrlEncode(nonce)}.${base64UrlEncode(new Uint8Array(sealed))}`;
}

/** Split a sealed value into its nonce and ciphertext, or `null` when malformed. */
function parseSealed(
  stored: string,
): { nonce: Uint8Array<ArrayBuffer>; body: Uint8Array<ArrayBuffer> } | null {
  const parts = stored.slice(SEALED_PREFIX.length).split(".");
  if (parts.length !== 2) return null;
  try {
    const nonce = new Uint8Array(base64UrlDecode(parts[0]));
    const body = new Uint8Array(base64UrlDecode(parts[1]));
    return nonce.length === NONCE_BYTES && body.length > TAG_BYTES ? { nonce, body } : null;
  } catch {
    return null; // not base64url
  }
}

/** Open `body` with one secret's key, or `null` when the tag doesn't verify. */
async function openWith(
  secret: string,
  userId: string,
  nonce: Uint8Array<ArrayBuffer>,
  body: Uint8Array<ArrayBuffer>,
): Promise<string | null> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad(userId), tagLength: TAG_BYTES * 8 },
      await sealKey(secret),
      body,
    );
    return decoder.decode(plain);
  } catch {
    return null; // wrong key, tampered, or another user's row (OperationError)
  }
}

/**
 * Open a stored TOTP secret: a sealed value with whichever auth secret seals it, or a legacy
 * plaintext base32 row as-is. Fails closed — see the module doc.
 *
 * @param secrets The auth secrets, current first ({@linkcode authSecrets}).
 * @param userId The owner the value was sealed for.
 * @param stored The stored `MfaRecord.secret`.
 * @returns `{ ok: true, secret, stale }`, or `{ ok: false }` when it can't be opened.
 */
export async function openTotpSecret(
  secrets: string[],
  userId: string,
  stored: string,
): Promise<OpenedTotpSecret> {
  if (!isSealedTotpSecret(stored)) {
    // A pre-sealing row: readable as before, and due for sealing.
    return LEGACY_BASE32.test(stored) ? { ok: true, secret: stored, stale: true } : { ok: false };
  }
  const parsed = parseSealed(stored);
  if (!parsed) return { ok: false };
  for (const [index, secret] of secrets.entries()) {
    const opened = await openWith(secret, userId, parsed.nonce, parsed.body);
    if (opened !== null) return { ok: true, secret: opened, stale: index > 0 };
  }
  return { ok: false };
}
