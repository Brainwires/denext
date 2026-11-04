// Who a storage request acts as: `service_role` (the secret key), `authenticated` (a user's
// access token or denext session) or `anon`. Every storage entry point — the Supabase-compatible
// `/storage/v1` routes, the TUS endpoint and the server API — resolves the request's identity
// here, once, through the backend's shared `resolveIdentity` (API keys and Supabase access tokens
// with `backend({ supabase })`, else the denext session), and both authorization modes read it:
// a bucket's TypeScript `authorize` gets its session and claims, and the SQL-RLS mode runs its
// `storage.objects` / `storage.buckets` statements as that role with those claims.

import { auth, type AuthSession } from "@denext/denext/server";
import { sessionFromClaims } from "@denext/auth";
import type { SupabaseJwtClaims } from "@denext/denext/server";
import { hasDenextAuth, type RequestIdentity, resolveIdentity } from "./identity.ts";

/** The role a storage request runs as — Supabase's names. */
export type StorageRole = "anon" | "authenticated" | "service_role";

/** A storage request's resolved identity. */
export interface StorageIdentity {
  /** The role. */
  role: StorageRole;
  /** The claims (`request.jwt.claims` under SQL-RLS; `auth.uid()` reads `sub`). */
  claims: Record<string, unknown>;
  /** The user's id (`claims.sub`), for `authenticated`. */
  userId?: string;
  /** Where it came from: a Supabase access token, an API key, the denext session, or nothing. */
  source: "jwt" | "api_key" | "session" | "none";
  /** The denext session behind it, when it is one (`auth()`); else `null`. */
  session: AuthSession | null;
}

/** The service identity (`{ service: true }` on the server). */
export const SERVICE_IDENTITY: StorageIdentity = Object.freeze({
  role: "service_role",
  claims: Object.freeze({ role: "service_role" }),
  source: "none",
  session: null,
}) as StorageIdentity;

/**
 * Resolve a request's identity. A credential that is presented and refused (an expired or
 * forged token, an unknown API key) rejects with the backend's `IdentityError` (401).
 *
 * @param request The request being served.
 * @returns The identity.
 */
export async function storageIdentity(request: Request): Promise<StorageIdentity> {
  const identity = await resolveIdentity(request);
  return { ...identity, session: identity.session ?? await jwtSession(identity) };
}

/**
 * The session behind a supabase-js caller's access token, as `auth()` reads it — so a bucket's
 * `authorize: ({ session }) => !!session` admits a signed-in supabase-js user exactly as it
 * admits a cookie session. With `denextAuth()` configured the token goes through `auth()` (a
 * revoked session, or one still owing its second factor, is `null`); without it the verified
 * claims are the session.
 */
async function jwtSession(identity: RequestIdentity): Promise<AuthSession | null> {
  if (identity.source !== "jwt" || identity.role !== "authenticated") return null;
  if (!hasDenextAuth()) return sessionFromClaims(identity.claims as SupabaseJwtClaims);
  const session = await auth().catch(() => null);
  return session && session.user.id === identity.userId ? session : null;
}
