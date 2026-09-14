/**
 * The passwordless **email providers** — `magicLink()` (a single-use sign-in link) and
 * `emailOtp()` (a one-time numeric code) — plus {@linkcode assertEmailProviderConfig}, the
 * config-time check that an app configuring one can actually run it.
 *
 * Both are plain data: the flow lives in {@link ./routes-email.ts | routes-email.ts}, on
 * `{basePath}/callback/:provider`. Either one needs `sendVerificationRequest` (denext ships
 * no mailer) and an adapter with the verification-token group plus `getUserByEmail`,
 * `createUser` and `updateUser`.
 *
 * ```ts
 * denextAuth({
 *   providers: [magicLink(), emailOtp({ allowSignUp: false })],
 *   adapter: sqliteAuthAdapter({ path: "auth.db" }),
 *   sendVerificationRequest: ({ identifier, url, token, purpose }) => mailer.send(…),
 *   secret,
 * });
 * ```
 *
 * @module
 */

import { type AuthConfig, type EmailProvider, isEmailProvider } from "./types.ts";

/** Options for {@linkcode magicLink} and {@linkcode emailOtp}. */
export interface EmailProviderOptions {
  /** Provider id — the `[provider]` route segment. Default `"email"` / `"email-otp"`. */
  id?: string;
  /** Display name for a sign-in button. Default `"Email"` / `"Email code"`. */
  name?: string;
  /**
   * Let an address with no account sign up by proving its mailbox (the user is created,
   * already verified, when the link or code is redeemed). Default `true`. With `false` an
   * unknown address is sent nothing — and answered exactly like a known one.
   */
  allowSignUp?: boolean;
}

/** The adapter methods an email sign-in can't run without. */
const REQUIRED_ADAPTER_METHODS = [
  "createVerificationToken",
  "useVerificationToken",
  "getUserByEmail",
  "createUser",
  "updateUser",
] as const;

/** Build one email provider from its mode, the caller's options and the mode's defaults. */
function emailProvider(
  mode: EmailProvider["mode"],
  options: EmailProviderOptions,
  defaults: { id: string; name: string },
): EmailProvider {
  return {
    id: options.id ?? defaults.id,
    name: options.name ?? defaults.name,
    type: "email",
    mode,
    allowSignUp: options.allowSignUp ?? true,
  };
}

/**
 * Passwordless sign-in by **magic link**: `POST {basePath}/callback/email` with `{ email }`
 * mails a single-use link (10 minutes by default, `email.magicMaxAge`); opening it signs
 * the user in. The link is consumed by its GET, so a mail gateway that pre-fetches links
 * can spend it — prefer {@linkcode emailOtp} where link scanners are common.
 *
 * @param options The provider id, display name and sign-up policy.
 * @returns The configured provider (`id: "email"`, `mode: "magic"`).
 */
export function magicLink(options: EmailProviderOptions = {}): EmailProvider {
  return emailProvider("magic", options, { id: "email", name: "Email" });
}

/**
 * Passwordless sign-in by **one-time code**: `POST {basePath}/callback/email-otp` with
 * `{ email }` mails a numeric code (`email.otpDigits`, default 6; valid 5 minutes by
 * default, `email.otpMaxAge`); posting `{ email, code }` to the same endpoint signs the
 * user in. Wrong codes count against a failure budget (5 per 5 minutes per address).
 *
 * @param options The provider id, display name and sign-up policy.
 * @returns The configured provider (`id: "email-otp"`, `mode: "otp"`).
 */
export function emailOtp(options: EmailProviderOptions = {}): EmailProvider {
  return emailProvider("otp", options, { id: "email-otp", name: "Email code" });
}

/**
 * Refuse, at config time, an email provider the app can't run: one is configured but
 * there is no `sendVerificationRequest`, or the adapter lacks a method the flow needs
 * (`createVerificationToken`, `useVerificationToken`, `getUserByEmail`, `createUser`,
 * `updateUser`). A config without an email provider is never affected.
 *
 * @param config The app's auth config.
 * @throws {Error} Naming the provider and exactly what is missing.
 */
export function assertEmailProviderConfig(config: AuthConfig): void {
  const provider = config.providers?.find(isEmailProvider);
  if (!provider) return;
  if (typeof config.sendVerificationRequest !== "function") {
    throw new Error(
      `denextAuth: the email provider "${provider.id}" needs \`sendVerificationRequest\` — ` +
        "denext ships no mailer; pass a function that delivers " +
        "{ identifier, url, token, purpose, expiresAt }.",
    );
  }
  const adapter = config.adapter;
  const missing = REQUIRED_ADAPTER_METHODS.filter((m) => typeof adapter?.[m] !== "function");
  if (missing.length === 0) return;
  throw new Error(
    `denextAuth: the email provider "${provider.id}" needs an \`adapter\` implementing ` +
      `${missing.join(" / ")}${adapter ? "" : " (none is configured)"} — pass e.g. ` +
      "`adapter: sqliteAuthAdapter({ path })`, or `inMemoryAuthAdapter()` in tests.",
  );
}
