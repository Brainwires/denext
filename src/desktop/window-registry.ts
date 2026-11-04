/**
 * The app's windows, runtime side: the main window the app started with, the tray panel, and the
 * windows pages open with `openWindow` (`denext/desktop/window`) or the backend with
 * `DesktopRuntime.windows.open`. Each window gets:
 *
 * - an id (`"main"`, `"panel"`, `"window-1"`, …) and a per-window token, handed to that window's
 *   documents only through a binding (`BrowserWindow.bind("__denextWindow")`, which the runtime
 *   answers for the app's own origin): the page's bridge client sends it with every request, so
 *   the bridge knows which window called ({@linkcode DesktopCapCtx.windowId}). The launch token
 *   stays the gate; the window token only selects the window. A page that cannot say (no binding)
 *   is the main window's.
 * - its own `window` capability controller: `denext/desktop/window` in a page acts on that page's
 *   window ({@linkcode WindowRegistry.router}).
 * - optionally a capability subset (`openWindow({ capabilities })`): least privilege for a page
 *   that needs little. It is not isolation — every window shares the app origin, its storage and
 *   the launch token.
 *
 * The `windows` capability ({@linkcode WindowRegistry.capability}) opens windows and acts on them
 * by id, and broadcasts `opened` / `closed` / `focus` / `blur` with the window's id.
 *
 * Closing: a window closed by the user or by code leaves the registry; the app quits once its last
 * window (the tray panel does not count) is gone, unless it is kept alive (`desktop.app.keepAlive`,
 * a tray). Every open and close is reported to the window lifecycle ({@link ./window-lifecycle.ts}:
 * the extensions' `onWindowOpened` / `onWindowClosed` / `onAppQuit` hooks and the `onBeforeQuit`
 * guards), which also holds a quit's last close while the quit hooks run.
 *
 * Keys: a window opened with a `key` (app-chosen, unique among the open windows) is found again
 * with `byKey`, its frame is saved to the window store ({@link ./window-store.ts}) as it moves and
 * when it closes, and restored — clamped onto a connected display — the next time the key opens
 * without explicit bounds. The keyed windows open at exit are the next launch's `lastSession`.
 *
 * Runtime-only (imported by `runDesktop`, never a client bundle).
 *
 * @module
 */

import {
  type DesktopCapability,
  type DesktopCapCtx,
  DesktopCapError,
  type DesktopWindowInfo,
} from "./extension.ts";
import type { WindowController } from "./caps/window.ts";
import { isAppQuitting, WINDOW_EVENTS } from "./caps/window.ts";
import { isAppPath } from "./tray-config.ts";
import type { DesktopWindowLevel } from "../server/config.ts";
import type { DesktopAppApi, DesktopRect, DesktopScreen } from "./launch-events.ts";
import {
  applyWindowOverlaySettings,
  type DesktopWindowSettings,
  WINDOW_LEVELS,
} from "./window-config.ts";
export { MAX_WINDOWS_LIMIT } from "./window-config.ts";
import { createWindowLifecycle, type WindowLifecycle } from "./window-lifecycle.ts";
import {
  clampToScreens,
  openWindowStore,
  type SessionWindow,
  windowKeyProblem,
  type WindowStore,
} from "./window-store.ts";

/** The binding name each window's documents read their window token from. */
export const WINDOW_BINDING = "__denextWindow";
/**
 * The default for `desktop.app.maxWindows`: the most windows open at once besides the main window
 * and the tray panel.
 */
export const MAX_OPEN_WINDOWS = 8;
/** The most capability names a window's subset lists. */
const MAX_SUBSET = 64;

/** What a window is. */
export type WindowKind = "main" | "panel" | "window";

/** The slice of `Deno.BrowserWindow` the registry uses (every method feature-detected). */
export interface RegistryWindow extends EventTarget {
  bind?(name: string, fn: () => unknown, options?: Record<string, unknown>): void;
  navigate?(url: string): void;
  show?(): void;
  hide?(): void;
  focus?(): void;
  close?(): void;
  isVisible?(): boolean;
  setBounds?(bounds: Record<string, number>): void;
  getBounds?(): { x: number; y: number; width: number; height: number };
  setTitle?(title: string): void;
}

/** The runtime's window constructor, as the registry calls it. */
export type WindowConstructor = new (options?: Record<string, unknown>) => RegistryWindow;

/** One of the app's windows. */
export interface RegisteredWindow {
  /** Its id (`"main"`, `"panel"`, `"window-1"`, …). */
  readonly id: string;
  /** What it is. */
  readonly kind: WindowKind;
  /** The runtime's window. */
  readonly window: RegistryWindow;
  /** Its per-window token. */
  readonly token: string;
  /** Its `window` capability controller. */
  readonly controller: WindowController;
  /** The capabilities its pages may call (`null`: all of them). */
  readonly capabilities: ReadonlySet<string> | null;
  /** Whether its documents can read the token (the runtime has bindings). */
  readonly bound: boolean;
  /** The app-chosen key it was opened with, if any. */
  readonly key?: string;
}

/** Options for {@linkcode createWindowRegistry}. */
export interface WindowRegistryOptions {
  /** The runtime's `Deno.BrowserWindow` (to open windows); without it `open` is `unsupported`. */
  readonly BrowserWindow?: WindowConstructor;
  /** The runtime's app API (`Deno.desktop`): quits and the displays. */
  readonly api?: DesktopAppApi;
  /** The most windows open at once besides the main window and the panel (default {@linkcode MAX_OPEN_WINDOWS}). */
  readonly maxWindows?: number;
  /** The app support folder the window store lives in (none: frames kept for this launch only). */
  readonly appSupportDir?: string;
  /** The window store (tests; default one opened in `appSupportDir`). */
  readonly store?: WindowStore;
  /** The connected displays (default `api.screens()`), to clamp a restored frame. */
  readonly screens?: () => readonly DesktopScreen[];
  /** Where warnings go (default `console.warn`). */
  readonly warn?: (message: string) => void;
  /** A quit hook was added: the runtime must not end the loop before it ran (keep-alive follows). */
  readonly onQuitWorkChanged?: () => void;
  /** The quit hooks' and guards' deadlines (tests; defaults in `window-lifecycle.ts`). */
  readonly lifecycleTimeouts?: { readonly quitMs?: number; readonly guardMs?: number };
  /** The URL a window loads for an app path (`/vm?id=1` → `app://localhost/vm?id=1`). */
  readonly appUrl: (path: string) => string;
  /** Push an event to the pages (every window's, or `target`'s). */
  readonly emit: (cap: string, event: string, data: unknown, target?: string) => void;
  /**
   * Make the `window` capability controller of a window (its `closed` hook is the registry's);
   * `overlay` when it was created as a layer-shell overlay.
   */
  readonly controller: (
    window: RegistryWindow,
    id: string,
    closed: () => void,
    overlay: boolean,
  ) => WindowController;
  /** Whether the app stays up with no window (`desktop.app.keepAlive`, a tray). */
  readonly keepAlive: () => boolean;
  /** A window closed for good (the `app` capability drops its page's trays). */
  readonly onClosed?: (id: string) => void;
  /** End the process (default `Deno.exit`). */
  readonly exit?: (code: number) => void;
  /** A new per-window token (default a random UUID). */
  readonly newToken?: () => string;
}

/** What {@linkcode createWindowRegistry} returns. */
export interface WindowRegistry {
  /**
   * Register a window the app already has (the adopted main window, the tray panel): bind its
   * token, make its controller, follow its focus and close. `overlay`: it was created as a
   * layer-shell overlay (default not).
   */
  adopt(
    window: RegistryWindow,
    kind: WindowKind,
    id?: string,
    options?: { readonly overlay?: boolean },
  ): RegisteredWindow;
  /** Open a new window from page / backend options (checked); `unsupported` without a runtime. */
  open(options: unknown): RegisteredWindow;
  /** A window by id. */
  get(id: string): RegisteredWindow | undefined;
  /** The window a token names (the bridge's {@link DesktopBridgeOptions.resolveWindow}). */
  resolveToken(token: string): string | undefined;
  /** The open windows. */
  list(): RegisteredWindow[];
  /** How many windows are open (the tray panel included). */
  count(): number;
  /** Whether window `id` may call capability `cap`. */
  allowed(id: string, cap: string): boolean;
  /** Whether any window's documents can read a window token (pages are told to ask). */
  bound(): boolean;
  /** Close a window for good (no close guard), then quit when it was the last one. */
  close(id: string): void;
  /** A window closed (by the user, or `close()` on it): drop it, then quit when it was the last. */
  closed(id: string): void;
  /**
   * Window `id`'s `close` listener hook: `true` when its page's close guard, or the lifecycle (a
   * quit's last close, while the quit hooks run), took the close over.
   */
  interceptClose(id: string, event: Event): boolean;
  /** The open window opened with `key`. */
  byKey(key: string): RegisteredWindow | undefined;
  /** Load another app path in window `id` (a keyed window's session follows); unknown id: nothing. */
  navigate(id: string, path: string): void;
  /** The open windows as the lifecycle hooks see them. */
  infos(): readonly DesktopWindowInfo[];
  /** The keyed windows open at the last exit (the window store's). */
  lastSession(): readonly SessionWindow[];
  /** The window lifecycle (the extensions' hooks and quit guards). */
  readonly lifecycle: WindowLifecycle;
  /** The `window` capability: each call acts on the calling window. */
  readonly router: DesktopCapability;
  /** The `windows` capability: open windows, list them, act on one by id. */
  readonly capability: DesktopCapability;
}

/** A `validation` error. */
function invalid(message: string): DesktopCapError {
  return new DesktopCapError("validation", message);
}

/** `unsupported` (501) with the reason. */
function unsupported(what: string, reason: string): DesktopCapError {
  return new DesktopCapError("unsupported", `the app cannot ${what}: ${reason}`, {
    status: 501,
    data: { reason },
  });
}

/** The args object (or `{}`). */
function argsOf(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null ? args as Record<string, unknown> : {};
}

/** An optional boolean option. */
function optBool(a: Record<string, unknown>, key: string): boolean | undefined {
  if (a[key] === undefined) return undefined;
  if (typeof a[key] !== "boolean") throw invalid(`${key} must be a boolean`);
  return a[key] as boolean;
}

/** An optional finite number option within [min, max]. */
function optNum(
  a: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const v = a[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw invalid(`${key} must be a number from ${min} to ${max}`);
  }
  return v;
}

/** The checked options of a window to open. */
export interface OpenWindowSettings {
  readonly url: string;
  readonly title?: string;
  readonly width?: number;
  readonly height?: number;
  readonly x?: number;
  readonly y?: number;
  readonly resizable?: boolean;
  readonly frameless?: boolean;
  readonly transparent?: boolean;
  readonly overlay?: boolean;
  readonly focusable?: boolean;
  readonly alwaysOnTop?: DesktopWindowLevel | false;
  readonly opacity?: number;
  readonly skipTaskbar?: boolean;
  readonly visibleOnAllWorkspaces?: boolean;
  readonly backgroundThrottling?: boolean;
  readonly show: boolean;
  readonly capabilities: ReadonlySet<string> | null;
  /** The app-chosen key (unique among the open windows). */
  readonly key?: string;
  /** Whether a saved frame fills in the bounds the call leaves out (default `true` with a key). */
  readonly restoreBounds?: boolean;
}

/** `alwaysOnTop`: a boolean or a level. */
function levelOf(value: unknown): DesktopWindowLevel | false | undefined {
  if (value === undefined) return undefined;
  if (value === true) return "floating";
  if (value === false) return false;
  if (WINDOW_LEVELS.includes(value as DesktopWindowLevel)) return value as DesktopWindowLevel;
  throw invalid(`alwaysOnTop must be a boolean or one of ${WINDOW_LEVELS.join(", ")}`);
}

/** `capabilities`: a list of capability names, or `null` for all. */
function subsetOf(value: unknown): ReadonlySet<string> | null {
  if (value === undefined || value === null) return null;
  if (
    !Array.isArray(value) || value.length > MAX_SUBSET ||
    !value.every((c) => typeof c === "string" && c !== "" && c.length <= 64)
  ) {
    throw invalid(`capabilities must be at most ${MAX_SUBSET} capability names`);
  }
  return new Set(value as string[]);
}

/**
 * Check the options of a window to open: an app path, sizes and positions, the flags, a level, an
 * opacity, a capability subset.
 *
 * @param args The page's (or the backend's) options.
 * @returns The checked settings.
 */
export function openWindowSettings(args: unknown): OpenWindowSettings {
  const a = argsOf(args);
  if (!isAppPath(a.url)) throw invalid('url must be a path of the app, like "/settings"');
  if (a.title !== undefined && (typeof a.title !== "string" || a.title.length > 1024)) {
    throw invalid("title must be a string up to 1024 characters");
  }
  const level = levelOf(a.alwaysOnTop);
  const opacity = optNum(a, "opacity", 0, 1);
  const keyProblem = a.key === undefined ? null : windowKeyProblem(a.key);
  if (keyProblem !== null) throw invalid(keyProblem);
  const restoreBounds = optBool(a, "restoreBounds");
  return {
    url: a.url,
    ...(a.title !== undefined ? { title: a.title as string } : {}),
    ...flagSettings(a),
    ...geometrySettings(a),
    ...(opacity !== undefined ? { opacity } : {}),
    ...(level !== undefined ? { alwaysOnTop: level } : {}),
    show: optBool(a, "show") ?? true,
    capabilities: subsetOf(a.capabilities),
    ...(a.key !== undefined ? { key: a.key as string } : {}),
    ...(restoreBounds !== undefined ? { restoreBounds } : {}),
  };
}

/** The boolean options of a window to open. */
const OPEN_FLAGS = [
  "resizable",
  "frameless",
  "transparent",
  "overlay",
  "focusable",
  "skipTaskbar",
  "visibleOnAllWorkspaces",
  "backgroundThrottling",
] as const;

/** The boolean options that are set, checked. */
function flagSettings(a: Record<string, unknown>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of OPEN_FLAGS) {
    const v = optBool(a, key);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** The size and position options that are set, checked and rounded. */
function geometrySettings(a: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  const ranges = [["width", 1, 10000], ["height", 1, 10000], ["x", -1e5, 1e5], ["y", -1e5, 1e5]];
  for (const [key, min, max] of ranges as [string, number, number][]) {
    const v = optNum(a, key, min, max);
    if (v !== undefined) out[key] = Math.round(v);
  }
  return out;
}

/** The runtime's creation options for checked settings (`focusable: false` is `noActivate`). */
function creationOptions(o: OpenWindowSettings): Record<string, unknown> {
  const pick = (key: keyof OpenWindowSettings) => o[key] !== undefined ? { [key]: o[key] } : {};
  return {
    ...pick("title"),
    ...pick("width"),
    ...pick("height"),
    ...pick("x"),
    ...pick("y"),
    ...pick("resizable"),
    ...pick("opacity"),
    ...pick("frameless"),
    ...pick("transparent"),
    // Creation-time from runtime 3.0.0-denext.6 (an older one ignores them; the taskbar entry is
    // also set right after creation, where the runtime has `setSkipTaskbar`).
    ...pick("overlay"),
    ...pick("skipTaskbar"),
    // Creation-time from runtime 3.0.0-denext.8: `false` keeps the page's timers at their rate
    // while the window is not on screen (an older runtime ignores it).
    ...pick("backgroundThrottling"),
    ...(o.focusable === false ? { noActivate: true } : {}),
    ...(o.alwaysOnTop !== undefined ? { alwaysOnTop: o.alwaysOnTop !== false } : {}),
    // Honoured once the runtime can create a window hidden; it is hidden right after otherwise.
    ...(o.show ? {} : { show: false }),
  };
}

/** A keyed window's frame as the registry follows it (saved to the store as it changes). */
interface Frame {
  readonly key: string;
  /** The app path it shows (as opened, or last navigated to through the windows API). */
  url: string;
  /** Its last known bounds (from the window, or the move / resize events). */
  bounds?: DesktopRect;
}

/** The registry's state. */
interface RegistryState {
  readonly options: WindowRegistryOptions;
  readonly windows: Map<string, RegisteredWindow>;
  readonly tokens: Map<string, string>;
  /** The keyed windows' frames, by window id. */
  readonly frames: Map<string, Frame>;
  /** The keyed windows of this session (open, or closed by the quit), by key: their app path. */
  readonly session: Map<string, string>;
  readonly store: WindowStore;
  readonly warn: (message: string) => void;
  lifecycle?: WindowLifecycle;
  nextId: number;
  anyBound: boolean;
}

/** One window as the lifecycle hooks see it. */
function infoOf(w: RegisteredWindow): DesktopWindowInfo {
  return { id: w.id, kind: w.kind, ...(w.key !== undefined ? { key: w.key } : {}) };
}

/** The lifecycle (made on first use: it reads the registry's windows). */
function lifecycleOf(st: RegistryState): WindowLifecycle {
  if (!st.lifecycle) {
    st.lifecycle = createWindowLifecycle({
      ...(st.options.api ? { api: st.options.api } : {}),
      windows: () => [...st.windows.values()].map(infoOf),
      exit: st.options.exit ?? Deno.exit,
      warn: st.warn,
      beforeExit: () => st.store.flush(),
      ...(st.options.onQuitWorkChanged ? { onQuitWorkChanged: st.options.onQuitWorkChanged } : {}),
      ...(st.options.lifecycleTimeouts?.quitMs !== undefined
        ? { quitTimeoutMs: st.options.lifecycleTimeouts.quitMs }
        : {}),
      ...(st.options.lifecycleTimeouts?.guardMs !== undefined
        ? { guardTimeoutMs: st.options.lifecycleTimeouts.guardMs }
        : {}),
    });
  }
  return st.lifecycle;
}

/** Bind the window token for the window's documents; whether the runtime took it. */
function bindToken(window: RegistryWindow, token: string): boolean {
  if (typeof window.bind !== "function") return false;
  try {
    window.bind(WINDOW_BINDING, () => token);
    return true;
  } catch {
    return false;
  }
}

/** Register `window` under `id`. */
function register(
  st: RegistryState,
  window: RegistryWindow,
  kind: WindowKind,
  id: string,
  capabilities: ReadonlySet<string> | null,
  overlay = false,
  key?: string,
): RegisteredWindow {
  if (st.windows.has(id)) throw new Error(`desktop: a window "${id}" is registered already`);
  const token = (st.options.newToken ?? (() => crypto.randomUUID()))();
  const bound = bindToken(window, token);
  if (bound) st.anyBound = true;
  const controller = st.options.controller(window, id, () => closed(st, id), overlay);
  const entry: RegisteredWindow = {
    id,
    kind,
    window,
    token,
    controller,
    capabilities,
    bound,
    ...(key !== undefined ? { key } : {}),
  };
  st.windows.set(id, entry);
  st.tokens.set(token, id);
  controller.install();
  window.addEventListener("focus", () => st.options.emit("windows", "focus", { id }));
  window.addEventListener("blur", () => st.options.emit("windows", "blur", { id }));
  st.options.emit("windows", "opened", infoOf(entry));
  lifecycleOf(st).windowOpened(infoOf(entry));
  return entry;
}

/** The windows that keep the app up (the tray panel does not). */
function appWindows(st: RegistryState): number {
  let n = 0;
  for (const w of st.windows.values()) if (w.kind !== "panel") n++;
  return n;
}

/** The window's bounds now, or `undefined` where the runtime cannot say (or it is closing). */
function boundsOf(window: RegistryWindow): DesktopRect | undefined {
  try {
    return window.getBounds?.() ?? undefined;
  } catch {
    return undefined;
  }
}

/** Save the keyed window `id`'s frame now (its bounds as last known). */
function saveFrame(st: RegistryState, id: string, bounds?: DesktopRect): void {
  const frame = st.frames.get(id);
  if (!frame) return;
  if (bounds) frame.bounds = bounds;
  if (frame.bounds) st.store.setBounds(frame.key, frame.bounds);
}

/** The session (the keyed windows open, or closed by the quit) changed: the store follows. */
function sessionChanged(st: RegistryState): void {
  st.store.setSession([...st.session].map(([key, url]) => ({ key, url })));
}

/**
 * Window `id` closed for good: drop it, tell the pages and the lifecycle (with whether the app is
 * quitting), save its frame, then end the app when it was the last app window and the app is not
 * kept alive — through the lifecycle's quit hooks when there are any, at once otherwise.
 */
function closed(st: RegistryState, id: string): void {
  const entry = st.windows.get(id);
  if (!entry) return;
  st.windows.delete(id);
  st.tokens.delete(entry.token);
  const quitting = isAppQuitting(st.options.api);
  const endsApp = appWindows(st) === 0 && !st.options.keepAlive();
  saveFrame(st, id, boundsOf(entry.window));
  const frame = st.frames.get(id);
  st.frames.delete(id);
  // A window the user closed leaves the session; one a quit closes was open at exit.
  if (frame && !quitting && !endsApp) {
    st.session.delete(frame.key);
    sessionChanged(st);
  }
  st.store.flush();
  st.options.onClosed?.(id);
  st.options.emit("windows", "closed", { id });
  const lifecycle = lifecycleOf(st);
  lifecycle.windowClosed({ ...infoOf(entry), appQuitting: quitting || endsApp });
  // With quit hooks, a quit's last close is held by the lifecycle while they run, and the runtime
  // ends the process once the quit is issued again; without any, the exit is immediate, as ever.
  if (endsApp && (!quitting || !lifecycle.hasQuitWork())) lifecycle.endApp();
}

/** Window `id`'s `close` listener hook: its page's guard first, then the lifecycle's hold. */
function interceptClose(st: RegistryState, id: string, event: Event): boolean {
  const entry = st.windows.get(id);
  if (!entry) return false;
  if (entry.controller.interceptClose(event)) return true;
  return lifecycleOf(st).holdQuitClose(
    event,
    st.windows.size === 1,
    () => {
      try {
        entry.window.hide?.();
      } catch { /* closing */ }
    },
    () => closed(st, id),
  );
}

/** Refuse to open a window this runtime or the window count does not allow. */
function checkCanOpen(st: RegistryState, settings: OpenWindowSettings): WindowConstructor {
  const Ctor = st.options.BrowserWindow;
  if (!Ctor) throw unsupported("open a window", "no Deno Desktop runtime");
  let opened = 0;
  for (const w of st.windows.values()) if (w.kind === "window") opened++;
  const max = maxWindows(st);
  if (opened >= max) throw invalid(`at most ${max} windows`);
  if (settings.capabilities !== null && typeof Ctor.prototype?.bind !== "function") {
    throw unsupported("give a window a capability subset", "this runtime has no window bindings");
  }
  if (settings.key !== undefined && byKey(st, settings.key)) {
    throw invalid(`a window with key "${settings.key}" is open already`);
  }
  return Ctor;
}

/** The most windows open at once besides the main window and the panel. */
function maxWindows(st: RegistryState): number {
  return st.options.maxWindows ?? MAX_OPEN_WINDOWS;
}

/** The open window opened with `key`. */
function byKey(st: RegistryState, key: string): RegisteredWindow | undefined {
  for (const w of st.windows.values()) if (w.key === key) return w;
  return undefined;
}

/** The connected displays, or none where the runtime cannot say. */
function screensOf(st: RegistryState): readonly DesktopScreen[] {
  try {
    return st.options.screens?.() ?? st.options.api?.screens?.() ?? [];
  } catch {
    return [];
  }
}

/**
 * The bounds a keyed window opens with: the call's own, with the ones it leaves out filled in from
 * the key's saved frame (unless `restoreBounds: false`), the result clamped onto a connected
 * display whenever a saved value was used.
 */
function restoredGeometry(st: RegistryState, settings: OpenWindowSettings): OpenWindowSettings {
  if (settings.key === undefined || settings.restoreBounds === false) return settings;
  const saved = st.store.bounds(settings.key);
  if (!saved) return settings;
  const sides = ["x", "y", "width", "height"] as const;
  if (sides.every((side) => settings[side] !== undefined)) return settings;
  const merged = { ...saved };
  for (const side of sides) if (settings[side] !== undefined) merged[side] = settings[side];
  return { ...settings, ...clampToScreens(merged, screensOf(st)) };
}

/** Follow a keyed window's frame: its moves and resizes (debounced into the store), its session. */
function followFrame(st: RegistryState, entry: RegisteredWindow, url: string): void {
  if (entry.key === undefined) return;
  const frame: Frame = { key: entry.key, url };
  st.frames.set(entry.id, frame);
  st.session.set(entry.key, url);
  sessionChanged(st);
  st.store.flush();
  const moved = (event: Event) => {
    const detail = ((event as CustomEvent).detail ?? {}) as Partial<DesktopRect>;
    const fresh = boundsOf(entry.window) ??
      (frame.bounds ? { ...frame.bounds, ...detail } : undefined);
    if (fresh) saveFrame(st, entry.id, fresh);
  };
  entry.window.addEventListener("move", moved);
  entry.window.addEventListener("resize", moved);
  // The bounds the window opened with, until it moves.
  const initial = boundsOf(entry.window);
  if (initial) frame.bounds = initial;
}

/** Load another app path in `entry` (checked); a keyed window's session follows it. */
function navigateWindow(st: RegistryState, entry: RegisteredWindow, url: unknown): void {
  if (!isAppPath(url)) throw invalid('url must be a path of the app, like "/settings"');
  if (typeof entry.window.navigate !== "function") {
    throw unsupported("navigate", "this Deno Desktop runtime has no BrowserWindow.navigate");
  }
  entry.window.navigate(st.options.appUrl(url));
  const frame = st.frames.get(entry.id);
  if (!frame) return;
  frame.url = url;
  st.session.set(frame.key, url);
  sessionChanged(st);
  st.store.flush();
}

/** The settings applied after creation: a level above floating, the taskbar, the workspaces. */
function afterCreation(settings: OpenWindowSettings): DesktopWindowSettings {
  const level = settings.alwaysOnTop;
  return {
    ...(level !== undefined && level !== "floating" ? { alwaysOnTop: level } : {}),
    ...(settings.skipTaskbar !== undefined ? { skipTaskbar: settings.skipTaskbar } : {}),
    ...(settings.visibleOnAllWorkspaces !== undefined
      ? { visibleOnAllWorkspaces: settings.visibleOnAllWorkspaces }
      : {}),
  };
}

/** Open a window from checked settings. */
function open(st: RegistryState, args: unknown): RegisteredWindow {
  const checked = openWindowSettings(args);
  const Ctor = checkCanOpen(st, checked);
  const settings = restoredGeometry(st, checked);
  const window = new Ctor(creationOptions(settings));
  const id = `window-${st.nextId++}`;
  // A window that closes by itself (the user) leaves the registry like a closed one.
  const entry = register(
    st,
    window,
    "window",
    id,
    settings.capabilities,
    settings.overlay === true,
    settings.key,
  );
  window.addEventListener("close", (event) => {
    if (interceptClose(st, id, event)) return;
    closed(st, id);
  });
  followFrame(st, entry, settings.url);
  applyWindowOverlaySettings(window, afterCreation(settings));
  if (!settings.show) window.hide?.();
  if (typeof window.navigate !== "function") {
    throw unsupported("open a window", "this runtime has no BrowserWindow.navigate");
  }
  window.navigate(st.options.appUrl(settings.url));
  return entry;
}

/** The window `args.id` names, or `not_found`. */
function target(st: RegistryState, args: unknown): RegisteredWindow {
  const id = argsOf(args).id;
  const entry = typeof id === "string" ? st.windows.get(id) : undefined;
  if (!entry) throw new DesktopCapError("not_found", "no such window", { status: 404 });
  return entry;
}

/** Call `window[name](...args)` on the window `args.id` names, or `unsupported`. */
function onWindow(
  st: RegistryState,
  args: unknown,
  name: "show" | "hide" | "focus" | "setBounds",
  ...rest: unknown[]
): null {
  const w = target(st, args).window;
  const fn = w[name] as ((...a: unknown[]) => unknown) | undefined;
  if (typeof fn !== "function") {
    throw unsupported(name, `this Deno Desktop runtime has no BrowserWindow.${name}`);
  }
  fn.apply(w, rest);
  return null;
}

/** One window as `list` reports it. */
function info(w: RegisteredWindow): Record<string, unknown> {
  let visible = true;
  try {
    visible = w.window.isVisible?.() ?? true;
  } catch { /* closing */ }
  return { ...infoOf(w), visible };
}

/** `setBounds`'s rectangle, checked. */
function boundsArg(args: unknown): Record<string, number> {
  const a = argsOf(args);
  const out: Record<string, number> = {};
  for (const key of ["x", "y"]) {
    const v = optNum(a, key, -1e5, 1e5);
    if (v !== undefined) out[key] = Math.round(v);
  }
  for (const key of ["width", "height"]) {
    const v = optNum(a, key, 1, 10000);
    if (v !== undefined) out[key] = Math.round(v);
  }
  return out;
}

/** Close the window `id` (no close guard): the runtime's `close()`, then the registry's `closed`. */
function closeWindow(st: RegistryState, id: string): void {
  const entry = st.windows.get(id);
  if (!entry) return;
  saveFrame(st, id, boundsOf(entry.window));
  try {
    entry.window.close?.();
  } finally {
    closed(st, id);
  }
}

/** The `windows` capability's methods. */
function windowsMethods(st: RegistryState): DesktopCapability["methods"] {
  return {
    capabilities: {
      handler: () => ({
        open: st.options.BrowserWindow !== undefined,
        capabilitySubsets: typeof st.options.BrowserWindow?.prototype?.bind === "function",
        hiddenCreate: false,
        max: maxWindows(st),
      }),
    },
    open: { handler: (args) => ({ id: open(st, args).id }) },
    current: { handler: (_args, ctx: DesktopCapCtx) => ({ id: ctx?.windowId ?? "main" }) },
    list: { handler: () => [...st.windows.values()].map(info) },
    show: { handler: (args) => onWindow(st, args, "show") },
    hide: { handler: (args) => onWindow(st, args, "hide") },
    focus: { handler: (args) => onWindow(st, args, "focus") },
    setBounds: { handler: (args) => onWindow(st, args, "setBounds", boundsArg(args)) },
    getBounds: {
      handler: (args) => {
        const w = target(st, args).window;
        return typeof w.getBounds === "function" ? w.getBounds() : null;
      },
    },
    navigate: {
      handler: (args) => {
        navigateWindow(st, target(st, args), argsOf(args).url);
        return null;
      },
    },
    close: {
      handler: (args) => {
        const entry = target(st, args);
        // Let the answer flush before the caller's own window (and maybe the app) goes.
        setTimeout(() => closeWindow(st, entry.id), 0);
        return null;
      },
    },
  };
}

/**
 * The `window` capability routed to the calling window's controller: the methods of `template`
 * (any controller's capability; they all have the same), each run by the controller of
 * `ctx.windowId`.
 */
function routerCapability(st: RegistryState, template: DesktopCapability): DesktopCapability {
  const methods: Record<string, DesktopCapability["methods"][string]> = {};
  for (const [name, method] of Object.entries(template.methods)) {
    methods[name] = {
      ...(method.timeoutMs !== undefined ? { timeoutMs: method.timeoutMs } : {}),
      handler: (args, ctx) => {
        const entry = st.windows.get(ctx?.windowId ?? "main");
        if (!entry) {
          throw unsupported("reach its window", "the window is closed");
        }
        return entry.controller.capability.methods[name].handler(args, ctx);
      },
    };
  }
  return {
    name: "window",
    events: WINDOW_EVENTS,
    perWindow: true,
    methods,
    onPageLoad: (windowId = "main") =>
      st.windows.get(windowId)?.controller.capability.onPageLoad?.(windowId),
  };
}

/**
 * Create the window registry. The `window` router is built from the first window's controller, so
 * adopt the main window before reading {@linkcode WindowRegistry.router}.
 *
 * @param options The runtime constructor, the app URL resolver, the emitter, the controller
 *   factory and the keep-alive rule.
 * @returns The registry.
 */
export function createWindowRegistry(options: WindowRegistryOptions): WindowRegistry {
  const warn = options.warn ?? ((m: string) => console.warn(`desktop: ${m}`));
  const st: RegistryState = {
    options,
    windows: new Map(),
    tokens: new Map(),
    frames: new Map(),
    session: new Map(),
    store: options.store ?? openWindowStore(options.appSupportDir, { warn }),
    warn,
    nextId: 1,
    anyBound: false,
  };
  let router: DesktopCapability | undefined;
  const capability: DesktopCapability = {
    name: "windows",
    events: ["opened", "closed", "focus", "blur"],
    methods: windowsMethods(st),
  };
  return {
    adopt: (window, kind, id = kind, options) => {
      const entry = register(st, window, kind, id, null, options?.overlay === true);
      // The tray panel's close (a quit's) is followed like an opened window's; the main window's
      // listener is `runDesktop`'s (it consults `interceptClose` and `closed`).
      if (kind === "panel") {
        window.addEventListener("close", (event) => {
          if (interceptClose(st, id, event)) return;
          closed(st, id);
        });
      }
      return entry;
    },
    open: (args) => open(st, args),
    get: (id) => st.windows.get(id),
    resolveToken: (token) => st.tokens.get(token),
    list: () => [...st.windows.values()],
    count: () => st.windows.size,
    allowed: (id, cap) => {
      const subset = st.windows.get(id)?.capabilities;
      return subset === null || subset === undefined || cap === "window" || subset.has(cap);
    },
    bound: () => st.anyBound,
    close: (id) => closeWindow(st, id),
    closed: (id) => closed(st, id),
    interceptClose: (id, event) => interceptClose(st, id, event),
    byKey: (key) => byKey(st, key),
    navigate: (id, path) => {
      const entry = st.windows.get(id);
      if (entry) navigateWindow(st, entry, path);
    },
    infos: () => [...st.windows.values()].map(infoOf),
    lastSession: () => st.store.lastSession(),
    get lifecycle() {
      return lifecycleOf(st);
    },
    get router() {
      if (!router) {
        const first = st.windows.values().next().value;
        if (!first) throw new Error("desktop: adopt a window before reading the router");
        router = routerCapability(st, first.controller.capability);
      }
      return router;
    },
    capability,
  };
}
