/**
 * Built-in auth provider presets: Google & GitHub, a generic OIDC provider, and a
 * Credentials (email/password) provider. Each returns a provider config the auth
 * runtime drives; `profile` maps the provider's response to a normalized
 * {@link AuthUser}.
 *
 * The nine additional presets (Microsoft Entra, Apple, Discord, GitLab, Slack, Auth0,
 * Okta, Keycloak, Facebook) live in {@link ./providers-presets.ts | providers-presets.ts}
 * and are re-exported here, so `denext/server` has one provider surface. Every preset —
 * including the three below — is a data literal handed to the shared `oauthPreset`
 * factory.
 *
 * @module
 */

import type { AuthUser, CredentialsProvider, OAuthProvider, ProfileInput } from "./types.ts";
import { type OAuthClientOptions, oauthPreset, oidcClaimProfile } from "./providers-presets.ts";

export type { OAuthClientOptions };
export {
  apple,
  auth0,
  type Auth0Options,
  discord,
  facebook,
  gitlab,
  type GitLabOptions,
  keycloak,
  type KeycloakOptions,
  microsoftEntra,
  type MicrosoftEntraOptions,
  okta,
  type OktaOptions,
  slack,
} from "./providers-presets.ts";

/**
 * Google (OIDC). Verifies the `id_token`; no userinfo round-trip needed.
 *
 * @param options The app's Google client credentials.
 * @returns The configured Google provider (`id: "google"`).
 */
export function google(options: OAuthClientOptions): OAuthProvider {
  return oauthPreset({
    id: "google",
    type: "oidc",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    issuer: "https://accounts.google.com",
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    scopes: ["openid", "email", "profile"],
    // The shared OIDC mapper drops an email the IdP marks unverified — otherwise an
    // attacker could register a Google-side account carrying a victim's address and
    // an app that links by email would take over the victim's account.
    profile: oidcClaimProfile,
  }, options);
}

/** A single entry from GitHub's `/user/emails` response. */
interface GitHubEmail {
  email?: string;
  primary?: boolean;
  verified?: boolean;
}

/**
 * Map GitHub's `/user` + `/user/emails` responses. Only an email GitHub reports as
 * verified (preferring the primary) is exposed, mirroring the `email_verified` handling
 * in `google`/`oidc` — an app that links accounts by email must never be handed an
 * unverified, attacker-chosen address.
 */
function githubProfile({ userinfo, emails }: ProfileInput): AuthUser {
  const list = emails as GitHubEmail[] | undefined;
  const verified = list?.find((e) => e.primary && e.verified) ?? list?.find((e) => e.verified);
  return {
    id: String(userinfo?.id ?? ""),
    name: (userinfo?.name ?? userinfo?.login) as string | undefined,
    email: verified?.email,
    emailVerified: verified ? true : undefined,
    image: userinfo?.avatar_url as string | undefined,
  };
}

/**
 * GitHub (OAuth 2.0). Reads the profile from the `/user` API.
 *
 * @param options The app's GitHub OAuth app credentials.
 * @returns The configured GitHub provider (`id: "github"`).
 */
export function github(options: OAuthClientOptions): OAuthProvider {
  return oauthPreset({
    id: "github",
    type: "oauth",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userinfoUrl: "https://api.github.com/user",
    // The `user:email` scope lets the flow read the account's verified email list;
    // `userinfo.email` alone can be an unverified, user-chosen address.
    userEmailsUrl: "https://api.github.com/user/emails",
    scopes: ["read:user", "user:email"],
    profile: githubProfile,
  }, options);
}

/** Options for a generic {@link oidc} provider. */
export interface OidcOptions extends OAuthClientOptions {
  /** Provider id / `[provider]` route segment (default `"oidc"`). */
  id?: string;
  /** Expected `iss` (also the OIDC discovery issuer when the endpoints are omitted). */
  issuer: string;
  /**
   * Authorization endpoint. Omit it — together with `tokenUrl` and `jwksUrl` — to let
   * denext read all three from the issuer's discovery document.
   */
  authorizationUrl?: string;
  /** Token endpoint. Omit with the other two for discovery. */
  tokenUrl?: string;
  /** JWKS endpoint (for `id_token` signature keys). Omit with the other two for discovery. */
  jwksUrl?: string;
  /** Optional userinfo endpoint. */
  userinfoUrl?: string;
  /** Map claims/userinfo to a user (defaults to standard OIDC claims). */
  profile?: (input: ProfileInput) => AuthUser;
}

/**
 * A generic OIDC provider (Authorization Code + PKCE, `id_token` verified via JWKS).
 *
 * Two forms:
 * ```ts
 * oidc({ issuer: "https://idp.example.com", clientId, clientSecret }); // discovery
 * oidc({ issuer, authorizationUrl, tokenUrl, jwksUrl, clientId, clientSecret }); // explicit
 * ```
 * The issuer-only form resolves the endpoints from
 * `<issuer>/.well-known/openid-configuration` and refuses a document that declares a
 * different `issuer`. Passing *some* of the three endpoints is a configuration error: it
 * would silently mix a hand-written endpoint with a discovered one.
 *
 * @param options Issuer (+ optional endpoints/mapper) and the app's client credentials.
 * @returns The configured OIDC provider (`id` defaults to `"oidc"`).
 */
export function oidc(options: OidcOptions): OAuthProvider {
  const explicit = Boolean(options.authorizationUrl && options.tokenUrl && options.jwksUrl);
  const partial = Boolean(options.authorizationUrl || options.tokenUrl || options.jwksUrl);
  if (!explicit && partial) {
    throw new TypeError(
      "auth: oidc() needs either all of authorizationUrl/tokenUrl/jwksUrl, or none of " +
        "them (issuer-only OIDC discovery)",
    );
  }
  // Until discovery resolves them, the issuer's discovery document stands in for the
  // endpoints: it keeps the provider pinned to the issuer's own host (the `safeFetch`
  // allowlist is derived from these URLs) without inventing a plausible-but-wrong path.
  const wellKnown = `${options.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  return oauthPreset({
    id: options.id ?? "oidc",
    type: "oidc",
    issuer: options.issuer,
    authorizationUrl: options.authorizationUrl ?? wellKnown,
    tokenUrl: options.tokenUrl ?? wellKnown,
    jwksUrl: options.jwksUrl ?? wellKnown,
    userinfoUrl: options.userinfoUrl,
    discovery: !explicit,
    scopes: ["openid", "email", "profile"],
    profile: options.profile,
  }, options);
}

/** Options for the {@link credentials} provider. */
export interface CredentialsOptions {
  /** Provider id (default `"credentials"`). */
  id?: string;
  /**
   * Validate the submitted fields and return the user, or `null` to reject. Do not
   * reveal whether an account exists; compare passwords with `verifyPassword` (store
   * them with `hashPassword`) — never `===`:
   * ```ts
   * credentials({
   *   authorize: async ({ email, password }) => {
   *     const row = findUser(email);
   *     const ok = await verifyPassword(password ?? "", row?.password_hash ?? "");
   *     return ok && row ? { id: String(row.id), email: row.email } : null;
   *   },
   * })
   * ```
   */
  authorize: (
    credentials: Record<string, string>,
  ) => Promise<AuthUser | null> | AuthUser | null;
}

/**
 * An email/password (or any custom) credentials provider.
 *
 * @param options The `authorize` callback and an optional provider id.
 * @returns The configured credentials provider.
 */
export function credentials(options: CredentialsOptions): CredentialsProvider {
  return { id: options.id ?? "credentials", type: "credentials", authorize: options.authorize };
}
