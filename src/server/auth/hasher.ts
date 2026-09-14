/**
 * The password-hashing seam. Everything denext auth hashes and verifies with a
 * *secret the user knows* — a Credentials password, an MFA backup code — goes through
 * a {@linkcode Hasher}, so an app can swap the algorithm (Argon2id from an npm/WASM
 * package, a KMS-backed peppered hash, a legacy bcrypt column during a migration)
 * without touching the auth flow.
 *
 * The default is {@linkcode scryptHasher}, a thin wrapper over the built-in
 * {@link ./password.ts | hashPassword} / `verifyPassword` — salted scrypt via
 * `node:crypto`, zero npm, constant-time compare, and equal work for an unknown
 * account (no user-enumeration timing oracle).
 *
 * @module
 */

import { hashPassword, type HashPasswordOptions, verifyPassword } from "./password.ts";

/**
 * How denext hashes and checks user-supplied secrets. An implementation MUST compare in
 * constant time and MUST NOT throw on a malformed `stored` value — return `false`, so a
 * corrupted row can never surface as a 500 or a stack trace.
 */
export interface Hasher {
  /**
   * Hash a plaintext secret for storage.
   *
   * @param plain The plaintext password / backup code.
   * @returns The self-describing stored string.
   */
  hash(plain: string): Promise<string>;

  /**
   * Check a plaintext secret against a stored hash.
   *
   * @param plain The submitted plaintext.
   * @param stored The stored string (possibly empty or malformed).
   * @returns `true` only on a match.
   */
  verify(plain: string, stored: string): Promise<boolean>;
}

/**
 * The default {@linkcode Hasher}: salted **scrypt** through `node:crypto`, encoded as
 * `scrypt$N=…,r=…,p=…$salt$hash`. Pass it explicitly to raise the cost:
 * ```ts
 * denextAuth({ hasher: scryptHasher({ cost: 2 ** 16 }), … })
 * ```
 * Hashes stay self-describing, so raising the cost never invalidates existing ones.
 *
 * @param options Tunable scrypt cost (`cost`/`blockSize`/`parallelization`).
 * @returns A {@linkcode Hasher} backed by `hashPassword` / `verifyPassword`.
 */
export function scryptHasher(options: HashPasswordOptions = {}): Hasher {
  return {
    hash: (plain: string): Promise<string> => hashPassword(plain, options),
    // The SAME options on both halves: `verify`'s equal-work rejection of an absent hash
    // has to burn this deployment's cost, or an unknown account rejects measurably faster
    // than a known one (a user-enumeration oracle that grows with `cost`).
    verify: (plain: string, stored: string): Promise<boolean> =>
      verifyPassword(plain, stored, options),
  };
}
