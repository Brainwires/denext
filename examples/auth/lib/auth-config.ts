// The denextAuth configuration, in one object:
//
//   adapter    where users, linked accounts, password hashes, API tokens, emailed tokens
//              and TOTP factors are persisted
//   session    database-backed (revocable) sessions + a sliding expiry
//   providers  email/password, a magic sign-in link, plus a corporate OIDC provider when
//              the env says so
//   email      the emailed-token flows (verification, reset, magic link) and their mailer
//   mfa        the TOTP second factor
//   rateLimit  brute-force protection on the login endpoint
//   events     the audit trail (lib/audit.ts), and `logger` for what auth would swallow
//
// `denext.config.ts` hands this object to `denextAuth()`, which mounts `/auth/*`; the app
// imports the same object wherever it calls an auth flow itself (API tokens, TOTP, the
// verification email).

import { type AuthConfig, type AuthProvider, credentials, magicLink, oidc } from "denext/server";
import { authEvents, authLogger } from "./audit.ts";
import { isProduction } from "./env.ts";
import { devMailer } from "./outbox.ts";
import { adapter } from "./users.ts";

export const authConfig: AuthConfig = {
  // A long random secret from the environment (`openssl rand -base64 32`); the public
  // fallback keeps the demo runnable with no setup but is refused in production — a
  // known secret would let anyone forge sessions.
  secret: authSecret(),
  // Required in production so the OAuth redirect_uri — and every emailed link — never
  // derives from the Host header.
  canonicalOrigin: Deno.env.get("CANONICAL_ORIGIN"),
  pages: {
    signIn: "/login",
    afterSignIn: "/dashboard",
    afterSignOut: "/",
    // A password (or magic-link) sign-in by a user with a confirmed TOTP factor lands
    // here, holding a PENDING session that `auth()` reads as signed out.
    mfa: "/mfa",
    // "Check your email": after a reset or magic-link request, and where the
    // verification link reports `?verified=1`.
    verifyRequest: "/check-email",
  },

  // Brute-force protection (on by default; shown here to make the limits visible):
  // 5 failed attempts per client IP + email per 15 minutes → a generic 429. The emailed
  // flows (3 sends per address per 15 minutes) and the second factor (5 attempts per
  // user per 5 minutes) have their own budgets, on by default too.
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

  // Every emailed token goes through this one function. The development mailer keeps the
  // message for /dev/outbox and prints the link; production needs a real one (see the file).
  sendVerificationRequest: devMailer,
  email: {
    // The reset link opens OUR page (app/reset/page.tsx), which posts the new password to
    // /auth/reset/confirm. The verification link keeps the default, /auth/verify, which
    // marks the address verified and redirects to `pages.verifyRequest` with ?verified=1.
    resetPath: "/reset",
  },
  // TOTP: users who enrolled (on /account/security) are asked for a code at every sign-in.
  // `required: "always"` would ask EVERYONE, sending a user without a factor to enrol first.
  mfa: { required: "enrolled" },

  events: authEvents,
  logger: authLogger,

  providers: [
    // No `authorize`: the built-in check looks the address up with the adapter's
    // `getUserByEmail`, verifies the password against `getCredential` with the configured
    // hasher (scrypt — what `hashPassword` writes at registration), and never reveals
    // whether the account exists: an unknown address costs the same verify as a real one.
    credentials(),
    // "Email me a sign-in link": POST /auth/callback/email mails a single-use link (10
    // minutes); opening it signs the mailbox's owner in — or, for an address with no
    // account, creates a verified one.
    magicLink(),
    ...corporateOidc(),
  ],
};

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
  if (isProduction()) {
    throw new Error("AUTH_SECRET must be set in production (openssl rand -base64 32)");
  }
  return "dev-only-secret-change-me-before-deploying-1";
}

/** The OAuth/OIDC providers a sign-in page should offer buttons for (never Credentials or email). */
export function oauthProviders(): AuthProvider[] {
  return authConfig.providers.filter((provider) =>
    provider.type === "oauth" || provider.type === "oidc"
  );
}
