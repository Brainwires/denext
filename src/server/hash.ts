/**
 * The two digest primitives denext auth shares between its token flows: a SHA-256 hex
 * digest (what a bearer API token and a verification token are stored as — never the
 * token itself) and a constant-time comparison of two such digests.
 *
 * Both are deliberately tiny and dependency-free (`crypto.subtle` + `node:crypto`), so the
 * modules that store hashed secrets agree byte-for-byte on the stored form.
 *
 * @module
 */

import { timingSafeEqual } from "node:crypto";

const encoder = new TextEncoder();

/**
 * SHA-256 of a string (UTF-8), hex-encoded lower-case — the only form a bearer API token
 * or a verification token ever reaches storage in. The output is stable across releases:
 * a hash written by an earlier denext still matches the same presented token.
 *
 * @param input The string to digest (the full presented token, prefix included).
 * @returns 64 lower-case hex characters.
 */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compare two hex digests in constant time (`timingSafeEqual`). A length mismatch is
 * `false` without throwing — and still runs one full-length comparison, so a malformed
 * value can't be told from a wrong one by how fast it is refused.
 *
 * @param a One digest (e.g. the stored hash).
 * @param b The other (e.g. the hash of the presented token).
 * @returns `true` only when both strings are byte-identical.
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) {
    timingSafeEqual(left, left); // comparable work; the answer is already "no"
    return false;
  }
  return timingSafeEqual(left, right);
}
