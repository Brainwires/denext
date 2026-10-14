/**
 * SMS delivery for denext auth: the `hooks.sendSms` hook when configured, else `sendSms` — one
 * sender for phone sign-in codes, phone MFA codes and phone changes, on denext's own endpoints
 * and `/auth/v1` alike.
 *
 * @module
 */

import { after, currentContext } from "../request-context.ts";
import { emitAuthEvent } from "./events.ts";
import type { GoTrueSmsMessage } from "./gotrue/options.ts";
import type { ResolvedAuthOptions } from "./options.ts";
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

/**
 * Hand one sign-in code to the SMS sender. Inside a request it runs after the response
 * (`after()`), so how long the gateway takes can't reveal that a number has an account; outside
 * one it is awaited. A delivery failure is logged — without the code or the text — and never
 * thrown; a delivered code fires `verificationRequested` (`purpose: "sms"`).
 *
 * @param options The resolved auth options (logger, events).
 * @param send The sender, from {@linkcode smsSenderOf}.
 * @param message The message.
 * @param expiresAt When the code expires, epoch seconds.
 */
export function deliverSmsCode(
  options: ResolvedAuthOptions,
  send: (message: GoTrueSmsMessage) => Promise<void> | void,
  message: GoTrueSmsMessage,
  expiresAt: number,
): Promise<void> {
  const job = async (): Promise<void> => {
    try {
      await send(message);
    } catch (error) {
      options.logger.error(`denextAuth: sending a "${message.type}" SMS failed`, error);
      return;
    }
    await emitAuthEvent(options, "verificationRequested", {
      identifier: message.phone,
      purpose: "sms",
      expiresAt,
    });
  };
  if (!currentContext()) return job();
  after(job);
  return Promise.resolve();
}
