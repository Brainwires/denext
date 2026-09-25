// Shared dev-server attach orchestration for the `denext desktop dev` and `denext mobile dev`
// verbs (the "Metro model"): start (or attach to) a `denext dev` server, spawn child processes,
// and wait for a shutdown signal. Both verbs drove identical copies of this; extracting it here
// keeps their behaviour byte-for-byte while the verb-specific parts (the desktop window / proxy
// env seam, the Capacitor config edit + restore-on-exit) stay in their own modules.
//
// These are CLI-layer concerns (spawning `denext dev` as a subprocess, trapping SIGINT/SIGTERM),
// so they live beside the other command helpers rather than in `src/build`. The injectable cores
// (`runDesktopDev` / `runMobileDev`) take the results below through their `deps`, so tests still
// never spawn a real server or process.

import { denoExecutable } from "../build/bundle.ts";
import { cliInvocation } from "../ui/proc.ts";
import { SHUTDOWN_SIGNALS } from "./shared.ts";

/**
 * A `denext dev` server a verb started or attached to. Structurally identical to (and assignable
 * to) both `MobileDevServer` and `DesktopDevServer`, which the injectable cores consume.
 */
export interface DevServerHandle {
  /** The URL a client loads / proxies to (`http://localhost:3000`). */
  readonly url: string;
  /** True when a server was already answering there (it is left running on exit). */
  readonly attached: boolean;
  /** Resolves when the server ends by itself. */
  readonly finished: Promise<void>;
  /** Stop the server (a no-op for an attached one). */
  stop(): Promise<void>;
}

/** A spawned child process reduced to `{ finished, stop }`, plus a synchronous exit probe. */
export interface SpawnedChild {
  /** Resolves when the child exits (closed, or killed). */
  readonly finished: Promise<void>;
  /** SIGTERM the child and await its exit. */
  stop(): Promise<void>;
  /** Whether the child has already exited (for a poll loop). */
  hasExited(): boolean;
}

/** Whether anything answers HTTP at `url` within a second. */
async function answersHttp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1000), redirect: "manual" });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn `deno <args>` in `cwd` (inheriting stdout/stderr), reduced to `{ finished, stop }`.
 * `stop` sends SIGTERM and awaits exit; a child already gone is ignored. `finished` resolves on
 * exit, and `hasExited()` reports it synchronously for a poll loop.
 *
 * @param args The `deno` arguments (e.g. `["dev", project, …]` or `["desktop", entry]`).
 * @param opts The child's cwd, stdin disposition, and any extra env.
 */
export function spawnDenoChild(
  args: string[],
  opts: { cwd: string; stdin: "null" | "inherit"; env?: Record<string, string> },
): SpawnedChild {
  const child = new Deno.Command(denoExecutable(), {
    args,
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  let exited = false;
  const finished = child.status.then(() => void (exited = true));
  const stop = async () => {
    try {
      child.kill("SIGTERM");
    } catch { /* already gone */ }
    await child.status;
  };
  return { finished, stop, hasExited: () => exited };
}

/**
 * Start `denext dev` for the project on the target host and port (strict, so the URL is known),
 * or attach to a server already answering there. Polls until it answers. An attached server's
 * `stop` is a no-op, so the caller's core leaves it running.
 *
 * @param project The project directory (the child's cwd, and the `denext dev` positional).
 * @param host The host to bind and proxy to.
 * @param url The full dev-server URL (its port is the `--port`).
 * @throws {Error} When the spawned server neither answers within 120s nor exits.
 */
export async function startOrAttachDevServer(
  project: string,
  host: string,
  url: string,
): Promise<DevServerHandle> {
  const port = new URL(url).port;
  if (await answersHttp(url)) {
    return { url, attached: true, finished: new Promise(() => {}), stop: () => Promise.resolve() };
  }
  const { finished, stop, hasExited } = spawnDenoChild(
    [...cliInvocation({ dir: project }), "dev", project, "--host", host, "--port", port],
    { cwd: project, stdin: "null" },
  );
  for (const deadline = Date.now() + 120_000; !(await answersHttp(url));) {
    if (hasExited() || Date.now() > deadline) {
      await stop();
      throw new Error(`the dev server did not come up at ${url}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { url, attached: false, finished, stop };
}

/** Resolves on the first Ctrl-C / SIGTERM (and stops listening). */
export function waitForShutdownSignal(): Promise<void> {
  return new Promise((done) => {
    const handler = () => {
      for (const signal of SHUTDOWN_SIGNALS) Deno.removeSignalListener(signal, handler);
      done();
    };
    for (const signal of SHUTDOWN_SIGNALS) Deno.addSignalListener(signal, handler);
  });
}
