/**
 * Bans: one rule for every credential a user can present. A ban (`bannedUntil`, written by the
 * `/auth/v1` admin API's `ban_duration`) refuses a sign-in AND every token checked while it lasts —
 * a bearer API token, a native access or refresh token, a Supabase access or refresh token —
 * so a credential issued before the ban stops working even where revoking it was missed.
 *
 * @module
 */

import type { AdapterUser } from "./adapter.ts";
import type { AuthConfig } from "./types.ts";

/**
 * Whether a stored user is banned right now.
 *
 * @param user The stored user (or nothing).
 * @param nowSeconds The clock, epoch seconds.
 * @returns `true` while the ban lasts.
 */
export function isBanned(
  user: AdapterUser | null | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const until = user?.bannedUntil;
  return typeof until === "number" && until > nowSeconds;
}

/**
 * How a read answers a credential (a session, a token) for its user: usable, refused for now (a
 * ban that ends before the credential does), or refused for good — which the read may also
 * delete, since no later read could accept it.
 */
export type CredentialVerdict = "ok" | "refused" | "dead";

/**
 * The verdict on a banned user's credential that expires at `expiresAt` (epoch seconds): dead
 * when the ban lasts at least as long (it can never be used again), refused otherwise (it works
 * once the ban ends). A credential with no expiry outlives every ban.
 *
 * @param user The stored, banned user.
 * @param expiresAt When the credential expires, if it does.
 * @returns `"dead"` or `"refused"`.
 */
export function banVerdict(user: AdapterUser, expiresAt: number | undefined): "refused" | "dead" {
  const until = user.bannedUntil;
  return typeof expiresAt === "number" && typeof until === "number" && expiresAt <= until
    ? "dead"
    : "refused";
}

/**
 * Whether the user `userId` is banned, read from the config's adapter (never banned without one).
 *
 * @param config The auth config.
 * @param userId The user.
 * @returns `true` while the ban lasts.
 */
export async function isBannedUser(config: AuthConfig, userId: string): Promise<boolean> {
  return config.adapter ? isBanned(await config.adapter.getUser(userId)) : false;
}
