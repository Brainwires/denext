/**
 * The pending second factor of a native `id_token` sign-in (`POST {basePath}/native/apple` |
 * `/native/google`). A user with a verified factor is not handed tokens for the id_token
 * alone: the sign-in answers `{ mfa_required: true, mfa_token, expires_in, factors }`, and the
 * app finishes it at `POST {basePath}/native/mfa` with a code — the way the web sign-in's
 * pending session is finished at `/mfa`, and the way GoTrue's `grant_type=id_token` is followed
 * by the MFA verify calls (there, an `aal1` session; a native session has no lesser level, so
 * here a token that is not a session at all).
 *
 * The `mfa_token` (`nmf_…`) is a native grant of kind `"mfa"`, stored hashed:
 *
 * - **single-use** — every presentation consumes it (the adapter's atomic `useNativeGrant`);
 *   a wrong code or an SMS send hands back a fresh token in its place, carrying one attempt
 *   fewer and the original expiry, so the chain is bounded in time and in guesses;
 * - **short-lived** — five minutes from the id_token sign-in, never extended;
 * - **grants nothing** — it is not a bearer, never verifies as an access token, and redeems
 *   only through the second-factor check for the user it names.
 *
 * @module
 */

import { sha256Hex } from "./hash.ts";
import type { ResolvedNative } from "./native.ts";
import { randomToken } from "./oauth.ts";
import type { AuthUser } from "./types.ts";

/** Every pending-MFA token starts with this. */
const MFA_TOKEN_PREFIX = "nmf_";
/** How long the second factor may take, seconds — from the id_token sign-in, never extended. */
const NATIVE_MFA_TTL = 300;
/** Wrong codes one sign-in may present before it has to start over. */
const NATIVE_MFA_ATTEMPTS = 5;

/** What a pending native sign-in remembers between the id_token and the second factor. */
export interface NativeMfaPending {
  /** The user the first factor authenticated, as `callbacks.signIn` approved it. */
  user: AuthUser;
  /** The provider of the id_token (`apple`, `google`). */
  provider: string;
  /** Whether the id_token sign-in created the user (for the `signIn` event). */
  isNewUser: boolean;
  /** When the first factor was proven, epoch seconds. */
  authTime: number;
  /** Wrong codes still allowed. */
  attemptsLeft: number;
  /** When the pending sign-in ends, epoch seconds. */
  expiresAt: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Store a pending sign-in and mint the token that names it.
 *
 * @param native The resolved native settings.
 * @param pending What the sign-in carries forward.
 * @returns The `mfa_token` (never stored in the clear).
 */
export async function issueNativeMfaToken(
  native: ResolvedNative,
  pending: NativeMfaPending,
): Promise<string> {
  const token = MFA_TOKEN_PREFIX + randomToken(32);
  await native.adapter.createNativeGrant({
    hash: await sha256Hex(token),
    kind: "mfa",
    expiresAt: pending.expiresAt,
    data: JSON.stringify(pending),
  });
  return token;
}

/** Whether a parsed value has every field a pending sign-in needs, of the right type. */
function isPending(value: Partial<NativeMfaPending> | null): value is NativeMfaPending {
  if (typeof value?.user?.id !== "string" || typeof value.provider !== "string") return false;
  const attempts = value.attemptsLeft;
  return Number.isInteger(attempts) && attempts! > 0 && Number.isFinite(value.expiresAt) &&
    Number.isFinite(value.authTime);
}

/** A stored pending sign-in, or `null` for anything malformed (fail closed). */
function parsePending(raw: string | undefined): NativeMfaPending | null {
  try {
    const value = JSON.parse(raw ?? "") as Partial<NativeMfaPending> | null;
    return isPending(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Spend an `mfa_token`: it is consumed whatever happens next, and its pending sign-in returned
 * when it was live.
 *
 * @param native The resolved native settings.
 * @param token The presented token.
 * @returns The pending sign-in, or `null` (unknown, spent, expired or malformed).
 */
export async function consumeNativeMfaToken(
  native: ResolvedNative,
  token: string,
): Promise<NativeMfaPending | null> {
  if (!token.startsWith(MFA_TOKEN_PREFIX) || token.length > 128) return null;
  const record = await native.adapter.useNativeGrant(await sha256Hex(token), "mfa");
  if (!record || record.kind !== "mfa" || record.expiresAt <= nowSeconds()) return null;
  const pending = parsePending(record.data);
  return pending && pending.expiresAt > nowSeconds() ? pending : null;
}

/**
 * A new pending sign-in for one that just completed its first factor.
 *
 * @param user The approved user.
 * @param provider The id_token's provider.
 * @param isNewUser Whether the sign-in created the user.
 * @returns The pending state to issue a token for.
 */
export function newNativeMfaPending(
  user: AuthUser,
  provider: string,
  isNewUser: boolean,
): NativeMfaPending {
  const now = nowSeconds();
  return {
    user,
    provider,
    isNewUser,
    authTime: now,
    attemptsLeft: NATIVE_MFA_ATTEMPTS,
    expiresAt: now + NATIVE_MFA_TTL,
  };
}

/**
 * The seconds a pending sign-in has left (what `expires_in` reports).
 *
 * @param pending The pending sign-in.
 * @returns Seconds until it ends (at least 0).
 */
export function nativeMfaExpiresIn(pending: NativeMfaPending): number {
  return Math.max(0, pending.expiresAt - nowSeconds());
}

/** A factor the app can answer natively: a verified TOTP or phone factor. */
export interface NativeMfaFactor {
  /** The factor id (`factor_id` for an SMS challenge). */
  id: string;
  /** `"totp"` or `"phone"`. */
  type: "totp" | "phone";
  /** Its label, when it has one. */
  friendly_name?: string;
}

/**
 * The factors a pending native sign-in may be finished with — the verified TOTP and phone
 * factors (a backup code always works too). Neither secrets nor numbers are listed.
 *
 * @param factors The user's factors.
 * @returns The answerable ones.
 */
export function nativeMfaFactors(
  factors: ReadonlyArray<{ id: string; type: string; status: string; friendlyName?: string }>,
): NativeMfaFactor[] {
  return factors.filter((f) => f.status === "verified" && (f.type === "totp" || f.type === "phone"))
    .map((f) => ({
      id: f.id,
      type: f.type as "totp" | "phone",
      ...(f.friendlyName ? { friendly_name: f.friendlyName } : {}),
    }));
}
