/**
 * `next-auth/providers/mailgun` on denext: passwordless sign-in links sent through Mailgun's
 * messages API (`AUTH_MAILGUN_KEY`; the sending domain is the `from` address's, the API host
 * `region`'s), on denext's `magicLink()` provider.
 *
 * ```ts
 * import Mailgun from "next-auth/providers/mailgun";
 * export const { handlers, auth } = NextAuth({
 *   adapter, // email sign-in stores its tokens through the adapter
 *   providers: [Mailgun({ from: "auth@mg.example.com", region: "EU" })],
 * });
 * ```
 *
 * @module
 */

import { httpEmailDescriptor, type HttpEmailUserConfig } from "./email-http.ts";
import type { ProviderDescriptor } from "./shared.ts";

/** The options of the Mailgun provider. */
export interface MailgunUserConfig extends HttpEmailUserConfig {
  /** The account's region: `"US"` (default, `api.mailgun.net`) or `"EU"` (`api.eu.mailgun.net`). */
  region?: "US" | "EU";
}

/** The API host of each region. */
const SERVERS = { US: "api.mailgun.net", EU: "api.eu.mailgun.net" } as const;

/**
 * The Mailgun email provider.
 *
 * @param options The sender (its domain is the sending domain), the region, the API key (default
 *   `AUTH_MAILGUN_KEY`), an `id` / `name` override, your own `sendVerificationRequest`.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Mailgun(
  options: MailgunUserConfig = {},
): ProviderDescriptor<MailgunUserConfig> {
  return httpEmailDescriptor<MailgunUserConfig>({
    id: "mailgun",
    name: "Mailgun",
    request: ({ to, from, name, apiKey, message }, own) => {
      const domain = from.split("@").at(1)?.replace(/>$/, "");
      if (!domain) throw new Error("next-auth mailgun: malformed Mailgun domain");
      const form = new FormData();
      form.append("from", `${name} <${from}>`);
      form.append("to", to);
      form.append("subject", message.subject);
      form.append("html", message.html);
      form.append("text", message.text);
      const host = SERVERS[own.region ?? "US"];
      return {
        url: `https://${host}/v3/${domain}/messages`,
        init: { headers: { authorization: `Basic ${btoa(`api:${apiKey}`)}` }, body: form },
      };
    },
  }, options);
}
