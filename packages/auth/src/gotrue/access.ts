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

import type { AdapterUser } from "../adapter.ts";
import { isVerified } from "../adapter-link.ts";
import { isBanned } from "../ban.ts";
import { bearerTokenOf } from "../bearer-header.ts";
import { nativeAdapterOf } from "../native.ts";
import { snapshotAllowed, snapshotMethods } from "../sso-user.ts";
import type { AuthConfig, AuthSession } from "../types.ts";
import {
  installedSupabaseKeys,
  looksLikeJwt,
  type SupabaseJwtClaims,
  SupabaseKeyError,
  type SupabaseKeys,
  verifySupabaseJwt,
  type VerifySupabaseJwtOptions,
} from "@denext/denext/auth-kit";

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
 * factor (an `aal1` session of a user who must complete MFA). A user's token is refused while its
 * user is banned (at every use, not only through the revocation a ban performs); the stored user
 * read for that check is returned. An SSO user's token is refused unless its session was started
 * by the user's identity provider (`sso/saml`).
 *
 * `storedAmr` is what the session's stored family says it proved — the source of truth for
 * anything that depends on how the session started, since the custom access token hook may
 * rewrite the token's `amr` claim. It is `undefined` for a token with no stored session (no
 * `session_id`, or an adapter without session families) or a stored session that records none.
 *
 * @param keys The key material.
 * @param token The JWT.
 * @param config The auth config whose adapter holds the sessions (optional).
 * @param options The clock.
 * @returns The claims, whether the session is pending, the stored user (when read) and the
 *   stored session's methods (when there is one).
 * @throws {SupabaseKeyError} `bad_jwt` / `jwt_expired`, or `bad_jwt` for a dead session, a
 *   deleted user (`session not found`, with or without a `session_id`) or a banned user.
 */
export async function verifyAccessTokenSession(
  keys: SupabaseKeys,
  token: string,
  config?: AuthConfig | null,
  options: VerifySupabaseJwtOptions = {},
): Promise<VerifiedAccessToken> {
  const claims = await verifySupabaseJwt(keys, token, options);
  if (claims.role !== "authenticated") return { claims, pending: false };
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const snapshot = await liveFamilySnapshot(claims, config, now);
  const pending = claims.aal !== "aal2" && snapshot?.pending === true;
  const user = await liveUser(claims, config, now);
  // An SSO user's session its identity provider did not start is dead at every use, as at refresh.
  if (user && snapshot && !snapshotAllowed(user, snapshot)) throw sessionNotFound();
  const verified: VerifiedAccessToken = { claims, pending, user };
  if (Array.isArray(snapshot?.amr)) verified.storedAmr = snapshotMethods(snapshot);
  return verified;
}

const sessionNotFound = () => new SupabaseKeyError("bad_jwt", "invalid JWT: session not found");

/**
 * The stored snapshot of the token's session family (`session_id`), when the adapter keeps them:
 * refused unless the family is live and the token's user's. `undefined` with no `session_id` or
 * no session families.
 */
async function liveFamilySnapshot(
  claims: SupabaseJwtClaims,
  config: AuthConfig | null | undefined,
  now: number,
): Promise<FamilySnapshot | undefined> {
  const adapter = nativeAdapterOf(config?.adapter);
  if (typeof claims.session_id !== "string" || !adapter) return undefined;
  const family = await adapter.getNativeSession(claims.session_id);
  if (
    !family || family.revokedAt !== undefined || family.expiresAt <= now ||
    family.userId !== claims.sub
  ) {
    throw sessionNotFound();
  }
  return familySnapshot(family.session);
}

/**
 * The token's stored user, read fresh when there is an adapter. A deleted user's token is dead at
 * every use — one with no `session_id` (nothing revoked it) included — exactly as a revoked
 * session's is; a banned user's is refused while the ban lasts.
 */
async function liveUser(
  claims: SupabaseJwtClaims,
  config: AuthConfig | null | undefined,
  now: number,
): Promise<AdapterUser | undefined> {
  const adapter = config?.adapter;
  if (!adapter) return undefined;
  const user = typeof claims.sub === "string" ? await adapter.getUser(claims.sub) : undefined;
  if (!user) throw sessionNotFound();
  if (isBanned(user, now)) throw new SupabaseKeyError("bad_jwt", "invalid JWT: user is banned");
  return user;
}

/** What {@linkcode verifyAccessTokenSession} answers. */
export interface VerifiedAccessToken {
  /** The verified claims. */
  claims: SupabaseJwtClaims;
  /** The session still owes its second factor. */
  pending: boolean;
  /** The stored user, when read. */
  user?: AdapterUser;
  /** The stored session's `amr` methods (never the hook-writable claim), when there is one. */
  storedAmr?: string[];
}

/** What a session family's stored snapshot says about its session. */
interface FamilySnapshot {
  pending?: unknown;
  amr?: unknown;
  oauth?: unknown;
}

function familySnapshot(raw: string): FamilySnapshot {
  try {
    const value = JSON.parse(raw) as FamilySnapshot | null;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
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
 * The denext session an `authenticated` access token stands for. `user.emailVerified` is left
 * unset: the token's `user_metadata` is user-writable, so it is no evidence — read the stored
 * user for it (`auth()` does).
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
  // `emailVerified` never comes from `user_metadata`: the user writes that object
  // (`PUT /user { data }`). `sessionFromJwtBearer` reads it from the stored user instead.
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
    const { claims, pending, user: stored, storedAmr } = await verifyAccessTokenSession(
      keys,
      token,
      config,
    );
    if (claims.role !== "authenticated") return undefined;
    const session = sessionFromClaims(claims);
    if (stored) session.user.emailVerified = isVerified(stored.emailVerified);
    // How the session started is the stored family's word, not the (hook-writable) claim's.
    if (storedAmr) session.amr = storedAmr;
    // A session still owing its second factor fails closed in `auth()`, as a cookie one does.
    if (pending) session.mfaPending = true;
    return session;
  } catch {
    return null;
  }
}
