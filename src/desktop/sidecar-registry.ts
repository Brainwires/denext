/**
 * The running app's sidecars, as the parts of the desktop runtime that end the app reach them:
 * the full-app updater stops them before it installs an update (detached ones included: the binary
 * is about to be replaced), and the process's `unload` (any `Deno.exit`) ends program sidecars and
 * lets detached ones go, still running. Kept tiny and dependency-free so `app-updater.ts` imports it
 * without the sidecar host.
 *
 * Runtime-only.
 *
 * @module
 */

/**
 * Why the app ends its sidecars now: `"exit"` (the process ends: a detached sidecar keeps running)
 * or `"update"` (a full-app update replaces the binary: detached sidecars are stopped too).
 */
export type SidecarKillReason = "exit" | "update";

/**
 * How the host ends its sidecars: `kill` now (synchronously), `stop` gracefully, `update` before a
 * full-app update (every sidecar stopped and waited for; rejects when one is still running).
 */
interface SidecarStopper {
  readonly kill: (reason: SidecarKillReason) => void;
  readonly stop: () => Promise<void>;
  readonly update?: () => Promise<void>;
}

const stoppers = new Set<SidecarStopper>();
let unloadInstalled = false;

/**
 * Register a host's sidecars (`runDesktop` does, as it starts them). The first registration also
 * ends them on the process's `unload`.
 *
 * @param stopper How to end them.
 * @returns A function that unregisters.
 */
export function registerSidecarStopper(stopper: SidecarStopper): () => void {
  stoppers.add(stopper);
  if (!unloadInstalled) {
    unloadInstalled = true;
    try {
      globalThis.addEventListener("unload", () => killSidecarsNow("exit"));
    } catch { /* no unload event here */ }
  }
  return () => stoppers.delete(stopper);
}

/**
 * End every registered sidecar now: before a full-app update is installed (`"update"`: detached
 * sidecars are asked to stop too) and at exit (`"exit"`: detached sidecars are let go, running).
 *
 * @param reason Why.
 */
export function killSidecarsNow(reason: SidecarKillReason = "exit"): void {
  for (const s of stoppers) {
    try {
      s.kill(reason);
    } catch { /* keep going */ }
  }
}

/**
 * End every registered sidecar before a full-app update is installed, and wait for them: each
 * sidecar is stopped (its `shutdown.graceMs`, then a forced kill where the app may signal
 * processes), detached ones included, their records removed. Nothing may still run the old
 * executable from the install folder when the swap starts (Windows refuses to replace files a
 * running process holds).
 *
 * @returns Once every sidecar is gone; rejects with the first sidecar that is still running.
 */
export async function endSidecarsForUpdate(): Promise<void> {
  const results = await Promise.allSettled(
    [...stoppers].map((s) => s.update ? s.update() : Promise.resolve(s.kill("update"))),
  );
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

/**
 * Stop every sidecar of the app gracefully (their `shutdown.graceMs`), e.g. before
 * `installAppUpdateAndRelaunch()` so a backend can finish writing first. The install itself also
 * stops every sidecar and waits for them before it quits. Detached sidecars (`detached: true`) are stopped too, their processes
 * ended and their registry records removed: there is one behaviour, everything stops.
 *
 * @returns Once every sidecar has stopped.
 * @example
 * ```ts
 * import { stopSidecars } from "denext/desktop";
 * import { installAppUpdateAndRelaunch } from "denext/desktop/updater";
 *
 * await stopSidecars();
 * await installAppUpdateAndRelaunch();
 * ```
 */
export async function stopSidecars(): Promise<void> {
  await Promise.all([...stoppers].map((s) => s.stop().catch(() => {})));
}
