/**
 * `next/cache` compat — `revalidatePath`, `revalidateTag`, `unstable_cache`, and
 * the Cache Components APIs (`cacheLife`, `cacheTag`), re-exported from denext's
 * server runtime.
 * @module
 */
export {
  cacheLife,
  cacheTag,
  refresh,
  revalidatePath,
  revalidateTag,
  unstable_cache,
  updateTag,
} from "../../server/mod.ts";
