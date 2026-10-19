/**
 * `next-auth/providers/forwardemail` on denext: passwordless sign-in links sent through Forward
 * Email's API (`AUTH_FORWARDEMAIL_KEY`), on denext's `magicLink()` provider.
 *
 * ```ts
 * import ForwardEmail from "next-auth/providers/forwardemail";
 * export const { handlers, auth } = NextAuth({
 *   adapter, // email sign-in stores its tokens through the adapter
 *   providers: [ForwardEmail({ from: "auth@example.com" })],
 * });
 * ```
 *
 * @module
 */

import { httpEmailDescriptor, type HttpEmailUserConfig, jsonRequest } from "./email-http.ts";
import type { ProviderDescriptor } from "./shared.ts";

/**
 * The Forward Email provider.
 *
 * @param options The sender, the API key (default `AUTH_FORWARDEMAIL_KEY`), an `id` / `name`
 *   override, your own `sendVerificationRequest`.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function ForwardEmail(
  options: HttpEmailUserConfig = {},
): ProviderDescriptor<HttpEmailUserConfig> {
  return httpEmailDescriptor({
    id: "forwardemail",
    name: "Forward Email",
    request: ({ to, from, apiKey, message }) =>
      jsonRequest("https://api.forwardemail.net/v1/emails", {
        authorization: `Basic ${btoa(`${apiKey}:`)}`,
      }, { from, to, subject: message.subject, html: message.html, text: message.text }),
  }, options);
}
