// Which seed files have run, by content hash — the Supabase CLI's
// `supabase_migrations.seed_files (path, hash)`: `denext db seed` (and `db push
// --include-seed`) skips a file whose hash is unchanged, runs a new or edited one, and `--force`
// runs them all. A Supabase-history project uses that very table; denext's `_migrations`
// projects keep `_seed_files` beside it (Postgres or SQLite). `db reset` drops it with the rest,
// so a reset seeds again.

import type { MigrationHistory } from "../../server/migration-history.ts";
import { type SqlClient, sqlState } from "../../server/postgres.ts";
import type { DbTarget } from "./target.ts";

/** The seed-file record of a database. */
export interface SeedFiles {
  /** The table, for messages. */
  readonly table: string;
  /** The hash recorded for `path`, if it ran before. */
  hashOf(path: string): Promise<string | undefined>;
  /** Record that `path` ran with this content hash. */
  record(path: string, hash: string): Promise<void>;
}

/**
 * The SHA-256 (hex) of a seed file's text.
 *
 * @param text The file's text.
 * @returns The hash.
 */
export async function seedHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** SQLSTATEs for a missing table or schema. */
const MISSING = new Set(["42P01", "3F000"]);

function postgresSeeds(sql: SqlClient, table: string, schema?: string): SeedFiles {
  const setup = async () => {
    if (schema) await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${table} (path text NOT NULL PRIMARY KEY, hash text NOT NULL)`,
    );
  };
  return {
    table,
    async hashOf(path) {
      try {
        const rows = await sql.unsafe<{ hash: string }>(
          `SELECT hash FROM ${table} WHERE path = $1`,
          [path],
        );
        return rows[0]?.hash;
      } catch (error) {
        if (MISSING.has(sqlState(error) ?? "")) return undefined;
        throw error;
      }
    },
    async record(path, hash) {
      await setup();
      await sql.unsafe(
        `INSERT INTO ${table} (path, hash) VALUES ($1, $2) ` +
          "ON CONFLICT (path) DO UPDATE SET hash = EXCLUDED.hash",
        [path, hash],
      );
    },
  };
}

/**
 * The seed-file record a target keeps: `supabase_migrations.seed_files` with the Supabase
 * history, else `_seed_files`.
 *
 * @param target The database.
 * @param history Its migration history (which decides the table).
 * @returns The record.
 */
export function seedFilesFor(target: DbTarget, history: MigrationHistory): SeedFiles {
  if (target.dialect === "postgres") {
    return history.format === "supabase"
      ? postgresSeeds(target.sql!, "supabase_migrations.seed_files", "supabase_migrations")
      : postgresSeeds(target.sql!, "_seed_files");
  }
  const db = target.sqlite!;
  const setup = () =>
    db.exec("CREATE TABLE IF NOT EXISTS _seed_files (path TEXT PRIMARY KEY, hash TEXT NOT NULL)");
  return {
    table: "_seed_files",
    hashOf(path) {
      setup();
      const rows = db.prepare("SELECT hash FROM _seed_files WHERE path = ?").all(path) as {
        hash: string;
      }[];
      return Promise.resolve(rows[0]?.hash);
    },
    record(path, hash) {
      setup();
      db.prepare("INSERT OR REPLACE INTO _seed_files (path, hash) VALUES (?, ?)").run(path, hash);
      return Promise.resolve();
    },
  };
}
