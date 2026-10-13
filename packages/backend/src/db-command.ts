// `denext db <action>` — the Supabase CLI's database verbs, over `backend({ postgres })`:
//
//   push   [--dry-run]           apply the backend's own migrations, then migrations/*.sql
//   status                       which migrations are applied and pending
//   reset  --yes                 drop the app's schemas, re-apply everything, run the seed file
//   diff   [--schema s] [--file name]   what the live database has that the migrations do not, as DDL
//   dump   [--data-only] [--schema s] [--file path]   pg_dump of the database
//
// The migrations directory is `migrations/` (what `denext generate migration` writes), else
// `supabase/migrations/`; the tracking table is `_migrations` (the one `denext job migrate` uses).
// `diff` applies the migrations to a throwaway shadow database (`CREATE DATABASE`, so the role
// needs CREATEDB) and compares the catalogs; `dump` runs `pg_dump`, which must be on PATH.

import { join, resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "@denext/denext/cli/command";
import {
  migratePostgres,
  type Migration,
  postgresClient,
  postgresMigrationStatus,
  type SqlClient,
} from "@denext/denext/server";
import { type CommandIo, consoleIo } from "./command-io.ts";
import { db } from "./postgres.ts";
import { rlsMigrations } from "./rls.ts";
import { diffSnapshots, quoteIdent, readSnapshot } from "./schema-diff.ts";

/** What the command needs from the plugin's setup. */
export interface DbCommandConfig {
  /** The database URL, when known (`postgres.url` or `DATABASE_URL`). */
  url: string | undefined;
  /** The backend's own migrations for the enabled services (RLS first). */
  backendMigrations: () => Migration[];
  /** The schemas the backend's services own (dropped by `reset`). */
  serviceSchemas: string[];
  /**
   * Wraps the client migrations run on — the SQL vault sets its keys in each migration's
   * transaction, so a migration can call `vault.create_secret()`.
   */
  keyed?: (sql: SqlClient) => Promise<SqlClient>;
}

/** Where the command prints, and how it runs `pg_dump` (injectable for tests). */
export interface DbCommandIo extends CommandIo {
  /** Run a program; resolves its exit code and output. */
  run(
    cmd: string,
    args: string[],
    env: Record<string, string>,
  ): Promise<{ code: number; stdout: Uint8Array; stderr: string }>;
  /** Write a file. */
  write(path: string, data: Uint8Array | string): Promise<void>;
  /** Open a client on another database URL (`diff`'s shadow). */
  connect(url: string): SqlClient;
}

const defaultIo: DbCommandIo = {
  ...consoleIo,
  async run(cmd, args, env) {
    const out = await new Deno.Command(cmd, { args, env, stdout: "piped", stderr: "piped" })
      .output();
    return { code: out.code, stdout: out.stdout, stderr: new TextDecoder().decode(out.stderr) };
  },
  write: (path, data) =>
    typeof data === "string" ? Deno.writeTextFile(path, data) : Deno.writeFile(path, data),
  connect: (url) => postgresClient(url, "denext db diff"),
};

/** The tracking table the backend's own migrations are recorded in. */
const BACKEND_TABLE = "backend_migrations";

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/** `migrations/`, else `supabase/migrations/`; `undefined` when neither exists. */
export async function migrationsDir(projectRoot: string): Promise<string | undefined> {
  for (const dir of ["migrations", join("supabase", "migrations")]) {
    if (await isDirectory(join(projectRoot, dir))) return join(projectRoot, dir);
  }
  return undefined;
}

/** The seed file: `supabase/seed.sql`, else `seed.sql`. */
async function seedFile(projectRoot: string): Promise<string | undefined> {
  for (const file of [join("supabase", "seed.sql"), "seed.sql"]) {
    try {
      if ((await Deno.stat(join(projectRoot, file))).isFile) return join(projectRoot, file);
    } catch {
      // Not there.
    }
  }
  return undefined;
}

/** Apply the backend's migrations, then the project's; returns what was applied. */
async function push(
  sql: SqlClient,
  config: DbCommandConfig,
  projectRoot: string,
  dryRun: boolean,
): Promise<string[]> {
  if (config.keyed) sql = await config.keyed(sql);
  const own = await migratePostgres(sql, {
    migrations: config.backendMigrations(),
    table: BACKEND_TABLE,
    dryRun,
  });
  const dir = await migrationsDir(projectRoot);
  const app = dir ? await migratePostgres(sql, { dir, dryRun }) : { applied: [], pending: [] };
  return dryRun ? [...own.pending, ...app.pending] : [...own.applied, ...app.applied];
}

function stamp(now = new Date()): string {
  return now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/**
 * The `db` verb.
 *
 * @param config What the plugin knows about the database.
 * @param io Where it prints, and its process and file access.
 * @returns The command.
 */
export function createDbCommand(config: DbCommandConfig, io: DbCommandIo = defaultIo): CommandSpec {
  return {
    name: "db",
    summary: "Push, reset, diff or dump the app's Postgres (@denext/backend)",
    usage: [
      "Usage: denext db <action> [flags]",
      "",
      "  push      Apply the backend's migrations, then migrations/*.sql (--dry-run lists them)",
      "  status    Which migrations are applied and which are pending",
      "  reset     Drop the app's schemas and re-apply everything, then the seed file (--yes)",
      "  diff      DDL for what the live database has that the migrations do not",
      "            (--schema <name>, repeatable; --file <name> writes migrations/<stamp>_<name>.sql)",
      "  dump      pg_dump the database, schema only (--data-only; --schema; --file <path>)",
    ].join("\n"),
    positionals: [{ name: "action", help: "push | status | reset | diff | dump" }],
    flags: [
      { name: "dry-run", type: "boolean", help: "push: list what would be applied" },
      { name: "yes", type: "boolean", help: "reset: confirm dropping the data" },
      { name: "schema", type: "string", help: "diff / dump: the schema (default public)" },
      { name: "file", type: "string", help: "diff: a migration name; dump: an output path" },
      { name: "data-only", type: "boolean", help: "dump: data, not the schema" },
    ],
    moduleDir: (ctx) => resolve(ctx.global.cwd ?? "."),
    run: (ctx) => runDb(ctx, config, io),
  };
}

async function runDb(ctx: CommandContext, config: DbCommandConfig, io: DbCommandIo): Promise<void> {
  const projectRoot = resolve(ctx.global.cwd ?? ".");
  const action = ctx.positionals[0] ?? "";
  const actions: Record<string, () => Promise<void>> = {
    push: () => pushAction(ctx, config, io, projectRoot),
    status: () => statusAction(config, io, projectRoot),
    reset: () => resetAction(ctx, config, io, projectRoot),
    diff: () => diffAction(ctx, config, io, projectRoot),
    dump: () => dumpAction(ctx, config, io),
  };
  const run = actions[action];
  if (!run) {
    io.error(
      `denext db: unknown action "${action}" (expected push | status | reset | diff | dump)`,
    );
    io.exit(1);
    return;
  }
  try {
    await run();
  } catch (error) {
    io.error(`denext db ${action}: ${(error as Error)?.message ?? error}`);
    io.exit(1);
  }
}

async function pushAction(
  ctx: CommandContext,
  config: DbCommandConfig,
  io: DbCommandIo,
  projectRoot: string,
): Promise<void> {
  const dryRun = ctx.flags["dry-run"] === true;
  const applied = await push(db.service(), config, projectRoot, dryRun);
  if (!applied.length) io.log("The database is up to date.");
  for (const name of applied) io.log(`  ${dryRun ? "would apply" : "applied"} ${name}`);
}

async function statusAction(
  config: DbCommandConfig,
  io: DbCommandIo,
  projectRoot: string,
): Promise<void> {
  const sql = db.service();
  const dir = await migrationsDir(projectRoot);
  const reports = [
    await postgresMigrationStatus(sql, {
      migrations: config.backendMigrations(),
      table: BACKEND_TABLE,
    }),
    ...(dir ? [await postgresMigrationStatus(sql, { dir })] : []),
  ];
  for (const report of reports) {
    for (const m of report.migrations) io.log(statusLine(m));
  }
  for (const name of dir ? reports[1].unknown : []) {
    io.log(`  unknown  ${name}  (applied, no file)`);
  }
}

function statusLine(m: { name: string; applied: boolean; changed?: boolean }): string {
  return `  ${m.applied ? "applied" : "pending"}  ${m.name}${m.changed ? "  (changed since)" : ""}`;
}

async function resetAction(
  ctx: CommandContext,
  config: DbCommandConfig,
  io: DbCommandIo,
  projectRoot: string,
): Promise<void> {
  if (ctx.flags.yes !== true) {
    io.error("denext db reset drops every table in the app's schemas: run it with --yes");
    io.exit(1);
    return;
  }
  const sql = db.service();
  const schemas = ["public", ...config.serviceSchemas];
  for (const schema of schemas) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
  }
  await sql.unsafe("CREATE SCHEMA public");
  await sql.unsafe("GRANT USAGE ON SCHEMA public TO PUBLIC");
  const applied = await push(sql, config, projectRoot, false);
  for (const name of applied) io.log(`  applied ${name}`);
  const seed = await seedFile(projectRoot);
  if (seed) {
    const text = await Deno.readTextFile(seed);
    const query = sql.unsafe(text);
    await (query.simple ? query.simple() : query);
    io.log(`  seeded from ${seed.slice(projectRoot.length + 1)}`);
  }
  io.log("The database was reset.");
}

function schemasOf(ctx: CommandContext): string[] {
  const value = ctx.flags.schema;
  const list = typeof value === "string" && value !== "" ? value.split(",") : ["public"];
  for (const schema of list) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) {
      throw new TypeError(`--schema ${JSON.stringify(schema)} is not a plain identifier`);
    }
  }
  return list;
}

function requireUrl(config: DbCommandConfig, action: string): string {
  if (!config.url) {
    throw new Error(
      `${action} needs the database URL: set DATABASE_URL (or backend({ postgres: { url } }))`,
    );
  }
  return config.url;
}

async function diffAction(
  ctx: CommandContext,
  config: DbCommandConfig,
  io: DbCommandIo,
  projectRoot: string,
): Promise<void> {
  const url = requireUrl(config, "diff");
  const schemas = schemasOf(ctx);
  const sql = db.service();
  const shadowName = `denext_shadow_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await sql.unsafe(`CREATE DATABASE ${shadowName}`);
  let statements: string[];
  try {
    const shadowUrl = new URL(url);
    shadowUrl.pathname = `/${shadowName}`;
    const shadow = io.connect(shadowUrl.toString());
    try {
      await push(shadow, config, projectRoot, false);
      statements = diffSnapshots(
        await readSnapshot(shadow, schemas),
        await readSnapshot(sql, schemas),
      );
    } finally {
      await shadow.close();
    }
  } finally {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${shadowName} WITH (FORCE)`);
  }
  if (!statements.length) {
    io.log("No changes: the database matches the migrations.");
    return;
  }
  const text = statements.join("\n\n") + "\n";
  const name = typeof ctx.flags.file === "string" ? ctx.flags.file : "";
  if (!name) {
    io.log(text);
    return;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new TypeError("--file is a migration name (letters, digits, _ and -)");
  }
  const dir = (await migrationsDir(projectRoot)) ?? join(projectRoot, "migrations");
  await Deno.mkdir(dir, { recursive: true });
  const path = join(dir, `${stamp()}_${name}.sql`);
  await io.write(path, `-- denext db diff (${schemas.join(", ")})\n\n${text}`);
  io.log(`Wrote ${path.slice(projectRoot.length + 1)}`);
}

async function dumpAction(
  ctx: CommandContext,
  config: DbCommandConfig,
  io: DbCommandIo,
): Promise<void> {
  const url = requireUrl(config, "dump");
  const args = [
    "--no-owner",
    "--no-privileges",
    ctx.flags["data-only"] === true ? "--data-only" : "--schema-only",
  ];
  for (const schema of schemasOf(ctx)) args.push("--schema", schema);
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
  const file = typeof ctx.flags.file === "string" ? ctx.flags.file : "";
  if (file) {
    await io.write(resolve(file), result.stdout);
    io.log(`Wrote ${file}`);
  } else io.log(new TextDecoder().decode(result.stdout));
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
