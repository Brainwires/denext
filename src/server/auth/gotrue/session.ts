/**
 * `/auth/v1` sessions: a session is a native session family in the adapter (the same records
 * `denextAuth({ native })` keeps), its access token a Supabase-shaped JWT, its refresh token
 * `<family>.<generation>.<mac>`.
 *
 * - The refresh token's MAC covers the family, the generation and a per-family salt that never
 *   leaves the server, under the auth `secret` and a MAC domain of its own. A refresh advances
 *   the generation by compare-and-swap; presenting an OLDER generation with a valid MAC is a
 *   replay and revokes the whole family (GoTrue's reuse detection) — except within
 *   `refreshTokenReuseInterval` seconds of the rotation that consumed it, when the same refresh
 *   token is answered again (two tabs refreshing at once). A forged token never touches the
 *   family.
 * - Every access token is minted from the user record as it is NOW (so a metadata change shows
 *   up at the next refresh), carries `session_id` (the family), `aal` and `amr`, and passes
 *   through the custom access token hook. `auth()` / `resolveIdentity()` re-check the family on
 *   every request, so a signed-out session's tokens stop at once.
 *
 * @module
 */

import { hmacSign, hmacVerify } from "../../session.ts";
import { authSecrets } from "../totp-seal.ts";
import type { AdapterUser, NativeSessionRecord } from "../adapter.ts";
import { type NativeAdapter, nativeAdapterOf } from "../native.ts";
import { randomToken } from "../oauth.ts";
import { resolveAuthOptions } from "../options.ts";
import type { AuthConfig } from "../types.ts";
import { GoTrueError } from "./errors.ts";
import { signSupabaseJwt, type SupabaseKeys } from "./keys.ts";
import type { GoTrueOptions } from "./options.ts";
import { factorsJson } from "./factors.ts";
import { appMetadataOf, identitiesOf, userJson, userMetadataOf } from "./user.ts";

/** The MAC domain of a `/auth/v1` refresh token. */
const REFRESH_DOMAIN = "denext.gotrue.refresh.v1";

/** One authentication method a session proved, as the `amr` claim lists it. */
export interface AmrEntry {
  /** `password`, `otp`, `oauth`, `anonymous`, `totp`, `mfa/phone`, `sso/saml`, … */
  method: string;
  /** When, epoch seconds. */
  timestamp: number;
  /** The provider, for `oauth`. */
  provider?: string;
}

/** The SAML origin of a session: what Single Logout needs to name it to the IdP and back. */
export interface SsoSessionInfo {
  /** The SSO provider id. */
  providerId: string;
  /** The assertion's NameID. */
  nameId: string;
  /** Its Format, when given. */
  nameIdFormat?: string;
  /** The AuthnStatement's SessionIndex, when given. */
  sessionIndex?: string;
}

/** What a family stores about its session. */
interface GoTrueSnapshot {
  /** Marks a `/auth/v1` family. */
  gotrue: 1;
  /** The user (id only — the record is re-read at every mint). */
  user: { id: string };
  /** The first-factor provider. */
  provider: string;
  /** The methods proven, in order. */
  amr: AmrEntry[];
  /** `aal2` once a second factor was verified in this session. */
  aal: "aal1" | "aal2";
  /** The SAML origin, for a session a SAML assertion started. */
  sso?: SsoSessionInfo;
}

/** Everything the session functions need. */
export interface SessionContext {
  /** The auth config (adapter, secret). */
  config: AuthConfig;
  /** The `/auth/v1` options. */
  options: GoTrueOptions;
  /** The JWT keys. */
  keys: SupabaseKeys;
  /** The issuer (`<origin>/auth/v1`). */
  issuer: string;
}

/** GoTrue's session response. */
export interface GoTrueSessionJson {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  expires_at: number;
  refresh_token: string;
  user: Record<string, unknown>;
}

const now = (): number => Math.floor(Date.now() / 1000);
const secrets = (config: AuthConfig): string[] => authSecrets(config.secret);

/** The adapter's session-family group, or a 500: `/auth/v1` sessions need it. */
export function familiesOf(config: AuthConfig): NativeAdapter {
  const adapter = nativeAdapterOf(config.adapter);
  if (!adapter) {
    throw new GoTrueError(
      500,
      "unexpected_failure",
      "the auth adapter keeps no session families (use sqliteAuthAdapter, postgresAuthAdapter " +
        "or backendAuthAdapter)",
    );
  }
  return adapter;
}

function jwtExpiry(options: GoTrueOptions): number {
  const value = options.jwtExpiry ?? 3600;
  return Number.isFinite(value) ? Math.min(7 * 86_400, Math.max(30, Math.floor(value))) : 3600;
}

function reuseInterval(options: GoTrueOptions): number {
  const value = options.refreshTokenReuseInterval ?? 10;
  return Number.isFinite(value) ? Math.min(60, Math.max(0, Math.floor(value))) : 10;
}

/** The family's lifetime: the auth `session.maxLifetime` (default 30 days), sliding. */
function familyLifetime(config: AuthConfig): number {
  return resolveAuthOptions(config).maxLifetime;
}

function parseSnapshot(raw: string): GoTrueSnapshot | null {
  try {
    const value = JSON.parse(raw) as GoTrueSnapshot;
    return value?.gotrue === 1 && typeof value.user?.id === "string" && Array.isArray(value.amr)
      ? value
      : null;
  } catch {
    return null;
  }
}

/**
 * The session a family stands for, when it is a live `/auth/v1` family of `userId`.
 *
 * @param config The auth config.
 * @param familyId The family (`session_id`).
 * @param userId The user the caller authenticated as.
 * @returns The family and its snapshot, or `null`.
 */
async function liveFamily(
  config: AuthConfig,
  familyId: string,
  userId: string,
): Promise<{ family: NativeSessionRecord; snapshot: GoTrueSnapshot } | null> {
  const family = await familiesOf(config).getNativeSession(familyId);
  if (!family || family.revokedAt !== undefined || family.expiresAt <= now()) return null;
  if (family.userId !== userId) return null;
  const snapshot = parseSnapshot(family.session);
  return snapshot ? { family, snapshot } : null;
}

/** Whether a user is banned right now. */
function isBanned(user: AdapterUser): boolean {
  return typeof user.bannedUntil === "number" && user.bannedUntil > now();
}

/**
 * Mint an access token for `user` in `family`, as of `issued`.
 *
 * @param ctx The session context.
 * @param user The user record (read fresh).
 * @param family The session family.
 * @param snapshot Its snapshot.
 * @param issued Issue time, epoch seconds.
 * @returns The token and its expiry.
 */
async function mintAccessToken(
  ctx: SessionContext,
  user: AdapterUser,
  family: NativeSessionRecord,
  snapshot: GoTrueSnapshot,
  issued: number,
): Promise<{ token: string; expiresIn: number; expiresAt: number }> {
  const adapter = ctx.config.adapter!;
  const identities = await identitiesOf(adapter, user);
  const expiresIn = jwtExpiry(ctx.options);
  const fixed = {
    sub: user.id,
    aud: "authenticated",
    role: "authenticated",
    iat: issued,
    exp: issued + expiresIn,
    aal: snapshot.aal,
    session_id: family.id,
    is_anonymous: user.isAnonymous === true,
  };
  let claims: Record<string, unknown> = {
    iss: ctx.issuer,
    ...fixed,
    email: user.email ?? "",
    phone: user.phone ?? "",
    app_metadata: appMetadataOf(user, identities),
    user_metadata: userMetadataOf(user),
    amr: snapshot.amr.map(({ method, timestamp, provider }) =>
      provider ? { method, timestamp, provider } : { method, timestamp }
    ),
  };
  const hook = ctx.options.hooks?.customAccessToken;
  if (hook) {
    const result = await hook({
      user_id: user.id,
      claims: structuredClone(claims),
      authentication_method: snapshot.amr[snapshot.amr.length - 1]?.method ?? "password",
    });
    if (!result || typeof result.claims !== "object" || result.claims === null) {
      throw new GoTrueError(500, "unexpected_failure", "custom access token hook failed");
    }
    // The hook may add claims; it may not change who the token is for or how long it lives.
    claims = { ...result.claims, ...fixed };
  }
  return { token: await signSupabaseJwt(ctx.keys, claims), expiresIn, expiresAt: fixed.exp };
}

function refreshInput(family: NativeSessionRecord, generation: number): string {
  return `${family.id}.${generation}.${family.salt}`;
}

async function refreshToken(
  config: AuthConfig,
  family: NativeSessionRecord,
  generation: number,
): Promise<string> {
  const mac = await hmacSign(refreshInput(family, generation), secrets(config)[0], REFRESH_DOMAIN);
  return `${family.id}.${generation}.${mac}`;
}

/** The full session response for a family at its current generation. */
async function sessionJson(
  ctx: SessionContext,
  user: AdapterUser,
  family: NativeSessionRecord,
  snapshot: GoTrueSnapshot,
  issued: number,
): Promise<GoTrueSessionJson> {
  const access = await mintAccessToken(ctx, user, family, snapshot, issued);
  return {
    access_token: access.token,
    token_type: "bearer",
    expires_in: access.expiresIn,
    expires_at: access.expiresAt,
    refresh_token: await refreshToken(ctx.config, family, family.generation),
    user: await userJson(ctx.config.adapter!, user, {
      factors: await factorsJson(ctx.config, user.id),
    }),
  };
}

/** How long the SAML origin of a session is kept for Single Logout, seconds. */
const SSO_SESSION_RECORD_TTL = 400 * 86_400;

/** Remember a SAML session's family for IdP-initiated Single Logout (when the adapter can). */
async function recordSso(
  config: AuthConfig,
  family: NativeSessionRecord,
  sso: SsoSessionInfo | undefined,
): Promise<void> {
  const adapter = config.adapter;
  if (!sso || typeof adapter?.createSsoSession !== "function") return;
  await adapter.createSsoSession({
    sessionId: family.id,
    providerId: sso.providerId,
    nameId: sso.nameId,
    ...(sso.sessionIndex !== undefined && { sessionIndex: sso.sessionIndex }),
    userId: family.userId,
    expiresAt: family.createdAt + SSO_SESSION_RECORD_TTL,
  });
}

/**
 * The SAML origin of a session family, when a SAML assertion started it.
 *
 * @param config The auth config.
 * @param familyId The family (`session_id`).
 * @returns The SAML origin, or `undefined`.
 */
export async function ssoOriginOf(
  config: AuthConfig,
  familyId: string,
): Promise<SsoSessionInfo | undefined> {
  const family = await familiesOf(config).getNativeSession(familyId);
  return family ? parseSnapshot(family.session)?.sso : undefined;
}

/**
 * Start a session for a user who just authenticated: a new family, its first token pair. Stamps
 * `lastSignInAt` on the user.
 *
 * @param ctx The session context.
 * @param user The user.
 * @param amr How they authenticated.
 * @param sso The SAML origin, for a SAML sign-in (kept for Single Logout).
 * @returns The session response.
 * @throws {GoTrueError} `user_banned` for a banned user.
 */
export async function startSession(
  ctx: SessionContext,
  user: AdapterUser,
  amr: AmrEntry,
  sso?: SsoSessionInfo,
): Promise<GoTrueSessionJson> {
  if (isBanned(user)) throw new GoTrueError(400, "user_banned", "User is banned");
  const at = now();
  const adapter = ctx.config.adapter!;
  const updated = await adapter.updateUser({ id: user.id, lastSignInAt: at });
  const snapshot: GoTrueSnapshot = {
    gotrue: 1,
    user: { id: user.id },
    provider: amr.provider ?? (amr.method === "oauth" ? "oauth" : amr.method),
    amr: [amr],
    aal: "aal1",
    ...(sso && { sso }),
  };
  const family: NativeSessionRecord = {
    id: crypto.randomUUID(),
    userId: user.id,
    generation: 0,
    salt: randomToken(16),
    session: JSON.stringify(snapshot),
    createdAt: at,
    expiresAt: at + familyLifetime(ctx.config),
  };
  await familiesOf(ctx.config).createNativeSession(family);
  await recordSso(ctx.config, family, sso);
  return await sessionJson(ctx, updated, family, snapshot, at);
}

/**
 * Step a session up to `aal2` after a verified second factor: the family is replaced by a new
 * one (the old one revoked) whose snapshot adds the factor, and a fresh pair is minted.
 *
 * @param ctx The session context.
 * @param user The user.
 * @param familyId The current session.
 * @param factor The method proven (`totp`, `mfa/phone`).
 * @returns The new session.
 */
export async function stepUpSession(
  ctx: SessionContext,
  user: AdapterUser,
  familyId: string,
  factor: AmrEntry,
): Promise<GoTrueSessionJson> {
  const live = await liveFamily(ctx.config, familyId, user.id);
  if (!live) throw new GoTrueError(401, "session_not_found", "Session not found");
  const families = familiesOf(ctx.config);
  const at = now();
  const snapshot: GoTrueSnapshot = {
    ...live.snapshot,
    amr: [factor, ...live.snapshot.amr],
    aal: "aal2",
  };
  const family: NativeSessionRecord = {
    id: crypto.randomUUID(),
    userId: user.id,
    generation: 0,
    salt: randomToken(16),
    session: JSON.stringify(snapshot),
    createdAt: live.family.createdAt,
    expiresAt: Math.max(live.family.expiresAt, at + 60),
  };
  await families.createNativeSession(family);
  await recordSso(ctx.config, family, snapshot.sso);
  await families.revokeNativeSession(live.family.id);
  return await sessionJson(ctx, user, family, snapshot, at);
}

const REFRESH_RE = /^([A-Za-z0-9-]{1,64})\.(\d{1,9})\.([A-Za-z0-9_-]{16,128})$/;

const notFound = () =>
  new GoTrueError(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");

/**
 * Exchange a refresh token for a new pair (`grant_type=refresh_token`).
 *
 * @param ctx The session context.
 * @param presented The refresh token.
 * @returns The new session.
 * @throws {GoTrueError} `refresh_token_not_found` (unknown, forged, revoked, expired) or
 *   `refresh_token_already_used` (a replay — the session is revoked).
 */
export async function refreshSession(
  ctx: SessionContext,
  presented: string,
): Promise<GoTrueSessionJson> {
  const match = REFRESH_RE.exec(presented);
  if (!match) throw notFound();
  const [, familyId, genText, mac] = match;
  const generation = Number(genText);
  const families = familiesOf(ctx.config);
  const family = await families.getNativeSession(familyId);
  const snapshot = family && parseSnapshot(family.session);
  if (!family || !snapshot || generation > family.generation) throw notFound();
  const genuine = await hmacVerify(
    refreshInput(family, generation),
    mac,
    secrets(ctx.config),
    REFRESH_DOMAIN,
  );
  if (!genuine) throw notFound();
  if (family.revokedAt !== undefined) {
    throw new GoTrueError(400, "refresh_token_already_used", "Invalid Refresh Token: Already Used");
  }
  const at = now();
  if (family.expiresAt <= at) throw notFound();
  const user = await ctx.config.adapter!.getUser(family.userId);
  if (!user) {
    await families.revokeNativeSession(family.id);
    throw notFound();
  }
  if (isBanned(user)) throw new GoTrueError(400, "user_banned", "User is banned");
  if (generation < family.generation) return await olderGeneration(ctx, user, family, generation);
  const expiresAt = at + familyLifetime(ctx.config);
  const swapped = await families.rotateNativeSession(family.id, generation, expiresAt, {
    rotatedAt: at,
  });
  if (!swapped) {
    const after = await families.getNativeSession(family.id) ?? family;
    return await olderGeneration(ctx, user, after, generation);
  }
  const rotated = { ...family, generation: generation + 1, expiresAt, rotatedAt: at };
  return await sessionJson(ctx, user, rotated, snapshot, at);
}

/** A used generation: answered again inside the reuse interval, a replay otherwise. */
async function olderGeneration(
  ctx: SessionContext,
  user: AdapterUser,
  family: NativeSessionRecord,
  generation: number,
): Promise<GoTrueSessionJson> {
  const at = now();
  const snapshot = parseSnapshot(family.session);
  const interval = reuseInterval(ctx.options);
  const graced = snapshot && family.revokedAt === undefined && interval > 0 &&
    generation === family.generation - 1 && family.rotatedAt !== undefined &&
    at - family.rotatedAt <= interval;
  if (graced) return await sessionJson(ctx, user, family, snapshot, family.rotatedAt!);
  await familiesOf(ctx.config).revokeNativeSession(family.id);
  resolveAuthOptions(ctx.config).logger.warn(
    "denextAuth: an /auth/v1 refresh token was reused — its session is revoked",
    { userId: family.userId },
  );
  throw new GoTrueError(400, "refresh_token_already_used", "Invalid Refresh Token: Already Used");
}
