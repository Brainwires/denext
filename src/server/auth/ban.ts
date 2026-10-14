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
 * Whether the user `userId` is banned, read from the config's adapter (never banned without one).
 *
 * @param config The auth config.
 * @param userId The user.
 * @returns `true` while the ban lasts.
 */
export async function isBannedUser(config: AuthConfig, userId: string): Promise<boolean> {
  return config.adapter ? isBanned(await config.adapter.getUser(userId)) : false;
}
