/**
 * `next/cache` compat — `revalidatePath`, `revalidateTag`, `unstable_cache`, and
 * the Cache Components APIs (`cacheLife`, `cacheTag`), re-exported from denext's
 * server runtime.
 * @module
 */
import { cacheLife, cacheTag, noStore } from "../../server/mod.ts";
import { isControlSignal } from "../../runtime/error-boundary.ts";

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
 * which denext also implements. Kept through 2.x; removed in 3.0.
 */
export function unstable_noStore(): void {
  noStore();
}

/**
 * `unstable_rethrow` — re-throw denext's control-flow signals (`redirect()`, `notFound()`,
 * `forbidden()`, `unauthorized()`) from inside a `try`/`catch`, so a catch-all handler
 * doesn't swallow them. A no-op for any other value.
 */
export function unstable_rethrow(error: unknown): void {
  if (isControlSignal(error)) throw error;
}

/** `unstable_after` — the pre-stable spelling of `after()`. */
export { after as unstable_after } from "../../server/mod.ts";
/** `unstable_expirePath` / `unstable_expireTag` — Next 15's spellings of revalidatePath/Tag. */
export {
  revalidatePath as unstable_expirePath,
  revalidateTag as unstable_expireTag,
} from "../../server/mod.ts";

/**
 * `io` — Next 16's experimental marker for I/O inside a cached scope. denext's cache model
 * does not require it; provided as a no-op for source/signature compatibility.
 */
export function io(): void {
  // no-op — accepted for compatibility.
}
