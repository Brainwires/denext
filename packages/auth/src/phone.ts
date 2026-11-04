/**
 * Phone numbers for denext auth: the one E.164 normaliser `phoneOtp()` sign-in, phone MFA and
 * `/auth/v1` share, so a number is spelled the same way wherever it is stored or looked up.
 *
 * @module
 */

/** E.164 after normalising: `+`, a non-zero digit, then 7–14 more digits (8–15 in all). */
const E164_RE = /^\+[1-9][0-9]{7,14}$/;

/**
 * Normalise a submitted phone number to E.164: spaces, dashes, dots and parentheses are
 * dropped, a missing `+` is added, and what remains must be `+` and 8–15 digits. Exactly one
 * number or nothing — a list, letters or an extension is refused.
 *
 * @param input The submitted value (anything — a non-string is refused).
 * @returns The number as `+15551234567`, or `null` when it isn't one valid number.
 */
export function normalizePhoneNumber(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const digits = input.trim().replace(/[\s().-]/g, "");
  const e164 = digits.startsWith("+") ? digits : `+${digits}`;
  return E164_RE.test(e164) ? e164 : null;
}
