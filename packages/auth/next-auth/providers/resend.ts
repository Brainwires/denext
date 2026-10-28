/**
 * `next-auth/providers/resend` on denext: passwordless sign-in links sent through Resend's
 * HTTP API (`AUTH_RESEND_KEY`), on denext's `magicLink()` provider.
 *
 * ```ts
 * import Resend from "next-auth/providers/resend";
 * export const { handlers, auth } = NextAuth({
 *   adapter, // email sign-in stores its tokens through the adapter
 *   providers: [Resend({ from: "auth@example.com" })],
 * });
 * ```
 *
 * @module
 */

import {
  emailDescriptor,
  type EmailUserConfig,
  type SendVerificationRequestParams,
  signInMessage,
} from "./email-shared.ts";
import type { EnvReader, ProviderDescriptor } from "./shared.ts";

/** The options of the Resend provider. */
export interface ResendUserConfig extends EmailUserConfig {
  /** The Resend API key (default `AUTH_RESEND_KEY`). */
  apiKey?: string;
}

/** Send one sign-in mail through Resend. */
function resendSender(
  options: ResendUserConfig,
  env: EnvReader,
): (params: SendVerificationRequestParams) => Promise<void> {
  return async (params) => {
    const apiKey = options.apiKey ?? env("AUTH_RESEND_KEY");
    if (!apiKey) throw new Error("next-auth resend: no apiKey (set AUTH_RESEND_KEY)");
    const message = signInMessage(params.url);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: options.from ?? "Auth.js <no-reply@authjs.dev>",
        to: params.identifier,
        ...message,
      }),
    });
    if (!res.ok) throw new Error(`next-auth resend: Resend answered ${res.status}`);
    await res.body?.cancel();
  };
}

/**
 * The Resend email provider.
 *
 * @param options The sender, the API key (default `AUTH_RESEND_KEY`), an `id` / `name`
 *   override, your own `sendVerificationRequest`.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Resend(
  options: ResendUserConfig = {},
): ProviderDescriptor<ResendUserConfig> {
  return emailDescriptor(
    { id: "resend", name: "Resend" },
    options,
    (env) => resendSender(options, env),
  );
}
