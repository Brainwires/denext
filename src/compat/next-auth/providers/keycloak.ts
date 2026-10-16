/**
 * `next-auth/providers/keycloak` on denext: Keycloak (OpenID Connect). `issuer` (default `AUTH_KEYCLOAK_ISSUER`) is the realm: `https://<host>/realms/<realm>` runs
 * on denext's `keycloak()` preset; any other issuer (a legacy `/auth/realms/<realm>`) goes
 * through OIDC discovery. Credentials default to `AUTH_KEYCLOAK_ID` / `AUTH_KEYCLOAK_SECRET`.
 *
 * ```ts
 * import Keycloak from "next-auth/providers/keycloak";
 * export const { handlers, auth } = NextAuth({ providers: [Keycloak] });
 * ```
 *
 * @module
 */

import { keycloak, oidc } from "../../../server/auth/providers.ts";
import type { OAuthProvider } from "../../../server/auth/types.ts";
import {
  issuerUrl,
  oauthDescriptor,
  type OAuthUserConfig,
  type ProviderDescriptor,
} from "./shared.ts";

/** A Keycloak realm issuer as a provider. */
function keycloakProvider(
  credentials: { clientId: string; clientSecret: string; scopes?: string[] },
  id: string,
  issuer: string,
): OAuthProvider {
  const url = issuerUrl(id, issuer);
  const realm = /^\/realms\/([^/]+)\/?$/.exec(url.pathname);
  if (realm) return keycloak({ ...credentials, baseUrl: url.origin, realm: realm[1] });
  return oidc({ ...credentials, id: "keycloak", issuer: url.href.replace(/\/+$/, "") });
}

/** The Keycloak profile, as the app's `profile()` callback receives it. */
export type KeycloakProfile = Record<string, unknown>;

/**
 * The Keycloak provider.
 *
 * @param options Client credentials (default from the environment), the realm
 *   `issuer`, an `id` / `name` override, `authorization.params`, a `profile()` mapper.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Keycloak(
  options: OAuthUserConfig<KeycloakProfile> = {},
): ProviderDescriptor<OAuthUserConfig<KeycloakProfile>> {
  return oauthDescriptor(
    { id: "keycloak", name: "Keycloak", type: "oidc" },
    options,
    (c, issuer) => keycloakProvider(c, options.id ?? "keycloak", issuer),
  );
}
