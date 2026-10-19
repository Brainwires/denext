/**
 * `next-auth/providers/webauthn` on denext: Auth.js's general WebAuthn provider (user verification
 * preferred), on denext's own passkeys (`denextAuth({ passkeys })`) as
 * `next-auth/providers/passkey` is. `signIn("webauthn")` from `next-auth/webauthn` signs in;
 * `signIn("webauthn", { action: "register" })` registers a credential for the signed-in user.
 *
 * ```ts
 * import WebAuthn from "next-auth/providers/webauthn";
 * export const { handlers, auth } = NextAuth({ adapter, providers: [WebAuthn] });
 * ```
 *
 * @module
 */

import { webAuthnDescriptor, type WebAuthnUserConfig } from "./webauthn-shared.ts";
import type { ProviderDescriptor } from "./shared.ts";

export type { WebAuthnCeremonyOptions, WebAuthnUserConfig } from "./webauthn-shared.ts";

/** Auth.js's default ceremony timeout: five minutes, in milliseconds. */
export const DEFAULT_WEBAUTHN_TIMEOUT: number = 5 * 60 * 1000;

/**
 * The `@simplewebauthn/browser` version Auth.js's built-in page loads. Exported for
 * compatibility: denext's passkey client is its own.
 */
export const DEFAULT_SIMPLEWEBAUTHN_BROWSER_VERSION = "v9.0.1";

/**
 * The WebAuthn provider.
 *
 * @param options An `id` / `name` override, the `relayingParty` (`id`, `name`, `origin`), the
 *   ceremony `timeout`s and `userVerification`.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function WebAuthn(
  options: WebAuthnUserConfig = {},
): ProviderDescriptor<WebAuthnUserConfig> {
  return webAuthnDescriptor(
    { id: "webauthn", name: "WebAuthn", userVerification: "preferred" },
    options,
  );
}
