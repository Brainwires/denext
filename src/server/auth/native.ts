/**
 * **Native session mode** — the token half of `denextAuth({ native })`, for an app whose
 * WebView can't carry the `__Host-` SameSite session cookie (a Capacitor shell at
 * `capacitor://localhost` calling `https://api.example.com`).
 *
 * Three credentials, all minted here:
 * - **the one-time code** (`nac_…`) the browser sheet hands the app's redirect URI. It is
 *   stored as a SHA-256 hash, bound to the redirect URI and the app's PKCE `S256` challenge,
 *   lives `codeTtl` seconds (60 by default) and is consumed atomically on the first redemption
 *   — right or wrong verifier alike, so it can't be brute-forced or replayed;
 * - **the access token** (`nat_…`): `base64url(payload).HMAC`, signed with the auth secret
 *   under its own MAC domain, valid `accessTokenTtl` seconds (15 minutes by default). It names
 *   its session family, and every verification re-reads that family, so a revoked family's
 *   access tokens die immediately rather than at expiry;
 * - **the refresh token** (`nrt_<family>.<generation>.<mac>`): the MAC covers the family, the
 *   generation and a per-family random salt that never leaves the server. A refresh advances
 *   the generation with an atomic compare-and-swap; presenting an OLDER generation that still
 *   carries a valid MAC is a replay, and revokes the whole family (RFC 9700 §4.14.2). A MAC
 *   that doesn't verify is a forgery, refused without touching the family — so knowing a
 *   family id is not enough to sign someone out.
 *
 * Two opt-in refresh policies:
 * - **`refreshTokenMaxAge`** caps a family absolutely, from its original sign-in
 *   (`createdAt`): past it a refresh is refused like an expired family's, and the family is
 *   revoked. Its expiry never slides past the cap, so access tokens stop with it too.
 * - **`refreshReuseInterval`** answers the loser of a refresh race: within that many seconds of
 *   a rotation, the IMMEDIATELY previous generation gets the pair that rotation issued, again.
 *   Nothing token-shaped is stored for this. Every part of a pair is a pure function of server
 *   secrets and stored family state — the refresh MAC covers `(family, generation, salt)`, and
 *   the access token's issue time is the stored `rotatedAt` and its id an HMAC of the same
 *   input under its own domain — so the pair is re-derived, byte-identical, from the record.
 *
 * Every refusal is uniform (`null` / `invalid_grant`), and no token is ever logged.
 *
 * @module
 */

import { hmacSign, hmacVerify } from "../session.ts";
import type { AuthAdapter, NativeSessionRecord } from "./adapter.ts";
import { emitAuthEvent } from "./events.ts";
import { constantTimeEqualHex, sha256Hex } from "./hash.ts";
import { base64UrlDecode, base64UrlEncode, randomToken } from "./oauth.ts";
import { resolveAuthOptions } from "./options.ts";
import { buildSessionPayload } from "./session.ts";
import type { AuthConfig, AuthNativeConfig, AuthSession, AuthUser } from "./types.ts";

/** The MAC domain of a native access token (never verifies as a cookie or a refresh token). */
const ACCESS_DOMAIN = "denext.native.access.v1";
/** The MAC domain of a native refresh token. */
const REFRESH_DOMAIN = "denext.native.refresh.v1";
/** The MAC domain of an access token's id (derived, so a pair can be re-derived exactly). */
const ACCESS_ID_DOMAIN = "denext.native.access-id.v1";
/** Access-token prefix — recognizable in logs and secret scanners. */
const ACCESS_PREFIX = "nat_";
/** Refresh-token prefix. */
const REFRESH_PREFIX = "nrt_";
/** One-time code prefix. */
const CODE_PREFIX = "nac_";
/** Sign-in nonce prefix. */
const NONCE_PREFIX = "nnc_";
/** How long a sign-in nonce stays redeemable (seconds). */
const NONCE_TTL = 600;

/** The adapter methods the native session mode needs. */
export type NativeAdapter = Required<
  Pick<
    AuthAdapter,
    | "createNativeGrant"
    | "useNativeGrant"
    | "createNativeSession"
    | "getNativeSession"
    | "rotateNativeSession"
    | "revokeNativeSession"
    | "revokeNativeSessionsByUser"
  >
>;

/** The adapter methods {@link nativeAdapter} checks for. */
const NATIVE_METHODS = [
  "createNativeGrant",
  "useNativeGrant",
  "createNativeSession",
  "getNativeSession",
  "rotateNativeSession",
  "revokeNativeSession",
  "revokeNativeSessionsByUser",
] as const;

/**
 * The configured adapter's native session group, or `null` when it lacks one.
 *
 * @param adapter The configured adapter.
 * @returns The adapter narrowed to the native methods, or `null`.
 */
export function nativeAdapterOf(adapter: AuthAdapter | undefined): NativeAdapter | null {
  if (!adapter) return null;
  return NATIVE_METHODS.every((m) => typeof adapter[m] === "function")
    ? adapter as NativeAdapter
    : null;
}

/** A redirect URI the app registered, pre-parsed for matching. */
interface RegisteredRedirect {
  /** The configured string, byte for byte. */
  raw: string;
  /** For a loopback `http:` entry: the URI with its port removed (matched port-agnostically). */
  loopback?: string;
}

/** {@link AuthNativeConfig} with every default applied. */
export interface ResolvedNative {
  /** The adapter's native group. */
  adapter: NativeAdapter;
  /** The registered redirect URIs. */
  redirects: RegisteredRedirect[];
  /** Access-token lifetime, seconds. */
  accessTtl: number;
  /** Refresh-token (family) lifetime, seconds. */
  refreshTtl: number;
  /** Absolute family lifetime from its original sign-in, seconds; `null` for none. */
  refreshMaxAge: number | null;
  /** The concurrent-refresh grace window, seconds (`0`: every reuse is a replay). */
  reuseInterval: number;
  /** One-time code lifetime, seconds. */
  codeTtl: number;
  /** Whether native id_token sign-in requires a server-issued nonce. */
  requireNonce: boolean;
  /** The raw config (providers, fetch seam). */
  config: AuthNativeConfig;
}

/** Schemes a redirect URI may never use. */
const FORBIDDEN_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "about:",
]);
/** Loopback IP literals (RFC 8252 §7.3 — never `localhost`, which DNS can redirect). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

/** Clamp a lifetime to `[min, max]`, using `fallback` for anything non-finite. */
function lifetime(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Validate one configured redirect URI (throws with an actionable message). */
function registerRedirect(raw: unknown): RegisteredRedirect {
  const fail = (why: string): never => {
    throw new Error(`denextAuth: native.redirectUris entry ${JSON.stringify(raw)} ${why}.`);
  };
  if (typeof raw !== "string" || raw === "") return fail("is not a non-empty string");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("is not an absolute URI");
  }
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return fail(`uses the forbidden ${url.protocol} scheme`);
  if (url.hash) return fail("carries a fragment");
  if (url.username || url.password) return fail("carries credentials");
  if (url.protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      return fail("is plain http — use https, a custom scheme, or a loopback IP literal");
    }
    const noPort = new URL(url.href);
    noPort.port = "";
    return { raw, loopback: noPort.href };
  }
  return { raw };
}

const resolvedNative = new WeakMap<AuthConfig, ResolvedNative | null>();

/**
 * Resolve (and memoise) `config.native`. Throws at config time on anything unusable: no
 * redirect URI, a forbidden one, or no adapter implementing the native session group.
 *
 * @param config The app's auth config.
 * @returns The resolved native settings, or `null` when native mode is off.
 */
export function resolveNative(config: AuthConfig): ResolvedNative | null {
  if (resolvedNative.has(config)) return resolvedNative.get(config)!;
  const native = config.native;
  if (!native) {
    resolvedNative.set(config, null);
    return null;
  }
  const adapter = nativeAdapterOf(config.adapter);
  if (!adapter) {
    throw new Error(
      "denextAuth: `native` needs an `adapter` implementing the native session group " +
        "(createNativeGrant, useNativeGrant, createNativeSession, getNativeSession, " +
        "rotateNativeSession, revokeNativeSession, revokeNativeSessionsByUser) — e.g. " +
        "`sqliteAuthAdapter({ path })`.",
    );
  }
  if (!Array.isArray(native.redirectUris)) {
    throw new Error("denextAuth: `native.redirectUris` must be an array of callback URIs.");
  }
  const resolved: ResolvedNative = {
    adapter,
    redirects: native.redirectUris.map(registerRedirect),
    accessTtl: lifetime(native.accessTokenTtl, 900, 60, 3600),
    refreshTtl: lifetime(native.refreshTokenTtl, 30 * 86_400, 3600, 365 * 86_400),
    refreshMaxAge: native.refreshTokenMaxAge === undefined
      ? null
      : lifetime(native.refreshTokenMaxAge, 3600, 3600, 10 * 365 * 86_400),
    reuseInterval: lifetime(native.refreshReuseInterval, 0, 0, 60),
    codeTtl: lifetime(native.codeTtl, 60, 10, 600),
    requireNonce: native.requireNonce !== false,
    config: native,
  };
  for (const provider of ["apple", "google"] as const) {
    const ids = native[provider]?.clientIds;
    if (native[provider] && (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => !id))) {
      throw new Error(`denextAuth: \`native.${provider}.clientIds\` must list at least one id.`);
    }
  }
  resolvedNative.set(config, resolved);
  return resolved;
}

/**
 * The registered redirect URI `presented` matches, or `null`. Exact string equality, except a
 * loopback `http:` registration, which matches the same URI on any port.
 *
 * @param native The resolved native settings.
 * @param presented The `redirect_uri` the app sent.
 * @returns The presented URI when it is registered, else `null`.
 */
export function matchRedirectUri(native: ResolvedNative, presented: string | null): string | null {
  if (!presented) return null;
  for (const entry of native.redirects) {
    if (entry.raw === presented) return presented;
    if (!entry.loopback) continue;
    try {
      const url = new URL(presented);
      if (url.protocol !== "http:" || !url.port) continue;
      url.port = "";
      if (url.href === entry.loopback) return presented;
    } catch {
      continue;
    }
  }
  return null;
}

/** The epoch-seconds clock. */
function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** The auth secrets, first one signing. */
function secrets(config: AuthConfig): string[] {
  return Array.isArray(config.secret) ? [...config.secret] : [config.secret];
}

// ---- the session snapshot a family acts as --------------------------------------

/** What a family stores about the sign-in it came from. */
export interface NativeSnapshot {
  /** The signed-in user. */
  user: AuthUser;
  /** The provider that authenticated them. */
  provider: string;
  /** Authentication methods proven. */
  amr?: string[];
  /** When the user authenticated, epoch seconds. */
  authTime?: number;
}

/** Parse a stored snapshot; anything malformed is `null` (fail closed). */
function parseSnapshot(raw: string): NativeSnapshot | null {
  try {
    const value = JSON.parse(raw) as NativeSnapshot;
    return value && typeof value === "object" && value.user && typeof value.user.id === "string" &&
        typeof value.provider === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

/**
 * The snapshot for a freshly authenticated user: the payload `callbacks.session` shapes, minus
 * the lifetime fields the tokens carry themselves.
 *
 * @param config The app's auth config.
 * @param user The authenticated user.
 * @param provider The provider that authenticated them.
 * @param amr The methods proven.
 * @param authTime When they authenticated (default now).
 * @returns The snapshot to store on the family.
 */
export async function snapshotFor(
  config: AuthConfig,
  user: AuthUser,
  provider: string,
  amr: string[],
  authTime?: number,
): Promise<NativeSnapshot> {
  const payload = await buildSessionPayload(config, user, provider, { amr, authTime });
  return {
    user: payload.user,
    provider: payload.provider,
    amr: payload.amr,
    authTime: payload.authTime,
  };
}

// ---- one-time codes and nonces --------------------------------------------------

/** What an authorization code is bound to. */
interface CodeBinding {
  /** The redirect URI the code was delivered to. */
  r: string;
  /** The PKCE S256 challenge. */
  c: string;
  /** The session snapshot the code redeems for. */
  s: NativeSnapshot;
}

/**
 * Mint a one-time authorization code bound to the redirect URI, the PKCE challenge and the
 * signed-in session.
 *
 * @param native The resolved native settings.
 * @param binding The redirect URI, the S256 challenge and the session snapshot.
 * @returns The code to deliver to the app (never stored in the clear).
 */
export async function createAuthCode(
  native: ResolvedNative,
  binding: { redirectUri: string; challenge: string; snapshot: NativeSnapshot },
): Promise<string> {
  const code = CODE_PREFIX + randomToken(32);
  const data: CodeBinding = { r: binding.redirectUri, c: binding.challenge, s: binding.snapshot };
  await native.adapter.createNativeGrant({
    hash: await sha256Hex(code),
    kind: "code",
    expiresAt: now() + native.codeTtl,
    data: JSON.stringify(data),
  });
  return code;
}

/** `BASE64URL(SHA256(verifier))` — the S256 transform (RFC 7636 §4.2). */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** A PKCE verifier: 43–128 unreserved characters (RFC 7636 §4.1). */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

/**
 * Redeem a code: consume it (whatever happens next — a code gets exactly one try), then check
 * it is unexpired, was delivered to THIS redirect URI, and that the verifier's S256 matches the
 * challenge (compared in constant time).
 *
 * @param native The resolved native settings.
 * @param input The presented code, verifier and redirect URI.
 * @returns The session snapshot the code was minted for, or `null` for any failure.
 */
export async function redeemAuthCode(
  native: ResolvedNative,
  input: { code: string; verifier: string; redirectUri: string },
): Promise<NativeSnapshot | null> {
  if (!input.code.startsWith(CODE_PREFIX)) return null;
  const record = await native.adapter.useNativeGrant(await sha256Hex(input.code), "code");
  if (!record?.data || record.kind !== "code" || record.expiresAt <= now()) return null;
  let binding: CodeBinding;
  try {
    binding = JSON.parse(record.data) as CodeBinding;
  } catch {
    return null;
  }
  if (typeof binding.r !== "string" || binding.r !== input.redirectUri) return null;
  if (!VERIFIER_RE.test(input.verifier) || typeof binding.c !== "string") return null;
  if (!constantTimeEqualHex(await s256(input.verifier), binding.c)) return null;
  return binding.s && typeof binding.s.user?.id === "string" ? binding.s : null;
}

/**
 * Issue a single-use sign-in nonce for a native id_token sign-in.
 *
 * @param native The resolved native settings.
 * @returns The nonce (pass it — or its SHA-256 hex — to the native sign-in sheet).
 */
export async function issueNonce(native: ResolvedNative): Promise<string> {
  const nonce = NONCE_PREFIX + randomToken(24);
  await native.adapter.createNativeGrant({
    hash: await sha256Hex(nonce),
    kind: "nonce",
    expiresAt: now() + NONCE_TTL,
  });
  return nonce;
}

/**
 * Consume a sign-in nonce: `true` exactly once for a nonce this server issued and that has
 * not expired.
 *
 * @param native The resolved native settings.
 * @param nonce The presented nonce.
 * @returns Whether it was live (it is spent either way).
 */
export async function consumeNonce(native: ResolvedNative, nonce: string): Promise<boolean> {
  if (!nonce.startsWith(NONCE_PREFIX)) return false;
  const record = await native.adapter.useNativeGrant(await sha256Hex(nonce), "nonce");
  return !!record && record.kind === "nonce" && record.expiresAt > now();
}

// ---- tokens -----------------------------------------------------------------------

/** What `POST {basePath}/native/token` answers. */
export interface NativeTokens {
  /** The bearer access token (`nat_…`). */
  access_token: string;
  /** Always `"Bearer"`. */
  token_type: "Bearer";
  /** Seconds until the access token expires. */
  expires_in: number;
  /** The rotating refresh token (`nrt_…`) — store it in `secureStore`. */
  refresh_token: string;
  /** Seconds until the refresh token expires unless used. */
  refresh_expires_in: number;
  /** The signed-in user. */
  user: AuthUser;
}

/** The signed access-token payload. */
interface AccessPayload {
  /** Family id. */
  f: string;
  /** User id. */
  u: string;
  /** Issued at, epoch seconds. */
  i: number;
  /** Expires at, epoch seconds. */
  e: number;
  /**
   * The token id: an HMAC of the family, generation and salt, so tokens of different
   * generations or families never collide, yet one generation's token can be re-derived
   * exactly (the `refreshReuseInterval` answer).
   */
  j: string;
}

/** The MAC input of a refresh token: family, generation and the family's secret salt. */
function refreshInput(familyId: string, generation: number, salt: string): string {
  return `${familyId}.${generation}.${salt}`;
}

/**
 * Mint the token pair for a family at its current generation, issued at `issued`. Deterministic
 * in `(signing secret, family record, snapshot, issued)` — nothing random — so the same inputs
 * re-derive the same pair byte for byte.
 */
async function mintTokens(
  config: AuthConfig,
  native: ResolvedNative,
  family: NativeSessionRecord,
  snapshot: NativeSnapshot,
  issued: number,
): Promise<NativeTokens> {
  const [signer] = secrets(config);
  const input = refreshInput(family.id, family.generation, family.salt);
  const payload: AccessPayload = {
    f: family.id,
    u: family.userId,
    i: issued,
    e: issued + native.accessTtl,
    j: (await hmacSign(input, signer, ACCESS_ID_DOMAIN)).slice(0, 12),
  };
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const accessMac = await hmacSign(body, signer, ACCESS_DOMAIN);
  const refreshMac = await hmacSign(input, signer, REFRESH_DOMAIN);
  return {
    access_token: `${ACCESS_PREFIX}${body}.${accessMac}`,
    token_type: "Bearer",
    expires_in: native.accessTtl,
    refresh_token: `${REFRESH_PREFIX}${family.id}.${family.generation}.${refreshMac}`,
    refresh_expires_in: Math.max(0, family.expiresAt - issued),
    user: snapshot.user,
  };
}

/**
 * Start a native session family for a signed-in user and mint its first token pair.
 *
 * @param config The app's auth config.
 * @param native The resolved native settings.
 * @param snapshot The session the family acts as.
 * @returns The token pair.
 */
export async function startNativeSession(
  config: AuthConfig,
  native: ResolvedNative,
  snapshot: NativeSnapshot,
): Promise<NativeTokens> {
  const created = now();
  const family: NativeSessionRecord = {
    id: randomToken(16),
    userId: snapshot.user.id,
    generation: 0,
    salt: randomToken(16),
    session: JSON.stringify(snapshot),
    createdAt: created,
    expiresAt: slidExpiry(native, created, created),
  };
  await native.adapter.createNativeSession(family);
  return await mintTokens(config, native, family, snapshot, created);
}

/** A parsed refresh token. */
interface RefreshParts {
  familyId: string;
  generation: number;
  mac: string;
}

/** Split `nrt_<family>.<generation>.<mac>`; anything else is `null`. */
function parseRefresh(token: string): RefreshParts | null {
  if (!token.startsWith(REFRESH_PREFIX)) return null;
  const parts = token.slice(REFRESH_PREFIX.length).split(".");
  if (parts.length !== 3 || !parts[0] || !/^\d{1,9}$/.test(parts[1]) || !parts[2]) return null;
  return { familyId: parts[0], generation: Number(parts[1]), mac: parts[2] };
}

/** Why a refresh was refused (for the event log; the caller always sees `invalid_grant`). */
export type RefreshOutcome =
  | { ok: true; tokens: NativeTokens }
  | { ok: false; reason: "invalid" | "reuse" | "revoked" | "expired" | "user_gone" };

/** A refusal, as {@link RefreshOutcome} carries it. */
type RefreshRefusal = Extract<RefreshOutcome, { ok: false }>;

/** The family's expiry after sliding at `at`: `refreshTtl` on, never past the absolute cap. */
function slidExpiry(native: ResolvedNative, at: number, createdAt: number): number {
  const sliding = at + native.refreshTtl;
  return native.refreshMaxAge === null
    ? sliding
    : Math.min(sliding, createdAt + native.refreshMaxAge);
}

/** Whether a family is past `refreshTokenMaxAge`, counted from its creation (the sign-in). */
function pastMaxAge(native: ResolvedNative, family: NativeSessionRecord, at: number): boolean {
  return native.refreshMaxAge !== null && family.createdAt + native.refreshMaxAge <= at;
}

/**
 * The checks every successful refresh shares, on a genuine, unrevoked family: unexpired, within
 * its absolute lifetime (past it the family is revoked, and the refusal reads as an expiry),
 * and its user still exists (else it is revoked). Answers the snapshot to mint for.
 */
async function liveSnapshot(
  config: AuthConfig,
  native: ResolvedNative,
  family: NativeSessionRecord,
  at: number,
): Promise<NativeSnapshot | RefreshRefusal> {
  // The absolute cap first: its expiry never slides past it, so the plain expiry check below
  // would otherwise refuse without revoking.
  if (pastMaxAge(native, family, at)) {
    await native.adapter.revokeNativeSession(family.id);
    return { ok: false, reason: "expired" };
  }
  if (family.expiresAt <= at) return { ok: false, reason: "expired" };
  const snapshot = parseSnapshot(family.session);
  const user = snapshot && await resolveAuthOptions(config).adapter?.getUser(family.userId);
  if (!snapshot || !user) {
    await native.adapter.revokeNativeSession(family.id);
    return { ok: false, reason: "user_gone" };
  }
  return snapshot;
}

/**
 * Whether presenting `generation` at `at` falls in the concurrent-refresh grace window: it is
 * the generation the family's LAST rotation consumed, and that rotation was at most
 * `refreshReuseInterval` seconds ago. Anything else that isn't current is a replay.
 */
function withinReuseInterval(
  native: ResolvedNative,
  family: NativeSessionRecord,
  generation: number,
  at: number,
): boolean {
  return native.reuseInterval > 0 && family.revokedAt === undefined &&
    generation === family.generation - 1 && family.rotatedAt !== undefined &&
    at - family.rotatedAt <= native.reuseInterval;
}

/**
 * An older generation was presented: within the grace window the previous generation is
 * answered with the pair its rotation issued — re-derived from the family record (`rotatedAt`
 * is that pair's issue time), never stored — and anything else is a replay.
 */
async function olderGeneration(
  config: AuthConfig,
  native: ResolvedNative,
  family: NativeSessionRecord,
  generation: number,
  at: number,
): Promise<RefreshOutcome> {
  if (!withinReuseInterval(native, family, generation, at)) {
    return await reuse(config, native, family);
  }
  const snapshot = await liveSnapshot(config, native, family, at);
  if ("ok" in snapshot) return snapshot;
  resolveAuthOptions(config).logger.debug(
    "denextAuth: a concurrent native refresh was answered within refreshReuseInterval",
    { userId: family.userId },
  );
  return {
    ok: true,
    tokens: await mintTokens(config, native, family, snapshot, family.rotatedAt!),
  };
}

/**
 * Rotate a refresh token: verify its MAC against the family's salt, then advance the family's
 * generation atomically and mint a new pair. An older generation with a valid MAC is a
 * **replay** — the family is revoked, so the thief and the legitimate app are both signed out
 * and the user signs in again — unless `refreshReuseInterval` covers it (the immediately
 * previous generation, shortly after its rotation: the same pair is answered again). A forged
 * token (bad MAC) is refused without touching the family.
 *
 * @param config The app's auth config.
 * @param native The resolved native settings.
 * @param presented The refresh token.
 * @returns The new pair, or why it was refused.
 */
export async function refreshNativeSession(
  config: AuthConfig,
  native: ResolvedNative,
  presented: string,
): Promise<RefreshOutcome> {
  const parts = parseRefresh(presented);
  if (!parts) return { ok: false, reason: "invalid" };
  const family = await native.adapter.getNativeSession(parts.familyId);
  if (!family) return { ok: false, reason: "invalid" };
  const genuine = await hmacVerify(
    refreshInput(family.id, parts.generation, family.salt),
    parts.mac,
    secrets(config),
    REFRESH_DOMAIN,
  );
  if (!genuine || parts.generation > family.generation) return { ok: false, reason: "invalid" };
  if (family.revokedAt !== undefined) return { ok: false, reason: "revoked" };
  const at = now();
  if (parts.generation < family.generation) {
    return await olderGeneration(config, native, family, parts.generation, at);
  }
  const snapshot = await liveSnapshot(config, native, family, at);
  if ("ok" in snapshot) return snapshot;
  const expiresAt = slidExpiry(native, at, family.createdAt);
  // The compare-and-swap: a concurrent refresh with the same token loses here. A lost swap is
  // judged against the family as the winner left it — a replay, unless the grace window covers it.
  const swapped = await native.adapter.rotateNativeSession(
    family.id,
    parts.generation,
    expiresAt,
    { rotatedAt: at },
  );
  if (!swapped) {
    const after = await native.adapter.getNativeSession(family.id) ?? family;
    return await olderGeneration(config, native, after, parts.generation, at);
  }
  const rotated: NativeSessionRecord = {
    ...family,
    generation: parts.generation + 1,
    expiresAt,
    rotatedAt: at,
  };
  return { ok: true, tokens: await mintTokens(config, native, rotated, snapshot, at) };
}

/** A replayed refresh token: revoke the family and report it. */
async function reuse(
  config: AuthConfig,
  native: ResolvedNative,
  family: NativeSessionRecord,
): Promise<RefreshOutcome> {
  await native.adapter.revokeNativeSession(family.id);
  const options = resolveAuthOptions(config);
  options.logger.warn("denextAuth: a native refresh token was replayed — its session is revoked", {
    userId: family.userId,
  });
  await emitAuthEvent(options, "sessionRevoked", { sessionId: family.id });
  return { ok: false, reason: "reuse" };
}

/**
 * The family a refresh token names — for sign-out, which revokes it. The MAC must verify
 * (at any generation), so a guessed family id can't sign anyone out.
 *
 * @param config The app's auth config.
 * @param native The resolved native settings.
 * @param presented The refresh token.
 * @returns The family id, or `null`.
 */
export async function familyOfRefreshToken(
  config: AuthConfig,
  native: ResolvedNative,
  presented: string,
): Promise<string | null> {
  const parts = parseRefresh(presented);
  if (!parts) return null;
  const family = await native.adapter.getNativeSession(parts.familyId);
  if (!family || parts.generation > family.generation) return null;
  const genuine = await hmacVerify(
    refreshInput(family.id, parts.generation, family.salt),
    parts.mac,
    secrets(config),
    REFRESH_DOMAIN,
  );
  return genuine ? family.id : null;
}

/**
 * Verify a native access token and return the session it acts as: the MAC must verify (any
 * configured secret), the token must be unexpired, and its family must still be live — not
 * revoked, not past its expiry, and owned by the same user.
 *
 * @param config The app's auth config.
 * @param presented The `nat_…` token from `Authorization: Bearer`.
 * @returns The session (carrying `nativeSessionId`), or `null`.
 */
export async function verifyNativeAccessToken(
  config: AuthConfig,
  presented: string,
): Promise<AuthSession | null> {
  const native = resolveNative(config);
  if (!native || !presented.startsWith(ACCESS_PREFIX)) return null;
  const dot = presented.lastIndexOf(".");
  if (dot <= ACCESS_PREFIX.length) return null;
  const body = presented.slice(ACCESS_PREFIX.length, dot);
  if (!(await hmacVerify(body, presented.slice(dot + 1), secrets(config), ACCESS_DOMAIN))) {
    return null;
  }
  let payload: AccessPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as AccessPayload;
  } catch {
    return null;
  }
  const at = now();
  if (typeof payload.e !== "number" || payload.e <= at || typeof payload.f !== "string") {
    return null;
  }
  const family = await native.adapter.getNativeSession(payload.f);
  if (!family || family.revokedAt !== undefined || family.expiresAt <= at) return null;
  if (family.userId !== payload.u) return null;
  const snapshot = parseSnapshot(family.session);
  if (!snapshot) return null;
  return {
    user: snapshot.user,
    provider: snapshot.provider,
    expiresAt: payload.e,
    v: 2,
    issuedAt: payload.i,
    authTime: snapshot.authTime,
    amr: snapshot.amr ?? [],
    nativeSessionId: family.id,
  };
}

/**
 * The native access token an `Authorization` header carries: the token for a
 * `Bearer nat_…` header, `undefined` when the header is absent or carries something else (an
 * API token, Basic auth) — so cookie sessions keep working beside bearer API tokens.
 *
 * @param request The request, if any.
 * @returns The `nat_…` token, or `undefined`.
 */
export function nativeBearerToken(request: Request | undefined): string | undefined {
  const header = request?.headers.get("authorization");
  if (!header) return undefined;
  const space = header.indexOf(" ");
  if (space < 0 || header.slice(0, space).toLowerCase() !== "bearer") return undefined;
  const token = header.slice(space + 1).trim();
  return token.startsWith(ACCESS_PREFIX) ? token : undefined;
}

/**
 * Revoke every native session family of a user (a no-op when native mode is off or the adapter
 * lacks the group).
 *
 * @param config The app's auth config.
 * @param userId The owner.
 * @returns Whether anything could be revoked.
 */
export async function revokeNativeSessionsOf(config: AuthConfig, userId: string): Promise<boolean> {
  const adapter = nativeAdapterOf(resolveAuthOptions(config).adapter);
  if (!adapter) return false;
  await adapter.revokeNativeSessionsByUser(userId);
  return true;
}
