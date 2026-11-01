/**
 * The initial-window settings of `denext.config.ts` (`desktop.window`, `desktop.titleBar`,
 * `desktop.backdrop`, `desktop.minSize`, `desktop.maxSize`): resolved once at launch by
 * {@link ../desktop/caps/mod.ts}'s `resolveDesktopCapabilities` (failing fast on a bad value, since
 * the desktop entry imports the config without the loader's validation) and applied by `runDesktop`
 * to the window it adopts.
 *
 * The size, title and resizability apply on every runtime; the size limits, title bar style and
 * backdrop need denext's pinned Deno Desktop runtime — under the stock runtime each one is skipped
 * with a single warning.
 *
 * Runtime-only (imported by the caps resolver and `runDesktop`, never a client bundle).
 *
 * @module
 */

import type { DesktopWindowLevel } from "../server/config.ts";

/** A window size in CSS pixels. */
export interface DesktopWindowSize {
  /** Width (at least 1). */
  readonly width: number;
  /** Height (at least 1). */
  readonly height: number;
}

/** The always-on-top levels, lowest first. */
export const WINDOW_LEVELS: readonly DesktopWindowLevel[] = [
  "floating",
  "status",
  "pop-up-menu",
  "screen-saver",
];

/** The resolved initial-window settings `runDesktop` applies (every key optional). */
export interface DesktopWindowSettings {
  /** The initial width (`desktop.window.width`). */
  readonly width?: number;
  /** The initial height (`desktop.window.height`). */
  readonly height?: number;
  /** The window title (`desktop.window.title`). */
  readonly title?: string;
  /** Whether the user can resize the window (`desktop.window.resizable`). */
  readonly resizable?: boolean;
  /** The title bar style (`desktop.titleBar`). */
  readonly titleBar?: "default" | "hidden" | "hiddenInset";
  /** The backdrop material (`desktop.backdrop`). */
  readonly backdrop?: "none" | "mica" | "acrylic" | "vibrancy";
  /** The smallest window size (`desktop.minSize`). */
  readonly minSize?: DesktopWindowSize;
  /** The largest window size (`desktop.maxSize`). */
  readonly maxSize?: DesktopWindowSize;
  /** Show the window at launch (`desktop.window.show`, default `true`). */
  readonly show?: boolean;
  /** No title bar or chrome (`desktop.window.frameless`, creation-time). */
  readonly frameless?: boolean;
  /** A transparent background (`desktop.window.transparent`, creation-time). */
  readonly transparent?: boolean;
  /** `false`: a non-activating panel (`desktop.window.focusable`, the runtime's `noActivate`). */
  readonly focusable?: boolean;
  /** Float above other windows, at this level (`desktop.window.alwaysOnTop`). */
  readonly alwaysOnTop?: DesktopWindowLevel | false;
  /** The window's opacity, 0–1 (`desktop.window.opacity`). */
  readonly opacity?: number;
  /** Off the taskbar (`desktop.window.skipTaskbar`). */
  readonly skipTaskbar?: boolean;
  /** On every Space / virtual desktop (`desktop.window.visibleOnAllWorkspaces`). */
  readonly visibleOnAllWorkspaces?: boolean;
  /** A Wayland layer-shell overlay surface (`desktop.window.overlay`, creation-time). */
  readonly overlay?: boolean;
}

/** The app-level settings of `desktop.app` that `runDesktop` applies at launch. */
export interface DesktopAppSettings {
  /** Keep running with no window (`desktop.app.keepAlive`; unset: on with a tray). */
  readonly keepAlive?: boolean;
  /** Show the macOS Dock icon (`desktop.app.dock`, default `true`). */
  readonly dock?: boolean;
  /** The macOS activation policy at launch (`desktop.app.activationPolicy`). */
  readonly activationPolicy?: "regular" | "accessory";
}

/**
 * The `initialWindow` creation flags `.deno-desktop/app.json` carries for the window the runtime
 * starts with (the shape of deno.json's `desktop.initialWindow`).
 */
export interface DesktopInitialWindow {
  /** Initial width. */
  readonly width?: number;
  /** Initial height. */
  readonly height?: number;
  /** No chrome. */
  readonly frameless?: boolean;
  /** A non-activating panel. */
  readonly noActivate?: boolean;
  /** A transparent background. */
  readonly transparent?: boolean;
  /** `false`: do not reveal the window once the app's first page loads. */
  readonly showOnFirstLoad?: boolean;
  /** A Wayland layer-shell overlay surface (runtime `3.0.0-denext.7`+). */
  readonly overlay?: boolean;
}

/** The macOS vibrancy material `desktop.backdrop: "vibrancy"` puts behind the page. */
export const DEFAULT_VIBRANCY = "under-window";

const TITLE_BARS = ["default", "hidden", "hiddenInset"] as const;
const POLICIES = ["regular", "accessory"] as const;
const BACKDROPS = ["none", "mica", "acrylic", "vibrancy"] as const;

/** A launch-time config error. */
function bad(key: string, message: string): Error {
  return new Error(`desktop: invalid desktop.${key}: ${message}`);
}

/** A positive finite number of pixels, or `undefined` when absent. */
function pixels(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw bad(key, "must be a number of pixels, at least 1");
  }
  return Math.round(value);
}

/** A `{ width, height }` size, or `undefined` when absent. */
function size(value: unknown, key: string): DesktopWindowSize | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) throw bad(key, "must be { width, height }");
  const v = value as { width?: unknown; height?: unknown };
  const width = pixels(v.width, `${key}.width`);
  const height = pixels(v.height, `${key}.height`);
  if (width === undefined || height === undefined) throw bad(key, "must be { width, height }");
  return { width, height };
}

/** One of `allowed`, or `undefined` when absent. */
function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  key: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw bad(key, `must be one of ${allowed.join(", ")}`);
  return value as T;
}

/** The boolean keys of `desktop.window`. */
const WINDOW_FLAGS = [
  "resizable",
  "show",
  "frameless",
  "transparent",
  "focusable",
  "skipTaskbar",
  "visibleOnAllWorkspaces",
  "overlay",
] as const;

/**
 * The first problem with `desktop.window`'s keys beyond width / height / title, as
 * `[key, message]` (the key relative to `desktop.`), or `null`. Shared with the config validator.
 *
 * @param w The `desktop.window` object.
 * @returns The problem, or `null`.
 */
export function desktopWindowKeyProblem(w: Record<string, unknown>): [string, string] | null {
  for (const key of WINDOW_FLAGS) {
    if (w[key] !== undefined && typeof w[key] !== "boolean") {
      return [`window.${key}`, "must be a boolean"];
    }
  }
  const top = w.alwaysOnTop;
  if (
    top !== undefined && typeof top !== "boolean" && !WINDOW_LEVELS.includes(top as never)
  ) {
    return ["window.alwaysOnTop", `must be a boolean or one of ${WINDOW_LEVELS.join(", ")}`];
  }
  const o = w.opacity;
  if (o !== undefined && (typeof o !== "number" || !Number.isFinite(o) || o < 0 || o > 1)) {
    return ["window.opacity", "must be a number from 0 to 1"];
  }
  return null;
}

/** `desktop.window`'s boolean flags that are set. */
function windowFlags(w: Record<string, unknown>): Partial<Record<string, boolean>> {
  const out: Partial<Record<string, boolean>> = {};
  for (const key of WINDOW_FLAGS) if (w[key] !== undefined) out[key] = w[key] as boolean;
  return out;
}

/** `desktop.window`'s own keys. */
function windowKeys(raw: unknown): Omit<
  DesktopWindowSettings,
  "titleBar" | "backdrop" | "minSize" | "maxSize"
> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null) throw bad("window", "must be an object");
  const w = raw as Record<string, unknown>;
  if (w.title !== undefined && typeof w.title !== "string") {
    throw bad("window.title", "must be a string");
  }
  const problem = desktopWindowKeyProblem(w);
  if (problem) throw bad(problem[0], problem[1]);
  return {
    ...windowSize(w),
    ...(w.title !== undefined ? { title: w.title as string } : {}),
    ...windowFlags(w),
    ...levelSetting(w.alwaysOnTop),
    ...(w.opacity !== undefined ? { opacity: w.opacity as number } : {}),
  };
}

/** `desktop.window`'s width / height, when set. */
function windowSize(w: Record<string, unknown>): { width?: number; height?: number } {
  const width = pixels(w.width, "window.width");
  const height = pixels(w.height, "window.height");
  return {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

/** `desktop.window.alwaysOnTop` (checked) as a level: `true` floats, `false` turns it off. */
function levelSetting(top: unknown): { alwaysOnTop?: DesktopWindowLevel | false } {
  if (top === undefined) return {};
  if (typeof top === "boolean") return { alwaysOnTop: top ? "floating" : false };
  return { alwaysOnTop: top as DesktopWindowLevel };
}

/**
 * Resolve `desktop.app`'s launch-time settings (`keepAlive`, `dock`, `activationPolicy`), throwing
 * on a bad value.
 *
 * @param desktop The config's `desktop` block (or `undefined`).
 * @returns The settings (empty when none are set).
 */
export function resolveDesktopAppSettings(desktop: unknown): DesktopAppSettings {
  const app = (desktop as { app?: unknown } | null | undefined)?.app;
  if (typeof app !== "object" || app === null) return {};
  const a = app as { keepAlive?: unknown; dock?: unknown; activationPolicy?: unknown };
  const out: { keepAlive?: boolean; dock?: boolean } = {};
  for (const key of ["keepAlive", "dock"] as const) {
    if (a[key] === undefined) continue;
    if (typeof a[key] !== "boolean") throw bad(`app.${key}`, "must be a boolean");
    out[key] = a[key] as boolean;
  }
  const policy = oneOf(a.activationPolicy, POLICIES, "app.activationPolicy");
  return policy !== undefined ? { ...out, activationPolicy: policy } : out;
}

/**
 * The `initialWindow` block of `.deno-desktop/app.json` for these settings, or `undefined` when
 * the window needs none: written only when the window is hidden at launch, frameless, transparent,
 * non-activating or a layer-shell overlay (the creation-time settings), then with its configured
 * size so it opens at that size. A size above the runtime's 65535 limit is left to `runDesktop` to
 * apply. `overlay` only for a runtime that reads it (an older one refuses the key).
 *
 * @param settings The resolved window settings.
 * @param overlayKnown Whether the runtime reads `initialWindow.overlay` (`initialOverlayRuntime`).
 * @returns The block, or `undefined`.
 */
export function desktopInitialWindow(
  settings: DesktopWindowSettings,
  overlayKnown = false,
): DesktopInitialWindow | undefined {
  const flags = {
    ...(settings.frameless === true ? { frameless: true } : {}),
    ...(settings.focusable === false ? { noActivate: true } : {}),
    ...(settings.transparent === true ? { transparent: true } : {}),
    ...(settings.show === false ? { showOnFirstLoad: false } : {}),
    ...(settings.overlay === true && overlayKnown ? { overlay: true } : {}),
  };
  if (Object.keys(flags).length === 0) return undefined;
  const fits = (n: number | undefined) => n !== undefined && n <= 65535;
  return {
    ...(fits(settings.width) ? { width: settings.width } : {}),
    ...(fits(settings.height) ? { height: settings.height } : {}),
    ...flags,
  };
}

/**
 * Resolve the `desktop` block's window settings, throwing on an invalid value.
 *
 * @param desktop The config's `desktop` block (or `undefined`).
 * @returns The settings (empty when none are set).
 */
export function resolveDesktopWindowSettings(desktop: unknown): DesktopWindowSettings {
  if (typeof desktop !== "object" || desktop === null) return {};
  const d = desktop as {
    window?: unknown;
    titleBar?: unknown;
    backdrop?: unknown;
    minSize?: unknown;
    maxSize?: unknown;
  };
  const titleBar = oneOf(d.titleBar, TITLE_BARS, "titleBar");
  const backdrop = oneOf(d.backdrop, BACKDROPS, "backdrop");
  const minSize = size(d.minSize, "minSize");
  const maxSize = size(d.maxSize, "maxSize");
  if (minSize && maxSize && (minSize.width > maxSize.width || minSize.height > maxSize.height)) {
    throw bad("minSize", "is larger than desktop.maxSize");
  }
  return {
    ...windowKeys(d.window),
    ...(titleBar !== undefined ? { titleBar } : {}),
    ...(backdrop !== undefined ? { backdrop } : {}),
    ...(minSize ? { minSize } : {}),
    ...(maxSize ? { maxSize } : {}),
  };
}

/** The slice of `Deno.BrowserWindow` the settings use (every member optional: feature-detected). */
interface ConfigurableWindow {
  setSize?(width: number, height: number): void;
  getSize?(): [number, number];
  getBounds?(): Rect;
  getScreen?(): { workArea: Rect } | null;
  setPosition?(x: number, y: number): void;
  setTitle?(title: string): void;
  setResizable?(resizable: boolean): void;
  setMinimumSize?(width: number, height: number): void;
  setMaximumSize?(width: number, height: number): void;
  setTitleBarStyle?(style: string): boolean;
  setBackgroundMaterial?(material: string): boolean;
  setVibrancy?(material: string | null): boolean;
  setAlwaysOnTop?(flag: boolean, level?: string): void;
  setOpacity?(opacity: number): void;
  setSkipTaskbar?(skip: boolean): void;
  setVisibleOnAllWorkspaces?(visible: boolean, options?: { visibleOnFullScreen?: boolean }): void;
}

/**
 * The window methods only runtime 3.0.0-denext.6 and later have: a missing one names the method,
 * not the pinned runtime (which has them).
 */
const FUTURE_METHODS = new Set<keyof ConfigurableWindow>([
  "setSkipTaskbar",
  "setVisibleOnAllWorkspaces",
]);

/**
 * laufey's `LAUFEY_WINDOW_LEVEL_*` codes for the levels above `"floating"` (the runtime's
 * `window_level_code`).
 */
const LEVEL_CODES: Readonly<Record<string, number>> = {
  status: 2,
  "pop-up-menu": 3,
  "screen-saver": 4,
};

/** The runtime's private window-level op on a `BrowserWindow` (3.0.0-denext.6 and later). */
const PRIVATE_WINDOW_LEVEL = Symbol.for("Deno_privateDesktopWindowLevel");

/**
 * Raise a window that `setAlwaysOnTop(true, level)` has put on top to `level` through the
 * runtime's own level op. The runtime defines `setAlwaysOnTop(flag, level)` in JS over its native
 * op, but on macOS (3.0.0-denext.6) the window's prototype still holds the native one, which drops
 * the level: every level ended at `"floating"`. Setting the level again is harmless where the
 * wrapper did take effect. A runtime without the op, or a level at or below `"floating"`, is left
 * alone.
 *
 * @param win The `Deno.BrowserWindow` (already on top).
 * @param level The Electron level name.
 */
export function applyWindowLevel(win: unknown, level: string): void {
  const code = LEVEL_CODES[level];
  if (code === undefined || typeof win !== "object" || win === null) return;
  const op = (win as Record<symbol, unknown>)[PRIVATE_WINDOW_LEVEL];
  if (typeof op === "function") op.call(win, code);
}

/** Call `window[name](...args)` when the runtime has it; `false` (and a warning) when it hasn't. */
function tryCall(
  window: ConfigurableWindow,
  name: keyof ConfigurableWindow,
  key: string,
  warn: (message: string) => void,
  ...args: unknown[]
): unknown {
  const fn = window[name] as ((...a: unknown[]) => unknown) | undefined;
  if (typeof fn !== "function") {
    warn(
      FUTURE_METHODS.has(name)
        ? `desktop.${key} needs a Deno Desktop runtime with BrowserWindow.${name}; ignored`
        : `desktop.${key} needs denext's pinned Deno Desktop runtime; ignored`,
    );
    return false;
  }
  try {
    return fn.apply(window, args);
  } catch (err) {
    warn(`desktop.${key} could not be applied: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/** Apply `desktop.backdrop`: Mica / Acrylic on Windows 11, vibrancy on macOS. */
function applyBackdrop(
  window: ConfigurableWindow,
  backdrop: NonNullable<DesktopWindowSettings["backdrop"]>,
  warn: (message: string) => void,
): void {
  // The runtime answers `false` where this OS / backend has no such backdrop (documented: Mica and
  // Acrylic are Windows 11, vibrancy macOS), which is not an error.
  if (backdrop === "vibrancy") tryCall(window, "setVibrancy", "backdrop", warn, DEFAULT_VIBRANCY);
  else if (backdrop !== "none") {
    tryCall(window, "setBackgroundMaterial", "backdrop", warn, backdrop);
  }
}

/** A rectangle in CSS pixels. */
interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The work area of the display the window is on (pinned runtime), or `null`. */
function workAreaOf(win: ConfigurableWindow): Rect | null {
  try {
    const area = typeof win.getScreen === "function" ? win.getScreen()?.workArea : null;
    return area && area.width > 0 && area.height > 0 ? area : null;
  } catch {
    return null;
  }
}

/**
 * Move a `width`×`height` window back inside `area` when the OS placed it partly outside. The OS
 * places a new window without regard to the size it is about to get (Windows cascades it from the
 * top-left), so a configured size close to the display's left it off the edge and under the
 * taskbar. A window that already fits keeps the OS's placement.
 */
function keepInside(win: ConfigurableWindow, area: Rect, width: number, height: number): void {
  if (typeof win.getBounds !== "function" || typeof win.setPosition !== "function") return;
  try {
    const { x, y } = win.getBounds();
    const nx = Math.max(area.x, Math.min(x, area.x + area.width - width));
    const ny = Math.max(area.y, Math.min(y, area.y + area.height - height));
    if (nx !== x || ny !== y) win.setPosition(nx, ny);
  } catch { /* placement is best effort */ }
}

/**
 * Apply `desktop.window`'s size, capped at the work area of the window's display, and move the
 * window inside that area ({@link keepInside}). An axis left unset keeps the current size.
 */
function applySize(
  win: ConfigurableWindow,
  settings: DesktopWindowSettings,
  warn: (message: string) => void,
): void {
  const [currentWidth, currentHeight] = typeof win.getSize === "function"
    ? win.getSize()
    : [800, 600];
  const area = workAreaOf(win);
  const width = Math.min(settings.width ?? currentWidth, area ? area.width : Infinity);
  const height = Math.min(settings.height ?? currentHeight, area ? area.height : Infinity);
  tryCall(win, "setSize", "window", warn, width, height);
  if (area) keepInside(win, area, width, height);
}

/**
 * Apply the settings to the adopted window. A setting the runtime cannot apply (the stock runtime
 * has no size limits, title bar styles or backdrops) is skipped with a warning; nothing throws.
 * Where the runtime reports the window's display, the configured size is capped at the display's
 * work area and the window is moved inside it.
 *
 * @param window The adopted `Deno.BrowserWindow` (`undefined` outside the desktop runtime: no-op).
 * @param settings The resolved settings.
 * @param warn Where warnings go (default `console.warn`).
 */
export function applyDesktopWindowSettings(
  window: unknown,
  settings: DesktopWindowSettings | undefined,
  warn: (message: string) => void = (m) => console.warn(`desktop: ${m}`),
): void {
  if (typeof window !== "object" || window === null || !settings) return;
  const win = window as ConfigurableWindow;
  if (settings.minSize) {
    const { width, height } = settings.minSize;
    tryCall(win, "setMinimumSize", "minSize", warn, width, height);
  }
  if (settings.maxSize) {
    const { width, height } = settings.maxSize;
    tryCall(win, "setMaximumSize", "maxSize", warn, width, height);
  }
  if (settings.width !== undefined || settings.height !== undefined) applySize(win, settings, warn);
  if (settings.title !== undefined) tryCall(win, "setTitle", "window.title", warn, settings.title);
  if (settings.resizable !== undefined) {
    tryCall(win, "setResizable", "window.resizable", warn, settings.resizable);
  }
  if (settings.titleBar !== undefined && settings.titleBar !== "default") {
    tryCall(win, "setTitleBarStyle", "titleBar", warn, settings.titleBar);
  }
  if (settings.backdrop !== undefined) applyBackdrop(win, settings.backdrop, warn);
  applyOverlaySettings(win, settings, warn);
}

/**
 * Apply the always-on-top level, opacity, taskbar and workspace settings to a window (the adopted
 * one, or one `openWindow` made). A setting the runtime cannot apply is skipped with a warning.
 *
 * @param win The `Deno.BrowserWindow`.
 * @param settings The settings (only those four keys are read).
 * @param warn Where warnings go.
 */
export function applyWindowOverlaySettings(
  win: unknown,
  settings: DesktopWindowSettings,
  warn: (message: string) => void = (m) => console.warn(`desktop: ${m}`),
): void {
  if (typeof win !== "object" || win === null) return;
  applyOverlaySettings(win as ConfigurableWindow, settings, warn);
}

/** Apply `desktop.window.alwaysOnTop`: on top (or not), then the level above floating. */
function applyAlwaysOnTop(
  win: ConfigurableWindow,
  level: DesktopWindowLevel | false,
  warn: (message: string) => void,
): void {
  if (level === false || level === "floating") {
    tryCall(win, "setAlwaysOnTop", "window.alwaysOnTop", warn, level !== false);
    return;
  }
  if (tryCall(win, "setAlwaysOnTop", "window.alwaysOnTop", warn, true, level) === false) return;
  try {
    applyWindowLevel(win, level);
  } catch (err) {
    warn(
      `desktop.window.alwaysOnTop could not be applied: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
}

/** Apply `desktop.window`'s always-on-top, opacity, taskbar and workspace settings. */
function applyOverlaySettings(
  win: ConfigurableWindow,
  settings: DesktopWindowSettings,
  warn: (message: string) => void,
): void {
  if (settings.alwaysOnTop !== undefined) applyAlwaysOnTop(win, settings.alwaysOnTop, warn);
  if (settings.opacity !== undefined) {
    tryCall(win, "setOpacity", "window.opacity", warn, settings.opacity);
  }
  if (settings.skipTaskbar !== undefined) {
    tryCall(win, "setSkipTaskbar", "window.skipTaskbar", warn, settings.skipTaskbar);
  }
  if (settings.visibleOnAllWorkspaces !== undefined) {
    const visible = settings.visibleOnAllWorkspaces;
    tryCall(win, "setVisibleOnAllWorkspaces", "window.visibleOnAllWorkspaces", warn, visible, {
      visibleOnFullScreen: visible,
    });
  }
}
