/**
 * `next-auth/providers/microsoft-entra-id` on denext: Microsoft Entra ID (OpenID Connect),
 * built on denext's `microsoftEntra()` preset. The tenant comes from `issuer`
 * (`https://login.microsoftonline.com/<tenant>/v2.0`, default `AUTH_MICROSOFT_ENTRA_ID_ISSUER`);
 * without one it is `common`, where denext checks every token's issuer against its own `tid`.
 * Credentials default to `AUTH_MICROSOFT_ENTRA_ID_ID` / `AUTH_MICROSOFT_ENTRA_ID_SECRET`.
 *
 * ```ts
 * import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
 * export const { handlers, auth } = NextAuth({
 *   providers: [MicrosoftEntraID({ issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER })],
 * });
 * ```
 *
 * @module
 */

import { microsoftEntra } from "../../src/providers.ts";
import { oauthDescriptor, type OAuthUserConfig, type ProviderDescriptor } from "./shared.ts";

/** The Entra ID claims, as the app's `profile()` callback receives them. */
export type MicrosoftEntraIDProfile = Record<string, unknown>;

/** The tenant segment of an Entra issuer URL (`common` when there is none). */
function tenantOf(issuer: string): string {
  const match = /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0\/?$/i.exec(issuer.trim());
  if (match) return match[1];
  if (issuer.trim() === "") return "common";
  throw new TypeError(
    `next-auth: microsoft-entra-id issuer ${JSON.stringify(issuer)} is not ` +
      '"https://login.microsoftonline.com/<tenant>/v2.0"',
  );
}

/**
 * The Microsoft Entra ID provider.
 *
 * @param options Client credentials and the tenant `issuer` (defaults from the environment),
 *   an `id` / `name` override, `authorization.params`, a `profile()` mapper.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function MicrosoftEntraID(
  options: OAuthUserConfig<MicrosoftEntraIDProfile> = {},
): ProviderDescriptor<OAuthUserConfig<MicrosoftEntraIDProfile>> {
  return oauthDescriptor(
    { id: "microsoft-entra-id", name: "Microsoft Entra ID", type: "oidc" },
    options,
    (c, issuer) => microsoftEntra({ ...c, tenant: tenantOf(issuer) }),
  );
}
