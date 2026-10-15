/**
 * `next-auth/providers/github` on denext: GitHub (OAuth 2.0), built on denext's `github()` preset (its
 * endpoints, scopes and email-verification rules). Credentials default to `AUTH_GITHUB_ID` /
 * `AUTH_GITHUB_SECRET`, as in Auth.js.
 *
 * ```ts
 * import GitHub from "next-auth/providers/github";
 * export const { handlers, auth } = NextAuth({ providers: [GitHub] });
 * ```
 *
 * @module
 */

import { github } from "../../../server/auth/providers.ts";
import { oauthDescriptor, type OAuthUserConfig, type ProviderDescriptor } from "./shared.ts";

/** The GitHub profile, as the app's `profile()` callback receives it. */
export type GitHubProfile = Record<string, unknown>;

/**
 * The GitHub provider.
 *
 * @param options Client credentials (default from the environment), an `id` / `name`
 *   override, `authorization.params`, a `profile()` mapper.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function GitHub(
  options: OAuthUserConfig<GitHubProfile> = {},
): ProviderDescriptor<OAuthUserConfig<GitHubProfile>> {
  return oauthDescriptor(
    { id: "github", name: "GitHub", type: "oauth" },
    options,
    (c) => github(c),
  );
}
