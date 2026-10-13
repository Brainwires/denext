/**
 * Supabase access tokens as denext sessions: `Authorization: Bearer <jwt>` minted by the
 * `/auth/v1` endpoints is a session `auth()` reads, exactly as a native `nat_…` token is — one
 * user store, two ways to present it.
 *
 * Every verification re-reads the token's session (`session_id`, a native session family) when
 * the adapter keeps them, so signing out or revoking a session ends its access tokens at once,
 * not at their expiry.
 *
 * @module
 */

import { bearerTokenOf } from "../bearer-header.ts";
import { nativeAdapterOf } from "../native.ts";
import type { AuthConfig, AuthSession } from "../types.ts";
import {
  installedSupabaseKeys,
  looksLikeJwt,
  type SupabaseJwtClaims,
  SupabaseKeyError,
  type SupabaseKeys,
  verifySupabaseJwt,
  type VerifySupabaseJwtOptions,
} from "./keys.ts";

/**
 * The JWT an `Authorization: Bearer` header carries, or `undefined` for none (another scheme,
 * a native `nat_…` token, an opaque API key).
 *
 * @param header The `Authorization` header.
 * @returns The JWT.
 */
export function jwtBearerOf(header: string | null | undefined): string | undefined {
  const token = bearerTokenOf(header);
  return token && looksLikeJwt(token) ? token : undefined;
}

/**
 * Verify a Supabase JWT and, for a user's access token, that its session is still live (when
 * the adapter keeps sessions): not revoked, not expired, the same user.
 *
 * @param keys The key material.
 * @param token The JWT.
 * @param config The auth config whose adapter holds the sessions (optional).
 * @param options The clock.
 * @returns The claims.
 * @throws {SupabaseKeyError} `bad_jwt` / `jwt_expired`, or `bad_jwt` for a dead session.
 */
export async function verifyAccessToken(
  keys: SupabaseKeys,
  token: string,
  config?: AuthConfig | null,
  options: VerifySupabaseJwtOptions = {},
): Promise<SupabaseJwtClaims> {
  return (await verifyAccessTokenSession(keys, token, config, options)).claims;
}

/**
 * {@linkcode verifyAccessToken}, also saying whether the token's session still owes a second
 * factor (an `aal1` session of a user who must complete MFA).
 *
 * @param keys The key material.
 * @param token The JWT.
 * @param config The auth config whose adapter holds the sessions (optional).
 * @param options The clock.
 * @returns The claims, and whether the session is pending.
 * @throws {SupabaseKeyError} `bad_jwt` / `jwt_expired`, or `bad_jwt` for a dead session.
 */
async function verifyAccessTokenSession(
  keys: SupabaseKeys,
  token: string,
  config?: AuthConfig | null,
  options: VerifySupabaseJwtOptions = {},
): Promise<{ claims: SupabaseJwtClaims; pending: boolean }> {
  const claims = await verifySupabaseJwt(keys, token, options);
  if (claims.role !== "authenticated" || typeof claims.session_id !== "string") {
    return { claims, pending: false };
  }
  const adapter = nativeAdapterOf(config?.adapter);
  if (!adapter) return { claims, pending: false };
  const family = await adapter.getNativeSession(claims.session_id);
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (
    !family || family.revokedAt !== undefined || family.expiresAt <= now ||
    family.userId !== claims.sub
  ) {
    throw new SupabaseKeyError("bad_jwt", "invalid JWT: session not found");
  }
  return { claims, pending: claims.aal !== "aal2" && snapshotPending(family.session) };
}

function snapshotPending(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { pending?: unknown }).pending === true;
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The denext session an `authenticated` access token stands for.
 *
 * @param claims Verified claims (`role: "authenticated"`).
 * @returns The session.
 */
export function sessionFromClaims(claims: SupabaseJwtClaims): AuthSession {
  const session: AuthSession = {
    user: userFromClaims(claims),
    provider: str(record(claims.app_metadata).provider) ?? "supabase",
    expiresAt: claims.exp,
    v: 2,
    amr: amrMethods(claims.amr),
  };
  if (typeof claims.iat === "number") session.issuedAt = claims.iat;
  const authTime = Array.isArray(claims.amr)
    ? claims.amr.map((entry) => record(entry).timestamp).find((t) => typeof t === "number")
    : undefined;
  if (typeof authTime === "number") session.authTime = authTime;
  // A bearer session is never slid and sets no cookie — the same marker a native one carries.
  session.nativeSessionId = str(claims.session_id) ?? `jwt:${claims.sub}`;
  return session;
}

/** The `amr` claim's method names (entries may be strings or `{ method }` objects). */
function amrMethods(amr: unknown): string[] {
  if (!Array.isArray(amr)) return [];
  return amr.map((entry) => typeof entry === "string" ? entry : str(record(entry).method))
    .filter((m): m is string => m !== undefined);
}

/** The session user an access token names. */
function userFromClaims(claims: SupabaseJwtClaims): AuthSession["user"] {
  const app = record(claims.app_metadata);
  const meta = record(claims.user_metadata);
  const roles = Array.isArray(app.roles)
    ? app.roles.filter((r): r is string => typeof r === "string")
    : undefined;
  const user: AuthSession["user"] = { id: claims.sub! };
  const email = str(claims.email);
  const name = str(meta.name) ?? str(meta.full_name);
  const image = str(meta.avatar_url) ?? str(meta.picture);
  if (email) user.email = email;
  if (name) user.name = name;
  if (image) user.image = image;
  if (typeof meta.email_verified === "boolean") user.emailVerified = meta.email_verified;
  if (roles) user.roles = roles;
  return user;
}

/**
 * The session a JWT bearer stands for, as `auth()` reads it: `undefined` when the bearer is
 * not a user's token (no keys installed, or an `anon` / `service_role` key — the cookie path
 * then decides), `null` when it is refused (signed out: an invalid bearer never falls back to
 * the cookie).
 *
 * @param config The auth config.
 * @param token The JWT.
 * @returns The session, `null`, or `undefined`.
 */
export async function sessionFromJwtBearer(
  config: AuthConfig,
  token: string,
): Promise<AuthSession | null | undefined> {
  const keys = installedSupabaseKeys();
  if (!keys) return undefined;
  try {
    const { claims, pending } = await verifyAccessTokenSession(keys, token, config);
    if (claims.role !== "authenticated") return undefined;
    const session = sessionFromClaims(claims);
    // A session still owing its second factor fails closed in `auth()`, as a cookie one does.
    if (pending) session.mfaPending = true;
    return session;
  } catch {
    return null;
  }
}
