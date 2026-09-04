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

/** Mutable state a `use cache` scope accrues via `cacheLife` / `cacheTag`. */
export interface CacheScope {
  /** The lifetime chosen for this entry (last `cacheLife` wins); undefined ⇒ default. */
  life?: CacheLifeProfile;
  /** Tags attached to this entry via `cacheTag`. */
  tags: string[];
}

// A `use cache` function body runs inside one of these; AsyncLocalStorage (not a
// module stack) so concurrent cached renders that interleave across `await` each
// see their own scope.
export const cacheScopeStorage = new AsyncLocalStorage<CacheScope>();

/** The cache scope of the enclosing `use cache` function, or undefined outside one. */
export function currentCacheScope(): CacheScope | undefined {
  return cacheScopeStorage.getStore();
}
