/**
 * The passwordless **phone provider** — `phoneOtp()`, a one-time code texted to an E.164 number
 * — plus {@linkcode assertPhoneProviderConfig}, the config-time check that an app configuring
 * it can actually run it.
 *
 * It is plain data: the flow lives in {@link ./routes-phone.ts | routes-phone.ts}, on
 * `{basePath}/callback/:provider`. It needs an SMS sender (`sendSms` or `hooks.sendSms` —
 * denext ships no SMS gateway) and an adapter with the verification-token group plus
 * `getUserByPhone`, `createUser` and `updateUser`.
 *
 * ```ts
 * denextAuth({
 *   providers: [phoneOtp()],
 *   adapter: sqliteAuthAdapter({ path: "auth.db" }),
 *   sendSms: ({ phone, message }) => sms.send(phone, message),
 *   secret,
 * });
 * ```
 *
 * @module
 */

import { assertProviderAdapter } from "./providers-email.ts";
import { smsSenderOf } from "./sms.ts";
import { type AuthConfig, isPhoneProvider, type PhoneProvider } from "./types.ts";

/** Options for {@linkcode phoneOtp}. */
export interface PhoneProviderOptions {
  /** Provider id — the `[provider]` route segment. Default `"phone"`. */
  id?: string;
  /** Display name for a sign-in button. Default `"Phone code"`. */
  name?: string;
  /**
   * Let a number with no account sign up by proving it (the user is created, already
   * phone-verified, when the code is redeemed). Default `true`. With `false` an unknown number
   * is sent nothing — and answered exactly like a known one.
   */
  allowSignUp?: boolean;
}

/** The adapter methods a phone sign-in can't run without. */
const REQUIRED_ADAPTER_METHODS = [
  "createVerificationToken",
  "useVerificationToken",
  "getUserByPhone",
  "createUser",
  "updateUser",
] as const;

/**
 * Passwordless sign-in by **SMS one-time code**: `POST {basePath}/callback/phone` with
 * `{ phone }` texts a numeric code (`email.otpDigits`, default 6; valid 5 minutes by default,
 * `email.otpMaxAge`) through `sendSms` / `hooks.sendSms`; posting `{ phone, code }` to the same
 * endpoint signs the user in (`amr: ["sms"]`). Wrong codes count against a failure budget (5
 * per 5 minutes per number). There is no GET: a code never rides a URL.
 *
 * @param options The provider id, display name and sign-up policy.
 * @returns The configured provider (`id: "phone"`, `type: "phone"`).
 */
export function phoneOtp(options: PhoneProviderOptions = {}): PhoneProvider {
  return {
    id: options.id ?? "phone",
    name: options.name ?? "Phone code",
    type: "phone",
    allowSignUp: options.allowSignUp ?? true,
  };
}

/**
 * Refuse, at config time, a phone provider the app can't run: one is configured but there is
 * no SMS sender (`sendSms` or `hooks.sendSms`), or the adapter lacks a method the flow needs
 * (`createVerificationToken`, `useVerificationToken`, `getUserByPhone`, `createUser`,
 * `updateUser`). A config without a phone provider is never affected.
 *
 * @param config The app's auth config.
 * @throws {Error} Naming the provider and exactly what is missing.
 */
export function assertPhoneProviderConfig(config: AuthConfig): void {
  const provider = config.providers?.find(isPhoneProvider);
  if (!provider) return;
  if (!smsSenderOf(config)) {
    throw new Error(
      `denextAuth: the phone provider "${provider.id}" needs \`sendSms\` (or ` +
        "`hooks.sendSms`) — denext ships no SMS gateway; pass a function that delivers " +
        "{ phone, otp, message, channel, type }.",
    );
  }
  assertProviderAdapter(config, `the phone provider "${provider.id}"`, REQUIRED_ADAPTER_METHODS);
}
