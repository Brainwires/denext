// The migration actions behind `denext migration <new|list|up|down|repair|squash|fetch>` and
// their `denext db` spellings (`db migrate` = `migration up`, `db rollback` = `migration down`,
// `db status` = `migration list`, `db push`, `db reset`, `db seed`, `db link`). Each works on
// Postgres and on SQLite; see ./target.ts for which database and which history.

import { dirname, join, relative } from "@std/path";
import { migrationPlan, slugName } from "../../build/generate-ops.ts";
import {
  compareVersions,
  type MigrationFile,
  projectMigrationsDir,
  readMigrationFiles,
  splitMigration,
} from "../../server/migration-files.ts";
import type { MigrationHistory } from "../../server/migration-history.ts";
import {
  listMigrations,
  migrateDown,
  migrateUp,
  type MigrationRow,
  planDown,
  repairHistory,
  versionAfter,
} from "../../server/migration-ops.ts";
import { checksum, migratePostgres, notifySchemaReload } from "../../server/postgres-migrate.ts";
import { isPostgresUrl, runScript, type SqlClient } from "../../server/postgres.ts";
import { displayTarget } from "../db-admin/connection.ts";
import type { CommandContext } from "../command.ts";
import {
  type BackendDbHooks,
  backendHooks,
  type BackendMigrationSet,
  type DbIo,
} from "./project.ts";
import { type SeedFiles, seedFilesFor, seedHash } from "./seed-files.ts";
import {
  type DbTarget,
  type EnvReader,
  historyFor,
  LINKED_URL_ENV,
  openTarget,
  remoteTargetName,
} from "./target.ts";

/** One invocation of a migration action. */
export interface MigrationRun {
  /** The parsed invocation. */
  ctx: CommandContext;
  /** The project. */
  projectDir: string;
  /** Where to print. */
  io: DbIo;
  /** Reads the environment. */
  env: EnvReader;
  /** Reads stdin whole (`migration new --stdin`). */
  stdin?: () => Promise<string>;
  /** Asks a yes/no question on the terminal; absent when there is no terminal to ask on. */
  confirm?: (question: string) => Promise<boolean>;
}

/**
 * Gate a destructive action: `--yes` passes; otherwise it is confirmed at the
 * terminal, and refused with no terminal. `always` gates it on any database; else only on a
 * remote one (`--linked`, or a `--db-url` off this machine), as the Supabase CLI prompts there.
 *
 * @param run The invocation.
 * @param what What it does (`"reset drops every table in the app's schemas"`).
 * @param always Whether a local database needs the confirmation too.
 * @throws {Error} When it is not confirmed.
 */
async function confirmDestructive(run: MigrationRun, what: string, always = false): Promise<void> {
  if (run.ctx.flags.yes === true) return;
  const remote = remoteTargetName({
    dbUrl: stringFlag(run.ctx, "db-url"),
    linked: run.ctx.flags.linked === true,
  }, run.env);
  if (!remote && !always) return;
  const full = remote ? `${what} on the remote database ${remote}` : what;
  if (!run.confirm) throw new Error(`${full}: run it with --yes`);
  if (!await run.confirm(`${full}. Continue?`)) throw new Error(`cancelled (${full})`);
}

/** The tracking table `@denext/backend`'s own migrations are recorded in. */
const BACKEND_TABLE = "backend_migrations";

/** A string flag's value, or `undefined`. */
function stringFlag(ctx: CommandContext, name: string): string | undefined {
  const value = ctx.flags[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The project's migrations: the directory (relative and absolute) and its files. */
async function localMigrations(projectDir: string) {
  const dir = await projectMigrationsDir(projectDir);
  const abs = join(projectDir, ...dir.split("/"));
  let exists = false;
  try {
    exists = (await Deno.stat(abs)).isDirectory;
  } catch { /* none yet */ }
  return { dir, abs, exists, files: exists ? await readMigrationFiles(abs) : [] };
}

/** Open the target the flags select. */
function targetOf(run: MigrationRun, readOnly = false, postgresOnly?: string): DbTarget {
  return openTarget(run.projectDir, {
    dbUrl: stringFlag(run.ctx, "db-url"),
    linked: run.ctx.flags.linked === true,
    readOnly,
    ...(postgresOnly ? { postgresOnly } : {}),
  }, run.env);
}

/** Run `fn` with the target and its history, closing the target after. */
async function withHistory<T>(
  run: MigrationRun,
  readOnly: boolean,
  fn: (
    history: MigrationHistory,
    local: Awaited<ReturnType<typeof localMigrations>>,
    target: DbTarget,
  ) => Promise<T>,
): Promise<T> {
  const local = await localMigrations(run.projectDir);
  const target = targetOf(run, readOnly);
  try {
    const sql = target.sql && !readOnly ? await keyed(target.sql) : target.sql;
    const history = await historyFor(
      sql ? { ...target, sql } : target,
      local.dir,
      local.exists,
    );
    const result = await fn(history, local, target);
    // Running servers re-read their REST catalog (PostgREST's `reload schema` signal).
    if (target.sql && !readOnly && run.ctx.flags["dry-run"] !== true) {
      await notifySchemaReload(target.sql);
    }
    return result;
  } finally {
    await target.close();
  }
}

/** The client migrations run on: the backend's keyed wrapper (SQL vault), else the client. */
async function keyed(sql: SqlClient): Promise<SqlClient> {
  const hooks = backendHooks();
  return hooks?.keyed ? await hooks.keyed(sql) : sql;
}

/**
 * Apply `@denext/backend`'s own migrations (Postgres, when the plugin is set up): the roles and
 * `auth` functions, the service schemas the app's migrations may refer to (realtime, storage,
 * vault, …), each set in the tracking table the server's start uses, so either applies a
 * migration once (by name, under the same advisory lock).
 */
async function applyBackend(
  target: DbTarget,
  hooks: BackendDbHooks | undefined,
  dryRun: boolean,
): Promise<string[]> {
  if (!hooks) return [];
  return await applySets(target, [
    { table: hooks.table || BACKEND_TABLE, migrations: hooks.migrations() },
    ...hooks.migrationSets?.() ?? [],
  ], dryRun);
}

/**
 * Apply `@denext/backend`'s migrations that need the app's tables (realtime's per-table
 * triggers), after the app's own — what the server's start would otherwise create.
 */
async function applyBackendAfterApp(
  target: DbTarget,
  hooks: BackendDbHooks | undefined,
  dryRun: boolean,
): Promise<string[]> {
  return hooks?.afterMigrationSets
    ? await applySets(target, hooks.afterMigrationSets(), dryRun)
    : [];
}

/** Apply sets of the backend's migrations, one migration at a time, in order (Postgres only). */
async function applySets(
  target: DbTarget,
  sets: BackendMigrationSet[],
  dryRun: boolean,
): Promise<string[]> {
  if (target.dialect !== "postgres" || sets.length === 0) return [];
  const sql = await keyed(target.sql!);
  const names: string[] = [];
  // One at a time, in the hooks' order (the roles before the schemas that grant to them):
  // `migratePostgres` orders a list by name, and `backend_realtime_*` sorts before `backend_rls_*`.
  for (const set of sets) {
    for (const migration of set.migrations) {
      const result = await migratePostgres(sql, {
        table: set.table,
        migrations: [migration],
        dryRun,
      });
      names.push(...dryRun ? result.pending : result.applied);
    }
  }
  return names;
}

/** `migration new <name>`: a timestamped file with up and down sections. */
export async function newAction(run: MigrationRun): Promise<void> {
  const name = run.ctx.positionals[1] ?? "";
  if (!slugName(name)) {
    throw new TypeError("give the migration a name: denext migration new <name>");
  }
  const up = run.ctx.flags.stdin === true && run.stdin ? await run.stdin() : undefined;
  const plan = await migrationPlan(run.projectDir, name, new Date(), up);
  for (const file of plan) {
    await Deno.mkdir(dirname(file.path), { recursive: true });
    await Deno.writeTextFile(file.path, file.contents, { createNew: !file.overwrite });
    run.io.log(
      `${file.overwrite ? "Replaced the outdated" : "Created"} ${
        relative(run.projectDir, file.path).replaceAll("\\", "/")
      }`,
    );
  }
}

/** The `--json` rows of `list`. */
function listTable(rows: MigrationRow[]): string[] {
  const time = (row: MigrationRow) =>
    row.appliedAt ? row.appliedAt.replace("T", " ").replace(/\.\d+Z$|Z$/, "") : "";
  const width = Math.max(14, ...rows.map((row) => row.version.length));
  const pad = (text: string) => text.padEnd(width);
  const lines = [
    `  ${pad("Local")} | ${pad("Remote")} | Time (UTC)`,
    `  ${"-".repeat(width)}-|-${"-".repeat(width)}-|--------------------`,
  ];
  for (const row of rows) {
    const notes = [
      row.changed ? "changed since applied" : "",
      row.local && row.reversible === false ? "no down" : "",
    ].filter(Boolean).join(", ");
    lines.push(
      `  ${pad(row.local ? row.version : "")} | ${pad(row.remote ? row.version : "")} | ${
        time(row).padEnd(19)
      }${notes ? `  (${notes})` : ""}`,
    );
  }
  return lines;
}

/** `migration list` / `db status`. */
export async function listAction(run: MigrationRun): Promise<void> {
  await withHistory(run, true, async (history, local, target) => {
    const rows = await listMigrations(
      history,
      local.files,
      history.format === "denext" && history.dialect === "postgres" ? checksum : undefined,
    );
    if (run.ctx.global.json) {
      run.io.log(JSON.stringify(
        { database: target.display, history: history.table, dir: local.dir, migrations: rows },
        null,
        2,
      ));
      return;
    }
    run.io.log(`${target.display} (${history.table}), ${local.dir}/`);
    if (!rows.length) {
      run.io.log("No migrations (create one with `denext migration new <name>`).");
      return;
    }
    for (const line of listTable(rows)) run.io.log(line);
  });
}

/**
 * `migration up` / `db migrate` / `db push`: the backend's migrations, then the pending ones.
 * On a remote database it is confirmed first (`--yes`, or a "yes" at the terminal).
 */
export async function upAction(
  run: MigrationRun,
  options: { seed?: boolean; verb?: string } = {},
): Promise<void> {
  const dryRun = run.ctx.flags["dry-run"] === true;
  if (!dryRun) {
    await confirmDestructive(run, `${options.verb ?? "up"} applies the pending migrations`);
  }
  await withHistory(run, false, async (history, local, target) => {
    const own = await applyBackend(target, backendHooks(), dryRun);
    const verb = dryRun ? "would apply" : "applied";
    const json: { applied: string[]; dryRun: boolean; seeded?: string[] } = { applied: [], dryRun };
    reportBackend(run, verb, own, json.applied);
    const names = await migrateUp(history, local.files, {
      to: stringFlag(run.ctx, "to") ?? stringFlag(run.ctx, "version"),
      includeAll: run.ctx.flags["include-all"] === true,
      dryRun,
    }, (name) => {
      if (!run.ctx.global.json) run.io.log(`  ${verb} ${name}`);
    });
    if (dryRun && !run.ctx.global.json) {
      for (const name of names) run.io.log(`  ${verb} ${name}`);
    }
    json.applied.push(...names);
    // What needs the app's tables (realtime's per-table triggers), once they exist.
    const late = await applyBackendAfterApp(target, backendHooks(), dryRun);
    reportBackend(run, verb, late, json.applied);
    if (options.seed && !dryRun) json.seeded = await seedTarget(run, target, history);
    if (run.ctx.global.json) run.io.log(JSON.stringify(json, null, 2));
    else if (!own.length && !names.length && !late.length) {
      run.io.log("The database is up to date.");
    }
  });
}

/** Record (and, without `--json`, print) the backend migrations `up` applied. */
function reportBackend(run: MigrationRun, verb: string, names: string[], applied: string[]): void {
  for (const name of names) {
    applied.push(name);
    if (!run.ctx.global.json) run.io.log(`  ${verb} ${name}  (@denext/backend)`);
  }
}

/** `--steps` / `--last` as a number. */
function stepsOf(ctx: CommandContext): number | undefined {
  const value = ctx.flags.steps;
  if (value === undefined) return undefined;
  const steps = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(steps) || steps < 1) {
    throw new TypeError("--steps must be a whole number of 1 or more");
  }
  return steps;
}

/** `migration down` / `db rollback`. */
export async function downAction(run: MigrationRun): Promise<void> {
  const dryRun = run.ctx.flags["dry-run"] === true;
  const options = {
    steps: stepsOf(run.ctx),
    to: stringFlag(run.ctx, "to") ?? stringFlag(run.ctx, "version"),
    dryRun,
  };
  if (run.ctx.flags["force-reset"] === true) return await forceReset(run, options);
  if (!dryRun) await confirmDestructive(run, "down runs the newest migrations' down scripts");
  await withHistory(run, false, async (history, local) => {
    const verb = dryRun ? "would revert" : "reverted";
    const names = await migrateDown(history, local.files, options, (name) => {
      if (!run.ctx.global.json) run.io.log(`  ${verb} ${name}`);
    });
    if (run.ctx.global.json) {
      run.io.log(JSON.stringify({ reverted: names, dryRun }, null, 2));
      return;
    }
    if (dryRun) { for (const name of names) run.io.log(`  ${verb} ${name}`); }
    if (!names.length) run.io.log("Nothing to roll back.");
  });
}

/**
 * `migration down --force-reset`: what the Supabase CLI's `migration down` does — reset the
 * database, then re-apply the migrations up to the version the rollback would leave.
 */
async function forceReset(
  run: MigrationRun,
  options: { steps?: number; to?: string; dryRun: boolean },
): Promise<void> {
  if (!options.dryRun) {
    await confirmDestructive(run, "--force-reset drops every table in the app's schemas", true);
  }
  const target = await withHistory(run, true, async (history, local) => {
    const steps = await planDown(history, local.files, options);
    return { steps, version: await versionAfter(history, steps) };
  });
  if (!target.steps.length) {
    run.io.log("Nothing to roll back.");
    return;
  }
  for (const step of target.steps) {
    run.io.log(
      `  ${options.dryRun ? "would drop" : "dropping"} ${step.file?.name ?? step.row.key}`,
    );
  }
  if (options.dryRun) return;
  await resetAction(run, {
    upTo: target.version ?? "",
    reapplyNothing: target.version === undefined,
  });
}

/** `migration repair --status applied|reverted <version…>`. */
export async function repairAction(run: MigrationRun): Promise<void> {
  const status = stringFlag(run.ctx, "status");
  if (status !== "applied" && status !== "reverted") {
    throw new TypeError("repair needs --status applied or --status reverted");
  }
  const versions = run.ctx.positionals.slice(1);
  if (!versions.length) throw new TypeError("repair needs one or more versions");
  await confirmDestructive(run, "repair rewrites the database's migration history");
  await withHistory(run, false, async (history, local) => {
    const names = await repairHistory(history, local.files, versions, status);
    if (run.ctx.global.json) {
      run.io.log(JSON.stringify({ status, migrations: names }, null, 2));
      return;
    }
    for (const name of names) run.io.log(`  marked ${status}: ${name}`);
  });
}

/** Join migrations' scripts into one (down scripts newest first). */
function squashed(files: MigrationFile[], header: string): string {
  const up = files.map((file) => `-- ${file.name}\n${file.up.trim()}\n`).join("\n");
  const downs = files.filter((file) => file.down !== undefined).reverse();
  const down = downs.length === files.length
    ? `\n-- migrate:down\n${
      downs.map((file) => `-- ${file.name}\n${file.down!.trim()}\n`).join("\n")
    }`
    : "";
  return `${header}\n\n-- migrate:up\n${up}${down}`;
}

/**
 * `migration squash [--version v]`: fold the local migrations (up to `v`) into the last one's
 * file. With `--linked` / `--db-url` / `--local`, the database's history is rewritten to match
 * (when every squashed migration was applied there).
 */
export async function squashAction(run: MigrationRun): Promise<void> {
  const local = await localMigrations(run.projectDir);
  const version = stringFlag(run.ctx, "version") ?? stringFlag(run.ctx, "to");
  const chosen = version === undefined
    ? local.files
    : local.files.filter((file) => compareVersions(file.version, version) <= 0);
  if (chosen.length < 2) {
    run.io.log("Nothing to squash (fewer than two migrations).");
    return;
  }
  const last = chosen.at(-1)!;
  const text = squashed(
    chosen,
    `-- Squashed by \`denext migration squash\` from ${chosen.length} migrations ` +
      `(${chosen[0].version} … ${last.version}).`,
  );
  const updateHistory = run.ctx.flags.linked === true || !!stringFlag(run.ctx, "db-url") ||
    run.ctx.flags.local === true;
  if (updateHistory) {
    await confirmDestructive(run, "squash rewrites the database's migration history");
    await rewriteHistory(run, chosen, last, text);
  }
  for (const file of chosen.slice(0, -1)) {
    await Deno.remove(join(local.abs, file.name));
    await removeIfExists(join(local.abs, file.name.replace(/\.sql$/, ".down.sql")));
  }
  await removeIfExists(join(local.abs, last.name.replace(/\.sql$/, ".down.sql")));
  await Deno.writeTextFile(join(local.abs, last.name), text);
  run.io.log(`Squashed ${chosen.length} migrations into ${local.dir}/${last.name}`);
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/** Replace the squashed migrations' rows with the squashed one's (all applied, or none). */
async function rewriteHistory(
  run: MigrationRun,
  chosen: MigrationFile[],
  last: MigrationFile,
  text: string,
): Promise<void> {
  await withHistory(run, false, async (history) => {
    const applied = new Map((await history.applied()).map((row) => [row.key, row]));
    const rows = chosen.map((file) => applied.get(history.keyOf(file)));
    if (rows.every((row) => !row)) return;
    if (rows.some((row) => !row)) {
      throw new Error(
        "some of the migrations to squash are applied and some are not: apply them first " +
          "(denext migration up), then squash",
      );
    }
    for (const row of rows) await history.forget(row!);
    const { up, down } = splitMigration(text);
    await history.record({ ...last, up, ...(down ? { down } : {}) });
    run.io.log(`  history: ${chosen.length} rows → ${last.name}`);
  });
}

/** `migration fetch`: write the Supabase history's recorded SQL to local files. */
export async function fetchAction(run: MigrationRun): Promise<void> {
  await withHistory(run, true, async (history, local) => {
    if (!history.statements) {
      throw new Error(
        `${history.table} records names and checksums, not SQL: fetch reads the Supabase ` +
          "CLI's history (supabase_migrations.schema_migrations)",
      );
    }
    const dir = local.exists ? local.abs : join(run.projectDir, "supabase", "migrations");
    await Deno.mkdir(dir, { recursive: true });
    const force = run.ctx.flags.force === true;
    for (const row of await history.statements()) {
      const name = `${row.version}${row.name ? `_${row.name}` : ""}.sql`;
      const path = join(dir, name);
      const body = row.statements.map((s) => s.replace(/;\s*$/, "")).join(";\n") + ";\n";
      try {
        await Deno.writeTextFile(path, body, { createNew: !force });
        run.io.log(`  wrote ${relative(run.projectDir, path).replaceAll("\\", "/")}`);
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
        run.io.log(`  exists, skipped: ${name} (--force overwrites)`);
      }
    }
  });
}

/** The seed files: `supabase/seed.sql`, else `seed.sql`. */
async function seedFiles(projectDir: string): Promise<string[]> {
  for (const file of [join("supabase", "seed.sql"), "seed.sql"]) {
    try {
      if ((await Deno.stat(join(projectDir, file))).isFile) return [join(projectDir, file)];
    } catch { /* not there */ }
  }
  return [];
}

/** Run one seed file unless its recorded hash is unchanged (and not `--force`); its name, if it ran. */
async function seedFile(
  run: MigrationRun,
  target: DbTarget,
  record: SeedFiles,
  file: string,
): Promise<string | undefined> {
  const text = await Deno.readTextFile(file);
  const name = relative(run.projectDir, file).replaceAll("\\", "/");
  const hash = await seedHash(text);
  if (run.ctx.flags.force !== true && await record.hashOf(name) === hash) {
    say(run, `  skipped ${name} (unchanged; --force re-runs it)`);
    return undefined;
  }
  if (target.dialect === "postgres") await runScript(await keyed(target.sql!), text);
  else target.sqlite!.exec(text);
  await record.record(name, hash);
  say(run, `  seeded from ${name}`);
  return name;
}

/** Print a progress line (not under `--json`). */
function say(run: MigrationRun, line: string): void {
  if (!run.ctx.global.json) run.io.log(line);
}

/**
 * Run the seed SQL (and the backend's bucket seeds) on a target; returns what ran. A seed file
 * whose content hash is recorded unchanged is skipped unless `--force`.
 */
async function seedTarget(
  run: MigrationRun,
  target: DbTarget,
  history: MigrationHistory,
): Promise<string[]> {
  const done: string[] = [];
  const record = seedFilesFor(target, history);
  for (const file of await seedFiles(run.projectDir)) {
    const name = await seedFile(run, target, record, file);
    if (name) done.push(name);
  }
  for (const line of await backendHooks()?.seedBuckets?.(run.projectDir) ?? []) {
    done.push(line);
    say(run, `  ${line}`);
  }
  return done;
}

/** `db seed`: the seed SQL, then the config's buckets and their objects. */
export async function seedAction(run: MigrationRun): Promise<void> {
  await withHistory(run, false, async (history, _local, target) => {
    const done = await seedTarget(run, target, history);
    if (run.ctx.global.json) run.io.log(JSON.stringify({ seeded: done }, null, 2));
    else if (!done.length && !(await seedFiles(run.projectDir)).length) {
      run.io.log(
        "Nothing to seed: add supabase/seed.sql (or seed.sql), or buckets to backend({ storage }).",
      );
    }
  });
}

/** Drop everything the app's migrations made (Postgres: the app's schemas; SQLite: every object). */
async function dropAll(target: DbTarget, history: MigrationHistory): Promise<void> {
  if (target.dialect === "sqlite") {
    const db = target.sqlite!;
    const objects = db.prepare(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('view', 'table')",
    ).all() as { type: string; name: string }[];
    db.exec("PRAGMA foreign_keys = OFF");
    for (const object of objects.sort((a) => (a.type === "view" ? -1 : 1))) {
      db.exec(
        `DROP ${object.type === "view" ? "VIEW" : "TABLE"} IF EXISTS "${
          object.name.replaceAll('"', '""')
        }"`,
      );
    }
    db.exec("PRAGMA foreign_keys = ON");
    return;
  }
  const sql = target.sql!;
  const schemas = [
    "public",
    ...(backendHooks()?.serviceSchemas ?? []),
    ...(history.format === "supabase" ? ["supabase_migrations"] : []),
  ];
  for (const schema of schemas) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema.replaceAll('"', '""')}" CASCADE`);
  }
  await sql.unsafe("CREATE SCHEMA public");
  await sql.unsafe("GRANT USAGE ON SCHEMA public TO PUBLIC");
}

/**
 * `db reset --yes [--version v] [--no-seed]`: drop the app's schemas (SQLite: its tables), then
 * re-apply the backend's migrations and the project's (up to `--version`), then seed.
 */
export async function resetAction(
  run: MigrationRun,
  forced?: { upTo: string; reapplyNothing: boolean },
): Promise<void> {
  // `migration down --force-reset` confirmed already.
  if (!forced) await confirmDestructive(run, "reset drops every table in the app's schemas", true);
  await withHistory(run, false, async (history, local, target) => {
    await dropAll(target, history);
    run.io.log(`Reset ${target.display}.`);
    await applyBackend(target, backendHooks(), false);
    const to = forced ? forced.upTo : stringFlag(run.ctx, "version") ?? stringFlag(run.ctx, "to");
    const files = forced?.reapplyNothing ? [] : local.files;
    await migrateUp(history, files, { to: to || undefined, includeAll: true }, (name) => {
      run.io.log(`  applied ${name}`);
    });
    if (run.ctx.flags["no-seed"] !== true) await seedTarget(run, target, history);
  });
}

/** Set (or replace) `KEY=value` in a dotenv file, keeping every other line. */
export function setDotenv(text: string, key: string, value: string): string {
  const line = `${key}=${JSON.stringify(value)}`;
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
}

/** `db link --url <postgres-url>`: check it, then store it in `.env` (never printed). */
export async function linkAction(run: MigrationRun): Promise<void> {
  const url = stringFlag(run.ctx, "url");
  if (!url) throw new TypeError(`link needs --url <postgres-url> (stored as ${LINKED_URL_ENV})`);
  if (!isPostgresUrl(url)) throw new TypeError("link takes a postgres:// URL");
  if (run.ctx.flags["skip-check"] !== true) {
    const target = openTarget(run.projectDir, { dbUrl: url }, run.env);
    try {
      await target.sql!.unsafe("SELECT 1");
    } finally {
      await target.close();
    }
  }
  const path = join(run.projectDir, ".env");
  let text = "";
  try {
    text = await Deno.readTextFile(path);
  } catch { /* a new .env */ }
  await Deno.writeTextFile(path, setDotenv(text, LINKED_URL_ENV, url), { mode: 0o600 });
  run.io.log(
    `Linked ${displayTarget(url)} (${LINKED_URL_ENV} in .env). Use --linked to target it.`,
  );
  if (!await gitIgnores(run.projectDir, ".env")) {
    run.io.log("Note: .env holds the database password; add it to .gitignore.");
  }
}

/** Whether `.gitignore` lists `name` (a loose check). */
async function gitIgnores(projectDir: string, name: string): Promise<boolean> {
  try {
    const text = await Deno.readTextFile(join(projectDir, ".gitignore"));
    return text.split(/\r?\n/).some((line) => {
      const entry = line.trim().replace(/^\//, "");
      return entry === name || entry === `${name}*` || entry === ".env*";
    });
  } catch {
    return false;
  }
}

/**
 * Hand a Postgres action to `@denext/backend` (`diff`, `dump`, `pull`, `lint`, `inspect`,
 * `test`, `types`).
 *
 * @param run The invocation.
 * @param action The action.
 */
export async function backendAction(run: MigrationRun, action: string): Promise<void> {
  const hooks = backendHooks();
  const impl = hooks?.actions[action];
  if (!impl) {
    throw new Error(
      `denext db ${action} runs on Postgres through @denext/backend: add ` +
        "backend({ postgres: {} }) to plugins in denext.config.ts",
    );
  }
  const local = await localMigrations(run.projectDir);
  const target = targetOf(run, false, `denext db ${action}`);
  try {
    await impl({
      ctx: run.ctx,
      projectDir: run.projectDir,
      sql: target.sql!,
      ...(target.url ? { url: target.url } : {}),
      migrationsDir: local.abs,
      io: run.io,
      applyAll: async (sql) => {
        const shadow: DbTarget = {
          dialect: "postgres",
          sql,
          display: "shadow",
          close: async () => {},
        };
        const own = await applyBackend(shadow, hooks, false);
        const history = await historyFor(shadow, local.dir, local.exists);
        return [...own, ...await migrateUp(history, local.files, { includeAll: true })];
      },
      recordApplied: async (name) => {
        const fresh = await localMigrations(run.projectDir);
        const file = fresh.files.find((f) => f.name === name);
        if (!file) throw new Error(`no local migration ${name}`);
        const history = await historyFor(target, fresh.dir, fresh.exists);
        await history.record(file);
      },
    });
  } finally {
    await target.close();
  }
}
