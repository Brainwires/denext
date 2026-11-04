/**
 * `next-auth/providers/apple` on denext: Apple (Sign in with Apple, `form_post`), built on denext's `apple()` preset (its
 * endpoints, scopes and email-verification rules). Credentials default to `AUTH_APPLE_ID` /
 * `AUTH_APPLE_SECRET`, as in Auth.js.
 *
 * ```ts
 * import Apple from "next-auth/providers/apple";
 * export const { handlers, auth } = NextAuth({ providers: [Apple] });
 * ```
 *
 * @module
 */

import { apple } from "../../src/providers.ts";
import { oauthDescriptor, type OAuthUserConfig, type ProviderDescriptor } from "./shared.ts";

/** The Apple profile, as the app's `profile()` callback receives it. */
export type AppleProfile = Record<string, unknown>;

/**
 * The Apple provider.
 *
 * @param options Client credentials (default from the environment), an `id` / `name`
 *   override, `authorization.params`, a `profile()` mapper.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Apple(
  options: OAuthUserConfig<AppleProfile> = {},
): ProviderDescriptor<OAuthUserConfig<AppleProfile>> {
  return oauthDescriptor({ id: "apple", name: "Apple", type: "oidc" }, options, (c) => apple(c));
}
