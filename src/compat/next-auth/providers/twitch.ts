/**
 * `next-auth/providers/twitch` on denext: Twitch (OpenID Connect). The id_token is asked for the address, its verification, the picture and the login name
 * (Twitch's `claims` parameter); the name is `preferred_username`. Credentials default to
 * `AUTH_TWITCH_ID` / `AUTH_TWITCH_SECRET`.
 *
 * ```ts
 * import Twitch from "next-auth/providers/twitch";
 * export const { handlers, auth } = NextAuth({ providers: [Twitch] });
 * ```
 *
 * @module
 */

import { oidcClaimProfile } from "../../../server/auth/providers-presets.ts";
import type { AuthUser, ProfileInput } from "../../../server/auth/types.ts";
import {
  oauthDescriptor,
  type OAuthUserConfig,
  type ProviderDescriptor,
  type ProviderSpec,
  specProvider,
} from "./shared.ts";

/** `value` when it is a non-empty string. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The standard claims, with Twitch's login name as the name. */
function twitchProfile(input: ProfileInput): AuthUser {
  const claims = { ...(input.userinfo ?? {}), ...(input.claims ?? {}) };
  return { ...oidcClaimProfile(input), name: text(claims.preferred_username) };
}

/** Twitch's OpenID Connect endpoints. */
const TWITCH: ProviderSpec = {
  id: "twitch",
  type: "oidc",
  issuer: "https://id.twitch.tv/oauth2",
  authorizationUrl: "https://id.twitch.tv/oauth2/authorize",
  tokenUrl: "https://id.twitch.tv/oauth2/token",
  jwksUrl: "https://id.twitch.tv/oauth2/keys",
  discovery: true,
  scopes: ["openid", "user:read:email"],
  profile: twitchProfile,
  authorizationParams: {
    claims: JSON.stringify({
      id_token: { email: null, email_verified: null, picture: null, preferred_username: null },
    }),
  },
};

/** The Twitch profile, as the app's `profile()` callback receives it. */
export type TwitchProfile = Record<string, unknown>;

/**
 * The Twitch provider.
 *
 * @param options Client credentials (default from the environment), an `id` / `name`
 *   override, `authorization.params`, a `profile()` mapper.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Twitch(
  options: OAuthUserConfig<TwitchProfile> = {},
): ProviderDescriptor<OAuthUserConfig<TwitchProfile>> {
  return oauthDescriptor(
    { id: "twitch", name: "Twitch", type: "oidc" },
    options,
    (c) => specProvider(TWITCH, c),
  );
}
