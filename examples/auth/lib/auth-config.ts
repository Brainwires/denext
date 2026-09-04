// The denextAuth configuration: a Credentials provider backed by scrypt password
// hashes, brute-force protection on the login endpoint, and the opt-in sqlite session
// store that makes sessions revocable ("sign out everywhere"). An OIDC provider is
// sketched below — fill in the issuer + client credentials to enable it.

import {
  type AuthConfig,
  credentials,
  // oidc,
  sqliteSessionStore,
  verifyPassword,
} from "denext/server";
import { findUserByEmail, type UserRow } from "./db.ts";

const memory = Deno.env.get("AUTH_DB") === ":memory:";

/** The stored hash for a row that may not exist — "" makes verifyPassword return false. */
const storedHash = (row: UserRow | undefined): string => row?.password_hash ?? "";

/** The non-sensitive identity denext keeps in the session. */
const authUser = (row: UserRow) => ({
  id: String(row.id),
  email: row.email,
  name: row.name,
});

export const authConfig: AuthConfig = {
  // A long random secret from the environment in production (`openssl rand -base64 32`);
  // the fallback keeps the demo runnable with no setup. Under NODE_ENV=production a
  // secret shorter than 32 chars is refused outright.
  secret: Deno.env.get("AUTH_SECRET") ??
    "dev-only-secret-change-me-before-deploying-1",
  // Required in production so the OAuth redirect_uri never derives from the Host header.
  canonicalOrigin: Deno.env.get("CANONICAL_ORIGIN"),
  pages: { signIn: "/login", afterSignIn: "/dashboard", afterSignOut: "/" },

  // Brute-force protection (on by default; shown here to make the limits visible):
  // 5 failed attempts per client IP + email per 15 minutes → a generic 429.
  rateLimit: { max: 5, windowMs: 15 * 60_000 },

  // Opt-in revocable sessions: the cookie carries only a random id; the payload lives in
  // this sqlite file, so `revokeSession` / `revokeAllSessions` end sessions at once.
  // (Omit `sessionStore` for the default stateless signed cookie.)
  sessionStore: sqliteSessionStore({
    path: memory ? ":memory:" : "sessions.db",
  }),

  providers: [
    credentials({
      // Never reveal whether the account exists: an unknown email and a wrong password
      // take the same path (verifyPassword runs either way and returns false on "").
      authorize: async ({ email = "", password = "" }) => {
        const row = findUserByEmail(email.trim().toLowerCase());
        const ok = await verifyPassword(password, storedHash(row));
        return ok ? authUser(row!) : null;
      },
    }),
    // oidc({
    //   id: "corp",
    //   issuer: "https://login.example.com",
    //   authorizationUrl: "https://login.example.com/oauth2/authorize",
    //   tokenUrl: "https://login.example.com/oauth2/token",
    //   jwksUrl: "https://login.example.com/.well-known/jwks.json",
    //   clientId: Deno.env.get("OIDC_CLIENT_ID")!,
    //   clientSecret: Deno.env.get("OIDC_CLIENT_SECRET")!,
    // }),
  ],
};
