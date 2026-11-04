/**
 * `next-auth/providers/gitlab` on denext: GitLab (gitlab.com or self-managed). Built on denext's `gitlab()` preset, which signs in with OpenID Connect: the account id is
 * GitLab's user id (the `sub` claim, as Auth.js's `id`), and `profile()` receives the id_token
 * claims. A self-managed instance is its origin as `issuer` (default `AUTH_GITLAB_ISSUER`);
 * without one it is gitlab.com. Credentials default to `AUTH_GITLAB_ID` / `AUTH_GITLAB_SECRET`.
 *
 * ```ts
 * import GitLab from "next-auth/providers/gitlab";
 * export const { handlers, auth } = NextAuth({ providers: [GitLab] });
 * ```
 *
 * @module
 */

import { gitlab } from "../../src/providers.ts";
import { oauthDescriptor, type OAuthUserConfig, type ProviderDescriptor } from "./shared.ts";

/** The GitLab profile, as the app's `profile()` callback receives it. */
export type GitLabProfile = Record<string, unknown>;

/**
 * The GitLab provider.
 *
 * @param options Client credentials (default from the environment), the instance
 *   `issuer`, an `id` / `name` override, `authorization.params`, a `profile()` mapper.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function GitLab(
  options: OAuthUserConfig<GitLabProfile> = {},
): ProviderDescriptor<OAuthUserConfig<GitLabProfile>> {
  return oauthDescriptor(
    { id: "gitlab", name: "GitLab", type: "oauth" },
    options,
    (c, issuer) => gitlab({ ...c, ...(issuer ? { baseUrl: issuer } : {}) }),
  );
}
