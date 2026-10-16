/**
 * `next-auth/providers/okta` on denext: Okta (OpenID Connect). `issuer` (default `AUTH_OKTA_ISSUER`) is a custom authorization server
 * (`https://<org>.okta.com/oauth2/<server>`, on denext's `okta()` preset) or the org server
 * (`https://<org>.okta.com`, through OIDC discovery). Credentials default to `AUTH_OKTA_ID` /
 * `AUTH_OKTA_SECRET`.
 *
 * ```ts
 * import Okta from "next-auth/providers/okta";
 * export const { handlers, auth } = NextAuth({ providers: [Okta] });
 * ```
 *
 * @module
 */

import { oidc, okta } from "../../../server/auth/providers.ts";
import type { OAuthProvider } from "../../../server/auth/types.ts";
import {
  issuerUrl,
  oauthDescriptor,
  type OAuthUserConfig,
  type ProviderDescriptor,
} from "./shared.ts";

/** An Okta issuer as a provider: a custom authorization server, or the org server. */
function oktaProvider(
  credentials: { clientId: string; clientSecret: string; scopes?: string[] },
  id: string,
  issuer: string,
): OAuthProvider {
  const url = issuerUrl(id, issuer);
  const path = url.pathname.replace(/\/+$/, "");
  const server = /^\/oauth2\/([^/]+)$/.exec(path);
  if (server) return okta({ ...credentials, domain: url.host, authorizationServer: server[1] });
  if (path !== "") {
    throw new TypeError(
      `next-auth: okta issuer ${JSON.stringify(issuer)} is neither "https://<org>.okta.com" ` +
        'nor "https://<org>.okta.com/oauth2/<server>"',
    );
  }
  return oidc({ ...credentials, id: "okta", issuer: url.origin });
}

/** The Okta profile, as the app's `profile()` callback receives it. */
export type OktaProfile = Record<string, unknown>;

/**
 * The Okta provider.
 *
 * @param options Client credentials (default from the environment), the
 *   `issuer`, an `id` / `name` override, `authorization.params`, a `profile()` mapper.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Okta(
  options: OAuthUserConfig<OktaProfile> = {},
): ProviderDescriptor<OAuthUserConfig<OktaProfile>> {
  return oauthDescriptor(
    { id: "okta", name: "Okta", type: "oidc" },
    options,
    (c, issuer) => oktaProvider(c, options.id ?? "okta", issuer),
  );
}
