// One `deno info` / `deno bundle` child at a time per process, each run with a deadline and
// retried once when it stalls.
//
// On Windows a `deno info` or `deno bundle` child sometimes never exits (no output, no CPU) while
// other Deno children run beside it; `deno test --parallel` (every test file on a thread of one
// process) and a build that crawls and bundles at once both start such children concurrently. A
// child that is alone finishes. So these children are serialized:
//
// - within one isolate by a promise chain;
// - across the isolates of one process (the test runner's threads) by an OS lock on a per-process
//   lock file in the temp directory (`Deno.FsFile.lock`: `LockFileEx` on Windows, `flock`
//   elsewhere; both conflict between two handles of one process, and the OS drops the lock when
//   the process exits). A temp directory that can't hold the file, or a filesystem that can't lock
//   it, leaves only the promise chain.
//
// A child still running after its deadline is killed ({@linkcode boundedOutput}) and started again
// once, after one line on stderr naming its pid and arguments; a second stall fails with an error
// naming both pids.
//
// A LONG-LIVED child (the esbuild service, a server a test starts) is spawned through
// {@linkcode spawnExclusive}: on Windows it takes the same turn, so it is never created while a
// `deno info` / `deno bundle` child of this process holds its pipes, and so can't inherit (and
// hold open for its whole life) the write end of that child's stdout. Elsewhere pipes are created
// close-on-exec and it spawns at once, as before.

import { join } from "@std/path";
import { exitedOutput, type PipedStreams } from "./exited-output.ts";

/** A child killed because it was still running at its deadline. */
export class ChildStallError extends Error {
  /** The killed child's pid. */
  readonly pid: number;
  /** What it wrote on stderr before it was killed. */
  readonly stderr: string;
  /**
   * @param label The command, e.g. `deno info`.
   * @param pid The killed child's pid.
   * @param deadlineMs The deadline it overran.
   * @param stderr What it wrote on stderr.
   */
  constructor(label: string, pid: number, deadlineMs: number, stderr: string) {
    super(
      `${label} (pid ${pid}) was still running after ${deadlineMs / 1000} s and was killed:\n` +
        stderr,
    );
    this.name = "ChildStallError";
    this.pid = pid;
    this.stderr = stderr;
  }
}

/**
 * `child`'s output, read until it exits ({@linkcode exitedOutput}); a child still running after
 * `deadlineMs` is killed and {@linkcode ChildStallError} thrown.
 *
 * @param child A spawned child.
 * @param piped Which of its output streams were spawned `"piped"`.
 * @param deadlineMs How long it may run.
 * @param label The command, for the error.
 * @returns The child's {@linkcode Deno.CommandOutput}.
 */
export async function boundedOutput(
  child: Deno.ChildProcess,
  piped: PipedStreams,
  deadlineMs: number,
  label: string,
): Promise<Deno.CommandOutput> {
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    try {
      child.kill("SIGKILL");
    } catch { /* it exited meanwhile */ }
  }, deadlineMs);
  try {
    const out = await exitedOutput(child, piped);
    if (killed) {
      const stderr = piped.stderr ? new TextDecoder().decode(out.stderr) : "";
      throw new ChildStallError(label, child.pid, deadlineMs, stderr);
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** The tail of this isolate's queue: settles when the last queued child's turn is over. */
let tail: Promise<unknown> = Promise.resolve();

/** Turns taken so far in this isolate (tests). */
let turns = 0;

/** How many children {@linkcode serialChild} has run in this isolate (tests). */
export function serialChildTurns(): number {
  return turns;
}

function tempDir(): string | undefined {
  try {
    return Deno.env.get("TMPDIR") || Deno.env.get("TEMP") || Deno.env.get("TMP") ||
      (Deno.build.os === "windows" ? undefined : "/tmp");
  } catch {
    return undefined; // no env permission: the promise chain alone
  }
}

/** The per-process lock file, or `undefined` when there is no temp directory to put it in. */
function lockPath(): string | undefined {
  const dir = tempDir();
  return dir ? join(dir, `denext-deno-child-${Deno.pid}.lock`) : undefined;
}

/** The process-wide lock, held open; `null` when it can't be had (then the chain alone holds). */
async function lockProcess(): Promise<Deno.FsFile | null> {
  const path = lockPath();
  if (!path) return null;
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { create: true, write: true });
  } catch {
    return null;
  }
  try {
    await file.lock(true);
    return file;
  } catch {
    file.close();
    return null;
  }
}

/**
 * Run `fn` once no other child queued in this process is running, holding the turn until it
 * settles. Turns go in call order within an isolate.
 *
 * @param fn Starts the child and reads it to its end.
 * @returns What `fn` returns.
 */
export function serialChild<T>(fn: () => Promise<T>): Promise<T> {
  return takeTurn(fn, true);
}

/** {@linkcode serialChild}'s turn; `count` adds it to {@linkcode serialChildTurns}. */
function takeTurn<T>(fn: () => Promise<T>, count: boolean): Promise<T> {
  const run = tail.then(async () => {
    if (count) turns++;
    const lock = await lockProcess();
    try {
      return await fn();
    } finally {
      if (lock) {
        try {
          await lock.unlock();
        } catch { /* closing drops it too */ }
        lock.close();
      }
    }
  });
  tail = run.catch(() => {});
  return run;
}

/**
 * Spawn a long-lived child: `spawn` (which starts it synchronously and returns it) runs, on
 * Windows, inside a {@linkcode serialChild} turn of this process — never while a `deno info` /
 * `deno bundle` child of this process is running, whose pipe handles a child created meanwhile
 * would inherit and hold open. The turn ends as soon as `spawn` returns. On other systems (pipes
 * are close-on-exec there) `spawn` runs at once, unchanged.
 *
 * @param spawn Starts the child.
 * @param os The system (default `Deno.build.os`; tests pass one).
 * @returns What `spawn` returned.
 */
export async function spawnExclusive<T>(
  spawn: () => T,
  os: typeof Deno.build.os = Deno.build.os,
): Promise<T> {
  if (os !== "windows") return spawn();
  return await takeTurn(() => Promise.resolve().then(spawn), false);
}

function writeStderr(line: string): void {
  try {
    Deno.stderr.writeSync(new TextEncoder().encode(`${line}\n`));
  } catch { /* stderr closed */ }
}

/**
 * Run `attempt` (one child to its end, under `deadlineMs`) in its {@linkcode serialChild} turn;
 * when it stalls ({@linkcode ChildStallError}), print one line naming the pid and `args` and run
 * it once more. A second stall throws an error naming both pids.
 *
 * @param label The command, e.g. `deno info`.
 * @param args Its arguments, for the stall line.
 * @param attempt Runs the child once, killing it at `deadlineMs`.
 * @param deadlineMs Each attempt's deadline.
 * @param onStall Where the stall line goes (default: stderr).
 * @returns What the successful attempt returns.
 */
export function retryOnStall<T>(
  label: string,
  args: readonly string[],
  attempt: (deadlineMs: number) => Promise<T>,
  deadlineMs: number,
  onStall: (line: string) => void = writeStderr,
): Promise<T> {
  return serialChild(async () => {
    try {
      return await attempt(deadlineMs);
    } catch (err) {
      if (!(err instanceof ChildStallError)) throw err;
      onStall(
        `    warning: ${label} (pid ${err.pid}) was still running after ${deadlineMs / 1000} s ` +
          `and was killed; retrying once: ${label} ${args.join(" ")}`,
      );
      try {
        return await attempt(deadlineMs);
      } catch (again) {
        if (!(again instanceof ChildStallError)) throw again;
        throw new ChildStallError(
          `${label} (stalled twice; first pid ${err.pid})`,
          again.pid,
          deadlineMs,
          again.stderr,
        );
      }
    }
  });
}
