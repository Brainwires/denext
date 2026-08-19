// A `use cache` data helper. The directive compiles (build-time) into a
// cross-request cache: the body runs once and its result is reused, so the
// timestamp captured here is STABLE across requests — it lives in the static
// shell. `cacheLife`/`cacheTag` tune lifetime and invalidation.
import { cacheLife, cacheTag } from "denext/server";

/** The (cached) time the shell's data was computed — identical across requests. */
export async function getCachedStamp(): Promise<string> {
  "use cache";
  cacheLife("minutes");
  cacheTag("stamp");
  // Simulate a data source; the value is cached, so this runs once per lifetime.
  await new Promise((r) => setTimeout(r, 10));
  return new Date().toISOString();
}
