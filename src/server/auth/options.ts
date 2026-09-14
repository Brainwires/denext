/**
 * One place that turns an {@link ./types.ts | AuthConfig} — every field optional, most
 * of them new in 2.5 — into the fully-defaulted {@linkcode ResolvedAuthOptions} the
 * routes, the session layer and the guards read. Resolving is **cached per config
 * object** (a `WeakMap`, like the credentials limiter), so the defaults are computed
 * once per app and a "warn once" really warns once.
 *
 * Every default here is the behaviour denext shipped before 2.5 — same base path, same
 * cookie names, same 7-day lifetime, no sliding refresh, scrypt hashing, silence — so a
 * config written for 2.4 resolves to exactly what it did then.
 *
 * @module
 */

import type { AuthAdapter } from "./adapter.ts";
import type { Hasher } from "./hasher.ts";
import { scryptHasher } from "./hasher.ts";
import type { SessionOptions } from "../session.ts";
import type { SessionStore } from "./session-store.ts";
import type {
  AuthConfig,
  AuthCookieConfig,
  AuthEmailConfig,
  AuthEvents,
  AuthLogger,
  AuthMfaConfig,
} from "./types.ts";

/** The endpoint prefix when `basePath` is not set. */
const DEFAULT_BASE_PATH = "/auth";
/** The session cookie name (pre-`__Host-`) when not overridden. Unchanged since 1.1. */
const DEFAULT_SESSION_COOKIE = "denext_auth";
/** The OAuth-transaction cookie name (pre-`__Host-`) when not overridden. */
const DEFAULT_TX_COOKIE = "denext_auth_tx";
/** Default session lifetime: 7 days. */
const DEFAULT_MAX_AGE = 60 * 60 * 24 * 7;

/** Email-token lifetimes (seconds) when `email.*MaxAge` is not set. */
const DEFAULT_EMAIL_MAX_AGES = { verify: 86_400, reset: 3_600, magic: 600, otp: 300 };
/** MFA defaults: one step of drift, ten backup codes, a 15-minute step-up window. */
const DEFAULT_MFA = { window: 1, backupCodes: 10, freshness: 900 };
/** The issuer label an authenticator shows when neither `mfa.issuer` nor `canonicalOrigin` is set. */
const DEFAULT_MFA_ISSUER = "denext";
/**
 * A same-origin absolute path: one leading `/` (never `//` or `/\`, which a browser reads
 * as another host) and no whitespace or backslash anywhere.
 */
const LINK_PATH_RE = /^\/(?![/\\])[^\s\\]*$/;

/** A path made of non-empty, URL-safe segments — what a `basePath` must look like. */
const BASE_PATH_RE = /^(?:\/[A-Za-z0-9._~-]+)+$/;
/** Segments that would make the prefix traverse rather than name a place. */
const TRAVERSAL_SEGMENTS = new Set([".", ".."]);
/** An RFC 6265 cookie-name token (the `__Host-` prefix's `-` is inside the set). */
const COOKIE_NAME_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/** One auth cookie with every attribute decided. */
export interface ResolvedAuthCookie {
  /** The name before the `__Host-` prefix is applied. */
  name: string;
  /** Whether the cookie layer prepends `__Host-` and forces Secure + `Path=/`. */
  hostPrefix: boolean;
  /** The `SameSite` attribute. */
  sameSite: "Strict" | "Lax" | "None";
  /** The `Path` attribute (ignored under `__Host-`, which forces `/`). */
  path: string;
}

/** An {@link AuthLogger} with every method present (no-ops by default). */
export interface ResolvedAuthLogger {
  /** Verbose flow tracing. */
  debug: (message: string, meta?: Record<string, unknown>) => void;
  /** A recoverable misconfiguration. */
  warn: (message: string, meta?: Record<string, unknown>) => void;
  /** A swallowed failure. */
  error: (message: string, error?: unknown) => void;
}

/** An {@link AuthConfig} with every default applied. */
export interface ResolvedAuthOptions {
  /** The endpoint prefix, normalised and without a trailing slash (e.g. `"/auth"`). */
  basePath: string;
  /** `basePath` plus a trailing slash — what a request path must start with to be claimed. */
  prefix: string;
  /** The session + OAuth-transaction cookies. */
  cookies: {
    /** The session cookie. */
    session: ResolvedAuthCookie;
    /** The short-lived OAuth transaction cookie. */
    transaction: ResolvedAuthCookie;
  };
  /** Session lifetime in seconds. */
  maxAge: number;
  /** Sliding-refresh threshold in seconds; `0` means never refresh. */
  updateAge: number;
  /** How user-supplied secrets are hashed and checked. */
  hasher: Hasher;
  /** Where the framework logs (no-ops unless the app supplied a logger). */
  logger: ResolvedAuthLogger;
  /** Lifecycle hooks (`{}` when none are configured). */
  events: AuthEvents;
  /** The store backing server-side sessions, or `undefined` for stateless cookies. */
  sessionStore?: SessionStore;
  /** The persistence adapter, when one is configured. */
  adapter?: AuthAdapter;
  /**
   * Email-token lifetimes (seconds) and the paths the emailed links open, every default
   * applied (`verifyPath`/`resetPath` default to `{basePath}/verify` and `{basePath}/reset`).
   */
  email: Required<AuthEmailConfig>;
  /** Second-factor policy, every default applied and every count clamped. */
  mfa: Required<AuthMfaConfig>;
}

/**
 * Turn a resolved auth cookie into {@link SessionOptions} for the signed-cookie layer —
 * the one place a cookie's name and attributes become a real `Set-Cookie`.
 *
 * @param config The auth config (supplies the signing secret).
 * @param cookie The resolved cookie (name + attributes).
 * @param maxAge Lifetime in seconds.
 * @returns The options to hand `getSession`.
 */
export function cookieSessionOptions(
  config: AuthConfig,
  cookie: ResolvedAuthCookie,
  maxAge: number,
): SessionOptions {
  return {
    secret: config.secret,
    cookieName: cookie.name,
    hostPrefix: cookie.hostPrefix,
    sameSite: cookie.sameSite,
    path: cookie.path,
    maxAge,
  };
}

/** Resolved options per config object — the plugin hands the same `config` to every request. */
const resolved = new WeakMap<AuthConfig, ResolvedAuthOptions>();

/**
 * Resolve (and memoise) the effective options for an auth config. Throws on a config
 * that can't work: an unusable `basePath`, an invalid cookie name, or
 * `session.strategy: "database"` with no store to put sessions in.
 *
 * @param config The app's {@link AuthConfig}.
 * @returns The fully-defaulted {@link ResolvedAuthOptions} for it.
 */
export function resolveAuthOptions(config: AuthConfig): ResolvedAuthOptions {
  const cached = resolved.get(config);
  if (cached) return cached;
  const logger = resolveLogger(config.logger);
  const basePath = normalizeBasePath(config.basePath);
  const options: ResolvedAuthOptions = {
    basePath,
    prefix: `${basePath}/`,
    cookies: {
      session: resolveCookie(config.cookies?.session, DEFAULT_SESSION_COOKIE),
      transaction: resolveCookie(config.cookies?.transaction, DEFAULT_TX_COOKIE),
    },
    maxAge: config.session?.maxAge ?? config.maxAge ?? DEFAULT_MAX_AGE,
    updateAge: config.session?.updateAge ?? 0,
    hasher: config.hasher ?? scryptHasher(),
    logger,
    events: config.events ?? {},
    sessionStore: resolveSessionStore(config, logger),
    adapter: config.adapter,
    email: resolveEmail(config.email ?? {}, basePath),
    mfa: resolveMfa(config.mfa ?? {}, config.canonicalOrigin),
  };
  resolved.set(config, options);
  return options;
}

/**
 * Normalise a configured base path: add the leading slash, drop the trailing one, and
 * refuse anything that would make the handler claim the whole site (`"/"`) or that isn't
 * a plain path (empty segments, a query, whitespace).
 */
function normalizeBasePath(configured: string | undefined): string {
  if (configured === undefined) return DEFAULT_BASE_PATH;
  const withSlash = configured.startsWith("/") ? configured : `/${configured}`;
  const trimmed = withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
  // `.` and `..` pass the character class (a dot is URL-safe) but are not places: a
  // `basePath` of "/auth/.." would have the handler claim, and the routes advertise, a
  // prefix that resolves somewhere else entirely.
  const traverses = trimmed.split("/").some((segment) => TRAVERSAL_SEGMENTS.has(segment));
  if (!BASE_PATH_RE.test(trimmed) || traverses) {
    throw new Error(
      `denextAuth: \`basePath\` ${JSON.stringify(configured)} is not a usable path — it must ` +
        'be one or more non-empty URL-safe segments, e.g. "/auth" or "/account/auth" ' +
        '(never "/", which would claim every request, and never a "." or ".." segment).',
    );
  }
  return trimmed;
}

/** A positive, finite lifetime in whole seconds, else `fallback`. */
function lifetime(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

/** A whole number clamped into `[min, max]`; a non-finite value is `fallback`. */
function clamped(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * A configured link path, or `fallback` when unset. Anything that isn't a same-origin
 * absolute path is refused at config time — a `//host` value would mail users a link to
 * another site, carrying a live token.
 */
function linkPath(field: string, configured: string | undefined, fallback: string): string {
  if (configured === undefined) return fallback;
  if (!LINK_PATH_RE.test(configured)) {
    throw new Error(
      `denextAuth: \`email.${field}\` ${JSON.stringify(configured)} is not a same-origin ` +
        'path — it must start with a single "/" (e.g. "/account/verify") and contain no ' +
        "whitespace or backslashes.",
    );
  }
  return configured;
}

/** Apply the email-flow defaults: lifetimes, the OTP length, and the two link targets. */
function resolveEmail(email: AuthEmailConfig, basePath: string): Required<AuthEmailConfig> {
  return {
    verifyMaxAge: lifetime(email.verifyMaxAge, DEFAULT_EMAIL_MAX_AGES.verify),
    resetMaxAge: lifetime(email.resetMaxAge, DEFAULT_EMAIL_MAX_AGES.reset),
    magicMaxAge: lifetime(email.magicMaxAge, DEFAULT_EMAIL_MAX_AGES.magic),
    otpMaxAge: lifetime(email.otpMaxAge, DEFAULT_EMAIL_MAX_AGES.otp),
    otpDigits: clamped(email.otpDigits, 6, 6, 10),
    verifyPath: linkPath("verifyPath", email.verifyPath, `${basePath}/verify`),
    resetPath: linkPath("resetPath", email.resetPath, `${basePath}/reset`),
  };
}

/** The authenticator issuer label: the configured one, else the canonical host, else "denext". */
function mfaIssuer(configured: string | undefined, canonicalOrigin: string | undefined): string {
  const trimmed = configured?.trim();
  if (trimmed) return trimmed;
  try {
    return canonicalOrigin
      ? new URL(canonicalOrigin).hostname || DEFAULT_MFA_ISSUER
      : DEFAULT_MFA_ISSUER;
  } catch {
    return DEFAULT_MFA_ISSUER;
  }
}

/** Apply the MFA defaults, clamping the drift window and the backup-code count. */
function resolveMfa(
  mfa: AuthMfaConfig,
  canonicalOrigin: string | undefined,
): Required<AuthMfaConfig> {
  return {
    required: mfa.required === "always" ? "always" : "enrolled",
    issuer: mfaIssuer(mfa.issuer, canonicalOrigin),
    window: clamped(mfa.window, DEFAULT_MFA.window, 0, 2),
    backupCodes: clamped(mfa.backupCodes, DEFAULT_MFA.backupCodes, 0, 20),
    freshness: lifetime(mfa.freshness, DEFAULT_MFA.freshness),
  };
}

/** Apply the cookie defaults, validating the name so it can't break the Set-Cookie header. */
function resolveCookie(
  configured: AuthCookieConfig | undefined,
  defaultName: string,
): ResolvedAuthCookie {
  const name = configured?.name ?? defaultName;
  if (!COOKIE_NAME_RE.test(name)) {
    throw new Error(
      `denextAuth: cookie name ${JSON.stringify(name)} is not a valid cookie token — use ` +
        "letters, digits, or any of !#$%&'*+-.^_`|~ (denext adds the `__Host-` prefix itself).",
    );
  }
  return {
    name,
    hostPrefix: configured?.hostPrefix ?? true,
    sameSite: configured?.sameSite ?? "Lax",
    path: configured?.path ?? "/",
  };
}

/** An {@link AuthLogger} with no-op fallbacks, so callers never branch on `?.`. */
function resolveLogger(logger: AuthLogger | undefined): ResolvedAuthLogger {
  return {
    debug: (message, meta) => logger?.debug?.(message, meta),
    warn: (message, meta) => logger?.warn?.(message, meta),
    error: (message, error) => logger?.error?.(message, error),
  };
}

/**
 * Decide where sessions live. An explicit `sessionStore` always wins; otherwise a
 * `"database"` strategy takes the adapter's store. `"database"` with neither is a
 * config-time error, because sessions would silently stay stateless — an app that asked
 * for revocable sessions and didn't get them is a security surprise, not a default.
 */
function resolveSessionStore(
  config: AuthConfig,
  logger: ResolvedAuthLogger,
): SessionStore | undefined {
  const adapterSessions = config.adapter?.sessions;
  if (config.sessionStore && adapterSessions && config.sessionStore !== adapterSessions) {
    logger.warn(
      "denextAuth: both `sessionStore` and `adapter.sessions` are configured and they are " +
        "different stores — the explicit `sessionStore` wins; the adapter's is unused.",
    );
  }
  if (config.sessionStore) return config.sessionStore;
  if (config.session?.strategy !== "database") return undefined;
  if (!adapterSessions) {
    throw new Error(
      'denextAuth: `session.strategy: "database"` needs somewhere to put sessions — pass ' +
        "`sessionStore` (e.g. `sqliteSessionStore()`) or an `adapter` that exposes `sessions`.",
    );
  }
  return adapterSessions;
}
