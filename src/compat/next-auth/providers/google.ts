/**
 * `next-auth/providers/google` on denext: Google (OpenID Connect), built on denext's `google()` preset (its
 * endpoints, scopes and email-verification rules). Credentials default to `AUTH_GOOGLE_ID` /
 * `AUTH_GOOGLE_SECRET`, as in Auth.js.
 *
 * ```ts
 * import Google from "next-auth/providers/google";
 * export const { handlers, auth } = NextAuth({ providers: [Google] });
 * ```
 *
 * @module
 */

import { google } from "../../../server/auth/providers.ts";
import { oauthDescriptor, type OAuthUserConfig, type ProviderDescriptor } from "./shared.ts";

/** The Google profile, as the app's `profile()` callback receives it. */
export type GoogleProfile = Record<string, unknown>;

/**
 * The Google provider.
 *
 * @param options Client credentials (default from the environment), an `id` / `name`
 *   override, `authorization.params`, a `profile()` mapper.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Google(
  options: OAuthUserConfig<GoogleProfile> = {},
): ProviderDescriptor<OAuthUserConfig<GoogleProfile>> {
  return oauthDescriptor({ id: "google", name: "Google", type: "oidc" }, options, (c) => google(c));
}
