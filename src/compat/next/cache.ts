/**
 * `next/cache` compat — `revalidatePath`, `revalidateTag`, `unstable_cache`, and
 * the Cache Components APIs (`cacheLife`, `cacheTag`), re-exported from denext's
 * server runtime.
 * @module
 */
import { cacheLife, cacheTag } from "../../server/mod.ts";

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
 * `unstable_noStore` — opt the current render out of caching (Next's pre-`"use cache"`
 * API). denext's cache is opt-in per `cache()`/`cacheTag` scope, so an un-annotated render
 * is already uncached; this is a no-op provided for source compatibility.
 */
export function unstable_noStore(): void {
  // no-op — denext does not cache a render unless it opts in.
}

/**
 * `io` — Next 16's experimental marker for I/O inside a cached scope. denext's cache model
 * does not require it; provided as a no-op for source/signature compatibility.
 */
export function io(): void {
  // no-op — accepted for compatibility.
}
