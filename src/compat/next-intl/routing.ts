/**
 * `next-intl/routing` compat — `defineRouting` and the normalized routing shape
 * shared by the navigation and middleware helpers.
 *
 * @module
 */

/** How locale prefixes appear in the URL. */
export type LocalePrefixMode = "always" | "as-needed" | "never";

/** Routing configuration accepted by {@link defineRouting}. */
export interface RoutingConfig {
  /** Supported locales. */
  locales: string[];
  /** The default locale. */
  defaultLocale: string;
  /** Prefix strategy (default `"always"`). */
  localePrefix?: LocalePrefixMode | { mode: LocalePrefixMode };
  /** Whether to set/read the locale cookie (default true). */
  localeCookie?: boolean | { name?: string };
  /** Whether to auto-detect the locale from headers (default true). */
  localeDetection?: boolean;
}

/** A routing config with defaults resolved. */
export interface ResolvedRouting extends RoutingConfig {
  /** Resolved prefix mode. */
  localePrefixMode: LocalePrefixMode;
  /** Resolved locale cookie name (empty string when disabled). */
  cookieName: string;
}

/** The default cookie name next-intl uses. */
const DEFAULT_COOKIE = "NEXT_LOCALE";

/**
 * Normalize + validate a routing config (fills defaults). Mirrors
 * `next-intl`'s `defineRouting`.
 *
 * @param config The routing config.
 * @returns The resolved routing.
 */
export function defineRouting(config: RoutingConfig): ResolvedRouting {
  const localePrefixMode = typeof config.localePrefix === "object"
    ? config.localePrefix.mode
    : (config.localePrefix ?? "always");
  const cookieName = config.localeCookie === false
    ? ""
    : (typeof config.localeCookie === "object" && config.localeCookie.name) || DEFAULT_COOKIE;
  return { ...config, localePrefixMode, cookieName };
}

/** Detect the best locale for a request from cookie, `Accept-Language`, then default. */
export function detectLocale(request: Request, routing: ResolvedRouting): string {
  if (routing.localeDetection !== false && routing.cookieName) {
    const cookie = request.headers.get("cookie") ?? "";
    const match = new RegExp(`(?:^|; )${RegExp.escape(routing.cookieName)}=([^;]+)`).exec(cookie);
    if (match && routing.locales.includes(match[1])) return match[1];
  }
  if (routing.localeDetection !== false) {
    const accept = request.headers.get("accept-language") ?? "";
    for (const part of accept.split(",")) {
      const tag = part.split(";")[0].trim();
      const base = tag.split("-")[0];
      const hit = routing.locales.find((l) => l === tag || l === base || l.split("-")[0] === base);
      if (hit) return hit;
    }
  }
  return routing.defaultLocale;
}
