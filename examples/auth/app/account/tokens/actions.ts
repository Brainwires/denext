"use server";

// Mint and revoke bearer API tokens — the non-interactive credential a script or CI job
// presents as `Authorization: Bearer tok_…` instead of carrying a browser cookie.
//
// `issueApiToken` returns the plaintext ONCE and stores only its SHA-256, so nothing here
// (or anywhere) can show it again; it reaches the next render through a single-use
// server-side slot, never the redirect URL. denext also mounts JSON endpoints for the same
// job — POST/GET /auth/tokens, DELETE /auth/tokens/:id, cookie-session only — which is what
// a JavaScript client would call; these actions are the no-JS path.

import { redirect } from "denext";
import {
  auth,
  type AuthSession,
  issueApiToken,
  listApiTokens,
  revokeApiToken,
} from "denext/server";
import { authConfig } from "../../../lib/auth-config.ts";
import { onceKey, stashOnce } from "../../../lib/once.ts";

/** Where both actions land. */
const PAGE = "/account/tokens";

/** Longest label we store, and how long a new token lives. */
const MAX_LABEL = 64;
const LIFETIME_SECONDS = 90 * 24 * 60 * 60;

/** The signed-in session, or a redirect to the login page. */
async function requireSession(): Promise<AuthSession> {
  const session = await auth();
  if (!session) redirect(`/login?callbackUrl=${encodeURIComponent(PAGE)}`);
  return session!;
}

/** Mint a token for the signed-in user and stash the plaintext for one render. */
export async function createToken(formData: FormData): Promise<void> {
  const session = await requireSession();
  const label = String(formData.get("label") ?? "").trim().slice(0, MAX_LABEL);
  const issued = await issueApiToken(authConfig, {
    userId: session.user.id,
    name: label || "untitled",
    // Scopes are strings this app defines; `requireBearer(config, { scope })` matches them
    // any-of, and a token with none satisfies no scoped endpoint.
    scopes: ["me:read"],
    expiresInSeconds: LIFETIME_SECONDS,
  });
  stashOnce(onceKey(session), issued.token);
  redirect(`${PAGE}?created=1`);
}

/** Revoke one of the caller's own tokens — immediately, and permanently. */
export async function revokeToken(formData: FormData): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get("tokenId") ?? "");
  // Prove ownership by finding the id among the caller's own live tokens: an id that isn't
  // theirs is answered exactly like an unknown one, so this never confirms a token exists.
  const own = await listApiTokens(authConfig, session.user.id);
  if (!own.some((token) => token.id === id)) redirect(`${PAGE}?error=unknown`);
  await revokeApiToken(authConfig, id);
  redirect(`${PAGE}?revoked=1`);
}
