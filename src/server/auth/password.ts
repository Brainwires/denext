/**
 * Password hashing for the Credentials provider: salted **scrypt** via Deno's built-in
 * `node:crypto` (zero npm), stored as a self-describing string so the cost parameters
 * can be raised later without invalidating existing hashes:
 *
 * ```text
 * scrypt$N=16384,r=8,p=1$<salt base64url>$<hash base64url>
 * ```
 *
 * `verifyPassword` recomputes the hash with the parameters embedded in the stored
 * string and compares with `timingSafeEqual`, and never throws on malformed input —
 * so an `authorize` callback stays a single `return (await verifyPassword(...)) ? user : null`.
 *
 * @module
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { base64UrlDecode, base64UrlEncode } from "./oauth.ts";

/** Tunable scrypt cost for {@linkcode hashPassword}. */
export interface HashPasswordOptions {
  /** CPU/memory cost `N` (a power of two). Default 16384 (2^14, ~16 MiB). */
  cost?: number;
  /** Block size `r`. Default 8. */
  blockSize?: number;
  /** Parallelization `p`. Default 1. */
  parallelization?: number;
}

/** The scrypt parameters embedded in a stored hash. */
interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** Derived key length in bytes. */
const KEY_LENGTH = 32;
/** Salt length in bytes. */
const SALT_LENGTH = 16;
/** Default cost: libsodium's "interactive" profile (N=2^14, r=8, p=1 — ~16 MiB, ~50 ms). */
const DEFAULT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };
/**
 * Upper bounds on the parameters a STORED hash may request, so a corrupted/hostile row
 * can't make `verifyPassword` allocate gigabytes or spin for minutes (self-DoS).
 */
const MAX_PARAMS: ScryptParams = { N: 1 << 22, r: 64, p: 16 };

/** Run scrypt (callback API) as a promise. */
function deriveKey(password: string, salt: Uint8Array, params: ScryptParams): Promise<Uint8Array> {
  // node:crypto caps memory at 32 MiB by default; scrypt needs 128·N·r bytes. Size the
  // cap to the requested parameters (with headroom) so a higher cost simply works.
  const maxmem = 128 * params.N * params.r * 2;
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: params.N, r: params.r, p: params.p, maxmem },
      (err, key) => err ? reject(err) : resolve(new Uint8Array(key)),
    );
  });
}

/** `N=…,r=…,p=…` → params, or `undefined` when malformed or over the sanity caps. */
function parseParams(spec: string): ScryptParams | undefined {
  const out: Partial<ScryptParams> = {};
  for (const part of spec.split(",")) {
    const [k, v] = part.split("=");
    const n = Number(v);
    if ((k !== "N" && k !== "r" && k !== "p") || !Number.isInteger(n) || n <= 0) return undefined;
    out[k] = n;
  }
  const { N, r, p } = out;
  if (N === undefined || r === undefined || p === undefined) return undefined;
  if ((N & (N - 1)) !== 0 || N < 2) return undefined; // scrypt requires a power of two
  if (N > MAX_PARAMS.N || r > MAX_PARAMS.r || p > MAX_PARAMS.p) return undefined;
  return { N, r, p };
}

/**
 * Hash a password for storage: a fresh random salt + scrypt, encoded as
 * `scrypt$N=…,r=…,p=…$salt$hash`. Store the returned string; verify later with
 * {@linkcode verifyPassword}.
 *
 * @example
 * ```ts
 * import { hashPassword } from "denext/server";
 * db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
 *   .run(email, await hashPassword(password));
 * ```
 *
 * @param password The plaintext password.
 * @param options Raise the scrypt cost for a higher-security deployment.
 * @returns The self-describing hash string.
 */
export async function hashPassword(
  password: string,
  options: HashPasswordOptions = {},
): Promise<string> {
  const params: ScryptParams = {
    N: options.cost ?? DEFAULT_PARAMS.N,
    r: options.blockSize ?? DEFAULT_PARAMS.r,
    p: options.parallelization ?? DEFAULT_PARAMS.p,
  };
  const salt = new Uint8Array(randomBytes(SALT_LENGTH));
  const hash = await deriveKey(password, salt, params);
  return `scrypt$N=${params.N},r=${params.r},p=${params.p}$${base64UrlEncode(salt)}$${
    base64UrlEncode(hash)
  }`;
}

/**
 * Verify a password against a hash produced by {@linkcode hashPassword}. The comparison
 * is constant-time (`timingSafeEqual`), and a malformed/unsupported `stored` value —
 * an empty column, a legacy format, a corrupted row — returns `false` rather than
 * throwing, so an `authorize` callback can't leak a stack trace or a 500.
 *
 * @example
 * ```ts
 * credentials({
 *   authorize: async ({ email, password }) => {
 *     const row = findUser(email); // may be undefined — still runs verify below
 *     const ok = await verifyPassword(password ?? "", row?.password_hash ?? "");
 *     return ok && row ? { id: String(row.id), email: row.email } : null;
 *   },
 * })
 * ```
 *
 * @param password The submitted plaintext password.
 * @param stored The stored `scrypt$…` string.
 * @returns `true` only when the password matches.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  const [algo, spec, saltB64, hashB64, ...rest] = stored.split("$");
  if (algo !== "scrypt" || !spec || !saltB64 || !hashB64 || rest.length > 0) return false;
  const params = parseParams(spec);
  if (!params) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64UrlDecode(saltB64);
    expected = base64UrlDecode(hashB64);
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;
  try {
    const actual = await deriveKey(password, salt, params);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
