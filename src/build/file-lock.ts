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
// - a lock this process already holds is re-entrant for the logical TASK holding it (see
//   `lockTask`) and the work that task started: a nested acquire of the same file is a reference
//   count, never a self-deadlock — two `open`s of one file in one process are separate `flock`
//   owners on macOS/Linux and would otherwise wait on each other forever;
// - the OS lock keeps other processes out, so tasks of one process take turns in-process, by the
//   same rule: another task's request waits for this task's hold when either is exclusive (shared
//   holds of several tasks coexist), first come first served. Two `denext dev` rebuilds started
//   from separate tasks (the startup's prepare steps, a request's typed-module emit, a watcher
//   batch) so never write `.denext/` at once. An in-process wait prints no Blocking line and has
//   no time limit. The rule that keeps it from waiting on itself: while a task holds a lock, it
//   must not await work started OUTSIDE it (by a sibling task, or a memoized promise another task
//   created) that takes the same lock — that work waits for the holder, the holder for it. Work
//   the holder started itself re-enters, so awaiting it is fine;
// - a shared lock is never upgraded in place (Cargo refuses the same: release, then acquire);
// - locks carry a RANK and must be taken in increasing rank order, the fixed order that keeps
//   two processes from each holding what the other waits for (Cargo PR #15698 fixed exactly
//   that deadlock). Taking a lower rank while holding a higher one throws — a bug, not a wait.
//   The check is per logical TASK (see `lockTask`): a lock counts against the task that took it
//   and the work that task started, never against an unrelated task of the same process, which
//   cannot be waiting on it.
// - a filesystem that cannot lock at all (some network mounts) proceeds unlocked, as Cargo does,
//   with one warning; so does a SHARED lock (a reader) whose lock file can't be created on a
//   read-only or unwritable directory.

import { AsyncLocalStorage } from "node:async_hooks";
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

/** A logical task of the rank check: the locks it took count against it and its subtasks. */
interface LockTaskFrame {
  /** The task this one was started in (`undefined` for the process's root task). */
  readonly parent: LockTaskFrame | undefined;
}

/** The process's root task: work started outside every {@linkcode lockTask}. */
const ROOT_TASK: LockTaskFrame = { parent: undefined };

/** The running task, carried through the async context (timers and promises included). */
const taskStorage = new AsyncLocalStorage<LockTaskFrame>();

function currentTask(): LockTaskFrame {
  return taskStorage.getStore() ?? ROOT_TASK;
}

/**
 * Run `fn` as its own logical task of the lock-rank check. The locks it takes count against it
 * and the work it starts, not against the rest of the process: a concurrent, unrelated task (one
 * install downloading under a rank-4 lock while another task reads a different cache at rank 3)
 * can't be waiting on them, so its lower-rank request is no order violation. The task still sees
 * every lock held by the task it was started in (and that task's ancestors), which may be
 * waiting on it: asking for a lower rank than any of those throws, exactly as before.
 *
 * Which context the held set follows: the async context work was STARTED in. A timer, a detached
 * promise or a callback scheduled inside the task runs in the task, so it sees the task's locks for
 * as long as they are held (a lock released before it runs no longer counts), and a lock it takes
 * counts against the task, even after `fn` has settled. Code outside every task belongs to the
 * process's root task, which every task sees. What the check can't see is a task holding a lock
 * while it awaits a promise another task started (a shared, memoized one): keep such waits out of
 * locked sections. The same task boundary decides who waits for a lock file this process already
 * holds: the holding task and the work it started re-enter it, any other task waits its turn
 * (see {@linkcode acquireFileLock}).
 *
 * @param fn The task's work.
 * @returns What `fn` returns.
 */
export function lockTask<T>(fn: () => T): T {
  return taskStorage.run({ parent: currentTask() }, fn);
}

interface Held {
  /** The mode of the holds (several tasks' shared holds, or one task's exclusive hold). */
  readonly mode: LockMode;
  readonly rank: number;
  refs: number;
  /** The tasks holding a reference, with each one's count. */
  readonly owners: Map<LockTaskFrame, number>;
  /** Settles once the OS lock is held. */
  readonly ready: Promise<Deno.FsFile | null>;
  /** The open, locked file once `ready` settled — `null` on a filesystem without locking. */
  file?: Deno.FsFile | null;
}

/** Every lock file this process holds (or is acquiring), by absolute path. */
const held = new Map<string, Held>();

/** A task waiting for other tasks' holds on a lock file to end. */
interface Waiter {
  readonly mode: LockMode;
  /** Takes the lock for the waiter, synchronously, once it is its turn. */
  readonly admit: () => void;
}

/** Each lock file's in-process queue, first come first served, by absolute path. */
const waiting = new Map<string, Waiter[]>();

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

/** The highest rank `task` holds, itself or through the tasks it was started in, or -1. */
function highestHeldRank(task: LockTaskFrame): number {
  const chain = new Set<LockTaskFrame>();
  for (let t: LockTaskFrame | undefined = task; t; t = t.parent) chain.add(t);
  let max = -1;
  for (const h of held.values()) {
    if (h.rank > max && [...h.owners.keys()].some((o) => chain.has(o))) max = h.rank;
  }
  return max;
}

/** Whether `task`, or a task it was started in, holds a reference to `entry` (a re-entry). */
function heldByTask(entry: Held, task: LockTaskFrame): boolean {
  for (let t: LockTaskFrame | undefined = task; t; t = t.parent) {
    if (entry.owners.has(t)) return true;
  }
  return false;
}

/** Whether holds in `a` and `b` exclude each other (anything but two shared ones). */
function conflicts(a: LockMode, b: LockMode): boolean {
  return a === "exclusive" || b === "exclusive";
}

/** Whether a new holder (not a re-entry) of `key` in `mode` must wait for its turn. */
function mustWait(key: string, mode: LockMode): boolean {
  if (waiting.has(key)) return true; // behind the tasks already waiting
  const entry = held.get(key);
  return entry !== undefined && conflicts(entry.mode, mode);
}

/** Give `key` to the waiters at the head of its queue that its holds now admit. */
function admitWaiters(key: string): void {
  const queue = waiting.get(key);
  if (!queue) return;
  while (queue.length > 0) {
    const entry = held.get(key);
    if (entry && conflicts(entry.mode, queue[0].mode)) break;
    queue.shift()!.admit(); // synchronous: the next one sees the hold it took
  }
  if (queue.length === 0) waiting.delete(key);
}

/** Take a new reference to `key` for `task`: join the compatible hold, or start locking. */
function claim(key: string, opts: FileLockOptions, task: LockTaskFrame): Held {
  const existing = held.get(key);
  if (existing) {
    existing.refs++;
    addOwner(existing, task);
    return existing;
  }
  const entry: Held = {
    mode: opts.mode,
    rank: opts.rank,
    refs: 1,
    owners: new Map([[task, 1]]),
    ready: lockFile(key, opts),
  };
  held.set(key, entry);
  return entry;
}

/** Wait for `task`'s turn on `key` (other tasks' conflicting holds and earlier waiters first). */
function turn(key: string, opts: FileLockOptions, task: LockTaskFrame): Promise<Held> {
  const { promise, resolve } = Promise.withResolvers<Held>();
  const queue = waiting.get(key) ?? [];
  queue.push({ mode: opts.mode, admit: () => resolve(claim(key, opts, task)) });
  waiting.set(key, queue);
  return promise;
}

/** Wait for the OS lock behind `task`'s reference to `entry`; a failure drops the reference. */
async function settle(key: string, entry: Held, task: LockTaskFrame): Promise<FileLock> {
  try {
    entry.file = await entry.ready;
  } catch (err) {
    entry.refs--;
    dropOwner(entry, task);
    // The lock never came: forget it (every reference fails with it) and let the next one try.
    if (held.get(key) === entry) {
      held.delete(key);
      admitWaiters(key);
    }
    throw err;
  }
  return handle(key, entry, task);
}

function addOwner(entry: Held, task: LockTaskFrame): void {
  entry.owners.set(task, (entry.owners.get(task) ?? 0) + 1);
}

function dropOwner(entry: Held, task: LockTaskFrame): void {
  const n = (entry.owners.get(task) ?? 0) - 1;
  if (n > 0) entry.owners.set(task, n);
  else entry.owners.delete(task);
}

function handle(path: string, entry: Held, task: LockTaskFrame): FileLock {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    dropOwner(entry, task);
    if (--entry.refs > 0) return;
    if (held.get(path) === entry) held.delete(path);
    const file = entry.file;
    if (file) {
      try {
        file.unlockSync();
      } catch { /* closing releases it anyway */ }
      try {
        file.close();
      } catch { /* already closed */ }
    }
    admitWaiters(path);
  };
  return { path, mode: entry.mode, release, [Symbol.dispose]: release };
}

/**
 * Acquire an OS advisory lock on `path` (created, with its directory, when missing). Tries
 * first; when the lock is held elsewhere, prints one Blocking line and waits. The lock counts
 * against the running {@linkcode lockTask} (the process's root task outside one) for the rank
 * order.
 *
 * Inside the process, the hold belongs to that task. The task and the work it started (a
 * subtask, a timer, a detached promise) re-enter it: a reference count, at once. Any other task
 * waits its turn, first come first served, while either hold is exclusive (shared holds of
 * several tasks coexist): the OS lock only keeps other processes out. So a task holding a lock
 * must never await work started outside it (a sibling task, a memoized promise another task
 * created) that takes the same lock: each would wait for the other, forever. Code outside every
 * task is the root task, which every task was started in: a lock it holds is re-entered by all.
 *
 * @param path The lock file.
 * @param opts Mode, description, rank.
 * @returns The held lock.
 * @throws When the acquisition would break the rank order (a lower rank than the running task
 *   holds), or upgrade a shared lock the running task holds.
 */
export async function acquireFileLock(path: string, opts: FileLockOptions): Promise<FileLock> {
  const key = resolve(path);
  const task = currentTask();
  const existing = held.get(key);
  if (existing && heldByTask(existing, task)) {
    if (existing.mode === "shared" && opts.mode === "exclusive") {
      throw new Error(
        `denext: this process holds a shared lock on ${opts.description} and asked for an ` +
          `exclusive one (release it first; locks are not upgraded in place)`,
      );
    }
    return await settle(key, claim(key, opts, task), task);
  }
  // A new hold for this task (it may wait, even to join another task's shared hold): in order.
  const top = highestHeldRank(task);
  if (opts.rank < top) {
    throw new Error(
      `denext: lock order violation — ${opts.description} (rank ${opts.rank}) requested while ` +
        `holding a rank-${top} lock`,
    );
  }
  const entry = mustWait(key, opts.mode) ? await turn(key, opts, task) : claim(key, opts, task);
  return await settle(key, entry, task);
}

/** Several locks released as one (in reverse acquisition order). */
export function lockGroup(locks: readonly FileLock[]): Disposable & { release(): void } {
  const release = () => {
    for (const lock of [...locks].reverse()) lock.release();
  };
  return { release, [Symbol.dispose]: release };
}
