// `denext doctor`'s denextAuth checks. SAML Single Logout of stateless cookie sessions keeps its
// session index and revocation list in the auth adapter: an adapter without those methods leaves
// it off (a LogoutRequest ends every session of the user), and the in-memory adapter keeps them
// per process, lost on a restart and unseen by other instances. The config is read off the plugin
// object structurally (the auth plugin is the app's `@denext/auth`, not a module of the CLI).

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
/** The key `inMemoryAuthAdapter()` marks its adapter with. */
const IN_MEMORY_ADAPTER = Symbol.for("denext.auth.inMemoryAdapter");

/**
 * The methods an auth adapter needs to revoke one SAML cookie session (`@denext/auth`'s
 * `cookieRevocationOf` checks the same list).
 */
const COOKIE_REVOCATION_METHODS = [
  "recordSsoSessionIndex",
  "listSsoSessionIndexBySessionIndex",
  "listSsoSessionIndexByNameId",
  "revokeSids",
  "isSidRevoked",
] as const;

/** The structural slice of an auth adapter this check reads. */
type AuthAdapterSlice = Partial<Record<(typeof COOKIE_REVOCATION_METHODS)[number], unknown>>;

/** The structural slice of an auth config this check reads. */
interface AuthConfigSlice {
  adapter?: AuthAdapterSlice;
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

/** Whether a `saml()` provider's Single Logout would end stateless cookie sessions. */
function logsOutCookieSessions(auth: AuthConfigSlice): boolean {
  if (!auth.adapter || auth.sessionStore || auth.session?.strategy === "database") return false;
  return (auth.providers ?? []).some((p) => p?.type === "saml" && !!p.sp?.signingKey);
}

/** What is wrong with the adapter for Single Logout of cookie sessions, or `null`. */
function adapterProblem(adapter: AuthAdapterSlice): string | null {
  if (!COOKIE_REVOCATION_METHODS.every((m) => typeof adapter[m] === "function")) {
    return "the auth adapter keeps no SAML session index (`recordSsoSessionIndex` … " +
      "`isSidRevoked`), so an IdP's LogoutRequest ends every session of the user instead of " +
      "the one it names — use sqliteAuthAdapter, postgresAuthAdapter or backendAuthAdapter";
  }
  if ((adapter as unknown as Record<symbol, unknown>)[IN_MEMORY_ADAPTER] === true) {
    return "the in-memory auth adapter keeps the SAML session index and revocation list in this " +
      "process: a restart forgets them and another instance never sees them — use " +
      "sqliteAuthAdapter, postgresAuthAdapter or backendAuthAdapter in production";
  }
  return null;
}

/**
 * The SAML Single Logout check: a warning (never critical) when stateless SAML sessions can't be
 * revoked exactly (the adapter lacks the session index) or only in this process (the in-memory
 * adapter).
 *
 * @param config The loaded `denext.config`.
 * @returns The check, or `null` when no `saml()` provider logs out cookie sessions.
 */
export function samlLogoutStoreCheck(config: DenextConfig | null): AuthCheck | null {
  const auth = authConfigOf(config);
  if (!auth?.adapter || !logsOutCookieSessions(auth)) return null;
  const problem = adapterProblem(auth.adapter);
  return {
    name: "saml logout store",
    ok: problem === null,
    detail: problem ?? "SAML Single Logout revocations live in the auth adapter",
    critical: false,
  };
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
