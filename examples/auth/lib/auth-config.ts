// The denextAuth configuration, in one object:
//
//   adapter    where users, linked accounts, password hashes and API tokens are persisted
//   session    database-backed (revocable) sessions + a sliding expiry
//   providers  email/password, plus a corporate OIDC provider when the env says so
//   rateLimit  brute-force protection on the login endpoint
//   events     the audit trail (lib/audit.ts), and `logger` for what auth would swallow
//
// `denext.config.ts` hands this object to `denextAuth()`, which mounts `/auth/*`; the app
// imports the same object wherever it mints or revokes an API token.

import {
  type AuthConfig,
  type AuthProvider,
  type AuthUser,
  credentials,
  oidc,
} from "denext/server";
import { authEvents, authLogger } from "./audit.ts";
import { adapter, checkPassword, CREDENTIALS, findUser } from "./users.ts";

export const authConfig: AuthConfig = {
  // A long random secret from the environment (`openssl rand -base64 32`); the public
  // fallback keeps the demo runnable with no setup but is refused in production — a
  // known secret would let anyone forge sessions.
  secret: authSecret(),
  // Required in production so the OAuth redirect_uri never derives from the Host header.
  canonicalOrigin: Deno.env.get("CANONICAL_ORIGIN"),
  pages: { signIn: "/login", afterSignIn: "/dashboard", afterSignOut: "/" },

  // Brute-force protection (on by default; shown here to make the limits visible):
  // 5 failed attempts per client IP + email per 15 minutes → a generic 429.
  rateLimit: { max: 5, windowMs: 15 * 60_000 },

  // Everything durable lives in one sqlite file (see lib/users.ts). Passing an adapter does
  // NOT make sessions stateful by itself — that is the `session` block below.
  adapter,

  // Revocable sessions: the cookie carries only a random id and the payload lives in the
  // adapter's `sessions` table, so `revokeSession` / `revokeAllSessions` end sessions at
  // once. `updateAge` slides an active session's expiry forward at most hourly (on the
  // paths that own their response: GET /auth/session, requireAuth, requireSession), so a
  // user who keeps working is never logged out mid-session while an idle one still expires.
  session: { strategy: "database", updateAge: 60 * 60 },

  events: authEvents,
  logger: authLogger,

  providers: [
    credentials({
      // Never reveal whether the account exists: an unknown email and a wrong password
      // take the same path (verifyPassword runs either way and returns false on "").
      authorize: ({ email = "", password = "" }) => sessionUser(email, password),
    }),
    ...corporateOidc(),
  ],
};

/** The session user for a submitted email + password, or `null` to refuse. */
async function sessionUser(email: string, password: string): Promise<AuthUser | null> {
  const user = await findUser(email);
  const ok = await checkPassword(user, password);
  if (!ok || !user) return null;
  // The id is the ADAPTER's, matching the `credentials` account row registration linked —
  // so the sign-in resolves by account and the session carries the stored roles.
  return { id: user.id, email: user.email, name: user.name, roles: user.roles };
}

/**
 * The corporate OIDC provider — present only when the three `OIDC_*` variables are set, so
 * the example runs with no configuration at all.
 *
 * The issuer alone is enough: denext reads the authorization/token/JWKS endpoints from
 * `<issuer>/.well-known/openid-configuration` (OIDC discovery), pins the request to the
 * issuer's host, refuses a document that names a different issuer, and caches the JWKS.
 *
 * @returns The provider list to spread into `providers` — one provider, or none.
 */
function corporateOidc(): AuthProvider[] {
  const issuer = Deno.env.get("OIDC_ISSUER");
  const clientId = Deno.env.get("OIDC_CLIENT_ID");
  const clientSecret = Deno.env.get("OIDC_CLIENT_SECRET");
  if (!issuer || !clientId || !clientSecret) return [];
  // Sign-in starts at /auth/signin/corp and returns to /auth/callback/corp. With the
  // adapter configured, a first corporate login creates the user and links the account —
  // unless the address already belongs to a password account whose email nobody verified,
  // which denext refuses (`account_not_linked`) rather than hand the account over.
  return [oidc({ id: "corp", issuer, clientId, clientSecret })];
}

/** `AUTH_SECRET`, or the demo's public fallback — never the fallback in production. */
function authSecret(): string {
  const secret = Deno.env.get("AUTH_SECRET");
  if (secret) return secret;
  const prod = Deno.env.get("NODE_ENV") === "production" ||
    Deno.env.get("DENEXT_ENV") === "production";
  if (prod) throw new Error("AUTH_SECRET must be set in production (openssl rand -base64 32)");
  return "dev-only-secret-change-me-before-deploying-1";
}

/** The OAuth/OIDC providers a sign-in page should offer buttons for (never Credentials). */
export function oauthProviders(): AuthProvider[] {
  return authConfig.providers.filter((provider) => provider.id !== CREDENTIALS);
}
