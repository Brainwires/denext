/**
 * One `NextAuth` instance per config object: what `NextAuth(config)` (v5), `NextAuth(options)`
 * (v4) and `getServerSession(options)` (v4) build from the app's config — translated to denext's
 * once, validated, and made the process's active one. The same options object always answers
 * the same instance, so a v4 app's `[...nextauth]` route and its `getServerSession(authOptions)`
 * calls share one config (and one rate-limit budget).
 *
 * @module
 */

import { bindAuthConfig, denextAuth } from "../../server/auth/mod.ts";
import type { RateLimitOptions } from "../../server/auth/rate-limit.ts";
import { translateConfig } from "./config.ts";
import { type ActiveNextAuth, bindActiveNextAuth, setActiveNextAuth } from "./state.ts";
import type { NextAuthConfig } from "./types.ts";

/** The instance each static config object was translated to. */
const instances = new WeakMap<object, ActiveNextAuth>();

/**
 * Translate `config` and validate it as denext's (which also makes it the process's active
 * one), without caching.
 *
 * @param config The Auth.js config.
 * @param rateLimit Shared rate limits (a lazy config's translations share one budget).
 * @returns The instance.
 */
export function instanceOf(config: NextAuthConfig, rateLimit?: RateLimitOptions): ActiveNextAuth {
  const active = translateConfig(config, undefined, rateLimit);
  // Validates the translated config (secret, providers, origin) and makes it the one `auth()`
  // reads. The plugin it returns is not needed: the handlers serve the endpoints.
  denextAuth(active.denext);
  setActiveNextAuth(active);
  return active;
}

/**
 * The instance for a static config object: built on first use, the same one afterwards.
 *
 * @param config The Auth.js config (v5 `NextAuthConfig` or v4 `NextAuthOptions`).
 * @returns The instance.
 */
export function instanceFor(config: NextAuthConfig): ActiveNextAuth {
  let active = instances.get(config);
  if (!active) instances.set(config, active = instanceOf(config));
  return active;
}

/**
 * Make `active` the instance this request reads (its Auth.js config and denext's), whatever
 * another instance made active meanwhile. Outside a request it does nothing.
 *
 * @param active The instance.
 */
export function bindInstance(active: ActiveNextAuth): void {
  bindActiveNextAuth(active);
  bindAuthConfig(active.denext);
}
