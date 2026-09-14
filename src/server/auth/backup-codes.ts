/**
 * MFA backup codes: single-use recovery codes a user prints when enrolling TOTP, for the
 * day the phone is lost. Each code is 10 characters from an unambiguous alphabet (no
 * `0`/`o`/`1`/`i`/`l`, ~49.5 bits), shown as `xxxxx-xxxxx`, and stored ONLY as a salted
 * hash through the auth {@link ./hasher.ts | Hasher} — the same seam as passwords, so an
 * app that swaps the algorithm swaps it here too.
 *
 * Redemption is the adapter's atomic `consumeBackupCode(userId, matches)`;
 * {@linkcode backupCodeMatcher} builds that `matches` predicate.
 *
 * @module
 */

import type { Hasher } from "./hasher.ts";

/** The code alphabet: lowercase letters and digits minus the look-alikes 0/o, 1/i/l. */
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
/** Characters per code (before the display hyphen). */
const CODE_LENGTH = 10;
/** Most codes one {@linkcode generateBackupCodes} call issues. */
const MAX_CODES = 20;
/** Largest byte value that maps uniformly onto the alphabet (rejection sampling). */
const UNBIASED_LIMIT = 256 - (256 % ALPHABET.length);
/** A normalised code is exactly {@linkcode CODE_LENGTH} alphabet characters. */
const NORMALISED_CODE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

/** A fresh set of backup codes: show `codes` once, store only `hashes`. */
export interface BackupCodes {
  /** The plaintext codes, formatted `xxxxx-xxxxx`, to show the user exactly once. */
  codes: string[];
  /** Their hashes, same order, for `MfaRecord.backupCodeHashes`. */
  hashes: string[];
}

/**
 * Generate a set of unique backup codes and hash each through `hasher`. The hash covers
 * the normalised form (no hyphen, lowercase), so a user may type a code with or without
 * the hyphen, in any case.
 *
 * @param hasher The auth {@linkcode Hasher} (`ResolvedAuthOptions.hasher`).
 * @param count How many codes, clamped to 0–20. Default 10.
 * @returns The plaintext codes and their hashes.
 */
export async function generateBackupCodes(
  hasher: Hasher,
  count: number = 10,
): Promise<BackupCodes> {
  const wanted = Number.isNaN(count) ? 0 : Math.min(MAX_CODES, Math.max(0, Math.trunc(count)));
  const unique = new Set<string>();
  while (unique.size < wanted) unique.add(randomCode());
  const normalised = [...unique];
  const hashes = await Promise.all(normalised.map((code) => hasher.hash(code)));
  const codes = normalised.map((code) => `${code.slice(0, 5)}-${code.slice(5)}`);
  return { codes, hashes };
}

/**
 * Build the `matches` predicate the adapter's `consumeBackupCode` walks the stored hashes
 * with. The presented code is normalised (spaces and hyphens stripped, lowercased); a
 * malformed one yields a predicate that matches nothing — yet still runs one
 * `hasher.verify` per stored hash, so a garbage submission costs what a wrong code does.
 *
 * @param hasher The auth {@linkcode Hasher} the codes were hashed with.
 * @param code The code the user typed.
 * @returns A predicate resolving `true` only when `code` is the one `hash` was made from.
 */
export function backupCodeMatcher(
  hasher: Hasher,
  code: string,
): (hash: string) => Promise<boolean> {
  const normalised = normaliseBackupCode(code);
  const wellFormed = NORMALISED_CODE.test(normalised);
  const candidate = wellFormed ? normalised : "";
  return async (hash: string): Promise<boolean> =>
    (await hasher.verify(candidate, hash)) && wellFormed;
}

/**
 * Normalise a presented code: drop whitespace and hyphens, lowercase.
 *
 * @param input The raw input (possibly not a string at runtime).
 * @returns The normalised code (possibly empty or malformed).
 */
function normaliseBackupCode(input: unknown): string {
  if (typeof input !== "string" || input.length > 64) return "";
  return input.replace(/[\s-]+/g, "").toLowerCase();
}

/**
 * One uniformly random code, by rejection sampling CSPRNG bytes onto the alphabet.
 *
 * @returns {@linkcode CODE_LENGTH} alphabet characters.
 */
function randomCode(): string {
  let code = "";
  while (code.length < CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < UNBIASED_LIMIT && code.length < CODE_LENGTH) {
        code += ALPHABET[byte % ALPHABET.length];
      }
    }
  }
  return code;
}
