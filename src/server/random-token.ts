// A cryptographically random, URL-safe token: CSRF tokens (`csrf()`), OAuth `state` / `nonce` /
// PKCE verifiers and session ids all draw from it.

import { toBase64Url } from "./session.ts";

/**
 * A cryptographically-random URL-safe token (for `state` / `nonce` / PKCE verifier).
 *
 * @param bytes Entropy in bytes (default 32 → a 43-char token).
 * @returns A base64url string of `bytes` random bytes.
 */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toBase64Url(buf);
}
