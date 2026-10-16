/**
 * `next-auth/providers/zoom` on denext: Zoom (OAuth 2.0). The scopes come from the Zoom app registration, so the authorization request names none unless
 * `authorization.params.scope` does. The token endpoint takes the client credentials as HTTP
 * Basic. Zoom's address is not treated as verified. Credentials default to `AUTH_ZOOM_ID` /
 * `AUTH_ZOOM_SECRET`.
 *
 * ```ts
 * import Zoom from "next-auth/providers/zoom";
 * export const { handlers, auth } = NextAuth({ providers: [Zoom] });
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

/** `GET /v2/users/me` as the user. */
function zoomProfile({ userinfo }: ProfileInput): AuthUser {
  const name = [text(userinfo?.first_name), text(userinfo?.last_name)].filter(Boolean).join(" ");
  return {
    id: String(userinfo?.id ?? ""),
    name: name || undefined,
    email: text(userinfo?.email),
    image: text(userinfo?.pic_url),
  };
}

/** Zoom's endpoints. */
const ZOOM: ProviderSpec = {
  id: "zoom",
  type: "oauth",
  authorizationUrl: "https://zoom.us/oauth/authorize",
  tokenUrl: "https://zoom.us/oauth/token",
  userinfoUrl: "https://api.zoom.us/v2/users/me",
  scopes: [],
  profile: zoomProfile,
  tokenEndpointAuthMethod: "client_secret_basic",
};

/** The Zoom profile, as the app's `profile()` callback receives it. */
export type ZoomProfile = Record<string, unknown>;

/**
 * The Zoom provider.
 *
 * @param options Client credentials (default from the environment), an `id` / `name`
 *   override, `authorization.params`, a `profile()` mapper.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Zoom(
  options: OAuthUserConfig<ZoomProfile> = {},
): ProviderDescriptor<OAuthUserConfig<ZoomProfile>> {
  return oauthDescriptor(
    { id: "zoom", name: "Zoom", type: "oauth" },
    options,
    (c) => specProvider(ZOOM, c),
  );
}
