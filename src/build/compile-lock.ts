// The app's lockfile and dependency-age rule, carried into `denext build --compile`'s own config.
//
// The compile resolves with a config it writes under `.denext/compile/` (./compile-app.ts), so
// Deno looks for a lockfile and an `.npmrc` beside THAT config, not the app's. Without them the
// binary embedded whatever the app's ranges resolved to that day: a newer (or unvetted) version
// than the app's `deno.lock` pins, with no integrity check, and an `.npmrc` `min-release-age` hold
// dropped. So the compile directory gets:
//
// - a copy of the app's lockfile (its `lock` field: a path, `{ path, frozen }`, or `deno.lock`
//   beside the config) as `deno.lock`: Deno resolves every specifier it locks to the locked
//   version and checks each package against the locked integrity. The copy drops the lockfile's
//   `workspace` section: it describes the app's config, and Deno would otherwise drop the locked
//   entries of every dependency the compile config does not list and resolve them afresh. The
//   framework's own exact-version entry (`jsr:@denext/denext@<v>/standalone`) is mapped to the
//   locked package when the lock has that version.
// - a copy of the app's `.npmrc` (its `min-release-age` and registries), never embedded
//   (`neverEmbedded`).
//
// After the compile ({@linkcode settleCompileLock}), what Deno added to the copy is new to the
// app's lock: recorded in it (as `deno compile --lock` against the app's file would), or, when the
// app's lock is frozen, refused. An app with no lockfile (`"lock": false`, or none written yet)
// compiles without one, as its build resolves.

import { join } from "@std/path";
import { lockfilePath } from "./app-framework-root.ts";

/** A parsed `deno.lock` (the sections this module reads). */
type Lockfile = Record<string, unknown> & { version?: unknown };

/** The lockfile sections whose keys are resolutions. */
const RESOLUTION_SECTIONS = ["specifiers", "jsr", "npm", "remote", "redirects"] as const;

/** The compile's lockfile, as {@linkcode seedCompileLock} wrote it. */
export interface CompileLock {
  /** The copy in the compile directory, or `undefined` when the compile runs without a lock. */
  readonly path?: string;
  /** The app's lockfile it was copied from. */
  readonly appLock?: string;
  /** The app's lock is frozen (`"lock": { "frozen": true }`). */
  readonly frozen: boolean;
  /** The copy as written, to tell what the compile added. */
  readonly seed?: Lockfile;
}

/** `value` is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Remove `path` if it exists. */
async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/**
 * The exact `jsr:` requirement a specifier names (`jsr:@denext/denext@4.6.0/standalone` →
 * `jsr:@denext/denext@4.6.0`, package `@denext/denext@4.6.0`), or `undefined` for anything else
 * (a range, a `file:` URL).
 *
 * @param specifier The module specifier.
 * @returns The requirement, its lockfile package key and the version.
 */
export function exactJsrRequirement(
  specifier: string,
): { requirement: string; pkg: string; version: string } | undefined {
  const m = /^jsr:(@[^/@]+\/[^/@]+)@(\d+\.\d+\.\d+(?:-[\w.]+)?)(?:\/|$)/.exec(specifier);
  return m
    ? { requirement: `jsr:${m[1]}@${m[2]}`, pkg: `${m[1]}@${m[2]}`, version: m[2] }
    : undefined;
}

/**
 * The lockfile the compile resolves with, seeded from the app's (see the module comment).
 *
 * @param configPath The app config's path.
 * @param lockField The app config's `lock` value.
 * @param dir The compile directory (the copy is `<dir>/deno.lock`).
 * @param ownSpecifier The specifier the generated entry imports the framework by.
 * @returns What was written, for {@linkcode settleCompileLock}.
 */
export async function seedCompileLock(
  configPath: string,
  lockField: unknown,
  dir: string,
  ownSpecifier: string,
): Promise<CompileLock> {
  const path = join(dir, "deno.lock");
  // A previous compile's copy must not pin this one.
  await removeIfPresent(path);
  const frozen = isRecord(lockField) && lockField.frozen === true;
  const appLock = lockfilePath(configPath, lockField);
  if (appLock === undefined) return { frozen: false };
  let text: string;
  try {
    text = await Deno.readTextFile(appLock);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return { frozen: false };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `denext build --compile: ${appLock} is not a readable lockfile (${(err as Error).message})`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`denext build --compile: ${appLock} is not a readable lockfile`);
  }
  const seed: Lockfile = structuredClone(parsed);
  delete seed.workspace;
  const own = exactJsrRequirement(ownSpecifier);
  const specifiers = isRecord(seed.specifiers) ? seed.specifiers : undefined;
  if (own && specifiers && isRecord(seed.jsr) && Object.hasOwn(seed.jsr, own.pkg)) {
    specifiers[own.requirement] ??= own.version;
  }
  await Deno.writeTextFile(path, `${JSON.stringify(seed, null, 2)}\n`);
  return { path, appLock, frozen, seed };
}

/**
 * The resolutions `after` has that `before` lacks, as `section: key`.
 *
 * @param before The seeded lockfile.
 * @param after The lockfile the compile left.
 * @returns The added entries, sorted.
 */
export function lockAdditions(before: Lockfile, after: Lockfile): string[] {
  const out: string[] = [];
  for (const section of RESOLUTION_SECTIONS) {
    const a = after[section];
    if (!isRecord(a)) continue;
    const b = isRecord(before[section]) ? before[section] : {};
    for (const key of Object.keys(a)) if (!Object.hasOwn(b, key)) out.push(`${section}: ${key}`);
  }
  return out.sort();
}

/**
 * `target` with `source`'s resolutions it lacks added, each section's keys sorted (Deno's order).
 *
 * @param target The app's lockfile.
 * @param source The compile's.
 * @returns The merged lockfile.
 */
export function mergeLockAdditions(target: Lockfile, source: Lockfile): Lockfile {
  const out: Lockfile = { ...target };
  for (const section of RESOLUTION_SECTIONS) {
    const s = source[section];
    if (!isRecord(s)) continue;
    const merged: Record<string, unknown> = {
      ...(isRecord(target[section]) ? target[section] : {}),
    };
    for (const [key, value] of Object.entries(s)) {
      if (!Object.hasOwn(merged, key)) merged[key] = value;
    }
    out[section] = Object.fromEntries(
      Object.keys(merged).sort().map((key) => [key, merged[key]]),
    );
  }
  return out;
}

/**
 * After the compile: what it resolved that the app's lock did not lock is recorded in the app's
 * lockfile, or, when that lock is frozen, refused (the binary is then not to be shipped).
 *
 * @param lock What {@linkcode seedCompileLock} wrote.
 * @throws When the app's lock is frozen and the compile resolved something it does not lock.
 */
export async function settleCompileLock(lock: CompileLock): Promise<void> {
  if (!lock.path || !lock.seed || !lock.appLock) return;
  let after: unknown;
  try {
    after = JSON.parse(await Deno.readTextFile(lock.path));
  } catch {
    return; // Deno wrote nothing new
  }
  if (!isRecord(after) || after.version !== lock.seed.version) return;
  const added = lockAdditions(lock.seed, after);
  if (added.length === 0) return;
  if (lock.frozen) {
    throw new Error(
      `denext build --compile: ${lock.appLock} is frozen and does not lock what the compiled ` +
        `server resolves:\n  ${added.join("\n  ")}\nTurn \`lock.frozen\` off, run ` +
        "`denext build --compile` once to record these in it, review the change and freeze it again.",
    );
  }
  const current = JSON.parse(await Deno.readTextFile(lock.appLock)) as Lockfile;
  if (current.version !== after.version) return;
  await Deno.writeTextFile(
    lock.appLock,
    `${JSON.stringify(mergeLockAdditions(current, after), null, 2)}\n`,
  );
}

/**
 * Copy the app's `.npmrc` (its `min-release-age` hold and its registries) beside the compile
 * config, where Deno reads it; a previous compile's copy goes when the app has none.
 *
 * @param projectDir The project.
 * @param dir The compile directory.
 */
export async function carryNpmrc(projectDir: string, dir: string): Promise<void> {
  const target = join(dir, ".npmrc");
  let text: string;
  try {
    text = await Deno.readTextFile(join(projectDir, ".npmrc"));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    await removeIfPresent(target);
    return;
  }
  await Deno.writeTextFile(target, text, { mode: 0o600 });
}
