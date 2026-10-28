/**
 * `next-auth/providers/linkedin` on denext: LinkedIn ("Sign In with LinkedIn using OpenID Connect"). `profile()` receives the id_token claims; an address LinkedIn marks verified
 * (`email_verified`) can link to an existing user. Credentials default to `AUTH_LINKEDIN_ID` /
 * `AUTH_LINKEDIN_SECRET`.
 *
 * ```ts
 * import LinkedIn from "next-auth/providers/linkedin";
 * export const { handlers, auth } = NextAuth({ providers: [LinkedIn] });
 * ```
 *
 * @module
 */

import {
  oauthDescriptor,
  type OAuthUserConfig,
  type ProviderDescriptor,
  type ProviderSpec,
  specProvider,
} from "./shared.ts";

/** LinkedIn's OpenID Connect endpoints. */
const LINKEDIN: ProviderSpec = {
  id: "linkedin",
  type: "oidc",
  issuer: "https://www.linkedin.com/oauth",
  authorizationUrl: "https://www.linkedin.com/oauth/v2/authorization",
  tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
  jwksUrl: "https://www.linkedin.com/oauth/openid/jwks",
  discovery: true,
  scopes: ["openid", "profile", "email"],
};

/** The LinkedIn profile, as the app's `profile()` callback receives it. */
export type LinkedInProfile = Record<string, unknown>;

/**
 * The LinkedIn provider.
 *
 * @param options Client credentials (default from the environment), an `id` / `name`
 *   override, `authorization.params`, a `profile()` mapper.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function LinkedIn(
  options: OAuthUserConfig<LinkedInProfile> = {},
): ProviderDescriptor<OAuthUserConfig<LinkedInProfile>> {
  return oauthDescriptor(
    { id: "linkedin", name: "LinkedIn", type: "oidc" },
    options,
    (c) => specProvider(LINKEDIN, c),
  );
}
