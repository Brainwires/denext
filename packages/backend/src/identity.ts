// Who a request is, Supabase-style: one function every wire protocol of the backend (REST,
// storage, realtime, functions) and `db()` resolve a request's identity through.
//
//   1. `Authorization: Bearer <jwt>` — a user's access token minted by `/auth/v1` (or any JWT
//      signed by the configured keys): its claims, as they are, become `request.jwt.claims`.
//      A legacy `anon` / `service_role` JWT there acts as that API key.
//   2. The secret key (`apikey: sb_secret_…`, the legacy `service_role` JWT, or either as the
//      bearer) — `service_role`, which bypasses row-level security.
//   3. The denext session — the auth cookie, or a native app's `nat_…` token (`auth()`). Its
//      claims go through Supabase's Custom Access Token Hook (`hooks.customAccessToken`) when
//      one is configured, cached per session for 60 seconds.
//   4. Otherwise `anon` (the publishable key, the legacy `anon` JWT, or nothing at all).
//
// A credential that is presented and refused is an error (401), never a silent downgrade to
// `anon`: a client with an expired token learns it has to refresh.

import {
  apiKeyRole,
  auth,
  type AuthSession,
  installedSupabaseKeys,
  looksLikeJwt,
  opaqueKeyRole,
  SupabaseKeyError,
  type SupabaseKeys,
} from "@denext/denext/server";
import { activeAuthConfig, bearerTokenOf, type GoTrueHooks, verifyAccessToken } from "@denext/auth";
import { authenticatedScope, type RlsOptions, type RlsScope, sessionClaims } from "./rls.ts";

/** The three roles a request can act as — Supabase's names. */
export type IdentityRole = "anon" | "authenticated" | "service_role";

/** A request's resolved identity. */
export interface RequestIdentity {
  /** The role: `anon`, `authenticated` (a user) or `service_role` (the secret key). */
  role: IdentityRole;
  /**
   * The `request.jwt.claims` the request's statements run with — a user's verified access
   * token claims, the claims of their denext session, or `{ role }` for a key.
   */
  claims: Record<string, unknown>;
  /** The user id (`auth.uid()`), for `authenticated`. */
  userId?: string;
  /** Where the identity came from. */
  source: "jwt" | "api_key" | "session" | "none";
  /** The denext session, when the identity is a cookie or native session. */
  session?: AuthSession;
}

/** Why a presented credential was refused (every one is a 401). */
export type IdentityErrorCode = "bad_jwt" | "jwt_expired" | "invalid_api_key" | "no_api_key";

/** A presented credential that was refused. Map it to the protocol's own 401 shape. */
export class IdentityError extends Error {
  /** The HTTP status (always 401). */
  // fallow-ignore-next-line unused-class-member -- public error shape: callers map it to a 401
  readonly status = 401;
  /** The reason. */
  readonly code: IdentityErrorCode;
  /**
   * Create the error.
   *
   * @param code The reason.
   * @param message The message (never contains the credential).
   */
  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
  }
}

/**
 * Whether a value is an {@linkcode IdentityError}.
 *
 * @param value Anything thrown.
 * @returns `true` for an identity error.
 */
export function isIdentityError(value: unknown): value is IdentityError {
  return value instanceof IdentityError;
}

/**
 * Whether a `db({ as })` value is a {@linkcode RequestIdentity} (not a user or a session).
 *
 * @param value The identity to act as.
 * @returns `true` for a resolved request identity.
 */
export function isRequestIdentity(value: unknown): value is RequestIdentity {
  const v = value as Partial<RequestIdentity> | null;
  return typeof v === "object" && v !== null && typeof v.source === "string" &&
    typeof v.role === "string" && typeof v.claims === "object";
}

/** Options for {@linkcode resolveIdentity}. */
export interface ResolveIdentityOptions {
  /** `rls.claims`: extra claims for a denext session. */
  rls?: RlsOptions;
  /** Refuse a request that carries no API key and no user credential (`no_api_key`). */
  requireApiKey?: boolean;
}

/** The anonymous identity. */
export const ANON_IDENTITY: RequestIdentity = Object.freeze({
  role: "anon",
  claims: Object.freeze({ role: "anon" }),
  source: "none",
}) as RequestIdentity;

function bearerOf(request: Request): string | undefined {
  return bearerTokenOf(request.headers.get("authorization"));
}

function refused(error: unknown): IdentityError {
  if (error instanceof SupabaseKeyError) return new IdentityError(error.code, error.message);
  return new IdentityError("bad_jwt", "invalid JWT");
}

/** The role an API key grants, or a 401. */
async function keyRole(keys: SupabaseKeys, value: string): Promise<"anon" | "service_role"> {
  try {
    return await apiKeyRole(keys, value);
  } catch (error) {
    throw refused(error);
  }
}

type Bearer =
  | { kind: "user"; claims: Record<string, unknown> & { sub?: string } }
  | { kind: "key"; role: "anon" | "service_role" }
  | { kind: "other" };

/** The denext auth config, when `denextAuth()` is configured (its adapter keeps the sessions). */
function authConfig() {
  try {
    return activeAuthConfig();
  } catch {
    return null;
  }
}

/** Classify the bearer: a user's token, an API key, or something denext auth reads itself. */
async function classifyBearer(keys: SupabaseKeys, token: string): Promise<Bearer> {
  if (looksLikeJwt(token)) {
    let claims;
    try {
      claims = await verifyAccessToken(keys, token, authConfig());
    } catch (error) {
      throw refused(error);
    }
    if (claims.role === "authenticated") return { kind: "user", claims };
    return { kind: "key", role: claims.role };
  }
  if (token.startsWith("sb_")) return { kind: "key", role: await keyRole(keys, token) };
  // An opaque value that happens to equal a configured key (a custom key format).
  const role = await opaqueKeyRole(keys, token);
  return role ? { kind: "key", role } : { kind: "other" };
}

function sessionIdentity(session: AuthSession, custom: Record<string, unknown>): RequestIdentity {
  return {
    role: "authenticated",
    claims: sessionClaims(session, custom),
    userId: session.user.id,
    source: "session",
    session,
  };
}

/** The `/auth/v1` hooks `backend({ supabase: { auth: { hooks } } })` installed, if any. */
let installedHooks: GoTrueHooks | undefined;

/**
 * Install (or, with `undefined`, remove) the `/auth/v1` options' hooks — the fallback source of
 * `customAccessToken` for a denext session when the auth config sets none. `backend()` calls it.
 *
 * @param hooks The `supabase.auth.hooks`, or `undefined`.
 */
export function installSupabaseAuthHooks(hooks: GoTrueHooks | undefined): void {
  installedHooks = hooks;
}

/** How long a hook's claims are reused for the same session. */
const HOOK_TTL_MS = 60_000;
/** The most sessions whose hook claims are kept, per hook. */
const HOOK_CACHE_MAX = 1000;

/**
 * The claims the hook may not change — restored from the pre-hook claims after it runs (and
 * dropped when the session had none), as `/auth/v1` does for its access tokens.
 */
const FIXED_CLAIMS = [
  "sub",
  "role",
  "aud",
  "session_id",
  "iat",
  "exp",
  "aal",
  "is_anonymous",
  "email",
] as const;

type AccessTokenHook = NonNullable<GoTrueHooks["customAccessToken"]>;

/** Per hook: the shaped claims per session, oldest first. */
const hookCaches = new WeakMap<AccessTokenHook, Map<string, { at: number; claims: Claims }>>();

type Claims = Record<string, unknown>;

/** The configured Custom Access Token Hook: the auth config's, else the installed `/auth/v1` one. */
function accessTokenHook(): AccessTokenHook | undefined {
  return authConfig()?.hooks?.customAccessToken ?? installedHooks?.customAccessToken;
}

/** One cache entry per session: its id, else the user and the sign-in time. */
function hookCacheKey(session: AuthSession): string {
  const id = session.sessionId ?? session.nativeSessionId;
  return id ? `s:${id}` : `u:${session.user.id}:${session.authTime ?? session.issuedAt ?? ""}`;
}

/** Run the hook over `claims` and restore the fixed claims; a throw or a malformed answer throws. */
async function runAccessTokenHook(
  hook: AccessTokenHook,
  session: AuthSession,
  claims: Claims,
): Promise<Claims> {
  const result = await hook({
    user_id: session.user.id,
    claims: structuredClone(claims),
    authentication_method: session.amr?.at(-1) ?? "password",
  });
  const shaped = result?.claims;
  if (typeof shaped !== "object" || shaped === null || Array.isArray(shaped)) {
    throw new Error("customAccessToken hook failed: it must return { claims: { … } }");
  }
  const out: Claims = { ...shaped };
  for (const key of FIXED_CLAIMS) {
    if (key in claims) out[key] = claims[key];
    else delete out[key];
  }
  return out;
}

/**
 * A denext session's claims through the Custom Access Token Hook, when one is configured —
 * cached per session for 60 seconds (at most 1000 sessions), so a page's many queries don't
 * call it each time. A throwing or malformed hook fails the request: the claims are never used
 * half-shaped.
 */
async function hookedClaims(session: AuthSession, claims: Claims): Promise<Claims> {
  const hook = accessTokenHook();
  if (!hook) return claims;
  let cache = hookCaches.get(hook);
  if (!cache) hookCaches.set(hook, cache = new Map());
  const key = hookCacheKey(session);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < HOOK_TTL_MS) return { ...hit.claims };
  const shaped = await runAccessTokenHook(hook, session, claims);
  cache.delete(key);
  if (cache.size >= HOOK_CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: now, claims: shaped });
  return { ...shaped };
}

/**
 * Whether a `denextAuth()` plugin has been created. Without one there is no denext session
 * (`auth()` from `denext/server` then throws, naming `@denext/auth`).
 *
 * @returns `true` when the auth plugin is configured.
 */
export function hasDenextAuth(): boolean {
  try {
    activeAuthConfig();
    return true;
  } catch {
    return false;
  }
}

/** A cookie or native denext session, or `null`. */
async function denextSession(rls: RlsOptions | undefined): Promise<RequestIdentity | null> {
  if (!hasDenextAuth()) return null;
  const session = await auth();
  if (!session) return null;
  const custom = rls?.claims ? await rls.claims(session) : {};
  const identity = sessionIdentity(session, custom ?? {});
  identity.claims = await hookedClaims(session, identity.claims);
  return identity;
}

type ContextBridge = { __denextCurrentRequestContext?: () => { request?: Request } | undefined };

/** The request being served right now, if any. */
function currentRequest(): Request | undefined {
  return (globalThis as ContextBridge).__denextCurrentRequestContext?.()?.request;
}

/**
 * Resolve a request's identity — the one function the backend's REST, storage, realtime and
 * functions endpoints, and `db()`, decide who a request is with. The result's `claims` are
 * what `request.jwt.claims` (`auth.uid()`, `auth.jwt()`, `auth.role()`) reads.
 *
 * Precedence: a user's access token (`Authorization: Bearer <jwt>`), then the secret key
 * (`service_role`), then the denext session (cookie or native token), then `anon`. API keys
 * come from the `apikey` header or the bearer; they are recognized only once
 * `backend({ supabase })` installs the keys.
 *
 * The denext session is read from the CURRENT request context (`auth()`), so pass the request
 * being served (the default).
 *
 * @param request The request (default: the one being served; none → `anon`).
 * @param options `rls.claims` for a session; `requireApiKey` to refuse a keyless request.
 * @returns The identity.
 * @throws {IdentityError} A presented token or key that is invalid or expired (401).
 */
export async function resolveIdentity(
  request: Request | undefined = currentRequest(),
  options: ResolveIdentityOptions = {},
): Promise<RequestIdentity> {
  if (!request) return ANON_IDENTITY;
  const keys = installedSupabaseKeys();
  if (!keys) {
    if (options.requireApiKey) throw new IdentityError("no_api_key", "No API key found in request");
    return (await denextSession(options.rls)) ?? ANON_IDENTITY;
  }
  const token = bearerOf(request);
  const bearer = token ? await classifyBearer(keys, token) : { kind: "other" as const };
  if (bearer.kind === "user") {
    return {
      role: "authenticated",
      claims: bearer.claims,
      userId: bearer.claims.sub,
      source: "jwt",
    };
  }
  const apikey = request.headers.get("apikey")?.trim();
  const headerRole = apikey ? await keyRole(keys, apikey) : undefined;
  const role = bearer.kind === "key" ? bearer.role : headerRole;
  if (role === "service_role") {
    return { role: "service_role", claims: { role: "service_role" }, source: "api_key" };
  }
  const session = await denextSession(options.rls);
  if (session) return session;
  if (role === undefined && options.requireApiKey) {
    throw new IdentityError("no_api_key", "No API key found in request");
  }
  return role === "anon"
    ? { role: "anon", claims: { role: "anon" }, source: "api_key" }
    : ANON_IDENTITY;
}

/**
 * The row-level-security scope for an identity: the Postgres role (`service_role` runs as the
 * connecting role, with no row-level security) and the `request.jwt.claims` JSON.
 *
 * @param identity The identity.
 * @returns The scope.
 */
export function identityScope(identity: RequestIdentity): RlsScope {
  const claims = { ...identity.claims, role: identity.role };
  if (identity.role === "authenticated") return authenticatedScope(claims);
  return { role: identity.role, claims: JSON.stringify(claims) };
}
