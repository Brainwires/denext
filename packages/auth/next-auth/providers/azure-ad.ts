/**
 * `next-auth/providers/azure-ad` on denext: Auth.js's deprecated name for Microsoft Entra ID —
 * `next-auth/providers/microsoft-entra-id` under the id `azure-ad`, so its credentials default to
 * `AUTH_AZURE_AD_ID` / `AUTH_AZURE_AD_SECRET` and the tenant to `AUTH_AZURE_AD_ISSUER`.
 *
 * ```ts
 * import AzureAD from "next-auth/providers/azure-ad";
 * export const { handlers, auth } = NextAuth({ providers: [AzureAD] });
 * ```
 *
 * @module
 */

import MicrosoftEntraID, { type MicrosoftEntraIDProfile } from "./microsoft-entra-id.ts";
import type { OAuthUserConfig, ProviderDescriptor } from "./shared.ts";

/** The Azure AD claims, as the app's `profile()` callback receives them. */
export type AzureADProfile = MicrosoftEntraIDProfile;

/**
 * The Azure Active Directory provider.
 *
 * @param options Client credentials and the tenant `issuer` (defaults from the environment),
 *   an `id` / `name` override, `authorization.params`, a `profile()` mapper.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function AzureAD(
  options: OAuthUserConfig<AzureADProfile> = {},
): ProviderDescriptor<OAuthUserConfig<AzureADProfile>> {
  return MicrosoftEntraID({
    ...options,
    id: options.id ?? "azure-ad",
    name: options.name ?? "Azure Active Directory",
  });
}
