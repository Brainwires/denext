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
 *    While a message box an extension opened during this phase is on screen (`host.confirm`,
 *    {@linkcode WindowLifecycle.whileGuardAsks}) the deadline stops counting, and it goes on
 *    when the box closes. Never for the OS's session end (`beforequit`'s `reason:
 *    "session-end"`): there the 5 seconds always run, a box or not, and a session end that
 *    arrives while a plain quit's deadline is paused restarts it, so a session end is never held
 *    past them (and the OS's own deadline, 10 s on macOS and 4 s on Windows, still applies).
 * 2. The runtime closes every window; a page's `onBeforeQuit` / `onCloseRequested` may hold it as
 *    before (src/desktop/caps/window.ts). Each window that closes is reported `onWindowClosed`
 *    with `appQuitting: true`.
 * 3. The last window's close is held: the pending `onWindowClosed` promises and every `onAppQuit`
 *    hook are waited for, 3 seconds together, then the quit is issued again
 *    with every consent kept and the runtime ends the process. With no window open (a tray app)
 *    step 3 happens inside step 1.
 *
 * A quit asked for again ({@linkcode WindowLifecycle.requestQuit}, `host.quit()` /
 * `DesktopRuntime.quit()`) is a new quit, guards and pages included, except that the guards of
 * whoever asked (that extension's, or `desktop.ts`'s) are not asked again: it decided already. The
 * approval lasts until the quit goes through or a new quit starts from anywhere else (the user,
 * the OS, `quitApp()`), so two guards that each cancel, ask their user and quit again cannot ask
 * each other round in a loop. A `requestQuit` made while the guards are being asked waits for
 * their answer first; one made from inside the asker's own guard is refused (`conflict`).
 *
 * The last app window closing without `desktop.app.keepAlive` is a quit too: `onWindowClosed`
 * gets `appQuitting: true`, the `onAppQuit` hooks run (bounded), then the process exits. Without
 * any quit hook the exit is immediate, as it always was.
 *
 * Runtime-only (imported by the window registry, never a client bundle).
 *
 * @module
 */

import {
  type DesktopCapability,
  DesktopCapError,
  type DesktopExtensionHost,
  type DesktopWindowClosedInfo,
  type DesktopWindowInfo,
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
/** A registered guard: who added it ({@linkcode WindowLifecycleHost.requestQuit} skips its owner's). */
interface GuardEntry {
  readonly fn: BeforeQuitGuard;
  readonly name: string;
  readonly owner?: string;
}

/** A deadline that can stop counting (nested pauses) and go on. */
interface PausableDeadline {
  /** Resolves once the time ran out (never after `clear`). */
  readonly expired: Promise<void>;
  pause(): void;
  resume(): void;
  /** Count again now, whatever the pauses (a session end arrived). */
  release(): void;
  clear(): void;
}

/** The lifecycle half of {@linkcode DesktopExtensionHost} (what the bridge hands a `setup`). */
export interface WindowLifecycleHost
  extends
    Pick<DesktopExtensionHost, "onWindowOpened" | "onWindowClosed" | "onAppQuit" | "windows"> {
  /**
   * Add a before-quit guard; `owner` names who added it (an extension's capability name, or
   * `"desktop.ts"`), so that owner's {@linkcode requestQuit} skips it.
   */
  onBeforeQuit(fn: BeforeQuitGuard, owner?: string): () => void;
  /**
   * Quit again, the full sequence (guards, pages, quit hooks), skipping `owner`'s own guards:
   * resolves `true` when the app is quitting (or its quit hooks run), `false` when a guard or a
   * page refused or holds it, or there is no runtime to quit. Waits for a quit whose guards are
   * being asked; refused (`conflict`) from inside `owner`'s own guard.
   */
  requestQuit(owner?: string): Promise<boolean>;
  /**
   * `box` is a message box on screen (`host.confirm`): while it is, the guards' deadline does not
   * count, if the guards are being asked for a quit that is not the OS's session end.
   */
  whileGuardAsks<T>(box: Promise<T>): Promise<T>;
}

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
  /**
   * Quit through `issue` (`Deno.desktop.quit()`, or the updater's `applyAndRelaunch`): when the
   * lifecycle holds the quit for its guards or hooks, it is `issue` that is called again once they
   * ran, so an install-and-relaunch stays one. `true` when the app is quitting, or the lifecycle
   * holds the quit (it is issued again unless a guard refuses); `false` when a page holds it or
   * `issue` refused.
   */
  quit(issue: () => boolean): boolean;
}

/** The app's lifecycle, once the registry made one (the updater's quit goes through it). */
let registered: WindowLifecycle | undefined;

/**
 * Register the app's window lifecycle (`setUpDesktopWindows` does), so the parts of the runtime
 * that quit the app from module scope — the full-app updater's install — issue the quit through
 * it ({@linkcode WindowLifecycle.quit}).
 *
 * @param lifecycle The lifecycle.
 * @returns A function that unregisters it.
 */
export function registerAppLifecycle(lifecycle: WindowLifecycle): () => void {
  registered = lifecycle;
  return () => {
    if (registered === lifecycle) registered = undefined;
  };
}

/**
 * The registered app lifecycle, or `undefined` when the app has none (no window, a plain
 * `deno run`).
 *
 * @returns The lifecycle.
 */
export function appLifecycle(): WindowLifecycle | undefined {
  return registered;
}

/** The lifecycle's state. */
interface LifecycleState {
  readonly options: WindowLifecycleOptions;
  readonly opened: Set<{ fn: WindowOpenedHook; name: string }>;
  readonly closed: Set<{ fn: WindowClosedHook; name: string }>;
  readonly quit: Set<{ fn: AppQuitHook; name: string }>;
  readonly guards: Set<GuardEntry>;
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
  /** What issues the quit in progress when it is issued again (default `Deno.desktop.quit`). */
  issuer: (() => boolean) | undefined;
  /** `quit(issue)` is calling its issuer (its `beforequit` keeps the issuer). */
  issuing: boolean;
  /** A quit's last close is held while the quit hooks run. */
  holding: boolean;
  /** The guards are being asked for the OS's session end (their deadline never pauses). */
  sessionEnd: boolean;
  /** The guards' deadline while they are asked. */
  deadline: PausableDeadline | undefined;
  /** The guards' answer for the quit being decided (with whether it was issued again). */
  phase: Promise<boolean> | undefined;
  /** Owners whose guards are not asked again for this quit (they asked for it: `requestQuit`). */
  readonly approved: Set<string>;
  /** Owners with a guard not answered yet, and how many. */
  readonly asking: Map<string, number>;
  /** `requestQuit` is issuing the quit (its `beforequit` keeps the approvals). */
  requesting: boolean;
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

/** A deadline of `ms` that {@linkcode PausableDeadline.pause} stops and `resume` goes on with. */
function pausableDeadline(ms: number): PausableDeadline {
  let remaining = ms;
  let started = 0;
  let pauses = 0;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fire: () => void = () => {};
  const expired = new Promise<void>((resolve) => (fire = resolve));
  const arm = () => {
    started = Date.now();
    timer = setTimeout(() => {
      done = true;
      fire();
    }, Math.max(0, remaining));
  };
  arm();
  return {
    expired,
    pause: () => {
      if (done || pauses++ > 0) return;
      clearTimeout(timer);
      remaining -= Date.now() - started;
    },
    resume: () => {
      if (done || pauses === 0 || --pauses > 0) return;
      arm();
    },
    release: () => {
      if (done || pauses === 0) return;
      pauses = 0;
      arm();
    },
    clear: () => {
      done = true;
      clearTimeout(timer);
    },
  };
}

/** The guards to ask for this quit: all but those of the owners who asked for it. */
function guardsToAsk(st: LifecycleState): GuardEntry[] {
  return [...st.guards].filter((g) => g.owner === undefined || !st.approved.has(g.owner));
}

/** Ask one guard (its owner counted as asking until it answered): a throw counts as a yes (logged). */
async function askGuard(st: LifecycleState, { fn, name, owner }: GuardEntry): Promise<boolean> {
  if (owner !== undefined) st.asking.set(owner, (st.asking.get(owner) ?? 0) + 1);
  const answered = () => {
    if (owner === undefined) return;
    const left = (st.asking.get(owner) ?? 1) - 1;
    if (left > 0) st.asking.set(owner, left);
    else st.asking.delete(owner);
  };
  try {
    const out = fn();
    // A plain answer has been given now (whatever it starts after returning is not the guard).
    if (typeof (out as Promise<boolean> | undefined)?.then !== "function") {
      answered();
      return out !== false;
    }
    try {
      return (await out) !== false;
    } finally {
      answered();
    }
  } catch (err) {
    st.options.warn(`${name}.onBeforeQuit failed (the quit goes on): ${failure(err)}`);
    return true;
  }
}

/**
 * Ask the guards, 5 seconds for all of them (not counting while an extension's message box is up,
 * unless this is the OS's session end): `false` when one answered so in time; a throw, or the
 * deadline, counts as a yes (logged).
 */
async function askGuards(st: LifecycleState): Promise<boolean> {
  const guards = guardsToAsk(st);
  if (guards.length === 0) return true;
  // The deadline first: a guard may open its box as it is called.
  const ms = st.options.guardTimeoutMs ?? QUIT_GUARD_TIMEOUT_MS;
  const deadline = pausableDeadline(ms);
  st.deadline = deadline;
  const all = Promise.all(guards.map((g) => askGuard(st, g))).then((list) =>
    list.every((ok) => ok)
  );
  const inTime = await Promise.race([all.then(() => true), deadline.expired.then(() => false)]);
  deadline.clear();
  st.deadline = undefined;
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

/** Issue the quit again (through its issuer), the pages' consents kept; `true` when quitting. */
function reissue(st: LifecycleState): boolean {
  const api = st.options.api;
  const issue = st.issuer ?? (typeof api?.quit === "function" ? () => api.quit!() : undefined);
  if (!issue) return false;
  st.releasing = true;
  try {
    return reissueAppQuit(api, () => issue() === true);
  } finally {
    st.releasing = false;
  }
}

/** The guards' turn: a `beforequit` was held; ask them, then cancel or issue the quit again. */
function startQuit(st: LifecycleState, sessionEnd: boolean): void {
  if (st.phase) {
    // The first quit's guards decide for a second one meanwhile; a session end among them keeps
    // its bound: the deadline counts again, box or not.
    if (sessionEnd) {
      st.sessionEnd = true;
      st.deadline?.release();
    }
    return;
  }
  st.phase = decideQuit(st, sessionEnd);
}

/** Ask the guards, then cancel or issue the quit again: whether the app is quitting. */
async function decideQuit(st: LifecycleState, sessionEnd: boolean): Promise<boolean> {
  st.guarding = true;
  st.sessionEnd = sessionEnd;
  try {
    const allowed = await askGuards(st);
    if (!allowed) {
      // A session end the OS holds for this answer is asked to stop (runtime 3.0.0-denext.8).
      st.options.api?.cancelQuit?.();
      return false;
    }
    st.approved.clear();
    if (st.options.windows().length === 0 && hasQuitWork(st)) {
      // No close will come to hold: the quit hooks run here.
      await runQuitWork(st);
      st.quitHooksRan = true;
      st.options.beforeExit?.();
    }
    return reissue(st) || st.holding;
  } finally {
    st.guarding = false;
    st.sessionEnd = false;
    st.phase = undefined;
  }
}

/** Whether a `beforequit` event is the OS's session end (`reason: "session-end"`). */
function isSessionEnd(event: Event): boolean {
  return (event as Event & { reason?: unknown }).reason === "session-end";
}

/**
 * Quit again for `owner` ({@linkcode WindowLifecycleHost.requestQuit}): its guards are skipped
 * until the quit goes through or another quit starts.
 */
async function requestQuit(st: LifecycleState, owner?: string): Promise<boolean> {
  const api = st.options.api;
  if (typeof api?.quit !== "function") return false;
  if (owner !== undefined && st.asking.has(owner)) {
    throw new DesktopCapError(
      "conflict",
      `quit() was called from inside ${owner}'s own onBeforeQuit guard: ` +
        "return true from the guard to let the quit go on",
    );
  }
  if (owner !== undefined) st.approved.add(owner);
  // A quit being decided: its answer first (if it lets the quit go, this one is done).
  while (st.phase) {
    if (await st.phase) return true;
  }
  st.requesting = true;
  let quitting: boolean;
  try {
    quitting = quitThrough(st, () => api.quit!.call(api) === true);
  } finally {
    st.requesting = false;
  }
  return st.phase ? await st.phase : quitting;
}

/**
 * Quit through `issue` ({@linkcode WindowLifecycle.quit}): `true` when quitting, or held by the
 * lifecycle (issued again unless a guard refuses).
 */
function quitThrough(st: LifecycleState, issue: () => boolean): boolean {
  st.issuer = issue;
  st.issuing = true;
  try {
    const quitting = issue() === true;
    // Held by the guards (`decideQuit` is running) or the last-close hold: issued again.
    return quitting || st.guarding || st.holding;
  } finally {
    st.issuing = false;
  }
}

/** The runtime's `beforequit`: a new quit is held for the guards; one issued again passes. */
function onBeforeQuitEvent(st: LifecycleState, event: Event): void {
  if (st.releasing || isReissuingQuit(st.options.api)) return;
  // A new quit: the hooks of a refused one are due again, and one not issued through `quit()`
  // is issued again with `Deno.desktop.quit()`.
  st.quitHooksRan = false;
  if (!st.issuing) st.issuer = undefined;
  // A quit from anywhere but `requestQuit` starts over: every guard is asked again.
  if (!st.requesting) st.approved.clear();
  const needsHold = guardsToAsk(st).length > 0 ||
    (hasQuitWork(st) && st.options.windows().length === 0) || st.phase !== undefined;
  if (!needsHold) {
    // Nothing to ask: the quit goes on, and the approvals were for it.
    st.approved.clear();
    return;
  }
  event.preventDefault();
  startQuit(st, isSessionEnd(event));
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
    issuer: undefined,
    issuing: false,
    holding: false,
    sessionEnd: false,
    deadline: undefined,
    phase: undefined,
    approved: new Set(),
    asking: new Map(),
    requesting: false,
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
  const onBeforeQuit = (fn: BeforeQuitGuard, owner?: string): () => void =>
    subscribe(st.guards, {
      fn,
      name: owner ?? "a host",
      ...(owner !== undefined ? { owner } : {}),
    });
  return {
    onWindowOpened: (fn) => onWindowOpened(fn),
    onWindowClosed: (fn) => onWindowClosed(fn),
    onAppQuit: (fn) => onAppQuit(fn),
    onBeforeQuit: (fn, owner) => onBeforeQuit(fn, owner),
    requestQuit: (owner) => requestQuit(st, owner),
    whileGuardAsks: (box) => {
      const deadline = st.deadline;
      if (!deadline || st.sessionEnd) return box;
      deadline.pause();
      return box.finally(() => deadline.resume());
    },
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
      st.holding = true;
      void runQuitWork(st).then(() => {
        st.quitHooksRan = true;
        options.beforeExit?.();
        st.holding = false;
        // `false`: a page holds the quit after all (a guard set meanwhile); it issues the quit
        // again when it lets go, and the hooks, which ran, are not run twice.
        reissue(st);
      });
      return true;
    },
    quit: (issue) => quitThrough(st, issue),
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
