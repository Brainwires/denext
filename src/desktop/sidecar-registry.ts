/**
 * The running app's sidecars, as the parts of the desktop runtime that end the app reach them:
 * the full-app updater stops them before it installs an update (detached ones too, but those with
 * `keepAcrossUpdates` or a `version`, which an update lets go on macOS and Linux), and the
 * process's `unload` (any `Deno.exit`) ends program sidecars and lets detached ones go, still
 * running. Kept tiny and dependency-free so `app-updater.ts` imports it
 * without the sidecar host.
 *
 * Runtime-only.
 *
 * @module
 */

/**
 * Why the app ends its sidecars now: `"exit"` (the process ends: a detached sidecar keeps running)
 * or `"update"` (a full-app update replaces the binary: detached sidecars are stopped too, but one
 * that survives updates, `keepAcrossUpdates` or a `version`, on macOS and Linux).
 */
export type SidecarKillReason = "exit" | "update";

/** Options for {@linkcode stopSidecars}. */
export interface StopSidecarsOptions {
  /**
   * Stop them for a full-app update: a detached sidecar that survives updates
   * (`detached.keepAcrossUpdates` or `detached.version`, on macOS and Linux) is let go running
   * instead of stopped, as `installAppUpdateAndRelaunch()` does. Default `false`: everything stops.
   */
  readonly forUpdate?: boolean;
}

/** How the host ends its sidecars: `kill` now (synchronously), `stop` gracefully. */
interface SidecarStopper {
  readonly kill: (reason: SidecarKillReason) => void;
  readonly stop: (options?: StopSidecarsOptions) => Promise<void>;
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
 * sidecars are asked to stop too, but those that survive updates) and at exit (`"exit"`: detached
 * sidecars are let go, running).
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
 * Stop every sidecar of the app gracefully (their `shutdown.graceMs`), e.g. before
 * `installAppUpdateAndRelaunch()` so a backend can finish writing first. The install itself still
 * ends whatever is left. Detached sidecars (`detached: true`) are stopped too, their processes
 * ended and their registry records removed; with `{ forUpdate: true }` one that survives updates
 * (`keepAcrossUpdates` or a `version`, on macOS and Linux) is let go running instead, as the
 * install itself does.
 *
 * @param options `forUpdate`: stop them as an update does.
 * @returns Once every sidecar has stopped (or been let go).
 * @example
 * ```ts
 * import { stopSidecars } from "denext/desktop";
 * import { installAppUpdateAndRelaunch } from "denext/desktop/updater";
 *
 * await stopSidecars({ forUpdate: true });
 * installAppUpdateAndRelaunch();
 * ```
 */
export async function stopSidecars(options: StopSidecarsOptions = {}): Promise<void> {
  await Promise.all([...stoppers].map((s) => s.stop(options).catch(() => {})));
}
