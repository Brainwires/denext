/**
 * `next-auth/providers/cognito` on denext: Amazon Cognito user pools (OpenID Connect). `issuer` (default `AUTH_COGNITO_ISSUER`) is the user pool, `https://cognito-
 * idp.<region>.amazonaws.com/<pool id>`; its endpoints come from OIDC discovery and may live on
 * the pool's `*.auth.<region>.amazoncognito.com` domain. A custom domain is listed in
 * `allowedHosts`. Credentials default to `AUTH_COGNITO_ID` / `AUTH_COGNITO_SECRET`.
 *
 * ```ts
 * import Cognito from "next-auth/providers/cognito";
 * export const { handlers, auth } = NextAuth({ providers: [Cognito] });
 * ```
 *
 * @module
 */

import { oidc } from "../../../server/auth/providers.ts";
import type { OAuthProvider } from "../../../server/auth/types.ts";
import {
  issuerUrl,
  oauthDescriptor,
  type OAuthUserConfig,
  type ProviderDescriptor,
} from "./shared.ts";

/** A user pool issuer as a provider, its hosted-UI domain allowed. */
function cognitoProvider(
  credentials: { clientId: string; clientSecret: string; scopes?: string[] },
  id: string,
  issuer: string,
): OAuthProvider {
  const url = issuerUrl(id, issuer);
  const region = /^cognito-idp\.([a-z0-9-]+)\.amazonaws\.com$/.exec(url.host)?.[1];
  const provider = oidc({ ...credentials, id: "cognito", issuer: url.href.replace(/\/+$/, "") });
  if (region) provider.allowedHosts = [`*.auth.${region}.amazoncognito.com`];
  return provider;
}

/** The Cognito profile, as the app's `profile()` callback receives it. */
export type CognitoProfile = Record<string, unknown>;

/**
 * The Cognito provider.
 *
 * @param options Client credentials (default from the environment), the user pool
 *   `issuer`, `allowedHosts`, an `id` / `name` override, `authorization.params`, a `profile()`
 *   mapper.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Cognito(
  options: OAuthUserConfig<CognitoProfile> = {},
): ProviderDescriptor<OAuthUserConfig<CognitoProfile>> {
  return oauthDescriptor(
    { id: "cognito", name: "Cognito", type: "oidc" },
    options,
    (c, issuer) => cognitoProvider(c, options.id ?? "cognito", issuer),
  );
}
