/**
 * Shared types for denext auth: the normalized user/session shapes and the
 * provider contracts (OAuth 2.0 / OIDC and Credentials).
 *
 * @module
 */

/** A normalized user profile — the non-sensitive identity denext stores in the session. */
export interface AuthUser {
  /** Stable provider-scoped user id. */
  id: string;
  /** Display name, if the provider supplies one. */
  name?: string;
  /** Email, if granted. Dropped by the built-in OIDC mappers when the provider marks
   * it `email_verified: false` — so an app that links accounts by email can't be fed
   * an attacker-chosen, unverified address. Check {@link emailVerified} before trusting
   * it for account linking. */
  email?: string;
  /** Whether the provider asserted the email is verified (`email_verified` claim).
   * `undefined` when the provider doesn't say. Never treat an unverified/absent value
   * as proof of ownership when linking to an existing local account. */
  emailVerified?: boolean;
  /** Avatar URL, if any. */
  image?: string;
}

/** The signed (readable, tamper-evident) session payload. Never stores tokens/secrets. */
export interface AuthSession {
  /** The signed-in user. */
  user: AuthUser;
  /** The provider id that authenticated this session. */
  provider: string;
  /** Expiry, epoch seconds. */
  expiresAt: number;
}

/** Raw inputs a provider maps into an {@link AuthUser}. */
export interface ProfileInput {
  /** The token endpoint response (access_token, id_token, …). */
  tokens: Record<string, unknown>;
  /** The userinfo endpoint response, if fetched. */
  userinfo?: Record<string, unknown>;
  /** The verified OIDC `id_token` claims, if present. */
  claims?: Record<string, unknown>;
  /**
   * The provider's email list, if a {@link OAuthProvider.userEmailsUrl} is configured
   * and fetched (e.g. GitHub `/user/emails`). Lets a synchronous mapper expose only a
   * verified address — the OAuth-provider analogue of the OIDC `email_verified` claim.
   */
  emails?: unknown[];
}

/** An OAuth 2.0 / OIDC provider (Authorization Code + PKCE). */
export interface OAuthProvider {
  /** URL-safe provider id (the `[provider]` route segment), e.g. `"google"`. */
  id: string;
  /** `"oidc"` verifies an `id_token`; `"oauth"` calls a userinfo endpoint. */
  type: "oauth" | "oidc";
  /** Authorization endpoint. */
  authorizationUrl: string;
  /** Token endpoint. */
  tokenUrl: string;
  /** Userinfo endpoint (OAuth providers, or OIDC when you prefer userinfo). */
  userinfoUrl?: string;
  /**
   * Optional endpoint returning the account's email list (e.g. GitHub
   * `/user/emails`), fetched with the access token after userinfo. Its result is
   * passed to {@link profile} as `emails`, so the mapper can pick a *verified* address
   * rather than trusting an unverified `userinfo.email`.
   */
  userEmailsUrl?: string;
  /** Expected `iss` for id_token verification (OIDC). */
  issuer?: string;
  /** JWKS URL for id_token signature keys (OIDC). */
  jwksUrl?: string;
  /** Requested scopes. */
  scopes: string[];
  /** OAuth client id. */
  clientId: string;
  /** OAuth client secret. */
  clientSecret: string;
  /** Map the token/userinfo/claims result to a normalized {@link AuthUser}. */
  profile: (input: ProfileInput) => AuthUser;
  /** Extra authorization-request query params (e.g. `{ access_type: "offline" }`). */
  authorizationParams?: Record<string, string>;
  /**
   * Hosts `safeFetch` may reach for this provider (token/userinfo/jwks). Derived
   * from the configured endpoints when omitted.
   */
  allowedHosts?: string[];
}

/** A Credentials (e.g. email/password) provider. */
export interface CredentialsProvider {
  /** Provider id (the `[provider]` route segment), typically `"credentials"`. */
  id: string;
  /** Discriminant marking this as a credentials provider. */
  type: "credentials";
  /**
   * Validate submitted credentials and return the user, or `null` to reject.
   * MUST NOT leak whether an account exists, use a constant-time password compare,
   * and should be rate-limited by the app.
   */
  authorize: (
    credentials: Record<string, string>,
  ) => Promise<AuthUser | null> | AuthUser | null;
}

/** Any configured provider. */
export type AuthProvider = OAuthProvider | CredentialsProvider;

/** True for an OAuth/OIDC provider (vs. Credentials). */
export function isOAuthProvider(p: AuthProvider): p is OAuthProvider {
  return p.type === "oauth" || p.type === "oidc";
}

/** Callbacks that let an app veto or enrich a sign-in. */
export interface AuthCallbacks {
  /** Return false to deny a sign-in, or a modified user to enrich the session. */
  signIn?: (user: AuthUser, provider: string) => Promise<boolean | AuthUser> | boolean | AuthUser;
  /** Adjust the session payload before it is issued. */
  session?: (session: AuthSession) => Promise<AuthSession> | AuthSession;
}

/** Configuration for {@link ../auth/mod.ts | denextAuth}. */
export interface AuthConfig {
  /** Configured providers. */
  providers: AuthProvider[];
  /** HMAC signing secret(s) for the session cookie (rotate with an array). */
  secret: string | string[];
  /**
   * The app's canonical origin (e.g. `https://example.com`). REQUIRED in production
   * so the OAuth `redirect_uri` is byte-stable and immune to Host-header injection.
   */
  canonicalOrigin?: string;
  /** Optional sign-in/session callbacks. */
  callbacks?: AuthCallbacks;
  /** Session lifetime in seconds (default 7 days). */
  maxAge?: number;
  /** Where to send the user after sign-in / sign-out when no `callbackUrl` is given. */
  pages?: { signIn?: string; afterSignIn?: string; afterSignOut?: string };
  /**
   * DANGEROUS: permit `http://localhost` providers in development (bypasses the
   * SSRF localhost block for token/userinfo/jwks). Never enable in production.
   */
  dangerouslyAllowInsecureProviders?: boolean;
}
