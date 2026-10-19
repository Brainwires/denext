/**
 * `next-auth/providers/postmark` on denext: passwordless sign-in links sent through Postmark's
 * email API (`AUTH_POSTMARK_KEY`, a server token), on denext's `magicLink()` provider.
 *
 * ```ts
 * import Postmark from "next-auth/providers/postmark";
 * export const { handlers, auth } = NextAuth({
 *   adapter, // email sign-in stores its tokens through the adapter
 *   providers: [Postmark({ from: "auth@example.com" })],
 * });
 * ```
 *
 * @module
 */

import { httpEmailDescriptor, type HttpEmailUserConfig, jsonRequest } from "./email-http.ts";
import type { ProviderDescriptor } from "./shared.ts";

/**
 * The Postmark email provider.
 *
 * @param options The sender, the server token (default `AUTH_POSTMARK_KEY`), an `id` / `name`
 *   override, your own `sendVerificationRequest`.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Postmark(
  options: HttpEmailUserConfig = {},
): ProviderDescriptor<HttpEmailUserConfig> {
  return httpEmailDescriptor({
    id: "postmark",
    name: "Postmark",
    request: ({ to, from, apiKey, message }) =>
      jsonRequest("https://api.postmarkapp.com/email", {
        accept: "application/json",
        "x-postmark-server-token": apiKey,
      }, {
        From: from,
        To: to,
        Subject: message.subject,
        TextBody: message.text,
        HtmlBody: message.html,
        MessageStream: "outbound",
      }),
  }, options);
}
