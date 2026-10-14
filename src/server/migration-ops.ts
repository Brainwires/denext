// The operations `denext migration up|down|list|repair` (and `denext db migrate|rollback`) run
// over a {@linkcode MigrationHistory}: which local files are applied, which are pending, what a
// rollback reverts. Dialect-free: Postgres and SQLite histories plug in alike.

import { compareVersions, type MigrationFile } from "./migration-files.ts";
import {
  type AppliedMigration,
  type MigrationHistory,
  NoDownScriptError,
} from "./migration-history.ts";

/** One line of `denext migration list`: a version, local, remote, or both. */
export interface MigrationRow {
  /** The version. */
  version: string;
  /** The local file's name, when there is one. */
  name?: string;
  /** Whether a local file has it. */
  local: boolean;
  /** Whether the database's history has it. */
  remote: boolean;
  /** When it was applied (when the history records it). */
  appliedAt?: string;
  /** Applied, but the file's SQL changed since (Postgres `_migrations` only). */
  changed?: boolean;
  /** Whether the local file has a down script. */
  reversible?: boolean;
}

/** Sort by version, then by name. */
function byVersion<T extends { version: string; name?: string }>(a: T, b: T): number {
  return compareVersions(a.version, b.version) || (a.name ?? "").localeCompare(b.name ?? "");
}

/**
 * Every version the files or the history know, local and remote side by side.
 *
 * @param history The database's history.
 * @param files The local migrations.
 * @param sum Checksums a file's up SQL (to flag a changed applied file), when the history has them.
 * @returns The rows, by version.
 */
export async function listMigrations(
  history: MigrationHistory,
  files: MigrationFile[],
  sum?: (text: string) => Promise<string>,
): Promise<MigrationRow[]> {
  const applied = new Map((await history.applied()).map((row) => [row.key, row]));
  const rows: MigrationRow[] = [];
  for (const file of files) {
    const row = applied.get(history.keyOf(file));
    applied.delete(history.keyOf(file));
    const changed = row?.checksum && sum ? row.checksum !== await sum(file.up) : false;
    rows.push({
      version: file.version,
      name: file.name,
      local: true,
      remote: !!row,
      ...(row?.appliedAt ? { appliedAt: row.appliedAt.toISOString() } : {}),
      ...(changed ? { changed } : {}),
      reversible: file.down !== undefined,
    });
  }
  for (const row of applied.values()) {
    rows.push({
      version: row.version,
      ...(row.name ? { name: row.name } : {}),
      local: false,
      remote: true,
      ...(row.appliedAt ? { appliedAt: row.appliedAt.toISOString() } : {}),
    });
  }
  return rows.sort(byVersion);
}

/** Options for {@linkcode planUp} / {@linkcode migrateUp}. */
export interface UpOptions {
  /** Apply nothing past this version. */
  to?: string;
  /** Apply a pending migration older than the newest applied one (otherwise refused). */
  includeAll?: boolean;
  /** List what would be applied, apply nothing. */
  dryRun?: boolean;
}

/** A pending migration older than the newest applied one, refused without `includeAll`. */
export class OutOfOrderError extends Error {
  /**
   * Build the error.
   *
   * @param names The out-of-order migrations.
   */
  constructor(readonly names: string[]) {
    super(
      `found local migrations older than the last one applied: ${names.join(", ")}. ` +
        "Rerun with --include-all to apply them anyway.",
    );
    this.name = "OutOfOrderError";
  }
}

/**
 * The migrations `up` would apply, in order.
 *
 * @param history The database's history.
 * @param files The local migrations.
 * @param options The target version, and whether out-of-order files are allowed.
 * @returns The pending migrations.
 * @throws {OutOfOrderError} For a pending migration older than the newest applied one.
 */
export async function planUp(
  history: MigrationHistory,
  files: MigrationFile[],
  options: UpOptions = {},
): Promise<MigrationFile[]> {
  const applied = await history.applied();
  const keys = new Set(applied.map((row) => row.key));
  const pending = files.filter((file) =>
    !keys.has(history.keyOf(file)) &&
    (options.to === undefined || compareVersions(file.version, options.to) <= 0)
  );
  const newest = applied.map((row) => row.version).sort(compareVersions).at(-1);
  if (newest !== undefined && !options.includeAll) {
    const early = pending.filter((file) => compareVersions(file.version, newest) < 0);
    if (early.length) throw new OutOfOrderError(early.map((file) => file.name));
  }
  return pending;
}

/**
 * Apply the pending migrations, in order; the first failure stops the run (the ones before it
 * stay applied).
 *
 * @param history The database's history.
 * @param files The local migrations.
 * @param options The target version, `includeAll` and `dryRun`.
 * @param onApplied Called after each one is applied.
 * @returns The names applied (or, for a dry run, that would be).
 */
export async function migrateUp(
  history: MigrationHistory,
  files: MigrationFile[],
  options: UpOptions = {},
  onApplied?: (name: string) => void,
): Promise<string[]> {
  const pending = await planUp(history, files, options);
  if (options.dryRun) return pending.map((file) => file.name);
  const applied: string[] = [];
  for (const file of pending) {
    if (await history.apply(file)) {
      applied.push(file.name);
      onApplied?.(file.name);
    }
  }
  return applied;
}

/** Options for {@linkcode planDown} / {@linkcode migrateDown}. */
export interface DownOptions {
  /** How many of the newest applied migrations to revert (default 1). */
  steps?: number;
  /** Revert every applied migration newer than this version (instead of `steps`). */
  to?: string;
  /** List what would be reverted, revert nothing. */
  dryRun?: boolean;
}

/** A migration a rollback reverts. */
export interface RollbackStep {
  /** The history's row. */
  row: AppliedMigration;
  /** The local file, when there is one. */
  file?: MigrationFile;
}

/**
 * The applied migrations a rollback reverts, newest first.
 *
 * @param history The database's history.
 * @param files The local migrations.
 * @param options `steps` or `to`.
 * @returns The steps.
 */
export async function planDown(
  history: MigrationHistory,
  files: MigrationFile[],
  options: DownOptions = {},
): Promise<RollbackStep[]> {
  const byKey = new Map(files.map((file) => [history.keyOf(file), file]));
  const applied = (await history.applied()).sort(byVersion).reverse();
  const steps = options.steps ?? 1;
  if (options.to === undefined && (!Number.isInteger(steps) || steps < 1)) {
    throw new TypeError("--steps must be a whole number of 1 or more");
  }
  const chosen = options.to !== undefined
    ? applied.filter((row) => compareVersions(row.version, options.to!) > 0)
    : applied.slice(0, steps);
  return chosen.map((row) => ({
    row,
    ...(byKey.has(row.key) ? { file: byKey.get(row.key) } : {}),
  }));
}

/**
 * The version a rollback leaves the database at: the newest applied version it does not revert
 * (`undefined` when it reverts everything).
 *
 * @param history The database's history.
 * @param steps The planned steps.
 * @returns The version.
 */
export async function versionAfter(
  history: MigrationHistory,
  steps: RollbackStep[],
): Promise<string | undefined> {
  const reverted = new Set(steps.map((step) => step.row.key));
  return (await history.applied())
    .filter((row) => !reverted.has(row.key))
    .map((row) => row.version)
    .sort(compareVersions)
    .at(-1);
}

/**
 * Revert the newest applied migrations with their down scripts, newest first. Every one must
 * have a local file with a down script, checked before anything runs.
 *
 * @param history The database's history.
 * @param files The local migrations.
 * @param options `steps` / `to`, and `dryRun`.
 * @param onReverted Called after each one is reverted.
 * @returns The names reverted (or, for a dry run, that would be).
 * @throws {NoDownScriptError} When one has no down script (or no local file).
 */
export async function migrateDown(
  history: MigrationHistory,
  files: MigrationFile[],
  options: DownOptions = {},
  onReverted?: (name: string) => void,
): Promise<string[]> {
  const steps = await planDown(history, files, options);
  const missing = steps.filter((step) => step.file?.down === undefined)
    .map((step) => step.file?.name ?? `${step.row.name ?? step.row.key} (no local file)`);
  if (missing.length) throw new NoDownScriptError(missing);
  if (options.dryRun) return steps.map((step) => step.file!.name);
  const reverted: string[] = [];
  for (const step of steps) {
    await history.revert(step.file!);
    reverted.push(step.file!.name);
    onReverted?.(step.file!.name);
  }
  return reverted;
}

/**
 * Mark versions applied or reverted in the history without running SQL (`migration repair`).
 *
 * @param history The database's history.
 * @param files The local migrations.
 * @param versions The versions.
 * @param status `applied` (needs the local file) or `reverted`.
 * @returns The names changed.
 * @throws {Error} For an `applied` version with no local file.
 */
export async function repairHistory(
  history: MigrationHistory,
  files: MigrationFile[],
  versions: string[],
  status: "applied" | "reverted",
): Promise<string[]> {
  const changed: string[] = [];
  if (status === "applied") {
    for (const version of versions) {
      const file = files.find((f) => f.version === version);
      if (!file) throw new Error(`no local migration has version ${version}`);
      await history.record(file);
      changed.push(file.name);
    }
    return changed;
  }
  const applied = await history.applied();
  for (const version of versions) {
    const rows = applied.filter((row) => row.version === version);
    if (!rows.length) throw new Error(`version ${version} is not in ${history.table}`);
    for (const row of rows) {
      await history.forget(row);
      changed.push(row.name ?? row.key);
    }
  }
  return changed;
}
