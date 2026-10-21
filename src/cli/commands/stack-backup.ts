// `denext stack backup` / `restore`: the stack's database, and with `--full` everything a new
// stack needs to come back as this one was. Every Postgres tool runs INSIDE the stack's db
// container (`docker compose exec`), as its superuser over the local socket, so the host needs no
// Postgres client and no password crosses a command line.
//
//   backup [file]          pg_dump's custom format (`.dump`); default .denext/backups/
//   backup --full [file]   one .tar.gz: MANIFEST.txt (the restore order), roles.sql (the
//                          non-superuser roles and their memberships, no passwords),
//                          extensions.sql, database.dump, settings.sql (database and role
//                          settings) and storage/ (the MinIO bucket, or the fs driver's dir)
//   restore <file> [--yes] a dump or a full backup (told apart by their first bytes); refuses a
//                          database that already has tables unless --yes, then pg_restore
//                          --clean --if-exists in one transaction, with the app stopped
//
// A full backup is untrusted input when it is restored: it is extracted by `safe-extract.ts`
// (no absolute paths, no `..`, no link leaving the directory, no hard links or devices), and
// only the steps restore knows are run, from the files the manifest names.

import { isAbsolute, join, resolve } from "@std/path";
import type { CommandContext } from "../command.ts";
import { writeAppUpdateArchive } from "../../build/app-update.ts";
import { extractArchive, UnsafeArchiveError } from "../../build/safe-extract.ts";
import {
  composeArgs,
  exists,
  ioMember,
  type PipeOptions,
  type PsRow,
  psRows,
  readEnvFile,
  requireRunning,
  type StackIo,
} from "./stack-io.ts";

/** Where a backup goes when no file is named (`.dockerignore` keeps `.denext/` out of the image). */
const BACKUP_DIR = join(".denext", "backups");

/** The steps a full backup holds, in the order `restore` runs them. */
export const RESTORE_STEPS = [
  "roles.sql",
  "extensions.sql",
  "database.dump",
  "settings.sql",
  "storage/",
] as const;

/** One step of a full restore. */
type RestoreStep = typeof RESTORE_STEPS[number];

/** The first line of a full backup's `MANIFEST.txt`. */
const MANIFEST_TITLE = "denext stack backup (full)";

/** Every role but the superusers and Postgres's own, idempotently, without passwords. */
const ROLES_SQL = `
SELECT format('DO %L;', format(
    'BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = %L) THEN CREATE ROLE %I; END IF; END',
    rolname, rolname))
  || E'\\n' || format('ALTER ROLE %I WITH %s %s %s %s %s %s CONNECTION LIMIT %s;', rolname,
    CASE WHEN rolcanlogin THEN 'LOGIN' ELSE 'NOLOGIN' END,
    CASE WHEN rolinherit THEN 'INHERIT' ELSE 'NOINHERIT' END,
    CASE WHEN rolcreaterole THEN 'CREATEROLE' ELSE 'NOCREATEROLE' END,
    CASE WHEN rolcreatedb THEN 'CREATEDB' ELSE 'NOCREATEDB' END,
    CASE WHEN rolreplication THEN 'REPLICATION' ELSE 'NOREPLICATION' END,
    CASE WHEN rolbypassrls THEN 'BYPASSRLS' ELSE 'NOBYPASSRLS' END,
    rolconnlimit)
FROM pg_roles WHERE rolname !~ '^pg_' AND NOT rolsuper ORDER BY rolname;
SELECT format('GRANT %I TO %I;', r.rolname, m.rolname)
FROM pg_auth_members a
JOIN pg_roles r ON r.oid = a.roleid
JOIN pg_roles m ON m.oid = a.member
WHERE m.rolname !~ '^pg_' AND NOT m.rolsuper AND NOT r.rolsuper
ORDER BY 1;
`;

/** The extensions (and the schemas they live in), created before the dump is restored. */
const EXTENSIONS_SQL = `
SELECT CASE WHEN n.nspname <> 'public'
    THEN format('CREATE SCHEMA IF NOT EXISTS %I;', n.nspname) || E'\\n' ELSE '' END
  || format('CREATE EXTENSION IF NOT EXISTS %I WITH SCHEMA %I;', e.extname, n.nspname)
FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE e.extname <> 'plpgsql' ORDER BY e.extname;
`;

/**
 * The database's and its roles' settings (\`ALTER DATABASE … SET\`, \`ALTER ROLE … SET\`), applied
 * to whatever the restoring stack's database is called. List settings (search_path, …) are kept
 * as Postgres stored them; every other value is a quoted literal.
 */
const SETTINGS_SQL = `
WITH s AS (
  SELECT s.setdatabase, s.setrole, r.rolname,
    split_part(c, '=', 1) AS name, substr(c, strpos(c, '=') + 1) AS value
  FROM pg_db_role_setting s
  LEFT JOIN pg_roles r ON r.oid = s.setrole
  CROSS JOIN LATERAL unnest(s.setconfig) AS c
  WHERE (s.setdatabase = 0
      OR s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()))
    AND (s.setrole = 0 OR (NOT r.rolsuper AND r.rolname !~ '^pg_'))
), t AS (
  SELECT *, format(' SET %s TO %s', name, CASE WHEN name IN ('search_path', 'temp_tablespaces',
      'session_preload_libraries', 'local_preload_libraries', 'shared_preload_libraries')
    THEN value ELSE quote_literal(value) END) AS tail
  FROM s WHERE name ~ '^[A-Za-z_][A-Za-z0-9_.]*$'
)
SELECT CASE WHEN setdatabase = 0 THEN format('ALTER ROLE %I', rolname) || tail || ';'
  ELSE format('DO %L;', format('BEGIN EXECUTE format(%L, current_database()); END',
    replace(CASE WHEN setrole = 0 THEN 'ALTER DATABASE '
      ELSE format('ALTER ROLE %I IN DATABASE ', rolname) END, '%', '%%')
    || '%I' || replace(tail, '%', '%%')))
  END
FROM t ORDER BY setdatabase, rolname NULLS FIRST, name;
`;

/** Tables outside the catalogs: a database with any is not empty. */
const TABLE_COUNT_SQL = `
SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_';
`;

/** `psql` as the superuser, quiet, rows only (`-At`) when `rows`. */
function psql(rows: boolean): string[] {
  const flags = rows ? "-X -q -At" : "-X -q";
  return [
    "sh",
    "-c",
    `exec psql ${flags} -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"`,
  ];
}

/** Run `cmd` in the `service` container (`docker compose exec -T`), stdin / stdout per `options`. */
async function execIn(
  ctx: CommandContext,
  dir: string,
  io: StackIo,
  service: string,
  cmd: string[],
  options: PipeOptions & { user?: string } = {},
): Promise<string> {
  const user = options.user ? ["-u", options.user] : [];
  const args = [...composeArgs(ctx), "exec", "-T", ...user, service, ...cmd];
  const out = await ioMember(io, "pipe")(args, dir, options);
  if (out.code !== 0) {
    throw new Error(`in ${service}: ${out.stderr.trim() || `exit ${out.code}`}`);
  }
  return out.stdout;
}

/** `docker compose cp from to`. */
async function composeCp(
  ctx: CommandContext,
  dir: string,
  io: StackIo,
  from: string,
  to: string,
): Promise<void> {
  const out = await io.docker([...composeArgs(ctx), "cp", from, to], dir, true);
  if (out.code !== 0) throw new Error(`docker compose cp failed: ${out.stderr.trim()}`);
}

/** Where the stack keeps its objects: the MinIO bucket, the fs driver's dir, or nowhere. */
export type StorageSource =
  | { readonly kind: "minio"; readonly bucket: string }
  | { readonly kind: "fs"; readonly dir: string }
  | { readonly kind: "none" };

/** `fs({ dir: "…" })` in the project's config, when the dir is a literal. */
const FS_DIR = /\bfs\s*\(\s*\{[^}]*?\bdir\s*:\s*["'`]([^"'`\n]+)["'`]/;

/** The fs driver's dir as the app's container sees it (`/app` is its working directory). */
function containerDir(dir: string): string {
  const parts = dir.split(/[\\/]/);
  if (parts.includes("..")) throw new Error(`storage dir ${dir} escapes the app`);
  const kept = parts.filter((p) => p !== "" && p !== ".");
  if (!kept.length) throw new Error(`storage dir ${dir} names no directory`);
  return dir.startsWith("/") ? `/${kept.join("/")}` : `/app/${kept.join("/")}`;
}

/** The literal `fs({ dir })` of the project's `denext.config.*`, when it has one. */
async function configFsDir(dir: string): Promise<string | undefined> {
  for (const name of ["denext.config.ts", "denext.config.mts", "denext.config.js"]) {
    const text = await Deno.readTextFile(join(dir, name)).catch(() => "");
    const m = FS_DIR.exec(text);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Where this stack's storage objects are.
 *
 * @param ctx The invocation (`--storage-dir`).
 * @param dir The project.
 * @param rows The stack's services.
 * @param env The `.env` values.
 * @returns The source.
 */
export async function storageSource(
  ctx: CommandContext,
  dir: string,
  rows: PsRow[],
  env: Record<string, string>,
): Promise<StorageSource> {
  if (rows.some((r) => r.Service === "minio")) {
    const bucket = env.S3_BUCKET || "denext";
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
      throw new Error(`S3_BUCKET ${bucket} is not a bucket name`);
    }
    return { kind: "minio", bucket };
  }
  const flag = ctx.flags["storage-dir"];
  const fsDir = typeof flag === "string" && flag ? flag : await configFsDir(dir);
  return fsDir ? { kind: "fs", dir: containerDir(fsDir) } : { kind: "none" };
}

/** `mc` against the stack's MinIO with its root credentials (from the container's env). */
const MC_ENV = 'export MC_CONFIG_DIR=/tmp/.mc-denext MC_HOST_stack="http://$MINIO_ROOT_USER:' +
  '$MINIO_ROOT_PASSWORD@127.0.0.1:9000"';

/** The container scratch dirs storage passes through. */
const MINIO_SCRATCH = { backup: "/tmp/denext-backup", restore: "/tmp/denext-restore" };

/** Copy the stack's objects into `target` (a new directory on the host). */
async function backupStorage(
  ctx: CommandContext,
  dir: string,
  io: StackIo,
  source: StorageSource,
  target: string,
): Promise<void> {
  if (source.kind === "fs") {
    await composeCp(ctx, dir, io, `web:${source.dir}/.`, target);
    return;
  }
  if (source.kind !== "minio") return;
  const scratch = MINIO_SCRATCH.backup;
  const script = `set -e; rm -rf ${scratch}; mkdir -p ${scratch}; ${MC_ENV}; ` +
    `mc mirror --quiet "stack/$1" ${scratch}`;
  await execIn(ctx, dir, io, "minio", ["sh", "-c", script, "sh", source.bucket]);
  try {
    await composeCp(ctx, dir, io, `minio:${scratch}/.`, target);
  } finally {
    await execIn(ctx, dir, io, "minio", ["rm", "-rf", scratch], { user: "0" }).catch(() => "");
  }
}

/** Put the objects in `from` (a host directory) back into the stack's storage. */
async function restoreStorage(
  ctx: CommandContext,
  dir: string,
  io: StackIo,
  source: StorageSource,
  from: string,
): Promise<void> {
  if (source.kind === "none") {
    io.log("  storage/: this stack has no storage service or fs dir (--storage-dir); skipped");
    return;
  }
  if (source.kind === "fs") {
    await composeCp(ctx, dir, io, `${from}/.`, `web:${source.dir}`);
    await execIn(ctx, dir, io, "web", ["chown", "-R", "deno:deno", source.dir], { user: "0" });
    return;
  }
  const scratch = MINIO_SCRATCH.restore;
  await execIn(ctx, dir, io, "minio", ["rm", "-rf", scratch], { user: "0" });
  await composeCp(ctx, dir, io, `${from}/.`, `minio:${scratch}`);
  try {
    const script = `set -e; ${MC_ENV}; mc mb --ignore-existing "stack/$1" >/dev/null; ` +
      `mc mirror --quiet --overwrite ${scratch} "stack/$1"`;
    await execIn(ctx, dir, io, "minio", ["sh", "-c", script, "sh", source.bucket]);
  } finally {
    await execIn(ctx, dir, io, "minio", ["rm", "-rf", scratch], { user: "0" }).catch(() => "");
  }
}

/** A timestamp for a file name. */
function stamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/[:]/g, "-");
}

/** The backup's path: the one asked for, or a new one under {@linkcode BACKUP_DIR}. */
async function backupPath(ctx: CommandContext, dir: string, full: boolean): Promise<string> {
  const named = ctx.positionals[1];
  const path = named
    ? resolve(dir, named)
    : join(dir, BACKUP_DIR, `stack-${stamp()}.${full ? "tar.gz" : "dump"}`);
  if (!named) await Deno.mkdir(join(dir, BACKUP_DIR), { recursive: true, mode: 0o700 });
  if (await exists(path)) throw new Error(`${path} already exists`);
  return path;
}

/** `pg_dump -Fc` of the stack's database into `file`. */
async function dumpDatabase(
  ctx: CommandContext,
  dir: string,
  io: StackIo,
  file: string,
): Promise<void> {
  const cmd = ["sh", "-c", 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'];
  await execIn(ctx, dir, io, "db", cmd, { outputFile: file });
}

/** A line of the manifest per step, numbered in restore order. */
function manifest(env: Record<string, string>, source: StorageSource, steps: string[]): string {
  const storage = source.kind === "minio"
    ? `minio bucket ${source.bucket}`
    : source.kind === "fs"
    ? `fs ${source.dir}`
    : "none";
  return [
    MANIFEST_TITLE,
    "format: 1",
    `created: ${new Date().toISOString()}`,
    `database: ${env.POSTGRES_DB || "denext"}`,
    `storage: ${storage}`,
    "",
    "Restore order:",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    "",
  ].join("\n");
}

/** Stage a full backup's files in `staging` (a new directory); returns the steps it holds. */
async function stageFull(
  ctx: CommandContext,
  dir: string,
  io: StackIo,
  staging: string,
  source: StorageSource,
): Promise<string[]> {
  const sql = { "roles.sql": ROLES_SQL, "extensions.sql": EXTENSIONS_SQL };
  for (const [name, query] of Object.entries(sql)) {
    await execIn(ctx, dir, io, "db", psql(true), { input: query, outputFile: join(staging, name) });
  }
  await dumpDatabase(ctx, dir, io, join(staging, "database.dump"));
  await execIn(ctx, dir, io, "db", psql(true), {
    input: SETTINGS_SQL,
    outputFile: join(staging, "settings.sql"),
  });
  if (source.kind === "none") return RESTORE_STEPS.filter((s) => s !== "storage/");
  await backupStorage(ctx, dir, io, source, join(staging, "storage"));
  return [...RESTORE_STEPS];
}

/** Write `path` as 0600 through `write`, via a temp name renamed into place. */
async function finishFile(path: string, write: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = `${path}.partial`;
  try {
    // Created 0600 before a byte is written: a backup holds the whole database.
    await Deno.remove(tmp).catch(() => {});
    await Deno.writeFile(tmp, new Uint8Array(), { mode: 0o600, createNew: true });
    await write(tmp);
    if (Deno.build.os !== "windows") await Deno.chmod(tmp, 0o600);
    await Deno.rename(tmp, path);
  } catch (error) {
    await Deno.remove(tmp).catch(() => {});
    throw error;
  }
}

/**
 * `denext stack backup [file] [--full]`.
 *
 * @param ctx The invocation.
 * @param dir The project.
 * @param io Docker.
 */
export async function backupAction(ctx: CommandContext, dir: string, io: StackIo): Promise<void> {
  const rows = await psRows(ctx, dir, io);
  requireRunning(rows, "db");
  const full = ctx.flags.full === true;
  const path = await backupPath(ctx, dir, full);
  if (!full) {
    await finishFile(path, (tmp) => dumpDatabase(ctx, dir, io, tmp));
    io.log(`Backed up the database to ${path}`);
    return;
  }
  const env = await readEnvFile(dir);
  const source = await storageSource(ctx, dir, rows, env);
  const root = await Deno.makeTempDir({ prefix: "denext-stack-backup-" });
  try {
    const staging = join(root, `stack-backup-${stamp()}`);
    await Deno.mkdir(staging, { mode: 0o700 });
    const steps = await stageFull(ctx, dir, io, staging, source);
    await Deno.writeTextFile(join(staging, "MANIFEST.txt"), manifest(env, source, steps));
    await finishFile(path, async (tmp) => void await writeAppUpdateArchive(staging, tmp));
    io.log(`Backed up the database${source.kind === "none" ? "" : " and storage"} to ${path}`);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

/**
 * The restore order a `MANIFEST.txt` records: only known steps, each once.
 *
 * @param text The manifest.
 * @returns The steps, in order.
 */
export function parseManifest(text: string): RestoreStep[] {
  if (!text.startsWith(MANIFEST_TITLE)) throw new Error("not a denext stack backup manifest");
  const order = text.split(/\r?\n/).indexOf("Restore order:");
  if (order === -1) throw new Error("the manifest has no restore order");
  const steps: RestoreStep[] = [];
  for (const line of text.split(/\r?\n/).slice(order + 1)) {
    const m = /^\s*\d+\.\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    const step = m[1] as RestoreStep;
    if (!RESTORE_STEPS.includes(step) || steps.includes(step)) {
      throw new Error(`the manifest names an unknown or repeated step: ${m[1]}`);
    }
    steps.push(step);
  }
  if (!steps.includes("database.dump")) throw new Error("the manifest has no database.dump");
  return steps;
}

/** What `file` holds: a pg_dump custom-format dump, or a full backup (gzip). */
export async function backupKind(file: string): Promise<"dump" | "full"> {
  const handle = await Deno.open(file);
  try {
    const head = new Uint8Array(5);
    const n = await handle.read(head) ?? 0;
    if (n >= 5 && new TextDecoder().decode(head) === "PGDMP") return "dump";
    if (n >= 2 && head[0] === 0x1f && head[1] === 0x8b) return "full";
  } finally {
    handle.close();
  }
  throw new Error(`${file} is neither a stack backup (.tar.gz) nor a pg_dump custom-format dump`);
}

/** Refuse a database that already has tables, unless `--yes`. */
async function checkEmpty(ctx: CommandContext, dir: string, io: StackIo): Promise<void> {
  const count = Number((await execIn(ctx, dir, io, "db", psql(true), { input: TABLE_COUNT_SQL }))
    .trim());
  if (count === 0 || ctx.flags.yes === true) return;
  throw new Error(
    `the database is not empty (${count} tables): restore replaces every object the backup ` +
      "holds (pg_restore --clean). Pass --yes to go ahead",
  );
}

/** `pg_restore` the dump at `file` (copied into the db container first, so it is seekable). */
async function restoreDump(
  ctx: CommandContext,
  dir: string,
  io: StackIo,
  file: string,
): Promise<void> {
  const inside = "/tmp/denext-restore.dump";
  await composeCp(ctx, dir, io, file, `db:${inside}`);
  try {
    const cmd = [
      "sh",
      "-c",
      'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists ' +
      `--single-transaction --no-password ${inside}`,
    ];
    await execIn(ctx, dir, io, "db", cmd);
  } finally {
    await execIn(ctx, dir, io, "db", ["rm", "-f", inside]).catch(() => "");
  }
}

/** The directory a full backup was extracted into that holds its `MANIFEST.txt`. */
async function backupRoot(extracted: string): Promise<string> {
  if (await exists(join(extracted, "MANIFEST.txt"))) return extracted;
  const dirs: string[] = [];
  for await (const e of Deno.readDir(extracted)) if (e.isDirectory) dirs.push(e.name);
  if (dirs.length === 1 && await exists(join(extracted, dirs[0], "MANIFEST.txt"))) {
    return join(extracted, dirs[0]);
  }
  throw new Error("the backup has no MANIFEST.txt");
}

/** Stop the app while its database is replaced; resolves whether it was running. */
async function stopApp(
  ctx: CommandContext,
  dir: string,
  io: StackIo,
  rows: PsRow[],
): Promise<boolean> {
  if (rows.find((r) => r.Service === "web")?.State !== "running") return false;
  const out = await io.docker([...composeArgs(ctx), "stop", "web"], dir, true);
  if (out.code !== 0) throw new Error(`docker compose stop web failed: ${out.stderr.trim()}`);
  return true;
}

/** Start the app again (after {@linkcode stopApp}). */
async function startApp(ctx: CommandContext, dir: string, io: StackIo): Promise<void> {
  const out = await io.docker([...composeArgs(ctx), "start", "web"], dir, true);
  if (out.code !== 0) io.error(`docker compose start web failed: ${out.stderr.trim()}`);
}

/** A full backup's steps, each file present (storage may be absent). */
async function fullSteps(root: string): Promise<RestoreStep[]> {
  const steps = parseManifest(await Deno.readTextFile(join(root, "MANIFEST.txt")));
  for (const step of steps) {
    if (step !== "storage/" && !(await Deno.lstat(join(root, step)).catch(() => null))?.isFile) {
      throw new Error(`the backup's manifest names ${step}, which it does not hold`);
    }
  }
  return steps;
}

/** Run a full backup's steps from `root`, in the manifest's order. */
async function restoreFull(
  ctx: CommandContext,
  dir: string,
  io: StackIo,
  root: string,
  source: StorageSource,
  app: { running: boolean },
): Promise<void> {
  for (const step of await fullSteps(root)) {
    const path = join(root, step.replace(/\/$/, ""));
    if (step === "storage/") {
      if (app.running) {
        await startApp(ctx, dir, io);
        app.running = false;
      }
      if (await exists(path)) await restoreStorage(ctx, dir, io, source, path);
    } else if (step === "database.dump") {
      await restoreDump(ctx, dir, io, path);
    } else {
      await execIn(ctx, dir, io, "db", psql(false), { inputFile: path });
    }
    io.log(`  restored ${step}`);
  }
}

const GIB = 1024 ** 3;

/** The extraction cap when the free space can't be measured and no `--max-size` is given. */
const UNMEASURED_RESTORE_CAP = 16 * GIB;

/**
 * A size such as `20G`, `512MiB`, `1.5t` or `1048576` (bytes; K/M/G/T are powers of 1024).
 *
 * @param text The size.
 * @returns The bytes.
 */
export function parseSize(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?$/i.exec(text.trim());
  const bytes = m
    ? Math.floor(Number(m[1]) * 1024 ** " kmgt".indexOf(m[2].toLowerCase() || " "))
    : 0;
  if (!(bytes > 0) || !Number.isSafeInteger(bytes)) {
    throw new Error(`--max-size: "${text}" is not a size (e.g. 20G, 512M or a byte count)`);
  }
  return bytes;
}

/** `bytes` for a person: `1.5 GiB`. */
function formatSize(bytes: number): string {
  const units = ["bytes", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${bytes} bytes` : `${n.toFixed(1)} ${units[i]}`;
}

/** The most a full backup may expand to, and why: `--max-size`, else free space minus a margin. */
export interface RestoreCap {
  /** The cap, in bytes. */
  readonly bytes: number;
  /** Where it came from, for the refusal. */
  readonly why: string;
}

/**
 * How large a full backup may expand to while it is extracted into `scratch`: what the disk
 * holding it has free, minus a margin (a tenth of it, at least 1 GiB) so the extraction can never
 * fill it, and no more than `--max-size`. Refuses when the disk has no room left at all.
 *
 * @param ctx The invocation (`--max-size`).
 * @param io Its `freeBytes`.
 * @param scratch The directory the backup is extracted under.
 * @returns The cap.
 */
export async function restoreCap(
  ctx: CommandContext,
  io: StackIo,
  scratch: string,
): Promise<RestoreCap> {
  const flag = ctx.flags["max-size"];
  const asked = typeof flag === "string" ? parseSize(flag) : undefined;
  const free = await io.freeBytes?.(scratch);
  if (free === undefined) {
    return asked !== undefined
      ? { bytes: asked, why: "--max-size" }
      : { bytes: UNMEASURED_RESTORE_CAP, why: "the default when free space can't be measured" };
  }
  const margin = Math.max(GIB, Math.floor(free / 10));
  const room = free - margin;
  if (room <= 0) {
    throw new Error(
      `only ${formatSize(free)} is free where the backup would be extracted (${scratch}); ` +
        `restore keeps ${formatSize(margin)} free. Free up space or point TMPDIR at a larger disk`,
    );
  }
  if (asked !== undefined && asked <= room) return { bytes: asked, why: "--max-size" };
  return {
    bytes: room,
    why: `${formatSize(free)} free where it is extracted, less a ${formatSize(margin)} margin`,
  };
}

/** Extract a full backup under `cap`, turning "too large" into a refusal that says what to do. */
async function extractBackup(file: string, dest: string, cap: RestoreCap): Promise<string> {
  try {
    await extractArchive(file, "tar.gz", dest, { maxBytes: cap.bytes, maxEntries: 10_000_000 });
  } catch (error) {
    if (error instanceof UnsafeArchiveError && /expands past/.test(error.message)) {
      throw new Error(
        `the backup expands past ${formatSize(cap.bytes)} (${cap.why}), so it was not ` +
          "restored. Free up space, point TMPDIR at a larger disk, or pass a larger --max-size",
      );
    }
    throw error;
  }
  return await backupRoot(dest);
}

/**
 * `denext stack restore <file> [--yes] [--max-size <size>]`.
 *
 * @param ctx The invocation.
 * @param dir The project.
 * @param io Docker.
 */
export async function restoreAction(ctx: CommandContext, dir: string, io: StackIo): Promise<void> {
  const named = ctx.positionals[1];
  if (!named) throw new Error("name the backup: denext stack restore <file>");
  const file = isAbsolute(named) ? named : resolve(dir, named);
  const kind = await backupKind(file);
  const rows = await psRows(ctx, dir, io);
  requireRunning(rows, "db");
  await checkEmpty(ctx, dir, io);
  const extracted = kind === "full" ? await Deno.makeTempDir({ prefix: "denext-restore-" }) : "";
  try {
    // Extract (and so validate) the whole archive before the database is touched.
    const root = kind === "full"
      ? await extractBackup(file, join(extracted, "x"), await restoreCap(ctx, io, extracted))
      : "";
    if (root) await fullSteps(root);
    const source = kind === "full"
      ? await storageSource(ctx, dir, rows, await readEnvFile(dir))
      : { kind: "none" as const };
    const app = { running: await stopApp(ctx, dir, io, rows) };
    try {
      if (kind === "dump") await restoreDump(ctx, dir, io, file);
      else await restoreFull(ctx, dir, io, root, source, app);
    } finally {
      if (app.running) await startApp(ctx, dir, io);
    }
    io.log(`Restored ${file}`);
  } finally {
    if (extracted) await Deno.remove(extracted, { recursive: true }).catch(() => {});
  }
}
