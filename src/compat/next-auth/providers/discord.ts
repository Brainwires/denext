/**
 * `next-auth/providers/discord` on denext: Discord (OAuth 2.0), built on denext's `discord()` preset (its
 * endpoints, scopes and email-verification rules). Credentials default to `AUTH_DISCORD_ID` /
 * `AUTH_DISCORD_SECRET`, as in Auth.js.
 *
 * ```ts
 * import Discord from "next-auth/providers/discord";
 * export const { handlers, auth } = NextAuth({ providers: [Discord] });
 * ```
 *
 * @module
 */

import { discord } from "../../../server/auth/providers.ts";
import { oauthDescriptor, type OAuthUserConfig, type ProviderDescriptor } from "./shared.ts";

/** The Discord profile, as the app's `profile()` callback receives it. */
export type DiscordProfile = Record<string, unknown>;

/**
 * The Discord provider.
 *
 * @param options Client credentials (default from the environment), an `id` / `name`
 *   override, `authorization.params`, a `profile()` mapper.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Discord(
  options: OAuthUserConfig<DiscordProfile> = {},
): ProviderDescriptor<OAuthUserConfig<DiscordProfile>> {
  return oauthDescriptor(
    { id: "discord", name: "Discord", type: "oauth" },
    options,
    (c) => discord(c),
  );
}
