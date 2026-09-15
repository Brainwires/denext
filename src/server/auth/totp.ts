/**
 * TOTP (RFC 6238) primitives for denext auth's second factor: secret generation, the
 * `otpauth://` provisioning URI an authenticator app scans, and code verification over a
 * ±`window` of time steps. Zero npm — HMAC-SHA-1 is `crypto.subtle`, the base32 secret
 * encoding is `@std/encoding`, and the code comparison is `node:crypto`'s
 * `timingSafeEqual`.
 *
 * These are pure functions over a secret. The replay guard (the adapter's atomic
 * `claimTotpStep`) and the per-user attempt limiter live one layer up, in the MFA flow —
 * which is why {@linkcode verifyTotp} returns the `step` a code matched.
 *
 * @module
 */

import { decodeBase32, encodeBase32 } from "@std/encoding/base32";
import { timingSafeEqual } from "node:crypto";

/** The smallest secret {@linkcode generateTotpSecret} issues: 160 bits (RFC 4226 §4 R6). */
const MIN_SECRET_BYTES = 20;
/** Default code length. */
const DEFAULT_DIGITS = 6;
/** Default time-step length in seconds. */
const DEFAULT_PERIOD = 30;
/** Default tolerance, in steps either side of "now", for clock skew. */
const DEFAULT_WINDOW = 1;
/** A presented code longer than this is rejected before any normalisation work. */
const MAX_CODE_INPUT = 64;
/** Remainders (mod 8) a valid unpadded RFC 4648 base32 string can have. */
const VALID_BASE32_REMAINDERS = new Set([0, 2, 4, 5, 7]);

/** Options for {@linkcode totpAuthUri}. */
export interface TotpAuthUriOptions {
  /** The base32 secret (as {@linkcode generateTotpSecret} returns it). */
  secret: string;
  /** The account label shown in the authenticator app (usually the email). */
  account: string;
  /** The service name shown in the app, prefixed to the label. An empty string omits it. */
  issuer: string;
  /** Code length, 6–8. Default 6 — the only length every authenticator app supports. */
  digits?: number;
  /** Time-step length in seconds. Default 30 — the only period every app supports. */
  period?: number;
  /** The HMAC algorithm. Only `"SHA1"`: it is what {@linkcode verifyTotp} checks. */
  algorithm?: "SHA1";
}

/** Options for {@linkcode verifyTotp}. */
export interface TotpVerifyOptions {
  /** Steps accepted either side of the current one (clock skew), 0–10. Default 1. */
  window?: number;
  /** The clock, in epoch **milliseconds**. Default `Date.now()`. */
  now?: number;
  /** Code length, 6–8. Default 6. */
  digits?: number;
  /** Time-step length in seconds. Default 30. */
  period?: number;
}

/**
 * The outcome of {@linkcode verifyTotp}: on a match, the time step the code belongs to —
 * hand it to the adapter's `claimTotpStep` so the same code can't be presented twice.
 */
export type TotpVerifyResult =
  | { ok: true; step: number }
  | { ok: false; error: "invalid_code" };

/**
 * Generate a fresh TOTP secret: `bytes` of CSPRNG output as unpadded, uppercase RFC 4648
 * base32 — the form authenticator apps expect.
 *
 * @param bytes Secret length in bytes; at least 20 (160 bits). Default 20.
 * @returns The base32 secret (32 characters at the default length).
 * @throws {RangeError} When `bytes` is not an integer ≥ 20.
 */
export function generateTotpSecret(bytes: number = MIN_SECRET_BYTES): string {
  if (!Number.isInteger(bytes) || bytes < MIN_SECRET_BYTES) {
    throw new RangeError(
      `generateTotpSecret: a TOTP secret must be at least ${MIN_SECRET_BYTES} bytes (got ${bytes})`,
    );
  }
  return encodeBase32(crypto.getRandomValues(new Uint8Array(bytes))).replace(/=+$/, "");
}

/**
 * Build the `otpauth://totp/…` provisioning URI (Google Authenticator key-URI format) to
 * render as a QR code or a link. The label is `Issuer:account` with each part
 * percent-encoded (so a `:` inside either part can't forge the separator), and every
 * query value is percent-encoded too (a space is `%20`, never `+`).
 *
 * @param options The secret, labels and code parameters.
 * @returns The URI, e.g. `otpauth://totp/Acme:ada%40example.com?secret=…&issuer=Acme&algorithm=SHA1&digits=6&period=30`.
 * @throws {RangeError} When `digits` or `period` is out of range.
 */
export function totpAuthUri(options: TotpAuthUriOptions): string {
  const digits = checkDigits(options.digits ?? DEFAULT_DIGITS);
  const period = checkPeriod(options.period ?? DEFAULT_PERIOD);
  const secret = options.secret.replace(/\s+/g, "").replace(/=+$/, "").toUpperCase();
  const account = encodeURIComponent(options.account);
  const issuer = options.issuer;
  const label = issuer ? `${encodeURIComponent(issuer)}:${account}` : account;
  const query = [
    `secret=${encodeURIComponent(secret)}`,
    ...(issuer ? [`issuer=${encodeURIComponent(issuer)}`] : []),
    `algorithm=${options.algorithm ?? "SHA1"}`,
    `digits=${digits}`,
    `period=${period}`,
  ];
  return `otpauth://totp/${label}?${query.join("&")}`;
}

/**
 * Verify a TOTP code (RFC 6238 over RFC 4226 HOTP, HMAC-SHA-1) against a base32 secret,
 * accepting any step within ±`window` of the current one. Whitespace in the code is
 * stripped (`"123 456"`); anything else malformed — non-digits, the wrong length, a
 * secret that isn't base32 — is `{ ok: false }`, never a throw. Every candidate step is
 * computed and compared in constant time; the loop never exits early on a match.
 *
 * This does NOT stop replay: pass the returned `step` to the adapter's `claimTotpStep`.
 *
 * @param secret The user's base32 secret (padding, spaces and case are tolerated).
 * @param code The code the user typed.
 * @param options Window, clock and code parameters.
 * @returns `{ ok: true, step }` for the first (earliest) matching step, else `{ ok: false }`.
 * @throws {RangeError} When `window`, `digits`, `period` or `now` is out of range.
 */
export async function verifyTotp(
  secret: string,
  code: string,
  options: TotpVerifyOptions = {},
): Promise<TotpVerifyResult> {
  const { window, now, digits, period } = resolveVerifyOptions(options);
  const key = decodeSecret(secret);
  const presented = normaliseCode(code, digits);
  if (!key || presented === undefined) return { ok: false, error: "invalid_code" };
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const current = Math.floor(now / 1000 / period);
  let matched: number | undefined;
  for (let step = current - window; step <= current + window; step++) {
    if (step < 0) continue;
    const expected = encoder.encode(await hotp(hmacKey, step, digits));
    const equal = timingSafeEqual(expected, presented);
    if (equal && matched === undefined) matched = step;
  }
  return matched === undefined ? { ok: false, error: "invalid_code" } : { ok: true, step: matched };
}

const encoder = new TextEncoder();

/**
 * One HOTP value (RFC 4226 §5.3): HMAC over the 8-byte big-endian counter, dynamic
 * truncation to 31 bits, then the low `digits` decimal digits.
 *
 * @param key The imported HMAC-SHA-1 key.
 * @param counter The moving factor (the TOTP step).
 * @param digits Code length.
 * @returns The zero-padded code.
 */
async function hotp(key: CryptoKey, counter: number, digits: number): Promise<string> {
  const message = new DataView(new ArrayBuffer(8));
  message.setBigUint64(0, BigInt(counter));
  const mac = new DataView(await crypto.subtle.sign("HMAC", key, message.buffer));
  const offset = mac.getUint8(mac.byteLength - 1) & 0x0f;
  const binary = mac.getUint32(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * Decode a base32 secret, tolerating whitespace, trailing padding and lowercase.
 *
 * @param secret The stored secret.
 * @returns The key bytes, or `undefined` when it is empty or not valid base32.
 */
function decodeSecret(secret: string): Uint8Array<ArrayBuffer> | undefined {
  if (typeof secret !== "string") return undefined;
  const cleaned = secret.replace(/\s+/g, "").replace(/=+$/, "").toUpperCase();
  if (!cleaned || !VALID_BASE32_REMAINDERS.has(cleaned.length % 8)) return undefined;
  try {
    const bytes = decodeBase32(cleaned.padEnd(Math.ceil(cleaned.length / 8) * 8, "="));
    return bytes.length > 0 ? new Uint8Array(bytes) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalise a presented code: strip whitespace, then require exactly `digits` ASCII digits.
 *
 * @param code The raw input (possibly not a string at runtime).
 * @param digits The expected length.
 * @returns The code's bytes, or `undefined` when malformed.
 */
function normaliseCode(code: unknown, digits: number): Uint8Array | undefined {
  if (typeof code !== "string" || code.length > MAX_CODE_INPUT) return undefined;
  const stripped = code.replace(/\s+/g, "");
  if (stripped.length !== digits || !/^[0-9]+$/.test(stripped)) return undefined;
  return encoder.encode(stripped);
}

/**
 * Apply {@linkcode verifyTotp}'s defaults and range-check every option.
 *
 * @param options The caller's options.
 * @returns The resolved values.
 */
function resolveVerifyOptions(options: TotpVerifyOptions): Required<TotpVerifyOptions> {
  const window = options.window ?? DEFAULT_WINDOW;
  if (!Number.isInteger(window) || window < 0 || window > 10) {
    throw new RangeError(`verifyTotp: window must be an integer 0–10 (got ${window})`);
  }
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0) {
    throw new RangeError(`verifyTotp: now must be a non-negative epoch-ms number (got ${now})`);
  }
  return {
    window,
    now,
    digits: checkDigits(options.digits ?? DEFAULT_DIGITS),
    period: checkPeriod(options.period ?? DEFAULT_PERIOD),
  };
}

/**
 * Range-check a code length.
 *
 * @param digits The requested length.
 * @returns `digits`, when it is an integer 6–8.
 */
function checkDigits(digits: number): number {
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new RangeError(`TOTP digits must be an integer 6–8 (got ${digits})`);
  }
  return digits;
}

/**
 * Range-check a time-step length.
 *
 * @param period The requested period in seconds.
 * @returns `period`, when it is a positive integer.
 */
function checkPeriod(period: number): number {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`TOTP period must be a positive integer of seconds (got ${period})`);
  }
  return period;
}
