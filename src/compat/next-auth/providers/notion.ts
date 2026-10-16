/**
 * `next-auth/providers/notion` on denext: Notion (public integrations, OAuth 2.0). The user is the workspace member who authorized the integration, read from the token
 * response's `owner.user` (what Auth.js's `profile()` receives too). `redirectUri` is accepted
 * and ignored: denext sends its own callback URL. The token endpoint takes the client
 * credentials as HTTP Basic. Notion's address is not treated as verified. Credentials default to
 * `AUTH_NOTION_ID` / `AUTH_NOTION_SECRET`.
 *
 * ```ts
 * import Notion from "next-auth/providers/notion";
 * export const { handlers, auth } = NextAuth({ providers: [Notion({ redirectUri: "https://app.example/api/auth/callback/notion" })] });
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

/** The person behind the token: the token response's `owner.user`. */
function ownerUser({ tokens }: ProfileInput): Record<string, unknown> {
  const owner = tokens.owner as { user?: unknown } | undefined;
  const user = owner?.user;
  return typeof user === "object" && user !== null ? user as Record<string, unknown> : {};
}

/** The owner user as the user. */
function notionProfile(input: ProfileInput): AuthUser {
  const user = ownerUser(input);
  const person = user.person as { email?: unknown } | undefined;
  return {
    id: String(user.id ?? ""),
    name: text(user.name),
    email: text(person?.email),
    image: text(user.avatar_url),
  };
}

/** Notion's endpoints. */
const NOTION: ProviderSpec = {
  id: "notion",
  type: "oauth",
  authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
  tokenUrl: "https://api.notion.com/v1/oauth/token",
  scopes: [],
  profile: notionProfile,
  authorizationParams: { owner: "user" },
  tokenEndpointAuthMethod: "client_secret_basic",
};

/** The Notion profile (the owner user), as the app's `profile()` callback receives it. */
export type NotionProfile = Record<string, unknown>;

/** The Notion provider's options. */
export interface NotionUserConfig extends OAuthUserConfig<NotionProfile> {
  /** Accepted for Auth.js compatibility; denext sends its own callback URL. */
  redirectUri?: string;
}

/**
 * The Notion provider.
 *
 * @param options Client credentials (default from the environment), `redirectUri` (ignored),
 *   an `id` / `name` override, `authorization.params`, a `profile()` mapper.
 * @returns The provider descriptor for `NextAuth({ providers })`.
 */
export default function Notion(
  options: NotionUserConfig = {},
): ProviderDescriptor<NotionUserConfig> {
  return oauthDescriptor(
    { id: "notion", name: "Notion", type: "oauth", rawProfile: ownerUser },
    options,
    (c) => specProvider(NOTION, c),
  );
}
