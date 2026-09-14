// A DEMO auth setup (in-memory, not for production) built on denext's FIRST-PARTY bearer API
// tokens — nothing here is hand-rolled:
//
//   issueApiToken(...)   mints `tok_…` and stores only its SHA-256 (the plaintext is returned once)
//   requireBearer(...)   API middleware: verifies `Authorization: Bearer …`, 401 otherwise, AND
//                        documents the requirement (it is tagged with `documentsSecurity`)
//
// Tokens live in an `inMemoryAuthAdapter()` — swap it for `sqliteAuthAdapter({ path })` and the
// same tokens survive a restart. `authConfig` is what `denext.config.ts` hands `denextAuth()`,
// which also mounts `/auth/tokens` so a signed-in user can mint and revoke their own tokens.

import {
  type AuthConfig,
  createApi,
  credentials,
  inMemoryAuthAdapter,
  issueApiToken,
  requireBearer,
} from "denext/server";

// The one demo account. A real app checks a database + a password hash (`verifyPassword`).
const DEMO = { username: "demo", password: "denext", email: "demo@example.com" };

const adapter = inMemoryAuthAdapter();

/**
 * The demo user's adapter id, created on first use. (A real app creates users when they sign
 * up; this "create if missing" shortcut is fine for a single-process demo.)
 */
async function demoUserId(): Promise<string> {
  const existing = await adapter.getUserByEmail(DEMO.email);
  if (existing) return existing.id;
  const created = await adapter.createUser({
    email: DEMO.email,
    name: "Demo user",
    emailVerified: Math.floor(Date.now() / 1000),
    roles: ["demo"],
  });
  return created.id;
}

/** Whether the submitted demo credentials are right. */
export function checkCredentials(username: string, password: string): boolean {
  return username === DEMO.username && password === DEMO.password;
}

/**
 * Mint a one-hour bearer token for the demo user, scoped to the writes. The returned string is
 * the only copy that will ever exist — only its hash is stored.
 */
export async function issueDemoToken(): Promise<string> {
  const { token } = await issueApiToken(authConfig, {
    userId: await demoUserId(),
    name: "swagger-ui",
    scopes: ["pets:write"],
    expiresInSeconds: 60 * 60,
  });
  return token;
}

/** The auth config `denext.config.ts` passes to `denextAuth()` — and the token store. */
export const authConfig = {
  secret: Deno.env.get("AUTH_SECRET") ?? "example-only-demo-secret-at-least-32-characters",
  canonicalOrigin: Deno.env.get("AUTH_ORIGIN") ?? "http://localhost:3000",
  adapter,
  // A cookie login, so `/auth/tokens` (mint/list/revoke) has a session to work with. The
  // Swagger flow below doesn't need it — POST /api/login hands out a token directly.
  providers: [
    credentials({
      authorize: async ({ username, password }) =>
        checkCredentials(username ?? "", password ?? "")
          ? { id: await demoUserId(), email: DEMO.email, emailVerified: true }
          : null,
    }),
  ],
} satisfies AuthConfig;

/**
 * Build protected endpoints with `authed.define(def, handler)`: the token is verified first
 * (401), must carry the `pets:write` scope (403), and the operation is marked secured in the
 * OpenAPI document automatically. Handlers get `ctx.token` / `ctx.user` / `ctx.session`.
 */
export const authed = createApi().use(requireBearer(authConfig, { scope: "pets:write" }));
