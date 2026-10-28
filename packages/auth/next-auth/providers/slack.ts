/**
 * `next-auth/providers/slack` on denext: Slack ("Sign in with Slack", OpenID Connect). Built on denext's `slack()` preset; `profile()` receives the id_token claims. Credentials
 * default to `AUTH_SLACK_ID` / `AUTH_SLACK_SECRET`.
 *
 * ```ts
 * import Slack from "next-auth/providers/slack";
 * export const { handlers, auth } = NextAuth({ providers: [Slack] });
 * ```
 *
 * @module
 */

import { slack } from "../../src/providers.ts";
import { oauthDescriptor, type OAuthUserConfig, type ProviderDescriptor } from "./shared.ts";

/** The Slack profile, as the app's `profile()` callback receives it. */
export type SlackProfile = Record<string, unknown>;

/**
 * The Slack provider.
 *
 * @param options Client credentials (default from the environment), an `id` / `name`
 *   override, `authorization.params`, a `profile()` mapper.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Slack(
  options: OAuthUserConfig<SlackProfile> = {},
): ProviderDescriptor<OAuthUserConfig<SlackProfile>> {
  return oauthDescriptor(
    { id: "slack", name: "Slack", type: "oidc" },
    options,
    (c) => slack(c),
  );
}
