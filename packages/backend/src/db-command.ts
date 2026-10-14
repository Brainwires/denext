// The Postgres half of `denext db`: the verb itself is denext's (it migrates, rolls back, pushes,
// resets and seeds on Postgres or SQLite with no plugin); `backend({ postgres })` installs these
// hooks at setup so the verb also applies the backend's own migrations first, drops its service
// schemas on `reset`, and gains the Postgres tooling:
//
//   diff   [--schema s] [--file name]   what the live database has that the migrations do not, as DDL
//   pull   [name] [--schema s]          the same, written as a new migration and marked applied
//   dump   [--data-only] [--schema s] [--file path]   pg_dump of the database
//   lint   [--schema s] [--level l] [--fail-on l]     plpgsql_check + built-in checks
//   inspect <report>                    the Supabase CLI's `inspect db` reports
//   test   [files…]                     pgTAP tests (supabase/tests/**/*.sql)
//   types  [--schema s] [--file path]   `supabase gen types typescript`-shaped types
//
// `diff` and `pull` apply the migrations to a throwaway shadow database (`CREATE DATABASE`, so the
// role needs CREATEDB) and compare the catalogs; `dump` runs `pg_dump`, which must be on PATH.

import { dirname, join, resolve } from "@std/path";
import { type Migration, postgresClient, type SqlClient } from "@denext/denext/server";
import { type DbActionInput, schemasOf } from "./db-action.ts";
import { inspectAction } from "./db-inspect.ts";
import { lintAction } from "./db-lint.ts";
import { testAction } from "./db-test.ts";
import { readRestCatalog } from "./rest-catalog.ts";
import { generateRestTypes } from "./rest-codegen.ts";
import { rlsMigrations } from "./rls.ts";
import { diffSnapshots, emptySnapshot, readSnapshot } from "./schema-diff.ts";

/** What the hooks need from the plugin's setup. */
export interface DbCommandConfig {
  /** The backend's own migrations for the enabled services (RLS first). */
  backendMigrations: () => Migration[];
  /** The schemas the backend's services own (dropped by `reset`). */
  serviceSchemas: string[];
  /**
   * Wraps the client migrations run on — the SQL vault sets its keys in each migration's
   * transaction, so a migration can call `vault.create_secret()`.
   */
  keyed?: (sql: SqlClient) => Promise<SqlClient>;
  /** Create the config's buckets and upload their seed objects (`denext db seed`). */
  seedBuckets?: (projectDir: string) => Promise<string[]>;
}

/** How the actions reach processes, files and other databases (injectable for tests). */
export interface DbCommandIo {
  /** Run a program; resolves its exit code and output. */
  run(
    cmd: string,
    args: string[],
    env: Record<string, string>,
  ): Promise<{ code: number; stdout: Uint8Array; stderr: string }>;
  /** Write a file (its directory created first). */
  write(path: string, data: Uint8Array | string): Promise<void>;
  /** Open a client on another database URL (`diff`'s shadow). */
  connect(url: string): SqlClient;
}

const defaultIo: DbCommandIo = {
  async run(cmd, args, env) {
    const out = await new Deno.Command(cmd, { args, env, stdout: "piped", stderr: "piped" })
      .output();
    return { code: out.code, stdout: out.stdout, stderr: new TextDecoder().decode(out.stderr) };
  },
  async write(path, data) {
    await Deno.mkdir(dirname(path), { recursive: true });
    if (typeof data === "string") await Deno.writeTextFile(path, data);
    else await Deno.writeFile(path, data);
  },
  connect: (url) => postgresClient(url, "denext db diff"),
};

/** The tracking table the backend's own migrations are recorded in. */
const BACKEND_TABLE = "backend_migrations";

/** An action of `denext db` the plugin implements. */
type Action = (input: DbActionInput, io: DbCommandIo) => Promise<void>;

/** The hooks `denext db` reads from `Symbol.for("denext.backend.db")`. */
export interface DbHooks {
  /** The backend's own migrations. */
  migrations(): Migration[];
  /** Their tracking table. */
  table: string;
  /** The schemas `reset` drops. */
  serviceSchemas: string[];
  /** Wraps the client migrations run on. */
  keyed?(sql: SqlClient): Promise<SqlClient>;
  /** The Postgres actions. */
  actions: Record<string, (input: DbActionInput) => Promise<void>>;
  /** Seed the config's buckets. */
  seedBuckets?(projectDir: string): Promise<string[]>;
}

/**
 * The hooks `denext db` uses when the project has `backend({ postgres })`.
 *
 * @param config What the plugin knows about its services.
 * @param io Process, file and connection access (tests inject fakes).
 * @param postgres Whether the config has `postgres` (the Postgres actions need it).
 * @returns The hooks.
 */
export function createDbHooks(
  config: DbCommandConfig,
  io: DbCommandIo = defaultIo,
  postgres = true,
): DbHooks {
  const actions: Record<string, Action> = {
    diff: diffAction,
    pull: pullAction,
    dump: dumpAction,
    lint: (input) => lintAction(input),
    inspect: (input) => inspectAction(input),
    test: (input) => testAction(input),
    types: typesAction,
  };
  return {
    migrations: config.backendMigrations,
    table: BACKEND_TABLE,
    serviceSchemas: config.serviceSchemas,
    ...(config.keyed ? { keyed: config.keyed } : {}),
    ...(config.seedBuckets ? { seedBuckets: config.seedBuckets } : {}),
    actions: postgres
      ? Object.fromEntries(
        Object.entries(actions).map(([name, action]) => [name, (input) => action(input, io)]),
      )
      : {},
  };
}

/** The slot the hooks live in. */
const HOOKS = Symbol.for("denext.backend.db");

/**
 * Install (or, with `undefined`, remove) the hooks `denext db` reads.
 *
 * @param hooks The hooks.
 */
export function installDbHooks(hooks: DbHooks | undefined): void {
  const slot = globalThis as Record<symbol, unknown>;
  if (hooks) slot[HOOKS] = hooks;
  else delete slot[HOOKS];
}

function requireUrl(input: DbActionInput, action: string): string {
  if (!input.url) {
    throw new Error(
      `${action} needs the database URL: set DATABASE_URL (or backend({ postgres: { url } }), ` +
        "or pass --db-url)",
    );
  }
  return input.url;
}

function stamp(now = new Date()): string {
  return now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/**
 * The DDL that turns the migrations' schema into the live one: the migrations are applied to a
 * shadow database and both catalogs compared.
 */
async function liveVsMigrations(
  input: DbActionInput,
  io: DbCommandIo,
  schemas: string[],
  action: string,
): Promise<string[]> {
  const url = requireUrl(input, action);
  const shadowName = `denext_shadow_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await input.sql.unsafe(`CREATE DATABASE ${shadowName}`);
  try {
    const shadowUrl = new URL(url);
    shadowUrl.pathname = `/${shadowName}`;
    const shadow = io.connect(shadowUrl.toString());
    try {
      await input.applyAll(shadow);
      return diffSnapshots(
        await readSnapshot(shadow, schemas),
        await readSnapshot(input.sql, schemas),
      );
    } finally {
      await shadow.close();
    }
  } finally {
    await input.sql.unsafe(`DROP DATABASE IF EXISTS ${shadowName} WITH (FORCE)`);
  }
}

/** Write `statements` as `<migrationsDir>/<stamp>_<name>.sql`; returns the file name. */
async function writeMigration(
  input: DbActionInput,
  io: DbCommandIo,
  name: string,
  header: string,
  statements: string[],
): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new TypeError("a migration name is letters, digits, _ and -");
  }
  const file = `${stamp()}_${name}.sql`;
  await io.write(
    join(input.migrationsDir, file),
    `${header}\n\n${statements.join("\n\n")}\n`,
  );
  return file;
}

function relativeDir(input: DbActionInput, file: string): string {
  return join(input.migrationsDir, file).slice(input.projectDir.length + 1).replaceAll("\\", "/");
}

async function diffAction(input: DbActionInput, io: DbCommandIo): Promise<void> {
  const schemas = schemasOf(input.ctx);
  const statements = await liveVsMigrations(input, io, schemas, "diff");
  if (!statements.length) {
    input.io.log("No changes: the database matches the migrations.");
    return;
  }
  const name = typeof input.ctx.flags.file === "string" ? input.ctx.flags.file : "";
  if (!name) {
    input.io.log(statements.join("\n\n") + "\n");
    return;
  }
  const file = await writeMigration(
    input,
    io,
    name,
    `-- denext db diff (${schemas.join(", ")})`,
    statements,
  );
  input.io.log(`Wrote ${relativeDir(input, file)}`);
}

/**
 * `db pull [name]`: what the database has that the migrations do not, as a new migration, then
 * recorded as applied on that database (it already has those objects) — `supabase db pull`.
 */
async function pullAction(input: DbActionInput, io: DbCommandIo): Promise<void> {
  const schemas = schemasOf(input.ctx);
  const statements = input.url
    ? await liveVsMigrations(input, io, schemas, "pull")
    // No URL for a shadow: everything the database has (as against an empty schema).
    : diffSnapshots(emptySnapshot(), await readSnapshot(input.sql, schemas));
  if (!statements.length) {
    input.io.log("No schema changes found: the migrations match the database.");
    return;
  }
  const name = input.ctx.positionals[1] ?? "remote_schema";
  const file = await writeMigration(
    input,
    io,
    name,
    `-- denext db pull (${schemas.join(", ")})`,
    statements,
  );
  await input.recordApplied(file);
  input.io.log(`Wrote ${relativeDir(input, file)} (recorded as applied on this database)`);
}

async function dumpAction(input: DbActionInput, io: DbCommandIo): Promise<void> {
  const url = requireUrl(input, "dump");
  const args = [
    "--no-owner",
    "--no-privileges",
    input.ctx.flags["data-only"] === true ? "--data-only" : "--schema-only",
  ];
  for (const schema of schemasOf(input.ctx)) args.push("--schema", schema);
  // The password goes in the environment, not on the command line (where `ps` shows it).
  const target = new URL(url);
  const env: Record<string, string> = {};
  if (target.password) env.PGPASSWORD = decodeURIComponent(target.password);
  target.password = "";
  args.push("--dbname", target.toString());
  let result: Awaited<ReturnType<DbCommandIo["run"]>>;
  try {
    result = await io.run("pg_dump", args, env);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        "pg_dump is not on PATH: install the PostgreSQL client tools (postgresql-client)",
      );
    }
    throw error;
  }
  if (result.code !== 0) throw new Error(`pg_dump failed: ${result.stderr.trim()}`);
  const file = typeof input.ctx.flags.file === "string" ? input.ctx.flags.file : "";
  if (file) {
    await io.write(resolve(input.projectDir, file), result.stdout);
    input.io.log(`Wrote ${file}`);
  } else input.io.log(new TextDecoder().decode(result.stdout));
}

/** `db types` (`denext gen types`): the whole schema's types, as `supabase gen types` writes. */
async function typesAction(input: DbActionInput, io: DbCommandIo): Promise<void> {
  const catalog = await readRestCatalog(input.sql, schemasOf(input.ctx), "*");
  const source = generateRestTypes(catalog.service ?? catalog, { standalone: true });
  const file = typeof input.ctx.flags.file === "string" ? input.ctx.flags.file : "";
  if (!file) {
    input.io.log(source);
    return;
  }
  await io.write(resolve(input.projectDir, file), source);
  input.io.log(`Wrote ${file}`);
}

/**
 * The backend's own migrations for the services a config enables, in order (RLS first).
 *
 * @param parts Each enabled service's migrations.
 * @returns The migrations.
 */
export function backendMigrationsOf(parts: Array<() => Migration[]>): Migration[] {
  return [...rlsMigrations(), ...parts.flatMap((part) => part())];
}
