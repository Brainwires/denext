/**
 * SMS delivery for denext auth: the `hooks.sendSms` hook when configured, else `sendSms` — one
 * sender for phone sign-in codes, phone MFA codes and phone changes, on denext's own endpoints
 * and `/auth/v1` alike.
 *
 * @module
 */

import type { GoTrueSmsMessage } from "./gotrue/options.ts";
import type { AuthConfig } from "./types.ts";

/**
 * The configured SMS sender, or `null` when SMS is not configured.
 *
 * @param config The auth config.
 * @returns The sender.
 */
export function smsSenderOf(
  config: AuthConfig,
): ((message: GoTrueSmsMessage) => Promise<void> | void) | null {
  return config.hooks?.sendSms ?? config.sendSms ?? null;
}
