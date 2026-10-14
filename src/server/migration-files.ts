// Migration files: how a directory of SQL becomes ordered migrations with an up and (optionally)
// a down script. Shared by the Postgres runner (`migratePostgres`), the SQLite runner
// (`migrateSqlite`) and the `denext migration` / `denext db` verbs.
//
// - `<version>_<name>.sql` — the version is the leading digits (Supabase's `<timestamp>_<name>`
//   convention, and what `denext generate migration` writes); a file without them is its own
//   version (its name minus `.sql`).
// - A file may hold both directions in dbmate-style sections: `-- migrate:up` then
//   `-- migrate:down`. Without markers the whole file is the up script.
// - A sibling `<version>_<name>.down.sql` is the down script instead (it is never a migration of
//   its own).

import { join } from "@std/path";

/** One migration as read from disk. */
export interface MigrationFile {
  /** The file name (`20261007093000_add_users.sql`): what `_migrations` records. */
  name: string;
  /** The version (`20261007093000`): what Supabase's history records and `--to` compares. */
  version: string;
  /** The name part after the version (`add_users`), or the whole stem without one. */
  label: string;
  /** The SQL that applies it. */
  up: string;
  /** The SQL that reverts it, when the file (or a `.down.sql` beside it) has one. */
  down?: string;
}

/** `20261007093000_add_users.sql` → version and label. */
const VERSIONED = /^([0-9]+)_(.*)\.sql$/;

/** A `-- migrate:up` / `-- migrate:down` marker line. */
const MARKER = /^[ \t]*--[ \t]*migrate:(up|down)\b.*$/gim;

/** A `.down.sql` companion. */
const DOWN_SUFFIX = ".down.sql";

/**
 * The version and label of a migration file name.
 *
 * @param name The file name.
 * @returns Its version and label.
 */
export function versionOf(name: string): { version: string; label: string } {
  const match = VERSIONED.exec(name);
  if (match) return { version: match[1], label: match[2] };
  const stem = name.replace(/\.sql$/, "");
  return { version: stem, label: stem };
}

/**
 * Whether a file name follows `<digits>_<name>.sql` (the only shape Supabase's history accepts).
 *
 * @param name The file name.
 * @returns True when it is versioned.
 */
export function isVersioned(name: string): boolean {
  return VERSIONED.test(name);
}

/**
 * Split a migration's text into its up and down scripts.
 *
 * @param text The file's SQL.
 * @returns The up script and, when the text has a `-- migrate:down` section, the down one.
 */
export function splitMigration(text: string): { up: string; down?: string } {
  const markers = [...text.matchAll(MARKER)];
  if (!markers.length) return { up: text };
  // Text before the first marker belongs to the up script (comments, usually).
  let up = text.slice(0, markers[0].index);
  let down: string | undefined;
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const start = marker.index! + marker[0].length;
    const end = i + 1 < markers.length ? markers[i + 1].index! : text.length;
    const body = text.slice(start, end);
    if (marker[1].toLowerCase() === "up") up += body;
    else down = (down ?? "") + body;
  }
  return { up, ...(down !== undefined && down.trim() ? { down } : {}) };
}

/**
 * One migration from its file name and text (plus a `.down.sql` companion's text).
 *
 * @param name The file name.
 * @param text The file's SQL.
 * @param downText A `.down.sql` companion's SQL, when there is one.
 * @returns The migration.
 * @throws {Error} When both the file and a companion define a down script.
 */
export function parseMigration(name: string, text: string, downText?: string): MigrationFile {
  const { up, down } = splitMigration(text);
  if (down !== undefined && downText !== undefined && downText.trim()) {
    throw new Error(
      `migration ${name} has a -- migrate:down section and a ${
        name.replace(/\.sql$/, DOWN_SUFFIX)
      } file: keep one`,
    );
  }
  const companion = downText !== undefined && downText.trim() ? downText : undefined;
  return {
    name,
    ...versionOf(name),
    up,
    ...(down ?? companion ? { down: down ?? companion } : {}),
  };
}

/**
 * Whether a directory entry is a migration (`*.sql`, not a `.down.sql` companion).
 *
 * @param name The file name.
 * @returns True for a migration file.
 */
function isMigrationFile(name: string): boolean {
  return name.endsWith(".sql") && !name.endsWith(DOWN_SUFFIX);
}

/** A path inside `dir` (a path or a `file:` URL). */
function inDir(dir: string | URL, name: string): string | URL {
  if (typeof dir === "string") return `${dir.replace(/\/?$/, "/")}${name}`;
  const base = dir.href.endsWith("/") ? dir : new URL(`${dir.href}/`);
  // Encoded: a `#`, `?` or `%` in a file name is part of the name, not URL syntax.
  return new URL(encodeURIComponent(name), base);
}

/** A file's text, or `undefined` when it does not exist. */
async function readOptional(path: string | URL): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

/**
 * Every migration in `dir`, in file-name order. A missing directory has none.
 *
 * @param dir The directory (a path or a `file:` URL).
 * @returns The migrations.
 */
export async function readMigrationFiles(dir: string | URL): Promise<MigrationFile[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && isMigrationFile(entry.name)) names.push(entry.name);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  names.sort();
  const out: MigrationFile[] = [];
  for (const name of names) {
    const text = await Deno.readTextFile(inDir(dir, name));
    const downText = await readOptional(inDir(dir, name.replace(/\.sql$/, DOWN_SUFFIX)));
    out.push(parseMigration(name, text, downText));
  }
  return out;
}

/**
 * Compare two versions: numerically when both are digits (so `9_x` sorts before `10_x`
 * regardless of padding), else as strings.
 *
 * @param a A version.
 * @param b Another.
 * @returns Negative, zero or positive.
 */
export function compareVersions(a: string, b: string): number {
  if (/^[0-9]+$/.test(a) && /^[0-9]+$/.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether `path` is a directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/**
 * A project's migrations directory, relative to it: `migrations` (what `denext generate
 * migration` writes), else `supabase/migrations` when only that one exists (a Supabase project),
 * else `migrations`.
 *
 * @param projectDir The project.
 * @returns The directory, relative to the project, with `/` separators.
 */
export async function projectMigrationsDir(projectDir: string): Promise<string> {
  if (await isDirectory(join(projectDir, "migrations"))) return "migrations";
  if (await isDirectory(join(projectDir, "supabase", "migrations"))) return "supabase/migrations";
  return "migrations";
}
