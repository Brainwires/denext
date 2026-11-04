/**
 * `next-auth/providers/sendgrid` on denext: passwordless sign-in links sent through SendGrid's
 * Mail Send API (`AUTH_SENDGRID_KEY`), on denext's `magicLink()` provider.
 *
 * ```ts
 * import SendGrid from "next-auth/providers/sendgrid";
 * export const { handlers, auth } = NextAuth({
 *   adapter, // email sign-in stores its tokens through the adapter
 *   providers: [SendGrid({ from: "auth@example.com" })],
 * });
 * ```
 *
 * @module
 */

import { httpEmailDescriptor, type HttpEmailUserConfig, jsonRequest } from "./email-http.ts";
import type { ProviderDescriptor } from "./shared.ts";

/**
 * The SendGrid email provider.
 *
 * @param options The sender, the API key (default `AUTH_SENDGRID_KEY`), an `id` / `name`
 *   override, your own `sendVerificationRequest`.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function SendGrid(
  options: HttpEmailUserConfig = {},
): ProviderDescriptor<HttpEmailUserConfig> {
  return httpEmailDescriptor({
    id: "sendgrid",
    name: "SendGrid",
    request: ({ to, from, apiKey, message }) =>
      jsonRequest("https://api.sendgrid.com/v3/mail/send", {
        authorization: `Bearer ${apiKey}`,
      }, {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from },
        subject: message.subject,
        content: [
          { type: "text/plain", value: message.text },
          { type: "text/html", value: message.html },
        ],
      }),
  }, options);
}
