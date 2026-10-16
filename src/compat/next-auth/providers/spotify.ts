/**
 * `next-auth/providers/spotify` on denext: Spotify (OAuth 2.0). Spotify doesn't say whether an address is verified, so a Spotify account is never linked to an
 * existing user by email unless the provider sets `allowDangerousEmailAccountLinking`.
 * Credentials default to `AUTH_SPOTIFY_ID` / `AUTH_SPOTIFY_SECRET`.
 *
 * ```ts
 * import Spotify from "next-auth/providers/spotify";
 * export const { handlers, auth } = NextAuth({ providers: [Spotify] });
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

/** `GET /v1/me` as the user. */
function spotifyProfile({ userinfo }: ProfileInput): AuthUser {
  const images = Array.isArray(userinfo?.images) ? userinfo.images as { url?: unknown }[] : [];
  return {
    id: String(userinfo?.id ?? ""),
    name: text(userinfo?.display_name),
    email: text(userinfo?.email),
    image: text(images[0]?.url),
  };
}

/** Spotify's endpoints and scopes. */
const SPOTIFY: ProviderSpec = {
  id: "spotify",
  type: "oauth",
  authorizationUrl: "https://accounts.spotify.com/authorize",
  tokenUrl: "https://accounts.spotify.com/api/token",
  userinfoUrl: "https://api.spotify.com/v1/me",
  scopes: ["user-read-email"],
  profile: spotifyProfile,
};

/** The Spotify profile, as the app's `profile()` callback receives it. */
export type SpotifyProfile = Record<string, unknown>;

/**
 * The Spotify provider.
 *
 * @param options Client credentials (default from the environment), an `id` / `name`
 *   override, `authorization.params`, a `profile()` mapper.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Spotify(
  options: OAuthUserConfig<SpotifyProfile> = {},
): ProviderDescriptor<OAuthUserConfig<SpotifyProfile>> {
  return oauthDescriptor(
    { id: "spotify", name: "Spotify", type: "oauth" },
    options,
    (c) => specProvider(SPOTIFY, c),
  );
}
