// Whether a project has a database for the Database section to show — decided from its files
// alone (`DATABASE_URL` in the environment or a `.env`, a `postgres:` key in its denext config),
// the same test `denext generate migration` uses, so nothing of the project's runs to decide it.
// Every page render asks (the navigation depends on it), so the answer is kept for a moment.

import { usesPostgres } from "@denext/denext/internal/ui-host";

/** How long one answer is reused, in ms. */
const TTL_MS = 5_000;

/** The last answer per project directory. */
const cache = new Map<string, { at: number; value: boolean }>();

/**
 * Whether the project at `dir` uses Postgres.
 *
 * @param dir The project directory.
 * @returns True when the Database section applies.
 */
export async function projectUsesDatabase(dir: string): Promise<boolean> {
  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = false;
  try {
    value = await usesPostgres(dir);
  } catch { /* unreadable: no section */ }
  cache.set(dir, { at: Date.now(), value });
  return value;
}
