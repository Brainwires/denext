// Object keys and bucket names: one normalization every entry point runs (the server API, the
// sign route, the download and upload handlers), so a key can never name a path outside its
// bucket — whatever driver stores it.

import { StorageError } from "./errors.ts";

/** The longest key accepted, in UTF-8 bytes (S3's own limit). */
const MAX_KEY_BYTES = 1024;

/** A bucket name: lowercase letters, digits, `-` and `_`, starting with a letter or digit. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** C0 controls, DEL and the backslash: refused anywhere in a key. */
// deno-lint-ignore no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\\]/;

/**
 * Validate a bucket name.
 *
 * @param name The configured or requested bucket name.
 * @returns The name.
 * @throws {StorageError} `invalid_bucket` when it is not a valid name.
 */
export function checkBucketName(name: string): string {
  if (typeof name !== "string" || !BUCKET_NAME.test(name)) {
    throw new StorageError("invalid_bucket", `invalid bucket name ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Normalize an object key: Unicode NFC, `/`-separated, with no empty, `.` or `..` segment, no
 * leading or trailing `/`, no control character or backslash, and at most
 * {@link MAX_KEY_BYTES} bytes. Normalization never rewrites a key into a different one — a key
 * that is not already in this form is refused, so the name a caller signs is the name stored.
 *
 * @param key The requested key.
 * @returns The key, NFC-normalized.
 * @throws {StorageError} `invalid_key` when the key is refused.
 */
export function normalizeKey(key: string): string {
  if (typeof key !== "string") throw invalidKey("must be a string");
  const nfc = key.normalize("NFC");
  if (nfc.length === 0) throw invalidKey("is empty");
  if (new TextEncoder().encode(nfc).byteLength > MAX_KEY_BYTES) {
    throw invalidKey(`is longer than ${MAX_KEY_BYTES} bytes`);
  }
  if (FORBIDDEN_CHARS.test(nfc)) throw invalidKey("contains a control character or backslash");
  for (const segment of nfc.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw invalidKey("has an empty, '.' or '..' segment");
    }
  }
  return nfc;
}

/**
 * Normalize a listing prefix: `""` (everything) or a key prefix whose complete segments obey
 * {@link normalizeKey}'s rules (a trailing `/` is allowed: `avatars/`).
 *
 * @param prefix The requested prefix.
 * @returns The prefix, NFC-normalized.
 */
export function normalizePrefix(prefix: string): string {
  if (prefix === "") return "";
  if (typeof prefix !== "string") throw invalidKey("prefix must be a string");
  const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return normalizeKey(trimmed) + (trimmed.length === prefix.length ? "" : "/");
}

function invalidKey(why: string): StorageError {
  return new StorageError("invalid_key", `object key ${why}`);
}
