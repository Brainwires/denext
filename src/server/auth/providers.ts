/**
 * Built-in auth provider presets: Google & GitHub, a generic OIDC provider, and a
 * Credentials (email/password) provider. Each returns a provider config the auth
 * runtime drives; `profile` maps the provider's response to a normalized
 * {@link AuthUser}.
 *
 * @module
 */

import type { AuthUser, CredentialsProvider, OAuthProvider, ProfileInput } from "./types.ts";

/** The client credentials every OAuth preset needs. */
export interface OAuthClientOptions {
  /** OAuth client id. */
  clientId: string;
  /** OAuth client secret. */
  clientSecret: string;
  /** Override the requested scopes. */
  scopes?: string[];
}

/** Google (OIDC). Verifies the `id_token`; no userinfo round-trip needed. */
export function google(options: OAuthClientOptions): OAuthProvider {
  return {
    id: "google",
    type: "oidc",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    issuer: "https://accounts.google.com",
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    scopes: options.scopes ?? ["openid", "email", "profile"],
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile: ({ claims }: ProfileInput): AuthUser => ({
      id: String(claims?.sub ?? ""),
      name: claims?.name as string | undefined,
      // Drop the email when the IdP explicitly marks it unverified — otherwise an
      // attacker could register a Google-side account carrying a victim's address and
      // an app that links by email would take over the victim's account.
      email: claims?.email_verified === false ? undefined : (claims?.email as string | undefined),
      emailVerified: claims?.email_verified as boolean | undefined,
      image: claims?.picture as string | undefined,
    }),
  };
}

/** A single entry from GitHub's `/user/emails` response. */
interface GitHubEmail {
  email?: string;
  primary?: boolean;
  verified?: boolean;
}

/** GitHub (OAuth 2.0). Reads the profile from the `/user` API. */
export function github(options: OAuthClientOptions): OAuthProvider {
  return {
    id: "github",
    type: "oauth",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userinfoUrl: "https://api.github.com/user",
    // The `user:email` scope lets the flow read the account's verified email list;
    // `userinfo.email` alone can be an unverified, user-chosen address.
    userEmailsUrl: "https://api.github.com/user/emails",
    scopes: options.scopes ?? ["read:user", "user:email"],
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile: ({ userinfo, emails }: ProfileInput): AuthUser => {
      // Only expose an email GitHub reports as verified (prefer the primary), mirroring
      // the `email_verified` handling in `google`/`oidc` — an app that links accounts by
      // email must never be handed an unverified, attacker-chosen address.
      const list = emails as GitHubEmail[] | undefined;
      const verified = list?.find((e) => e.primary && e.verified) ?? list?.find((e) => e.verified);
      return {
        id: String(userinfo?.id ?? ""),
        name: (userinfo?.name ?? userinfo?.login) as string | undefined,
        email: verified?.email,
        emailVerified: verified ? true : undefined,
        image: userinfo?.avatar_url as string | undefined,
      };
    },
  };
}

/** Options for a generic {@link oidc} provider. */
export interface OidcOptions extends OAuthClientOptions {
  /** Provider id / `[provider]` route segment (default `"oidc"`). */
  id?: string;
  /** Expected `iss`. */
  issuer: string;
  /** Authorization endpoint. */
  authorizationUrl: string;
  /** Token endpoint. */
  tokenUrl: string;
  /** JWKS endpoint (for `id_token` signature keys). */
  jwksUrl: string;
  /** Optional userinfo endpoint. */
  userinfoUrl?: string;
  /** Map claims/userinfo to a user (defaults to standard OIDC claims). */
  profile?: (input: ProfileInput) => AuthUser;
}

/** A generic OIDC provider (Authorization Code + PKCE, `id_token` verified via JWKS). */
export function oidc(options: OidcOptions): OAuthProvider {
  return {
    id: options.id ?? "oidc",
    type: "oidc",
    authorizationUrl: options.authorizationUrl,
    tokenUrl: options.tokenUrl,
    userinfoUrl: options.userinfoUrl,
    issuer: options.issuer,
    jwksUrl: options.jwksUrl,
    scopes: options.scopes ?? ["openid", "email", "profile"],
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile: options.profile ?? (({ claims, userinfo }: ProfileInput): AuthUser => {
      const src = { ...userinfo, ...claims };
      // Drop the email when the IdP explicitly marks it unverified (see `google`): a
      // generic OIDC provider may let a user set an arbitrary, unverified address.
      const verified = src.email_verified as boolean | undefined;
      return {
        id: String(src.sub ?? ""),
        name: src.name as string | undefined,
        email: verified === false ? undefined : (src.email as string | undefined),
        emailVerified: verified,
        image: src.picture as string | undefined,
      };
    }),
  };
}

/** Options for the {@link credentials} provider. */
export interface CredentialsOptions {
  /** Provider id (default `"credentials"`). */
  id?: string;
  /**
   * Validate the submitted fields and return the user, or `null` to reject. Do not
   * reveal whether an account exists; use a constant-time password compare.
   */
  authorize: (
    credentials: Record<string, string>,
  ) => Promise<AuthUser | null> | AuthUser | null;
}

/** An email/password (or any custom) credentials provider. */
export function credentials(options: CredentialsOptions): CredentialsProvider {
  return { id: options.id ?? "credentials", type: "credentials", authorize: options.authorize };
}
