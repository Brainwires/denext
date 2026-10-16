/**
 * `next-auth/providers/facebook` on denext: Facebook (OAuth 2.0, the Graph API). Built on denext's `facebook()` preset. Graph never says whether an address is verified, so a
 * Facebook account is never linked to an existing user by email unless the provider sets
 * `allowDangerousEmailAccountLinking`. Credentials default to `AUTH_FACEBOOK_ID` /
 * `AUTH_FACEBOOK_SECRET`.
 *
 * ```ts
 * import Facebook from "next-auth/providers/facebook";
 * export const { handlers, auth } = NextAuth({ providers: [Facebook] });
 * ```
 *
 * @module
 */

import { facebook } from "../../../server/auth/providers.ts";
import { oauthDescriptor, type OAuthUserConfig, type ProviderDescriptor } from "./shared.ts";

/** The Facebook profile, as the app's `profile()` callback receives it. */
export type FacebookProfile = Record<string, unknown>;

/**
 * The Facebook provider.
 *
 * @param options Client credentials (default from the environment), an `id` / `name`
 *   override, `authorization.params`, a `profile()` mapper.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Facebook(
  options: OAuthUserConfig<FacebookProfile> = {},
): ProviderDescriptor<OAuthUserConfig<FacebookProfile>> {
  return oauthDescriptor(
    { id: "facebook", name: "Facebook", type: "oauth" },
    options,
    (c) => facebook(c),
  );
}
