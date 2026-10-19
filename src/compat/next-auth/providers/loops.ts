/**
 * `next-auth/providers/loops` on denext: passwordless sign-in links sent as a Loops transactional
 * email (`AUTH_LOOPS_KEY`, and the template's `transactionalId`, which gets the link as its `url`
 * data variable), on denext's `magicLink()` provider.
 *
 * ```ts
 * import Loops from "next-auth/providers/loops";
 * export const { handlers, auth } = NextAuth({
 *   adapter, // email sign-in stores its tokens through the adapter
 *   providers: [Loops({ transactionalId: "clx…" })],
 * });
 * ```
 *
 * @module
 */

import { httpEmailDescriptor, type HttpEmailUserConfig, jsonRequest } from "./email-http.ts";
import type { ProviderDescriptor } from "./shared.ts";

/** The options of the Loops provider. */
export interface LoopsUserConfig extends HttpEmailUserConfig {
  /** The transactional email's id (its template receives the link as `url`). */
  transactionalId?: string;
}

/**
 * The Loops email provider.
 *
 * @param options The transactional email's id, the API key (default `AUTH_LOOPS_KEY`), an
 *   `id` / `name` override, your own `sendVerificationRequest`.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Loops(options: LoopsUserConfig = {}): ProviderDescriptor<LoopsUserConfig> {
  return httpEmailDescriptor<LoopsUserConfig>({
    id: "loops",
    name: "Loops",
    request: ({ to, apiKey, url }, own) => {
      if (!own.transactionalId) throw new TypeError("next-auth loops: no transactionalId");
      return jsonRequest("https://app.loops.so/api/v1/transactional", {
        authorization: `Bearer ${apiKey}`,
      }, { transactionalId: own.transactionalId, email: to, dataVariables: { url } });
    },
  }, options);
}
