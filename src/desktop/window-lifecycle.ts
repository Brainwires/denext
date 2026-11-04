/**
 * The window lifecycle hooks an extension (or `desktop.ts`) can take part in: a window opened, a
 * window closed for good (never a reload), the app about to quit, and a guard that can refuse a
 * quit. The static form is on a capability (`onWindowOpened` / `onWindowClosed` / `onAppQuit` in
 * {@link DesktopCapability}); the dynamic form is the {@link DesktopExtensionHost} a `setup` gets
 * (`host.onWindowOpened(fn)`, …, `host.onBeforeQuit(fn)`, `host.windows()`).
 *
 * The quit, in order:
 * 1. A quit starts (`Deno.desktop.quit()` from `quitApp()` or a tray's Quit, Cmd+Q, the OS's
 *    session end): its `beforequit` is held while the runtime-side guards ({@linkcode
 *    WindowLifecycle.onBeforeQuit}) are asked, 5 seconds for all of them (a page's deadline).
 *    A `false` cancels the quit (and asks the OS to stop a session end, `cancelQuit`); a throw or
 *    a guard past the deadline is logged and does not cancel. Then the quit is issued again.
 * 2. The runtime closes every window; a page's `onBeforeQuit` / `onCloseRequested` may hold it as
 *    before (src/desktop/caps/window.ts). Each window that closes is reported `onWindowClosed`
 *    with `appQuitting: true`.
 * 3. The last window's close is held: the pending `onWindowClosed` promises and every `onAppQuit`
 *    hook are waited for, 3 seconds together, then the quit is issued again
 *    with every consent kept and the runtime ends the process. With no window open (a tray app)
 *    step 3 happens inside step 1.
 *
 * The last app window closing without `desktop.app.keepAlive` is a quit too: `onWindowClosed`
 * gets `appQuitting: true`, the `onAppQuit` hooks run (bounded), then the process exits. Without
 * any quit hook the exit is immediate, as it always was.
 *
 * Runtime-only (imported by the window registry, never a client bundle).
 *
 * @module
 */

import type {
  DesktopCapability,
  DesktopExtensionHost,
  DesktopWindowClosedInfo,
  DesktopWindowInfo,
} from "./extension.ts";
import type { DesktopAppApi } from "./launch-events.ts";
import {
  isAppQuitting,
  isReissuingQuit,
  reissueAppQuit,
  UNRESPONSIVE_MS,
  watchAppQuit,
} from "./caps/window.ts";

/** How long every `onAppQuit` hook (and a pending `onWindowClosed`) is given together. */
const APP_QUIT_TIMEOUT_MS = 3_000;
/** How long the runtime-side `onBeforeQuit` guards are given together (a page's deadline). */
const QUIT_GUARD_TIMEOUT_MS = UNRESPONSIVE_MS;

/** A window-opened hook. */
type WindowOpenedHook = (info: DesktopWindowInfo) => void | Promise<void>;
/** A window-closed hook. */
type WindowClosedHook = (info: DesktopWindowClosedInfo) => void | Promise<void>;
/** An app-quit hook. */
type AppQuitHook = () => void | Promise<void>;
/** A before-quit guard: `false` cancels the quit. */
type BeforeQuitGuard = () => boolean | Promise<boolean>;

/** The subscription half of {@linkcode DesktopExtensionHost} (what the bridge hands a `setup`). */
export type WindowLifecycleHost = Pick<
  DesktopExtensionHost,
  "onWindowOpened" | "onWindowClosed" | "onAppQuit" | "onBeforeQuit" | "windows"
>;

/** Options for {@linkcode createWindowLifecycle}. */
export interface WindowLifecycleOptions {
  /** The runtime's app API (`Deno.desktop`): its `beforequit`, `quit` and `cancelQuit`. */
  readonly api?: DesktopAppApi;
  /** The open windows now. */
  readonly windows: () => readonly DesktopWindowInfo[];
  /** End the process. */
  readonly exit: (code: number) => void;
  /** Where hook failures and deadlines go. */
  readonly warn: (message: string) => void;
  /** Called right before the process ends or the quit is handed back to the runtime (a flush). */
  readonly beforeExit?: () => void;
  /** Called when the first quit hook is added (keep-alive follows {@linkcode WindowLifecycle.hasQuitWork}). */
  readonly onQuitWorkChanged?: () => void;
  /** The guards' deadline (default 5 s, a page's). */
  readonly guardTimeoutMs?: number;
  /** The quit hooks' deadline (default 3 s). */
  readonly quitTimeoutMs?: number;
}

/** What {@linkcode createWindowLifecycle} returns. */
export interface WindowLifecycle extends WindowLifecycleHost {
  /** Take the static hooks of these capabilities (`onWindowOpened` replayed for the open windows). */
  addCapabilities(caps: Iterable<DesktopCapability>): void;
  /** Listen for the runtime's quits (once the registry has the API). */
  install(): void;
  /** A window opened: run the opened hooks. */
  windowOpened(info: DesktopWindowInfo): void;
  /** A window closed for good: run the closed hooks (their promises kept for the quit to wait on). */
  windowClosed(info: DesktopWindowClosedInfo): void;
  /** Whether a quit has hooks to wait for (`onAppQuit`, or `onWindowClosed` promises to finish). */
  hasQuitWork(): boolean;
  /**
   * A quit's `close` reached `window` unheld by its page: `true` when the lifecycle held it (the
   * last window: its hooks run, then the quit is issued again). `hide` makes the window look
   * closed meanwhile, `closed` drops it from the registry (which reports it closed).
   */
  holdQuitClose(event: Event, last: boolean, hide: () => void, closed: () => void): boolean;
  /** The last app window closed, not by a quit: run the quit hooks (bounded), then exit. */
  endApp(): void;
}

/** The lifecycle's state. */
interface LifecycleState {
  readonly options: WindowLifecycleOptions;
  readonly opened: Set<{ fn: WindowOpenedHook; name: string }>;
  readonly closed: Set<{ fn: WindowClosedHook; name: string }>;
  readonly quit: Set<{ fn: AppQuitHook; name: string }>;
  readonly guards: Set<{ fn: BeforeQuitGuard; name: string }>;
  /** `onWindowClosed` promises not settled yet (the quit waits for them). */
  readonly pending: Set<Promise<void>>;
  /** The lifecycle itself is issuing the quit again (its `beforequit` passes). */
  releasing: boolean;
  /** The guards are being asked (a second quit meanwhile waits for their answer). */
  guarding: boolean;
  /** The quit hooks ran for the quit in progress (its last close is not held again). */
  quitHooksRan: boolean;
  /** `endApp` started (a second last-close changes nothing). */
  ending: boolean;
}

/** The message of a hook failure. */
function failure(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Call hook `fn` with `arg`: a throw is logged; a promise is returned with its rejection logged
 * (so a caller can wait for it), else `undefined`.
 */
function callHook<A>(
  st: LifecycleState,
  what: string,
  name: string,
  fn: (arg: A) => void | Promise<void>,
  arg: A,
): Promise<void> | undefined {
  try {
    const out = fn(arg);
    if (out && typeof (out as Promise<void>).then === "function") {
      return (out as Promise<void>).then(undefined, (err) => {
        st.options.warn(`${name}.${what} failed: ${failure(err)}`);
      });
    }
  } catch (err) {
    st.options.warn(`${name}.${what} failed: ${failure(err)}`);
  }
  return undefined;
}

/** `promise` or the deadline, whichever comes first; `false` when the deadline won. */
function bounded(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(() => true, () => true).then((ok) => {
      clearTimeout(timer);
      resolve(ok);
    });
  });
}

/** Run `fn` for the windows open now (a hook added late sees every window). */
function replayOpened(st: LifecycleState, name: string, fn: WindowOpenedHook): void {
  for (const info of st.options.windows()) callHook(st, "onWindowOpened", name, fn, info);
}

/** Add a hook to `set`; the unsubscribe. */
function subscribe<T>(set: Set<T>, entry: T): () => void {
  set.add(entry);
  return () => void set.delete(entry);
}

/** A quit hook or guard was added: keep-alive may change (the runtime must not end the loop first). */
function quitWorkChanged(st: LifecycleState): void {
  st.options.onQuitWorkChanged?.();
}

/**
 * Ask the guards, 5 seconds for all of them: `false` when one answered so in time; a throw, or
 * the deadline, counts as a yes (logged).
 */
async function askGuards(st: LifecycleState): Promise<boolean> {
  if (st.guards.size === 0) return true;
  const answers = [...st.guards].map(async ({ fn, name }) => {
    try {
      return (await fn()) !== false;
    } catch (err) {
      st.options.warn(`${name}.onBeforeQuit failed (the quit goes on): ${failure(err)}`);
      return true;
    }
  });
  const all = Promise.all(answers).then((list) => list.every((ok) => ok));
  const ms = st.options.guardTimeoutMs ?? QUIT_GUARD_TIMEOUT_MS;
  const inTime = await bounded(all, ms);
  if (!inTime) {
    st.options.warn(`an onBeforeQuit guard gave no answer within ${ms} ms: the quit goes on`);
    return true;
  }
  return await all;
}

/**
 * Wait for the pending `onWindowClosed` promises and run every `onAppQuit` hook, at most 3
 * seconds together; past it the exit goes on (logged).
 */
async function runQuitWork(st: LifecycleState): Promise<void> {
  const work: Promise<void>[] = [...st.pending];
  for (const { fn, name } of st.quit) {
    const p = callHook(st, "onAppQuit", name, fn, undefined);
    if (p) work.push(p);
  }
  if (work.length === 0) return;
  const ms = st.options.quitTimeoutMs ?? APP_QUIT_TIMEOUT_MS;
  const inTime = await bounded(Promise.all(work), ms);
  if (!inTime) {
    st.options.warn(`the app quits before every onAppQuit hook finished (${ms} ms)`);
  }
}

/** Issue the quit again, the pages' consents kept; `true` when the app is quitting. */
function reissue(st: LifecycleState): boolean {
  const api = st.options.api;
  if (typeof api?.quit !== "function") return false;
  st.releasing = true;
  try {
    return reissueAppQuit(api, () => api.quit!() === true);
  } finally {
    st.releasing = false;
  }
}

/** The guards' turn: a `beforequit` was held; ask them, then cancel or issue the quit again. */
async function startQuit(st: LifecycleState): Promise<void> {
  if (st.guarding) return; // the first quit's guards decide for a second one meanwhile
  st.guarding = true;
  try {
    const allowed = await askGuards(st);
    if (!allowed) {
      // A session end the OS holds for this answer is asked to stop (runtime 3.0.0-denext.8).
      st.options.api?.cancelQuit?.();
      return;
    }
    if (st.options.windows().length === 0 && hasQuitWork(st)) {
      // No close will come to hold: the quit hooks run here.
      await runQuitWork(st);
      st.quitHooksRan = true;
      st.options.beforeExit?.();
    }
    reissue(st);
  } finally {
    st.guarding = false;
  }
}

/** The runtime's `beforequit`: a new quit is held for the guards; one issued again passes. */
function onBeforeQuitEvent(st: LifecycleState, event: Event): void {
  if (st.releasing || isReissuingQuit(st.options.api)) return;
  // A new quit: the hooks of a refused one are due again.
  st.quitHooksRan = false;
  const needsHold = st.guards.size > 0 ||
    (hasQuitWork(st) && st.options.windows().length === 0);
  if (!needsHold) return;
  event.preventDefault();
  void startQuit(st);
}

/** Whether a quit has hooks to wait for. */
function hasQuitWork(st: LifecycleState): boolean {
  return st.quit.size > 0 || st.closed.size > 0 || st.pending.size > 0;
}

/**
 * Create the window lifecycle over the registry's windows.
 *
 * @param options The runtime API, the open windows, the exit, and where warnings go.
 * @returns The lifecycle.
 */
export function createWindowLifecycle(options: WindowLifecycleOptions): WindowLifecycle {
  const st: LifecycleState = {
    options,
    opened: new Set(),
    closed: new Set(),
    quit: new Set(),
    guards: new Set(),
    pending: new Set(),
    releasing: false,
    guarding: false,
    quitHooksRan: false,
    ending: false,
  };
  const onWindowOpened = (fn: WindowOpenedHook, name = "a host"): () => void => {
    const off = subscribe(st.opened, { fn, name });
    replayOpened(st, name, fn);
    return off;
  };
  const onWindowClosed = (fn: WindowClosedHook, name = "a host"): () => void => {
    const off = subscribe(st.closed, { fn, name });
    quitWorkChanged(st);
    return off;
  };
  const onAppQuit = (fn: AppQuitHook, name = "a host"): () => void => {
    const off = subscribe(st.quit, { fn, name });
    quitWorkChanged(st);
    return off;
  };
  const onBeforeQuit = (fn: BeforeQuitGuard, name = "a host"): () => void =>
    subscribe(st.guards, { fn, name });
  return {
    onWindowOpened: (fn) => onWindowOpened(fn),
    onWindowClosed: (fn) => onWindowClosed(fn),
    onAppQuit: (fn) => onAppQuit(fn),
    onBeforeQuit: (fn) => onBeforeQuit(fn),
    windows: () => options.windows(),
    addCapabilities: (caps) => {
      for (const cap of caps) {
        if (cap.onWindowOpened) onWindowOpened(cap.onWindowOpened, cap.name);
        if (cap.onWindowClosed) onWindowClosed(cap.onWindowClosed, cap.name);
        if (cap.onAppQuit) onAppQuit(cap.onAppQuit, cap.name);
      }
    },
    install: () => {
      watchAppQuit(options.api);
      options.api?.addEventListener?.("beforequit", (event) => onBeforeQuitEvent(st, event));
    },
    windowOpened: (info) => {
      for (const { fn, name } of st.opened) callHook(st, "onWindowOpened", name, fn, info);
    },
    windowClosed: (info) => {
      for (const { fn, name } of st.closed) {
        const p = callHook(st, "onWindowClosed", name, fn, info);
        if (!p) continue;
        st.pending.add(p);
        p.finally(() => st.pending.delete(p));
      }
    },
    hasQuitWork: () => hasQuitWork(st),
    holdQuitClose: (event, last, hide, closed) => {
      if (!last || st.quitHooksRan || !isAppQuitting(options.api) || !hasQuitWork(st)) return false;
      event.preventDefault();
      hide();
      closed();
      void runQuitWork(st).then(() => {
        st.quitHooksRan = true;
        options.beforeExit?.();
        // `false`: a page holds the quit after all (a guard set meanwhile); it issues the quit
        // again when it lets go, and the hooks, which ran, are not run twice.
        reissue(st);
      });
      return true;
    },
    endApp: () => {
      if (!hasQuitWork(st)) {
        options.beforeExit?.();
        options.exit(0);
        return;
      }
      if (st.ending) return;
      st.ending = true;
      void runQuitWork(st).then(() => {
        options.beforeExit?.();
        options.exit(0);
      });
    },
  };
}
