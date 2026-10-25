// `denext doctor`'s denextAuth checks. SAML Single Logout of stateless cookie sessions keeps its
// session index and revocation list in the app's cache store; the in-memory store is per
// instance, so a production deployment of several instances would revoke a session on one
// instance only. The config is read off the plugin object structurally (the CLI's copy of the
// auth module may not be the app's).

import type { DenextConfig } from "../../server/config.ts";

/** One doctor line (the shape `doctor.ts` prints). */
export interface AuthCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly critical: boolean;
}

/** The key `denextAuth()` puts its config under on the plugin object. */
const AUTH_PLUGIN_CONFIG = Symbol.for("denext.auth.pluginConfig");

/** The structural slice of an auth config this check reads. */
interface AuthConfigSlice {
  adapter?: unknown;
  sessionStore?: unknown;
  session?: { strategy?: string };
  providers?: { type?: string; sp?: { signingKey?: unknown } }[];
}

function authConfigOf(config: DenextConfig | null): AuthConfigSlice | null {
  for (const plugin of config?.plugins ?? []) {
    if (plugin?.name !== "denext-auth") continue;
    const found = (plugin as unknown as Record<symbol, unknown>)[AUTH_PLUGIN_CONFIG];
    if (found && typeof found === "object") return found as AuthConfigSlice;
  }
  return null;
}

/** Whether SAML Single Logout would revoke stateless cookie sessions through the cache store. */
function revokesCookieSessions(auth: AuthConfigSlice): boolean {
  if (!auth.adapter || auth.sessionStore || auth.session?.strategy === "database") return false;
  return (auth.providers ?? []).some((p) => p?.type === "saml" && !!p.sp?.signingKey);
}

function envSet(name: string): boolean {
  try {
    return !!Deno.env.get(name);
  } catch {
    return false;
  }
}

/** Whether an app-provided store object is the built-in in-memory one. */
function inMemoryObject(store: object): string | null {
  const name = (store as { constructor?: { name?: string } }).constructor?.name;
  return name === "InMemoryCache" ? "an in-memory `cache.store`" : null;
}

/** Whether the default store would be the in-memory one: on Deno Deploy. */
function deployDefault(config: DenextConfig): string | null {
  const onDeploy = envSet("DENO_DEPLOYMENT_ID") || config.deploy?.adapter?.name === "deno-deploy";
  return onDeploy ? "Deno Deploy (the in-memory cache store by default)" : null;
}

/** Why the production cache store would be the in-memory one, or `null` when it won't. */
function inMemoryReason(config: DenextConfig): string | null {
  const store = config.cache?.store;
  if (store === "memory") return '`cache: { store: "memory" }`';
  if (store && typeof store === "object") return inMemoryObject(store);
  return store === "sqlite" ? null : deployDefault(config);
}

/**
 * `denext doctor`'s denextAuth checks.
 *
 * @param config The loaded `denext.config`.
 * @returns The checks that apply (none without an auth plugin).
 */
export function authChecks(config: DenextConfig | null): AuthCheck[] {
  const check = samlLogoutStoreCheck(config);
  return check ? [check] : [];
}

/**
 * The SAML Single Logout store check: a warning (never critical) when stateless SAML sessions
 * would keep their revocation list in the in-memory cache store in production.
 *
 * @param config The loaded `denext.config`.
 * @returns The check, or `null` when no `saml()` provider revokes cookie sessions.
 */
export function samlLogoutStoreCheck(config: DenextConfig | null): AuthCheck | null {
  const auth = authConfigOf(config);
  if (!config || !auth || !revokesCookieSessions(auth)) return null;
  const reason = inMemoryReason(config);
  return {
    name: "saml logout store",
    ok: reason === null,
    detail: reason === null
      ? "SAML Single Logout revocations live in the cache store"
      : `SAML Single Logout keeps its revocation list in memory (${reason}): with more than one ` +
        "instance a LogoutRequest revokes the session on one of them only — set `cache.store` " +
        "to a shared store (Postgres, Redis, Deno KV) or give denextAuth a `sessionStore`",
    critical: false,
  };
}
