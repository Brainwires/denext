/**
 * `next/cache` compat — `revalidatePath`, `revalidateTag`, `unstable_cache`, and
 * the Cache Components APIs (`cacheLife`, `cacheTag`), re-exported from denext's
 * server runtime.
 * @module
 */
export {
  cacheLife,
  cacheTag,
  revalidatePath,
  revalidateTag,
  unstable_cache,
} from "../../server/mod.ts";
