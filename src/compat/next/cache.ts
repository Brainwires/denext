/**
 * `next/cache` compat — `revalidatePath`, `revalidateTag`, `updateTag`, `refresh`,
 * `unstable_cache`, the Cache Components APIs (`cacheLife`, `cacheTag`) re-exported from
 * denext's server runtime, and Next.js 16.4's render-stage markers (`navigation`, `prefetch`).
 * @module
 */
import { cacheLife, cacheTag, noStore } from "../../server/mod.ts";
import { currentCacheScopeKind } from "../../server/cache-scope.ts";
import { currentContext } from "../../server/request-context.ts";

export {
  cacheLife,
  cacheTag,
  refresh,
  revalidatePath,
  revalidateTag,
  unstable_cache,
  updateTag,
} from "../../server/mod.ts";

// The `unstable_`-prefixed spellings Next still ships alongside the stable ones.
export { cacheLife as unstable_cacheLife, cacheTag as unstable_cacheTag };

/**
 * `unstable_noStore` — opt the current render out of the page cache. A route with
 * `export const revalidate = N` that reads per-user data and calls this is rendered per
 * request instead of being stored and served to every visitor.
 *
 * @deprecated Next.js 15 deprecates it in favor of `connection()` (from `denext/server`),
 * which denext also implements. Kept as a compatible alias because Next still exports it.
 */
export function unstable_noStore(): void {
  noStore();
}

/**
 * `unstable_rethrow` — re-throw denext's control-flow signals (`redirect()`, `notFound()`,
 * `forbidden()`, `unauthorized()`) from inside a `try`/`catch`, so a catch-all handler
 * doesn't swallow them. A no-op for any other value.
 */
export { unstable_rethrow } from "../../runtime/error-boundary.ts";

/** `unstable_after` — the pre-stable spelling of `after()`. */
export { after as unstable_after } from "../../server/mod.ts";
/** `unstable_expirePath` / `unstable_expireTag` — Next 15's spellings of revalidatePath/Tag. */
export {
  revalidatePath as unstable_expirePath,
  revalidateTag as unstable_expireTag,
} from "../../server/mod.ts";

/**
 * `io` — Next 16's marker that the code after it performs I/O or reads a dynamic source
 * (`new Date()`, `Math.random()`). Next.js uses it to end a prerender at that point; denext's
 * PPR prerender already treats such reads as part of the render, so it resolves at once, inside
 * a `"use cache"` scope and in a request alike (as Next.js's does there).
 */
export function io(): Promise<void> {
  return Promise.resolve();
}

/**
 * The checks `navigation()` and `prefetch()` share (Next.js 16.4's render-stage markers): a
 * request scope, and not inside a cached function, where the stage boundary itself would be
 * cached. Messages are Next.js's.
 */
function assertStageMarker(name: "navigation" | "prefetch"): void {
  if (!currentContext()) {
    throw new Error(`\`${name}\` was called outside a request scope.`);
  }
  const kind = currentCacheScopeKind();
  if (kind === undefined) return;
  if (kind === "unstable") {
    throw new Error(
      `Route used \`${name}()\` inside a function cached with \`unstable_cache()\`. This is not ` +
        `supported: \`unstable_cache()\` caches must be able to be produced before a ${name}.`,
    );
  }
  const directive = kind === "private" ? '"use cache: private"' : '"use cache"';
  throw new Error(
    `Route used \`${name}()\` inside ${directive}. This is not currently supported. Instead, ` +
      `move the "use cache" directive to a function that's called below \`await ${name}()\`, so ` +
      `that the cached content is deferred to the ${name} without caching the stage boundary itself.`,
  );
}

/**
 * `navigation()` — Next.js 16.4: the code after `await navigation()` runs only for an actual
 * navigation, not for a runtime prefetch. denext renders a route only when it is requested (it
 * has no runtime prefetch), so in a request it resolves at once; the content below it stays
 * cacheable (it doesn't make the render dynamic).
 *
 * @throws Outside a request, or inside a cached function (Next.js's rule).
 */
export function navigation(): Promise<void> {
  assertStageMarker("navigation");
  return Promise.resolve();
}

/**
 * `prefetch()` — Next.js 16.4: the code after `await prefetch()` is left out of the route's
 * shell and deferred to a prefetch or navigation. denext has no partial prefetching, so in a
 * request it resolves at once; the content below it stays cacheable.
 *
 * @throws Outside a request, or inside a cached function (Next.js's rule).
 */
export function prefetch(): Promise<void> {
  assertStageMarker("prefetch");
  return Promise.resolve();
}

/**
 * `unstable_navigation` — Next.js 16.4 canary's spelling of {@link navigation}.
 * @deprecated Import `navigation`; kept so an app that adopted the canary name still links.
 */
export const unstable_navigation: typeof navigation = navigation;

/**
 * `unstable_prefetch` — Next.js 16.4 canary's spelling of {@link prefetch}.
 * @deprecated Import `prefetch`; kept so an app that adopted the canary name still links.
 */
export const unstable_prefetch: typeof prefetch = prefetch;
