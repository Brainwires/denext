/**
 * `next-auth/providers/auth0` on denext: Auth0 (OpenID Connect). Built on denext's `auth0()` preset. The tenant is `issuer` (`https://<tenant>.auth0.com`, or a
 * custom domain; default `AUTH_AUTH0_ISSUER`). Credentials default to `AUTH_AUTH0_ID` /
 * `AUTH_AUTH0_SECRET`.
 *
 * ```ts
 * import Auth0 from "next-auth/providers/auth0";
 * export const { handlers, auth } = NextAuth({ providers: [Auth0] });
 * ```
 *
 * @module
 */

import { auth0 } from "../../../server/auth/providers.ts";
import {
  issuerUrl,
  oauthDescriptor,
  type OAuthUserConfig,
  type ProviderDescriptor,
} from "./shared.ts";

/** The Auth0 profile, as the app's `profile()` callback receives it. */
export type Auth0Profile = Record<string, unknown>;

/**
 * The Auth0 provider.
 *
 * @param options Client credentials (default from the environment), the tenant
 *   `issuer`, an `id` / `name` override, `authorization.params`, a `profile()` mapper.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Auth0(
  options: OAuthUserConfig<Auth0Profile> = {},
): ProviderDescriptor<OAuthUserConfig<Auth0Profile>> {
  return oauthDescriptor(
    { id: "auth0", name: "Auth0", type: "oidc" },
    options,
    (c, issuer) => auth0({ ...c, domain: issuerUrl(options.id ?? "auth0", issuer).host }),
  );
}
