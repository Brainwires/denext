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
//     published answers as a denext dev server AND says it is the one the file describes: the
//     same pid, serving this project. A 200 alone proves only that a port is busy — after pid
//     reuse the port can belong to a new dev server (a different project's, say) while the pid
//     belongs to something else entirely.
//   * ORPHANED CHILDREN. `deno run … dev` is the parent of the process holding the port.
//     `src/profile/browser.ts` records what happens when only the parent is killed: the helper
//     is reparented and keeps running (there, pegging a core; here, holding the port, so the
//     next dev server falls forward onto a different one). Hence a graceful signal first — that
//     path drains the server and removes `dev.json` itself — and the tree only as a fallback.
//
// And one the file itself poses: it is project content. A clone can commit one naming `-1`
// (every process the caller may signal) or the UI's own pid. `readDevInfo` refuses anything but
// a plausible pid, and this module never signals its own process or its parent whatever the
// file says.

import { join } from "@std/path";
import { type DevInfo, type DevStateResponse, readDevInfo } from "../mcp/dev-client.ts";

/** How long a liveness probe waits before calling the published origin dead. */
const PROBE_MS = 700;

/** How long the graceful signal is given to drain the server before the tree is killed. */
const GRACE_MS = 4000;

/** How often the graceful wait re-checks whether the server has gone. */
const POLL_MS = 150;

/**
 * The endpoint only a denext dev server answers — the identity half of the liveness check. A
 * copy of the VALUE (`src/build/dev-server/state.ts`'s `DEV_STATE_PATH`), not an import: this
 * module graph must never reach the bundler.
 */
const DEV_STATE_PATH = "/_denext/dev-state";

/** Why a stop did not happen, or how it did. */
export type StopStatus =
  | "stopped"
  | "not-running"
  | "stale"
  | "mismatch"
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
 * What the origin a `dev.json` published says about itself: the `pid` and `projectDir` fields of
 * `/_denext/dev-state`, as received (`unknown`, because the answer is whatever listens there).
 */
export interface DevIdentity {
  /** The answering server's process id, when it published one. */
  readonly pid: unknown;
  /** The project directory it serves, when it published one. */
  readonly projectDir: unknown;
}

/**
 * The process-touching edges of {@linkcode stopDevServer}, replaceable so a test can drive the
 * graceful, hard and mismatch paths without a dev server and observe every signal that would
 * have been sent. The defaults are the real thing.
 */
export interface StopDevServerDeps {
  /** Ask the published origin who it is: `null` when nothing (denext) answers. */
  readonly probe?: (info: DevInfo) => Promise<DevIdentity | null>;
  /** Deliver one signal; throws when the process is already gone (`Deno.kill`'s contract). */
  readonly kill?: (pid: number, signal: Deno.Signal) => void;
  /** Run the tree-kill helper, `[program, ...args]`, never shell-interpreted. */
  readonly run?: (argv: string[]) => Promise<void>;
  /** The platform (defaults to the host). */
  readonly os?: typeof Deno.build.os;
  /** The pids that are never signalled whatever the file says: this process and its parent. */
  readonly self?: readonly number[];
  /** How long the graceful signal is given to drain, in milliseconds. */
  readonly graceMs?: number;
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
 * Ask the origin a `dev.json` published who it is.
 *
 * `/_denext/dev-state` is the identity half of the liveness check: only a denext dev server
 * answers it, and it answers with the server's own `pid` and `projectDir`. A 200 that carries
 * neither (something else listening, an older dev server) is still an answer — it is
 * {@linkcode identityMatches} that then refuses to treat it as the server the file describes.
 *
 * @param info The published dev-server info.
 * @returns What answered, or `null` when nothing did.
 */
async function probeDevState(info: DevInfo): Promise<DevIdentity | null> {
  try {
    const response = await fetch(`${info.origin}${DEV_STATE_PATH}?limit=1`, {
      signal: AbortSignal.timeout(PROBE_MS),
    });
    if (!response.ok) {
      // The body is not needed, but an unread body keeps the connection (and the op) alive.
      await response.body?.cancel();
      return null;
    }
    const body = await response.json().catch(() => ({})) as Partial<DevStateResponse>;
    return { pid: body.pid, projectDir: body.projectDir };
  } catch {
    return null;
  }
}

/**
 * Whether the server that answered is the one `dev.json` describes, serving this project: the
 * pid it reports is the pid the file names, and its project directory is `dir` (realpath, so a
 * symlinked or `/private/tmp`-style spelling of the same directory still matches).
 *
 * @param identity What the origin said about itself.
 * @param info The published dev-server info.
 * @param dir The project directory the UI manages.
 * @returns True only when both halves match.
 */
async function identityMatches(
  identity: DevIdentity,
  info: DevInfo,
  dir: string,
): Promise<boolean> {
  if (identity.pid !== info.pid || typeof identity.projectDir !== "string") return false;
  try {
    return await Deno.realPath(identity.projectDir) === await Deno.realPath(dir);
  } catch {
    return false; // one of the two no longer exists — nothing to prove they are the same
  }
}

/**
 * Stop the dev server a project published, if one is really running.
 *
 * The sequence is deliberate: discover, prove it is alive AND the server the file describes,
 * ask it to drain, wait, and only then kill the tree. A stale `dev.json` is cleaned up rather
 * than acted on, so the panel stops claiming a server is running when nothing is; a `dev.json`
 * whose origin answers as some *other* server is neither acted on nor cleaned up — it is not
 * this operation's to remove, and the pid it names is not this operation's to signal.
 *
 * @param dir The project directory.
 * @param deps The process-touching edges (tests replace them; see {@linkcode StopDevServerDeps}).
 * @returns What happened, ready to show.
 */
export async function stopDevServer(
  dir: string,
  deps: StopDevServerDeps = {},
): Promise<StopOutcome> {
  const info = await readDevInfo(dir);
  if (info === null) {
    return { status: "not-running", message: "No dev server is running." };
  }
  const self = deps.self ?? [Deno.pid, Deno.ppid];
  if (self.includes(info.pid)) {
    // A planted file naming the UI (or the terminal it runs in) — never ours to signal.
    return {
      status: "mismatch",
      message: `.denext/dev.json names pid ${info.pid}, which is this UI's own process, not ` +
        "a dev server; not stopping it.",
    };
  }
  const probe = deps.probe ?? probeDevState;
  const identity = await probe(info);
  if (identity === null) {
    // The file outlived the server. Removing it is the whole fix — and it is why the pid is
    // never signalled here: by now it may belong to something else entirely.
    await removeDevInfo(dir);
    return {
      status: "stale",
      message: `No dev server is answering at ${info.origin} — cleared the stale ` +
        ".denext/dev.json it left behind.",
    };
  }
  if (!await identityMatches(identity, info, dir)) {
    return {
      status: "mismatch",
      message: `A different dev server answers at ${info.origin} (not pid ${info.pid} serving ` +
        "this project); not stopping it.",
    };
  }
  const edges = {
    kill: deps.kill ?? Deno.kill,
    run: deps.run ?? run,
    probe,
    graceMs: deps.graceMs ?? GRACE_MS,
  };
  const signal = gracefulSignal(deps.os);
  if (
    signal !== null && kill(edges.kill, info.pid, signal) && await goneWithin(edges, info, dir)
  ) {
    return { status: "stopped", message: `Stopped the dev server at ${info.origin}.` };
  }
  return await hardStop(edges, info, dir, signal === null, deps.os);
}

/** The resolved edges the stop runs through once the server has proven who it is. */
interface StopEdges {
  readonly kill: NonNullable<StopDevServerDeps["kill"]>;
  readonly run: NonNullable<StopDevServerDeps["run"]>;
  readonly probe: NonNullable<StopDevServerDeps["probe"]>;
  readonly graceMs: number;
}

/**
 * The fallback: kill the process tree, then confirm the port was actually released.
 *
 * @param edges The resolved process edges.
 * @param info The published dev-server info.
 * @param dir The project directory.
 * @param straightToKill Whether the platform had no graceful signal to try first.
 * @param os The platform (defaults to the host).
 * @returns What happened.
 */
async function hardStop(
  edges: StopEdges,
  info: DevInfo,
  dir: string,
  straightToKill: boolean,
  os?: typeof Deno.build.os,
): Promise<StopOutcome> {
  const argv = treeKillCommand(info.pid, os);
  if (argv === null) {
    return {
      status: "unsupported",
      message: `Could not stop the dev server at ${info.origin}: this platform has no known ` +
        `way to stop it. Stop pid ${info.pid} yourself.`,
    };
  }
  await edges.run(argv);
  kill(edges.kill, info.pid, "SIGKILL");
  if (!await goneWithin(edges, info, dir)) {
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
 * @param deliver The signal edge (`Deno.kill`, or a test's recorder).
 * @param pid The process id.
 * @param signal The signal.
 * @returns True when the signal was delivered (false when the process was already gone).
 */
function kill(deliver: StopEdges["kill"], pid: number, signal: Deno.Signal): boolean {
  try {
    deliver(pid, signal);
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
 * Wait for the dev server to stop answering as itself.
 *
 * "Gone" is anything but the server that was signalled: nothing on the port, or — should the
 * port already have been taken by another server — something that is not it.
 *
 * @param edges The resolved process edges (the probe and the grace budget).
 * @param info The published dev-server info.
 * @param dir The project directory.
 * @returns True when it stopped answering within the budget.
 */
async function goneWithin(edges: StopEdges, info: DevInfo, dir: string): Promise<boolean> {
  const deadline = Date.now() + edges.graceMs;
  const stillOurs = async () => {
    const identity = await edges.probe(info);
    return identity !== null && await identityMatches(identity, info, dir);
  };
  while (Date.now() < deadline) {
    if (!await stillOurs()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return !await stillOurs();
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
