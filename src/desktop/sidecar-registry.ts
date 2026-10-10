/**
 * The running app's sidecars, as the parts of the desktop runtime that end the app reach them:
 * the full-app updater stops them before it installs an update, and the process's `unload` (any
 * `Deno.exit`) ends program sidecars. Kept tiny and dependency-free so `app-updater.ts` imports it
 * without the sidecar host.
 *
 * Runtime-only.
 *
 * @module
 */

/** How the host ends its sidecars: `kill` now (synchronously), `stop` gracefully. */
interface SidecarStopper {
  readonly kill: () => void;
  readonly stop: () => Promise<void>;
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
      globalThis.addEventListener("unload", () => killSidecarsNow());
    } catch { /* no unload event here */ }
  }
  return () => stoppers.delete(stopper);
}

/** End every registered sidecar now: before a full-app update is installed, and at exit. */
export function killSidecarsNow(): void {
  for (const s of stoppers) {
    try {
      s.kill();
    } catch { /* keep going */ }
  }
}

/**
 * Stop every sidecar of the app gracefully (their `shutdown.graceMs`), e.g. before
 * `installAppUpdateAndRelaunch()` so a backend can finish writing first. The install itself still
 * ends whatever is left.
 *
 * @returns Once every sidecar has stopped.
 * @example
 * ```ts
 * import { stopSidecars } from "denext/desktop";
 * import { installAppUpdateAndRelaunch } from "denext/desktop/updater";
 *
 * await stopSidecars();
 * installAppUpdateAndRelaunch();
 * ```
 */
export async function stopSidecars(): Promise<void> {
  await Promise.all([...stoppers].map((s) => s.stop().catch(() => {})));
}
