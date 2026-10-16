/**
 * `next-auth/providers/twitter` on denext: X (Twitter), OAuth 2.0. The account is X's user id; X shares no email address here, so an X account is never linked to
 * an existing user by email. The token endpoint takes the client credentials as HTTP Basic, as X
 * requires for a confidential client. Credentials default to `AUTH_TWITTER_ID` /
 * `AUTH_TWITTER_SECRET`.
 *
 * ```ts
 * import Twitter from "next-auth/providers/twitter";
 * export const { handlers, auth } = NextAuth({ providers: [Twitter] });
 * ```
 *
 * @module
 */

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

/** `GET /2/users/me`'s `{ data }` as the user. */
function twitterProfile({ userinfo }: ProfileInput): AuthUser {
  const data = (userinfo?.data ?? {}) as Record<string, unknown>;
  return { id: String(data.id ?? ""), name: text(data.name), image: text(data.profile_image_url) };
}

/** X's endpoints and scopes. */
const TWITTER: ProviderSpec = {
  id: "twitter",
  type: "oauth",
  authorizationUrl: "https://x.com/i/oauth2/authorize",
  tokenUrl: "https://api.x.com/2/oauth2/token",
  userinfoUrl: "https://api.x.com/2/users/me?user.fields=profile_image_url",
  scopes: ["users.read", "tweet.read", "offline.access"],
  profile: twitterProfile,
  tokenEndpointAuthMethod: "client_secret_basic",
};

/** The Twitter profile, as the app's `profile()` callback receives it. */
export type TwitterProfile = Record<string, unknown>;

/**
 * The Twitter provider.
 *
 * @param options Client credentials (default from the environment), an `id` / `name`
 *   override, `authorization.params`, a `profile()` mapper.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Twitter(
  options: OAuthUserConfig<TwitterProfile> = {},
): ProviderDescriptor<OAuthUserConfig<TwitterProfile>> {
  return oauthDescriptor(
    { id: "twitter", name: "Twitter", type: "oauth" },
    options,
    (c) => specProvider(TWITTER, c),
  );
}
