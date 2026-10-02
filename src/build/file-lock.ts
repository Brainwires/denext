// Cargo-style advisory file locks: real OS locks (`flock` on Unix, `LockFileEx` on Windows,
// through `Deno.FsFile.lock`), released by the OS when the holding process exits, so there is
// no stale-lock heuristic, no PID file and nothing to clean up after a crash or a `kill -9`.
//
// The contract follows Cargo's (`cargo::util::flock` / `cache_lock`):
//
// - try the lock first; when another process holds it, print ONE line to stderr —
//   `    Blocking waiting for file lock on <what> (<lock file>) — held by another denext
//   process; Ctrl-C to abort` — and then block until it is free (or, with
//   `DENEXT_LOCK_TIMEOUT=<seconds>`, fail once that long has passed);
// - shared locks coexist, an exclusive lock excludes everything;
// - a lock this process already holds is re-entrant (a nested acquire of the same file is a
//   reference count, never a self-deadlock — two `open`s of one file in one process are
//   separate `flock` owners on macOS/Linux and would otherwise wait on each other forever);
// - a shared lock is never upgraded in place (Cargo refuses the same: release, then acquire);
// - locks carry a RANK and must be taken in increasing rank order, the fixed order that keeps
//   two processes from each holding what the other waits for (Cargo PR #15698 fixed exactly
//   that deadlock). Taking a lower rank while holding a higher one throws — a bug, not a wait.
// - a filesystem that cannot lock at all (some network mounts) proceeds unlocked, as Cargo does,
//   with one warning; so does a SHARED lock (a reader) whose lock file can't be created on a
//   read-only or unwritable directory.

import { dirname, resolve } from "@std/path";

/** A lock's mode: many `shared` holders at once, or one `exclusive` holder. */
export type LockMode = "shared" | "exclusive";

/** What {@linkcode acquireFileLock} needs to know besides the path. */
export interface FileLockOptions {
  /** `shared` (readers) or `exclusive` (writers). */
  readonly mode: LockMode;
  /** What the Blocking line names, e.g. `build directory .denext`. */
  readonly description: string;
  /** Position in the global acquisition order (see the module header). */
  readonly rank: number;
  /** Where the single Blocking line goes (default: stderr). */
  readonly onBlocking?: (line: string) => void;
  /** Where the proceeding-unlocked warning goes (default: stderr). */
  readonly onWarning?: (line: string) => void;
  /**
   * How long to wait for a contended lock before failing, in ms (default: `DENEXT_LOCK_TIMEOUT`
   * seconds, else forever).
   */
  readonly timeoutMs?: number;
}

/** `DENEXT_LOCK_TIMEOUT`: seconds to wait for a contended lock before failing (unset: forever). */
const LOCK_TIMEOUT_ENV = "DENEXT_LOCK_TIMEOUT";

/**
 * The lock wait limit in ms from a `DENEXT_LOCK_TIMEOUT` value: a positive number of seconds, else
 * `undefined` (wait forever — an unset, empty, zero, negative or malformed value).
 *
 * @param value The variable's value.
 * @returns The limit in ms, or `undefined`.
 */
export function lockTimeoutMs(value: string | undefined): number | undefined {
  const seconds = Number(value?.trim() || NaN);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

function envLockTimeoutMs(): number | undefined {
  try {
    return lockTimeoutMs(Deno.env.get(LOCK_TIMEOUT_ENV));
  } catch {
    return undefined; // no env permission: wait forever
  }
}

/** A held lock. Release it (or let `using` dispose it); process exit releases it too. */
export interface FileLock extends Disposable {
  /** The lock file's absolute path. */
  readonly path: string;
  /** The mode it is held in. */
  readonly mode: LockMode;
  /** Drop this reference; the OS lock goes when the last reference in the process does. */
  release(): void;
}

interface Held {
  readonly mode: LockMode;
  readonly rank: number;
  refs: number;
  /** Settles once the OS lock is held. */
  readonly ready: Promise<Deno.FsFile | null>;
  /** The open, locked file once `ready` settled — `null` on a filesystem without locking. */
  file?: Deno.FsFile | null;
}

/** Every lock file this process holds (or is acquiring), by absolute path. */
const held = new Map<string, Held>();

/**
 * The Blocking line, in Cargo's wording (`Blocking` right-aligned in a 12-column status), plus the
 * lock file and how to get out.
 *
 * @param description What the lock guards (`build directory .denext`).
 * @param path The lock file.
 * @returns The line.
 */
export function blockingLine(description: string, path: string): string {
  return `    Blocking waiting for file lock on ${description} (${path}) — held by another denext ` +
    "process; Ctrl-C to abort";
}

function writeStderr(line: string): void {
  try {
    Deno.stderr.writeSync(new TextEncoder().encode(`${line}\n`));
  } catch {
    // stderr closed — the wait still happens
  }
}

/** The errno code of `err` (`err.code`, else one named in its message). */
function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return err instanceof Error ? /\b(E[A-Z]{2,})\b/.exec(err.message)?.[1] : undefined;
}

/** Errnos that say this filesystem cannot lock (some network mounts, FUSE, WSL1, SMB). */
const NO_LOCKING = new Set(["ENOLCK", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EINVAL"]);

/** Whether `err` says this filesystem cannot lock (Cargo proceeds unlocked there too). */
export function lockingUnsupported(err: unknown): boolean {
  if (err instanceof Deno.errors.NotSupported) return true;
  if (NO_LOCKING.has(errnoOf(err) ?? "")) return true;
  return err instanceof Error && /not supported|not implemented/i.test(err.message);
}

/** Whether `err` says the lock file can't be created here (a read-only or unwritable directory). */
function cannotCreate(err: unknown): boolean {
  if (err instanceof Deno.errors.PermissionDenied) return true;
  return ["EROFS", "EACCES", "EPERM"].includes(errnoOf(err) ?? "");
}

/** Lock files already warned about (one warning per file per process). */
const warnedUnlocked = new Set<string>();

function proceedUnlocked(path: string, opts: FileLockOptions, why: unknown): null {
  if (!warnedUnlocked.has(path)) {
    warnedUnlocked.add(path);
    const reason = why instanceof Error ? why.message : String(why);
    (opts.onWarning ?? writeStderr)(
      `    warning: proceeding without a lock on ${opts.description} (${path}): ${reason}`,
    );
  }
  return null;
}

/** Wait for the lock, polling until `timeoutMs` has passed; then fail naming the holder's file. */
async function lockWithin(
  file: Deno.FsFile,
  exclusive: boolean,
  path: string,
  opts: FileLockOptions,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(200, Math.max(1, deadline - Date.now()))));
    if (await file.tryLock(exclusive)) return;
  }
  throw new Error(
    `denext: gave up after ${timeoutMs / 1000}s waiting for file lock on ${opts.description} ` +
      `(${path}); another denext process holds it (${LOCK_TIMEOUT_ENV})`,
  );
}

async function lockFile(path: string, opts: FileLockOptions): Promise<Deno.FsFile | null> {
  let file: Deno.FsFile;
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    file = await Deno.open(path, { read: true, write: true, create: true });
  } catch (err) {
    // A reader on a read-only tree has nothing to protect from itself: proceed (with a warning).
    if (opts.mode === "shared" && cannotCreate(err)) return proceedUnlocked(path, opts, err);
    throw err;
  }
  const exclusive = opts.mode === "exclusive";
  try {
    if (!await file.tryLock(exclusive)) {
      (opts.onBlocking ?? writeStderr)(blockingLine(opts.description, path));
      const timeoutMs = opts.timeoutMs ?? envLockTimeoutMs();
      if (timeoutMs === undefined) await file.lock(exclusive);
      else await lockWithin(file, exclusive, path, opts, timeoutMs);
    }
    return file;
  } catch (err) {
    file.close();
    if (lockingUnsupported(err)) return proceedUnlocked(path, opts, err);
    throw err;
  }
}

/** The highest rank this process holds, or -1. */
function highestHeldRank(): number {
  let max = -1;
  for (const h of held.values()) max = Math.max(max, h.rank);
  return max;
}

function handle(path: string, entry: Held): FileLock {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (--entry.refs > 0) return;
    held.delete(path);
    const file = entry.file;
    if (!file) return;
    try {
      file.unlockSync();
    } catch { /* closing releases it anyway */ }
    try {
      file.close();
    } catch { /* already closed */ }
  };
  return { path, mode: entry.mode, release, [Symbol.dispose]: release };
}

/**
 * Acquire an OS advisory lock on `path` (created, with its directory, when missing). Tries
 * first; when the lock is held elsewhere, prints one Blocking line and waits.
 *
 * @param path The lock file.
 * @param opts Mode, description, rank.
 * @returns The held lock.
 * @throws When the acquisition would break the rank order, or upgrade a shared lock.
 */
export async function acquireFileLock(path: string, opts: FileLockOptions): Promise<FileLock> {
  const key = resolve(path);
  const existing = held.get(key);
  if (existing) {
    if (existing.mode === "shared" && opts.mode === "exclusive") {
      throw new Error(
        `denext: this process holds a shared lock on ${opts.description} and asked for an ` +
          `exclusive one (release it first; locks are not upgraded in place)`,
      );
    }
    existing.refs++;
    try {
      await existing.ready;
    } catch (err) {
      existing.refs--;
      throw err;
    }
    return handle(key, existing);
  }
  const top = highestHeldRank();
  if (opts.rank < top) {
    throw new Error(
      `denext: lock order violation — ${opts.description} (rank ${opts.rank}) requested while ` +
        `holding a rank-${top} lock`,
    );
  }
  const entry: Held = { mode: opts.mode, rank: opts.rank, refs: 1, ready: lockFile(key, opts) };
  held.set(key, entry);
  try {
    entry.file = await entry.ready;
  } catch (err) {
    held.delete(key);
    throw err;
  }
  return handle(key, entry);
}

/** Several locks released as one (in reverse acquisition order). */
export function lockGroup(locks: readonly FileLock[]): Disposable & { release(): void } {
  const release = () => {
    for (const lock of [...locks].reverse()) lock.release();
  };
  return { release, [Symbol.dispose]: release };
}
