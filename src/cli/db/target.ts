// Which database `denext migration …` / `denext db …` act on, and which migration history it
// keeps:
//
//   --db-url <url>   a postgres:// URL, or a SQLite file (`sqlite:<path>`, `file:<path>`, or a
//                    path ending .db / .sqlite / .sqlite3)
//   --linked         the URL `denext db link --url` stored (DENEXT_LINKED_DATABASE_URL in .env)
//   (default)        the project's own: `@denext/backend`'s client (`backend({ postgres })`),
//                    else DATABASE_URL when it is a postgres:// URL, else SQLite at DB_PATH
//                    (default app.db) — the database the generated jobs/migrate.ts uses.
//
// A target's URL is never printed: `display` masks the password.

import { isAbsolute, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { isPostgresUrl, postgresClient, type SqlClient } from "../../server/postgres.ts";
import {
  type MigrationHistory,
  postgresHistory,
  sqliteHistory,
  SUPABASE_HISTORY,
  supabaseHistory,
} from "../../server/migration-history.ts";
import { displayTarget } from "../db-admin/connection.ts";

/** The environment variable `denext db link` stores the remote database URL in. */
export const LINKED_URL_ENV = "DENEXT_LINKED_DATABASE_URL";

/** The feature named in a missing-client error. */
const FEATURE = "denext db";

/** The slot `@denext/backend` installs its Postgres client in (see packages/backend). */
const BACKEND_POSTGRES = Symbol.for("denext.backend.postgres");

/** A database the verbs act on. */
export interface DbTarget {
  /** Postgres or SQLite. */
  readonly dialect: "postgres" | "sqlite";
  /** The Postgres client. */
  readonly sql?: SqlClient;
  /** The SQLite database. */
  readonly sqlite?: DatabaseSync;
  /** The SQLite file. */
  readonly path?: string;
  /** The Postgres URL, when known (`pg_dump`, a shadow database). Never print it. */
  readonly url?: string;
  /** The target for messages, its password masked. */
  readonly display: string;
  /** Close what this opened. */
  close(): Promise<void>;
}

/** Reads an environment variable. */
export type EnvReader = (name: string) => string | undefined;

/** Read an environment variable, or `undefined` without permission. */
export function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name) || undefined;
  } catch {
    return undefined;
  }
}

/** `sqlite:<path>` / `file:<path>` / a `.db` path → the path; anything else → undefined. */
export function sqlitePathOf(value: string): string | undefined {
  const prefixed = /^(?:sqlite|file):(?:\/\/)?(.+)$/i.exec(value);
  if (prefixed) return prefixed[1];
  if (/\.(?:db|sqlite3?)$/i.test(value)) return value;
  return undefined;
}

/** How a target is picked. */
export interface TargetOptions {
  /** `--db-url`. */
  dbUrl?: string;
  /** `--linked`. */
  linked?: boolean;
  /** Read-only use: a missing SQLite file is an empty in-memory database, not created. */
  readOnly?: boolean;
  /** Postgres only (the verb has no SQLite implementation). */
  postgresOnly?: string;
}

/** Open a SQLite target. */
function openSqlite(projectDir: string, file: string, readOnly: boolean): DbTarget {
  const path = isAbsolute(file) ? file : join(projectDir, file);
  let exists = true;
  try {
    Deno.statSync(path);
  } catch {
    exists = false;
  }
  const db = new DatabaseSync(readOnly && !exists ? ":memory:" : path);
  return {
    dialect: "sqlite",
    sqlite: db,
    path,
    display: `sqlite:${file}`,
    close: () => Promise.resolve(db.close()),
  };
}

/** Open a Postgres target from a URL. */
function openPostgres(url: string, feature: string): DbTarget {
  const sql = postgresClient(url, feature);
  return { dialect: "postgres", sql, url, display: displayTarget(url), close: () => sql.close() };
}

/**
 * Open the database a verb acts on.
 *
 * @param projectDir The project.
 * @param options The flags.
 * @param env Reads the environment (`.env` already loaded).
 * @returns The target.
 * @throws {Error} When the flags name nothing usable, or the verb needs Postgres and has none.
 */
export function openTarget(
  projectDir: string,
  options: TargetOptions,
  env: EnvReader = readEnv,
): DbTarget {
  const target = pickTarget(projectDir, options, env);
  if (options.postgresOnly && target.dialect !== "postgres") {
    target.close();
    throw new Error(
      `${options.postgresOnly} needs Postgres: set DATABASE_URL to a postgres:// URL, add ` +
        "backend({ postgres }), or pass --db-url / --linked",
    );
  }
  return target;
}

/** `--db-url`: a Postgres URL or a SQLite file. */
function fromDbUrl(projectDir: string, dbUrl: string, readOnly: boolean): DbTarget {
  if (isPostgresUrl(dbUrl)) return openPostgres(dbUrl, FEATURE);
  const path = sqlitePathOf(dbUrl);
  if (path) return openSqlite(projectDir, path, readOnly);
  throw new TypeError(
    "--db-url takes a postgres:// URL or a SQLite file (sqlite:<path>, or a .db path)",
  );
}

/**
 * Whether a Postgres URL names this machine: a loopback host, or a Unix socket (no host, or a
 * `host=/path` parameter). A URL that does not parse counts as remote.
 *
 * @param url The postgres:// URL.
 * @returns Whether it is local.
 */
export function isLoopbackPostgres(url: string): boolean {
  // Parsed by hand: `postgres://u@/db?host=/socket` is a valid libpq URL but not a WHATWG one.
  const match = /^postgres(?:ql)?:\/\/([^/?#]*)[^?#]*(?:\?([^#]*))?/i.exec(url.trim());
  if (!match) return false;
  const authority = match[1].slice(match[1].lastIndexOf("@") + 1);
  let host: string;
  try {
    host = new URLSearchParams(match[2] ?? "").get("host") ??
      decodeURIComponent(authority.replace(/^\[([^\]]*)\](?::\d*)?$|:\d*$/, "$1"));
  } catch {
    return false;
  }
  host = host.toLowerCase();
  if (host === "" || host.startsWith("/")) return true;
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * The display name of the REMOTE database the flags target, or `undefined` for a local one:
 * `--linked` is always remote, `--db-url` when it is a Postgres URL off this machine. (The
 * project's own database is never treated as remote.)
 *
 * @param options The flags.
 * @param env Reads the environment.
 * @returns The masked target, or `undefined`.
 */
export function remoteTargetName(
  options: TargetOptions,
  env: EnvReader = readEnv,
): string | undefined {
  if (options.dbUrl) {
    return isPostgresUrl(options.dbUrl) && !isLoopbackPostgres(options.dbUrl)
      ? displayTarget(options.dbUrl)
      : undefined;
  }
  if (!options.linked) return undefined;
  const url = env(LINKED_URL_ENV);
  return url ? displayTarget(url) : "the linked database";
}

/** `--linked`: the URL `denext db link` stored. */
function fromLinked(env: EnvReader): DbTarget {
  const url = env(LINKED_URL_ENV);
  if (!url) {
    throw new Error(
      `--linked needs a linked database: run \`denext db link --url <postgres-url>\` first ` +
        `(it stores ${LINKED_URL_ENV} in .env)`,
    );
  }
  return openPostgres(url, FEATURE);
}

/** The project's own: the backend's client, else `DATABASE_URL`, else SQLite. */
function fromProject(projectDir: string, env: EnvReader, readOnly: boolean): DbTarget {
  const slot = (globalThis as { [BACKEND_POSTGRES]?: { sql?: SqlClient } })[BACKEND_POSTGRES];
  const url = env("DATABASE_URL");
  const known = isPostgresUrl(url) ? url : undefined;
  if (slot?.sql) {
    return {
      dialect: "postgres",
      sql: slot.sql,
      ...(known ? { url: known } : {}),
      display: displayTarget(known),
      // The plugin's client: its teardown closes it.
      close: () => Promise.resolve(),
    };
  }
  if (known) return openPostgres(known, FEATURE);
  return openSqlite(projectDir, env("DB_PATH") ?? "app.db", readOnly);
}

function pickTarget(projectDir: string, options: TargetOptions, env: EnvReader): DbTarget {
  const readOnly = options.readOnly === true;
  if (options.dbUrl) return fromDbUrl(projectDir, options.dbUrl, readOnly);
  if (options.linked) return fromLinked(env);
  return fromProject(projectDir, env, readOnly);
}

/** Whether the Supabase CLI's history table exists on this database. */
async function hasSupabaseHistory(sql: SqlClient): Promise<boolean> {
  const rows = await sql.unsafe<{ found: string | null }>(
    `SELECT to_regclass('${SUPABASE_HISTORY}')::text AS found`,
  );
  return !!rows[0]?.found;
}

/**
 * The history a target keeps: the Supabase CLI's (`supabase_migrations.schema_migrations`) on
 * Postgres for a project whose migrations are in `supabase/migrations/` (or that has none yet,
 * on a database that already has that table), denext's `_migrations` otherwise.
 *
 * @param target The database.
 * @param migrationsDir The migrations directory, relative to the project.
 * @param dirExists Whether that directory exists.
 * @returns The history.
 */
export async function historyFor(
  target: DbTarget,
  migrationsDir: string,
  dirExists: boolean,
): Promise<MigrationHistory> {
  if (target.dialect === "sqlite") return sqliteHistory(target.sqlite!);
  const sql = target.sql!;
  if (migrationsDir === "supabase/migrations") return supabaseHistory(sql);
  if (!dirExists && await hasSupabaseHistory(sql)) return supabaseHistory(sql);
  return postgresHistory(sql);
}
