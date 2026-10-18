// The `use cache` scope primitive, split out so both `cache.ts` (which runs and
// reads scopes) and `request-context.ts` (which only checks "are we inside one?"
// to reject request-specific reads) can depend on it without importing each other
// — breaking what used to be a `cache.ts` ⇄ `request-context.ts` cycle.

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A cache lifetime profile, in **seconds** (Next.js `cacheLife`). All fields are
 * optional; an omitted field inherits the `default` profile's value.
 */
export interface CacheLifeProfile {
  /** Client-side staleness window: served without a background check (SWR hint). */
  stale?: number;
  /** Seconds until the entry is refreshed in the background (stale-while-revalidate). */
  revalidate?: number;
  /** Hard maximum age (seconds) before the value must be recomputed; `Infinity` = never. */
  expire?: number;
}

/** The fields of a {@link CacheLifeProfile}. */
export const LIFE_FIELDS = ["stale", "revalidate", "expire"] as const;

/** Where a profile came from, for {@link validateCacheLifeProfile}'s messages. */
type ProfileSource = { kind: "inline" } | { kind: "config"; name: string };

/** Next.js's check of one `cacheLife` field: a number of seconds, or `Infinity`. */
function checkLifeValue(key: (typeof LIFE_FIELDS)[number], value: unknown, from: ProfileSource) {
  if (value === undefined) return;
  if (value === false) {
    throw new Error(
      key === "stale"
        ? "Pass `Infinity` instead of `false` if you want to cache on the client forever without checking with the server."
        : key === "revalidate"
        ? "Pass `Infinity` instead of `false` if you do not want to revalidate by time."
        : "Pass `Infinity` instead of `false` if you want to cache on the server forever without checking with the origin.",
    );
  }
  if (typeof value !== "number") throw new Error(`The ${key} option must be a number of seconds.`);
  if (value !== Infinity && !Number.isFinite(value)) {
    throw new Error(
      from.kind === "config"
        ? `Invalid "cacheLife.${from.name}.${key}" provided, expected a finite number of seconds or Infinity, received ${value}`
        : `Invalid \`cacheLife()\` option "${key}" provided, expected a finite number of seconds or Infinity, received ${value}.`,
    );
  }
}

/**
 * Validate a cacheLife profile as Next.js does (`validateAndNormalizeCacheLifeProfile`): each
 * field a number of seconds or `Infinity` (`false` is refused with a hint), and `expire` no
 * smaller than `revalidate`.
 *
 * @param profile The profile to check.
 * @param from `"inline"` for a `cacheLife({ … })` / `revalidateTag(tag, { … })` argument, or the
 *   config profile's name (for the config error message).
 * @returns The same profile.
 * @throws With Next.js's message when a field is invalid.
 */
export function validateCacheLifeProfile(
  profile: CacheLifeProfile,
  from: "inline" | { config: string } = "inline",
): CacheLifeProfile {
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
    throw new Error("Invalid `cacheLife()` option. Either pass a profile name or object.");
  }
  const source: ProfileSource = from === "inline"
    ? { kind: "inline" }
    : { kind: "config", name: from.config };
  for (const key of LIFE_FIELDS) checkLifeValue(key, profile[key], source);
  const { revalidate, expire } = profile;
  if (revalidate !== undefined && expire !== undefined && revalidate > expire) {
    throw new Error(
      "If providing both the revalidate and expire options, the expire option must be greater " +
        "than the revalidate option. The expire option indicates how many seconds from the " +
        "start until it can no longer be used.",
    );
  }
  return profile;
}

/**
 * What kind of cached function a scope belongs to: a shared `"use cache"` entry (also
 * `"use cache: remote"` and any other named handler), a per-request `"use cache: private"`
 * one, or an `unstable_cache()` loader. The request APIs and `cacheLife()` check it.
 */
export type CacheScopeKind = "public" | "private" | "unstable";

/** Mutable state a `use cache` scope accrues via `cacheLife` / `cacheTag`. */
export interface CacheScope {
  /** The scope's kind; absent means `"public"`. */
  kind?: CacheScopeKind;
  /**
   * The lifetime the body chose with `cacheLife()`: each field is the lowest value any call
   * set (Next.js's rule); a field no call set is absent. Undefined ⇒ no `cacheLife()` call.
   */
  life?: CacheLifeProfile;
  /**
   * The shortest lifetime of the cached functions the body called: a nested `"use cache"`
   * propagates its entry's remaining life here, an `unstable_cache()` call its `revalidate`
   * option. Applies to a field `cacheLife()` didn't set.
   */
  nested?: CacheLifeProfile;
  /**
   * Tags attached to this entry via `cacheTag` (and those of the cached calls it made: a nested
   * `"use cache"` entry's tags and an `unstable_cache()` call's `tags` option).
   */
  tags: string[];
}

// A `use cache` function body runs inside one of these; AsyncLocalStorage (not a
// module stack) so concurrent cached renders that interleave across `await` each
// see their own scope.
export const cacheScopeStorage = new AsyncLocalStorage<CacheScope>();

/** The kind of the enclosing cache scope, or undefined outside one. */
export function currentCacheScopeKind(): CacheScopeKind | undefined {
  const scope = cacheScopeStorage.getStore();
  return scope ? (scope.kind ?? "public") : undefined;
}

/** The cache scope of the enclosing `use cache` function, or undefined outside one. */
export function currentCacheScope(): CacheScope | undefined {
  return cacheScopeStorage.getStore();
}
