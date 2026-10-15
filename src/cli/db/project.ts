// Setting a project up for the database verbs (`denext db`, `denext migration`, the `db-admin`
// child): load its config and run its plugins' setup, so `@denext/backend` installs its Postgres
// client and the hooks below. The verbs read those from process-global slots — denext does not
// depend on the package, so the shapes here are structural.

import { resolveProject } from "../../build/paths.ts";
import { applyPlugins } from "../../plugin/mod.ts";
import { defaultLoader } from "../../server/mod.ts";
import type { Migration } from "../../server/postgres-migrate.ts";
import type { SqlClient } from "../../server/postgres.ts";
import type { CommandContext } from "../command.ts";

/**
 * Load the project and set its plugins up, so `@denext/backend` installs what it declares.
 *
 * @param projectDir The project.
 */
export async function setUpProject(projectDir: string): Promise<void> {
  const paths = await resolveProject(projectDir);
  if (!paths.config?.plugins?.length) return;
  await applyPlugins({
    projectRoot: projectDir,
    appDir: paths.appDir,
    config: paths.config,
    mode: "build",
    load: defaultLoader,
  });
}

/** Where a database verb prints. */
export interface DbIo {
  /** A line on stdout. */
  log(line: string): void;
  /** A line on stderr. */
  error(line: string): void;
}

/** What `denext db <action>` hands an action `@denext/backend` implements. */
export interface BackendActionInput {
  /** The parsed invocation. */
  ctx: CommandContext;
  /** The project. */
  projectDir: string;
  /** The Postgres client of the target database. */
  sql: SqlClient;
  /** The target's URL, when known (`pg_dump`, a shadow database). Never print it. */
  url?: string;
  /** The project's migrations directory (absolute). */
  migrationsDir: string;
  /** Apply the backend's and the project's migrations to another database (a shadow). */
  applyAll(sql: SqlClient): Promise<string[]>;
  /** Record a local migration file (by name) as applied in the target's history (`db pull`). */
  recordApplied(name: string): Promise<void>;
  /** Where to print. */
  io: DbIo;
}

/** Migrations recorded in a tracking table of their own. */
export interface BackendMigrationSet {
  /** The tracking table (the one the server's start records them in). */
  table: string;
  /** The tracking table's schema; default: the search path. */
  schema?: string;
  /** The migrations, in order. */
  migrations: Migration[];
}

/** The hooks `@denext/backend` installs for the database verbs. */
export interface BackendDbHooks {
  /** The backend's own migrations for the services the config enables (applied first). */
  migrations(): Migration[];
  /** Their tracking table. */
  table: string;
  /** Further sets of the backend's migrations, each in its own table (applied after those). */
  migrationSets?(): BackendMigrationSet[];
  /**
   * Sets that need the app's tables (realtime's per-table triggers), applied after the app's
   * own migrations — what the server's start would otherwise create.
   */
  afterMigrationSets?(): BackendMigrationSet[];
  /** The schemas the backend's services own (dropped by `db reset`). */
  serviceSchemas: string[];
  /** Wraps the client migrations run on (the SQL vault sets its keys per transaction). */
  keyed?(sql: SqlClient): Promise<SqlClient>;
  /** The Postgres actions it implements: `diff`, `dump`, `pull`, `lint`, `inspect`, `test`, `types`. */
  actions: Record<string, (input: BackendActionInput) => Promise<void>>;
  /** Create the config's buckets and upload their seed objects; returns lines to print. */
  seedBuckets?(projectDir: string): Promise<string[]>;
}

/** The slot `@denext/backend` installs {@linkcode BackendDbHooks} in. */
const BACKEND_DB_HOOKS = Symbol.for("denext.backend.db");

/**
 * The hooks `@denext/backend` installed, when the project uses it with `postgres`.
 *
 * @returns The hooks, or `undefined`.
 */
export function backendHooks(): BackendDbHooks | undefined {
  return (globalThis as Record<symbol, unknown>)[BACKEND_DB_HOOKS] as BackendDbHooks | undefined;
}
