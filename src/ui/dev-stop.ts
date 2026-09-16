// Stop a running `denext dev`, found through the address it published.
//
// The UI never holds the child's handle. `runDeno` hands the process an abort signal and
// returns only its outcome, and a UI that was restarted never spawned the child in the first
// place. What both cases have is `.denext/dev.json`, which the dev server writes with its own
// pid — so "stop the dev server" is one operation regardless of who started it, and it is why
// the handle surviving a UI restart needs no detached process to survive with it.
//
// Two hazards shape the order of what follows, both documented elsewhere in this tree:
//
//   * PID REUSE. A stale `dev.json` (a server killed without draining) names a pid the OS is
//     free to have reassigned. Signalling a pid read from a file, with nothing else checked, is
//     how an unrelated process gets killed. So nothing is signalled until the origin that file
//     published answers as a denext dev server.
//   * ORPHANED CHILDREN. `deno run … dev` is the parent of the process holding the port.
//     `src/profile/browser.ts` records what happens when only the parent is killed: the helper
//     is reparented and keeps running (there, pegging a core; here, holding the port, so the
//     next dev server falls forward onto a different one). Hence a graceful signal first — that
//     path drains the server and removes `dev.json` itself — and the tree only as a fallback.

import { join } from "@std/path";
import { type DevInfo, readDevInfo } from "../mcp/dev-client.ts";

/** How long a liveness probe waits before calling the published origin dead. */
const PROBE_MS = 700;

/** How long the graceful signal is given to drain the server before the tree is killed. */
const GRACE_MS = 4000;

/** How often the graceful wait re-checks whether the server has gone. */
const POLL_MS = 150;

/** The endpoint only a denext dev server answers — the identity half of the liveness check. */
const DEV_STATE_PATH = "/_denext/dev-state";

/** Why a stop did not happen, or how it did. */
export type StopStatus =
  | "stopped"
  | "not-running"
  | "stale"
  | "unsupported"
  | "failed";

/** The outcome of {@linkcode stopDevServer}. */
export interface StopOutcome {
  /** What happened. */
  readonly status: StopStatus;
  /** A one-line explanation, ready to render. */
  readonly message: string;
}

/**
 * The signal that asks a dev server to drain, or `null` on a platform with no such signal.
 *
 * Windows has no `SIGTERM`: the two places this tree traps termination
 * (`src/cli/shared.ts`, `src/profile/browser.ts`) both branch to `SIGBREAK` there, and a
 * console control event cannot be delivered to an unrelated process the way a signal can. So
 * Windows has no graceful path at all and goes straight to {@linkcode treeKillCommand}, which
 * is honest about being a hard kill rather than pretending a signal was delivered.
 *
 * Pure, so the platform matrix is unit-testable without spawning anything.
 *
 * @param os The platform (defaults to the host).
 * @returns The signal, or `null` when the platform has no graceful stop.
 */
export function gracefulSignal(os: typeof Deno.build.os = Deno.build.os): Deno.Signal | null {
  return os === "windows" ? null : "SIGTERM";
}

/**
 * The command that kills a process *and its children*, as `[program, ...args]`.
 *
 * Killing the published pid alone is not enough (see the module note), so the fallback is a
 * tree kill on every platform that has one.
 *
 * Pure, so the platform matrix is unit-testable without spawning anything.
 *
 * @param pid The parent process id.
 * @param os The platform (defaults to the host).
 * @returns The argv, or `null` on a platform with no known tree kill.
 */
export function treeKillCommand(
  pid: number,
  os: typeof Deno.build.os = Deno.build.os,
): string[] | null {
  if (os === "windows") return ["taskkill", "/PID", String(pid), "/T", "/F"];
  if (os === "darwin" || os === "linux") return ["pkill", "-KILL", "-P", String(pid)];
  return null;
}

/**
 * Whether the origin a `dev.json` published is answering as a denext dev server.
 *
 * This is the PID-reuse guard: a file naming a pid proves nothing, but a denext-only endpoint
 * answering on the origin that file published proves the server it describes is still there.
 *
 * @param info The published dev-server info.
 * @returns True when the dev server answered.
 */
async function devServerAnswers(info: DevInfo): Promise<boolean> {
  try {
    const response = await fetch(`${info.origin}${DEV_STATE_PATH}`, {
      signal: AbortSignal.timeout(PROBE_MS),
    });
    // The body is not needed, but an unread body keeps the connection (and the op) alive.
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Stop the dev server a project published, if one is really running.
 *
 * The sequence is deliberate: discover, prove it is alive, ask it to drain, wait, and only then
 * kill the tree. A stale `dev.json` is cleaned up rather than acted on, so the panel stops
 * claiming a server is running when nothing is.
 *
 * @param dir The project directory.
 * @returns What happened, ready to show.
 */
export async function stopDevServer(dir: string): Promise<StopOutcome> {
  const info = await readDevInfo(dir);
  if (info === null) {
    return { status: "not-running", message: "No dev server is running." };
  }
  if (!await devServerAnswers(info)) {
    // The file outlived the server. Removing it is the whole fix — and it is why the pid is
    // never signalled here: by now it may belong to something else entirely.
    await removeDevInfo(dir);
    return {
      status: "stale",
      message: `No dev server is answering at ${info.origin} — cleared the stale ` +
        ".denext/dev.json it left behind.",
    };
  }
  const signal = gracefulSignal();
  if (signal !== null && kill(info.pid, signal) && await goneWithin(info, GRACE_MS)) {
    return { status: "stopped", message: `Stopped the dev server at ${info.origin}.` };
  }
  return await hardStop(info, dir, signal === null);
}

/**
 * The fallback: kill the process tree, then confirm the port was actually released.
 *
 * @param info The published dev-server info.
 * @param dir The project directory.
 * @param straightToKill Whether the platform had no graceful signal to try first.
 * @returns What happened.
 */
async function hardStop(
  info: DevInfo,
  dir: string,
  straightToKill: boolean,
): Promise<StopOutcome> {
  const argv = treeKillCommand(info.pid);
  if (argv === null) {
    return {
      status: "unsupported",
      message: `Could not stop the dev server at ${info.origin}: this platform has no known ` +
        `way to stop it. Stop pid ${info.pid} yourself.`,
    };
  }
  await run(argv);
  kill(info.pid, "SIGKILL");
  if (!await goneWithin(info, GRACE_MS)) {
    return {
      status: "failed",
      message: `The dev server at ${info.origin} is still answering after being stopped. ` +
        `Stop pid ${info.pid} yourself.`,
    };
  }
  // A killed server never ran its own cleanup, so the file it published is now a lie.
  await removeDevInfo(dir);
  const how = straightToKill ? " (Windows has no graceful stop, so it was killed)" : "";
  return { status: "stopped", message: `Stopped the dev server at ${info.origin}${how}.` };
}

/**
 * Send one signal, reporting whether it was delivered.
 *
 * @param pid The process id.
 * @param signal The signal.
 * @returns True when the signal was delivered (false when the process was already gone).
 */
function kill(pid: number, signal: Deno.Signal): boolean {
  try {
    Deno.kill(pid, signal);
    return true;
  } catch {
    return false; // already exited, or not ours to signal
  }
}

/**
 * Run a helper command, ignoring its exit status.
 *
 * The status is genuinely not interesting: `pkill` exits non-zero when the parent had no
 * children left to kill, which is a success for our purposes. Whether the server actually
 * stopped is decided by probing the port, never by a helper's exit code.
 *
 * @param argv The command and its arguments, never shell-interpreted.
 */
async function run(argv: string[]): Promise<void> {
  try {
    await new Deno.Command(argv[0], {
      args: argv.slice(1),
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
  } catch { /* the helper is not installed — the probe below is what decides */ }
}

/**
 * Wait for the dev server to stop answering.
 *
 * @param info The published dev-server info.
 * @param budget How long to wait, in milliseconds.
 * @returns True when it stopped answering within the budget.
 */
async function goneWithin(info: DevInfo, budget: number): Promise<boolean> {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (!await devServerAnswers(info)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return !await devServerAnswers(info);
}

/**
 * Remove a `dev.json` that no longer describes anything.
 *
 * @param dir The project directory.
 */
async function removeDevInfo(dir: string): Promise<void> {
  try {
    await Deno.remove(join(dir, ".denext", "dev.json"));
  } catch { /* already gone, or not ours to remove */ }
}
