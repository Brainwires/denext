// When Loopy's browser goes away with Loopy. Chrome is a separate process, so nothing ends it but
// Loopy itself:
//
// - desktop: the tray's Quit (Loopy's own item: it kills Chrome, then quits the app), the page's
//   Quit (the runtime's `beforequit`), and `unload` as the last resort;
// - dev server: one toolset per process, kept on `globalThis` so a hot reload of the route reuses
//   it (a newer toolset version replaces it and closes the old Chrome), and Ctrl-C / SIGTERM kill
//   Chrome before the server stops.
//
// Every runtime API is injected, so all of it is unit-tested.

import type { Toolset } from "./toolset.ts";

/** Adds and removes signal listeners (`Deno.addSignalListener` / `removeSignalListener`). */
export interface SignalDeps {
  readonly signals: readonly Deno.Signal[];
  readonly add: (signal: Deno.Signal, handler: () => void) => void;
  readonly remove: (signal: Deno.Signal, handler: () => void) => void;
  /** Deliver `signal` again once this handler is gone, so the process stops as it would have. */
  readonly resend: (signal: Deno.Signal) => void;
}

/** The termination signals of this OS. */
const SIGNALS: readonly Deno.Signal[] = Deno.build.os === "windows"
  ? ["SIGINT", "SIGBREAK"]
  : ["SIGINT", "SIGTERM"];

/** The real signal API (on Windows a signal can't be re-sent, so the process exits). */
const denoSignals: SignalDeps = {
  signals: SIGNALS,
  add: (s, h) => Deno.addSignalListener(s, h),
  remove: (s, h) => Deno.removeSignalListener(s, h),
  resend: (s) => Deno.build.os === "windows" ? Deno.exit(130) : Deno.kill(Deno.pid, s),
};

/**
 * On the first termination signal: run `kill`, stop listening, and let the signal take its course
 * (it is delivered again with this handler gone).
 *
 * @returns Stops listening.
 */
export function installSignalCleanup(kill: () => void, deps: SignalDeps = denoSignals): () => void {
  const uninstall = () => {
    for (const s of deps.signals) {
      try {
        deps.remove(s, handlers.get(s)!);
      } catch { /* not installed */ }
    }
  };
  const handlers = new Map(deps.signals.map((s) => [s, () => {
    kill();
    uninstall();
    deps.resend(s);
  }]));
  for (const [s, h] of handlers) {
    try {
      deps.add(s, h);
    } catch { /* unsupported here */ }
  }
  return uninstall;
}

/** Where the dev server's toolset is kept across hot reloads. */
const SHARED = Symbol.for("denext.examples.loopy.toolset");

/** The version of the shared toolset's shape: a newer one replaces an older one. */
export const SHARED_TOOLSET_VERSION = 2;

/** What {@linkcode sharedToolset} keeps. */
interface Shared {
  readonly version: number;
  readonly toolset: Toolset;
  readonly uninstall: () => void;
}

/**
 * The process's one toolset, created on first use: reused while its version matches (a hot reload
 * of the route), else the old one's Chrome is killed and closed and a new one takes its place.
 * Ctrl-C and SIGTERM kill the current one's Chrome.
 *
 * @param create Makes a toolset.
 * @param holder Where it is kept (default `globalThis`).
 * @param signals The signal API (tests pass a fake).
 */
export function sharedToolset(
  create: () => Toolset,
  holder: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>,
  signals?: SignalDeps,
  version: number = SHARED_TOOLSET_VERSION,
): Toolset {
  const kept = holder[SHARED] as Shared | undefined;
  if (kept?.version === version) return kept.toolset;
  if (kept) {
    kept.uninstall();
    kept.toolset.killBrowser();
    void kept.toolset.close().catch(() => {});
  }
  const toolset = create();
  const uninstall = installSignalCleanup(() => toolset.killBrowser(), signals);
  holder[SHARED] = { version, toolset, uninstall } satisfies Shared;
  return toolset;
}

/** The part of `Deno.desktop` (denext's pinned runtime) quitting uses. */
export interface QuitApi {
  addEventListener?(type: string, listener: (event: Event) => void): void;
  /** Electron's `app.quit()`; true when the app is quitting. */
  quit?(): boolean;
}

/**
 * Kill Chrome whenever the app quits: the runtime's `beforequit` (the page's Quit, `quitApp()`)
 * and `unload` (any other exit).
 *
 * @param kill Kills Chrome, synchronously.
 * @param app `Deno.desktop`, when the runtime has it.
 * @param target Where `unload` fires (default `globalThis`).
 */
export function installQuitCleanup(
  kill: () => void,
  app: QuitApi | undefined,
  target: Pick<EventTarget, "addEventListener"> = globalThis,
): void {
  app?.addEventListener?.("beforequit", () => kill());
  target.addEventListener("unload", () => kill());
}

/**
 * Quit Loopy: kill Chrome first, then quit the app through the runtime, or end the process where
 * the runtime has no quit.
 */
export function quitLoopy(
  kill: () => void,
  app: QuitApi | undefined,
  exit: (code: number) => void = Deno.exit,
): void {
  kill();
  if (typeof app?.quit === "function") app.quit();
  else exit(0);
}

/** The tray's items (denext.config.ts `desktop.tray.menu`). */
export interface TrayActions {
  readonly show: () => void;
  readonly hide: () => void;
  readonly quit: () => void;
}

/** Run the tray item `id`. */
export function trayAction(id: string, actions: TrayActions): void {
  if (id === "show") actions.show();
  else if (id === "hide") actions.hide();
  else if (id === "quit") actions.quit();
}
