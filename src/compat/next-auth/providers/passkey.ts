/**
 * `next-auth/providers/passkey` on denext: passkeys (WebAuthn, discoverable credentials with user
 * verification required), on denext's own passkeys (`denextAuth({ passkeys })`). Listing it turns
 * them on under the auth base path; `signIn("passkey")` from `next-auth/webauthn` signs in with
 * one and `signIn("passkey", { action: "register" })` adds one for the signed-in user. With an
 * Auth.js adapter, the credentials are its `Authenticator` rows (and a `webauthn` account each).
 *
 * ```ts
 * import Passkey from "next-auth/providers/passkey";
 * export const { handlers, auth } = NextAuth({
 *   adapter,
 *   providers: [Passkey],
 *   experimental: { enableWebAuthn: true },
 * });
 * ```
 *
 * @module
 */

import { webAuthnDescriptor, type WebAuthnUserConfig } from "./webauthn-shared.ts";
import type { ProviderDescriptor } from "./shared.ts";

export type { WebAuthnCeremonyOptions, WebAuthnUserConfig } from "./webauthn-shared.ts";

/**
 * The Passkey provider.
 *
 * @param options An `id` / `name` override, the `relayingParty` (`id`, `name`, `origin`), the
 *   ceremony `timeout`s.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Passkey(
  options: WebAuthnUserConfig = {},
): ProviderDescriptor<WebAuthnUserConfig> {
  return webAuthnDescriptor(
    { id: "passkey", name: "Passkey", userVerification: "required" },
    options,
  );
}
