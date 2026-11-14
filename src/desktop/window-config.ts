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

import type { DesktopWindowButtonPosition, DesktopWindowLevel } from "../server/config.ts";
import { windowKeyProblem } from "./window-store.ts";

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
  /** The main window's key (`desktop.window.key`): its frame is saved and restored. */
  readonly key?: string;
  /**
   * The width used when the main window has no saved frame (`desktop.window.defaultWidth`):
   * `width` beats the saved frame, which beats this, which beats the runtime's own size.
   */
  readonly defaultWidth?: number;
  /** The height used when the main window has no saved frame (`desktop.window.defaultHeight`). */
  readonly defaultHeight?: number;
  /** Where the macOS traffic lights sit (`desktop.window.windowButtonPosition`). */
  readonly windowButtonPosition?: DesktopWindowButtonPosition;
  /** Whether the native title bar draws the title text (`desktop.window.titleVisibility`). */
  readonly titleVisibility?: DesktopTitleVisibility;
  /** The macOS toolbar style that lays the title bar out (`desktop.window.toolbarStyle`). */
  readonly toolbarStyle?: DesktopToolbarStyle;
}

/** The app-level settings of `desktop.app` that `runDesktop` applies at launch. */
export interface DesktopAppSettings {
  /** Keep running with no window (`desktop.app.keepAlive`; unset: on with a tray). */
  readonly keepAlive?: boolean;
  /**
   * Show the macOS Dock icon (`desktop.app.dock`, default `true`); `"while-window-open"`: an
   * accessory app whose Dock helper holds the icon while a window shows (macOS).
   */
  readonly dock?: boolean | "while-window-open";
  /** The macOS activation policy at launch (`desktop.app.activationPolicy`). */
  readonly activationPolicy?: "regular" | "accessory";
  /** Reopen the keyed windows of the last session at launch (`desktop.app.restoreWindows`). */
  readonly restoreWindows?: boolean;
  /** The most windows open at once besides the main window and the panel (`desktop.app.maxWindows`). */
  readonly maxWindows?: number;
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

/** The title bar styles (`desktop.titleBar`, a window's `titleBar`). */
export const TITLE_BARS = ["default", "hidden", "hiddenInset"] as const;
/** A title bar style. */
export type DesktopTitleBarStyle = typeof TITLE_BARS[number];
/**
 * The title visibilities (`desktop.window.titleVisibility`, a window's `titleVisibility`):
 * `"hidden"` keeps the native title bar, its buttons and its drag area but draws no title text.
 */
/** A title visibility. */
export type DesktopTitleVisibility = "visible" | "hidden";
export const TITLE_VISIBILITIES: readonly DesktopTitleVisibility[] = ["visible", "hidden"];
/**
 * The macOS toolbar styles (`desktop.window.toolbarStyle`, a window's `toolbarStyle`): an empty
 * toolbar in that style lays the title bar out; `"automatic"` adds none.
 */
/** A toolbar style. */
export type DesktopToolbarStyle = "automatic" | "unified" | "unifiedCompact" | "expanded";
export const TOOLBAR_STYLES: readonly DesktopToolbarStyle[] = [
  "automatic",
  "unified",
  "unifiedCompact",
  "expanded",
];
const POLICIES = ["regular", "accessory"] as const;
/** The most `desktop.app.maxWindows` may be. */
export const MAX_WINDOWS_LIMIT = 64;
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

/** The largest window button offset, in points (the runtime's own bound). */
const MAX_BUTTON_OFFSET = 1e7;

/**
 * Why `value` is not a window button position (`{ x, y }`, each a finite number of points from 0),
 * or `null`. Shared by `desktop.window.windowButtonPosition` and a window's own option.
 *
 * @param value The configured value.
 * @returns The problem, or `null`.
 */
export function windowButtonPositionProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "must be { x, y }";
  }
  const v = value as { x?: unknown; y?: unknown };
  for (const axis of ["x", "y"] as const) {
    const n = v[axis];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > MAX_BUTTON_OFFSET) {
      return `${axis} must be a number of points from 0 to ${MAX_BUTTON_OFFSET}`;
    }
  }
  return null;
}

/**
 * A checked window button position ({@linkcode windowButtonPositionProblem} found none), rounded to
 * whole points.
 *
 * @param value The checked value.
 * @returns The position.
 */
export function windowButtonPositionOf(value: unknown): DesktopWindowButtonPosition {
  const v = value as { x: number; y: number };
  return { x: Math.round(v.x), y: Math.round(v.y) };
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
  const key = w.key === undefined ? null : windowKeyProblem(w.key);
  if (key !== null) return ["window.key", key.replace(/^key /, "")];
  const buttons = w.windowButtonPosition === undefined
    ? null
    : windowButtonPositionProblem(w.windowButtonPosition);
  if (buttons !== null) return ["window.windowButtonPosition", buttons];
  const title = titleOptionValuesProblem(w);
  if (title !== null) return [`window.${title[0]}`, title[1]];
  const combo = titleOptionsProblem({
    frameless: w.frameless === true,
    titleVisibility: w.titleVisibility as DesktopTitleVisibility | undefined,
    toolbarStyle: w.toolbarStyle as DesktopToolbarStyle | undefined,
  });
  if (combo !== null) return [`window.${combo[0]}`, combo[1]];
  return null;
}

/**
 * Why a window's `titleVisibility` / `toolbarStyle` value is not one of the allowed ones, as
 * `[key, message]`, or `null`. Shared by `desktop.window` and a window's own options.
 *
 * @param w The options (only those two keys are read).
 * @returns The problem, or `null`.
 */
export function titleOptionValuesProblem(w: Record<string, unknown>): [string, string] | null {
  const v = w.titleVisibility;
  if (v !== undefined && !TITLE_VISIBILITIES.includes(v as DesktopTitleVisibility)) {
    return ["titleVisibility", `must be one of ${TITLE_VISIBILITIES.join(", ")}`];
  }
  const t = w.toolbarStyle;
  if (t !== undefined && !TOOLBAR_STYLES.includes(t as DesktopToolbarStyle)) {
    return ["toolbarStyle", `must be one of ${TOOLBAR_STYLES.join(", ")}`];
  }
  return null;
}

/** The title options of one window, checked together by {@linkcode titleOptionsProblem}. */
export interface TitleOptionsCombination {
  /** The window has no title bar (`frameless: true`). */
  readonly frameless?: boolean;
  /** Its title bar style (`desktop.titleBar`, or the window's own `titleBar`). */
  readonly titleBar?: DesktopTitleBarStyle;
  /** Its title visibility. */
  readonly titleVisibility?: DesktopTitleVisibility;
  /** Its toolbar style. */
  readonly toolbarStyle?: DesktopToolbarStyle;
}

/**
 * Why these title options can't be shown together, as `[key, message]` (the key is
 * `titleVisibility` or `toolbarStyle`), or `null`. A frameless window has no title bar to hide a
 * title in or lay out with a toolbar, and the `"hidden"` title bar style has no toolbar (the
 * runtime refuses a toolbar style there: `"hiddenInset"` is that look). The defaults
 * (`"visible"`, `"automatic"`) always combine.
 *
 * @param o The window's title options.
 * @returns The problem, or `null`.
 */
export function titleOptionsProblem(o: TitleOptionsCombination): [string, string] | null {
  const toolbar = o.toolbarStyle !== undefined && o.toolbarStyle !== "automatic";
  if (o.frameless === true) {
    if (o.titleVisibility === "hidden") {
      return ["titleVisibility", "needs a title bar: a frameless window has none"];
    }
    if (toolbar) return ["toolbarStyle", "needs a title bar: a frameless window has none"];
  }
  if (toolbar && o.titleBar === "hidden") {
    return [
      "toolbarStyle",
      `"${o.toolbarStyle}" needs the "default" or "hiddenInset" title bar: the "hidden" title ` +
      `bar has no toolbar (use "hiddenInset" for that look)`,
    ];
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
    ...(w.key !== undefined ? { key: w.key as string } : {}),
    ...(w.windowButtonPosition !== undefined
      ? { windowButtonPosition: windowButtonPositionOf(w.windowButtonPosition) }
      : {}),
    ...(w.titleVisibility !== undefined
      ? { titleVisibility: w.titleVisibility as DesktopTitleVisibility }
      : {}),
    ...(w.toolbarStyle !== undefined
      ? { toolbarStyle: w.toolbarStyle as DesktopToolbarStyle }
      : {}),
  };
}

/** `desktop.window`'s width / height and default width / height, when set. */
function windowSize(w: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of ["width", "height", "defaultWidth", "defaultHeight"]) {
    const v = pixels(w[key], `window.${key}`);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * The settings the main window opens with once its saved frame is known: without a saved frame
 * (no `desktop.window.key`, or none saved for it yet) the default size fills in an axis
 * `width` / `height` leaves out; with one the defaults are dropped (the saved frame is restored
 * instead). Precedence: `width` / `height` > the saved frame > the default > the runtime's size.
 *
 * @param settings The resolved window settings.
 * @param hasSavedFrame Whether the main window's key has a saved frame.
 * @returns The settings to apply.
 */
export function withDefaultWindowSize(
  settings: DesktopWindowSettings | undefined,
  hasSavedFrame: boolean,
): DesktopWindowSettings | undefined {
  if (settings?.defaultWidth === undefined && settings?.defaultHeight === undefined) {
    return settings;
  }
  const { defaultWidth, defaultHeight, ...rest } = settings;
  if (hasSavedFrame) return rest;
  const width = rest.width ?? defaultWidth;
  const height = rest.height ?? defaultHeight;
  return {
    ...rest,
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
  const a = app as {
    keepAlive?: unknown;
    dock?: unknown;
    activationPolicy?: unknown;
    restoreWindows?: unknown;
    maxWindows?: unknown;
  };
  const out: {
    keepAlive?: boolean;
    dock?: boolean | "while-window-open";
    restoreWindows?: boolean;
    maxWindows?: number;
  } = {};
  for (const key of ["keepAlive", "restoreWindows"] as const) {
    if (a[key] === undefined) continue;
    if (typeof a[key] !== "boolean") throw bad(`app.${key}`, "must be a boolean");
    out[key] = a[key] as boolean;
  }
  if (a.dock !== undefined) {
    if (typeof a.dock !== "boolean" && a.dock !== "while-window-open") {
      throw bad("app.dock", 'must be a boolean or "while-window-open"');
    }
    out.dock = a.dock;
  }
  if (a.maxWindows !== undefined) {
    const problem = maxWindowsProblem(a.maxWindows);
    if (problem) throw bad("app.maxWindows", problem);
    out.maxWindows = a.maxWindows as number;
  }
  const policy = oneOf(a.activationPolicy, POLICIES, "app.activationPolicy");
  return policy !== undefined ? { ...out, activationPolicy: policy } : out;
}

/**
 * Why `value` is not a `desktop.app.maxWindows`, or `null`: an integer from 1 to
 * {@linkcode MAX_WINDOWS_LIMIT}.
 *
 * @param value The configured value.
 * @returns The problem, or `null`.
 */
export function maxWindowsProblem(value: unknown): string | null {
  if (
    typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_WINDOWS_LIMIT
  ) {
    return `must be an integer from 1 to ${MAX_WINDOWS_LIMIT}`;
  }
  return null;
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
  const window = windowKeys(d.window);
  const combo = titleOptionsProblem({ ...window, ...(titleBar !== undefined ? { titleBar } : {}) });
  if (combo !== null) throw bad(`window.${combo[0]}`, combo[1]);
  return {
    ...window,
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
  setTitleVisibility?(visibility: string): boolean;
  setToolbarStyle?(style: string): boolean;
  setWindowButtonPosition?(position: DesktopWindowButtonPosition | null): boolean;
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
  "setTitleVisibility",
  "setToolbarStyle",
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
  applySizeLimits(win, settings, warn);
  if (settings.width !== undefined || settings.height !== undefined) applySize(win, settings, warn);
  if (settings.title !== undefined) tryCall(win, "setTitle", "window.title", warn, settings.title);
  if (settings.resizable !== undefined) {
    tryCall(win, "setResizable", "window.resizable", warn, settings.resizable);
  }
  if (settings.titleBar !== undefined) applyTitleBarStyle(win, settings.titleBar, warn);
  if (settings.frameless !== true) applyTitleOptions(win, settings, warn);
  if (settings.windowButtonPosition !== undefined && settings.frameless !== true) {
    applyWindowButtonPosition(win, settings.windowButtonPosition, warn);
  }
  if (settings.backdrop !== undefined) applyBackdrop(win, settings.backdrop, warn);
  applyOverlaySettings(win, settings, warn);
}

/**
 * Apply a window's size limits (the adopted one, or one `openWindow` made): `minSize` with
 * `setMinimumSize`, `maxSize` with `setMaximumSize`. A runtime without them (the stock one) is a
 * warning; nothing throws.
 *
 * @param win The `Deno.BrowserWindow`.
 * @param limits The smallest and largest sizes, either optional.
 * @param warn Where warnings go.
 */
export function applySizeLimits(
  win: unknown,
  limits: Pick<DesktopWindowSettings, "minSize" | "maxSize">,
  warn: (message: string) => void = (m) => console.warn(`desktop: ${m}`),
): void {
  if (typeof win !== "object" || win === null) return;
  const w = win as ConfigurableWindow;
  if (limits.minSize) {
    const { width, height } = limits.minSize;
    tryCall(w, "setMinimumSize", "minSize", warn, width, height);
  }
  if (limits.maxSize) {
    const { width, height } = limits.maxSize;
    tryCall(w, "setMaximumSize", "maxSize", warn, width, height);
  }
}

/**
 * Apply a title bar style to a window (the adopted one, or one `openWindow` made): `"default"` is
 * the window's own and needs nothing. A runtime without `setTitleBarStyle` (the stock one) is a
 * warning; nothing throws.
 *
 * @param win The `Deno.BrowserWindow`.
 * @param style The style.
 * @param warn Where warnings go.
 */
export function applyTitleBarStyle(
  win: unknown,
  style: DesktopTitleBarStyle,
  warn: (message: string) => void = (m) => console.warn(`desktop: ${m}`),
): void {
  if (typeof win !== "object" || win === null || style === "default") return;
  tryCall(win as ConfigurableWindow, "setTitleBarStyle", "titleBar", warn, style);
}

/**
 * Apply a window's title visibility and toolbar style (the adopted one, or one `openWindow` made),
 * after its title bar style. Only a value other than the default (`"visible"`, `"automatic"`) is
 * applied, since a new window starts with the defaults. The runtime answers `false` where the OS
 * can't (the toolbar style off macOS, the title under a Linux window manager's decorations), which
 * is not an error (`windowCapabilities()` reports it); a runtime without the method warns. Nothing
 * throws.
 *
 * @param win The `Deno.BrowserWindow`.
 * @param settings The settings (only `titleVisibility` and `toolbarStyle` are read).
 * @param warn Where warnings go.
 */
export function applyTitleOptions(
  win: unknown,
  settings: Pick<DesktopWindowSettings, "titleVisibility" | "toolbarStyle">,
  warn: (message: string) => void = (m) => console.warn(`desktop: ${m}`),
): void {
  if (typeof win !== "object" || win === null) return;
  const w = win as ConfigurableWindow;
  if (settings.titleVisibility === "hidden") {
    tryCall(w, "setTitleVisibility", "window.titleVisibility", warn, "hidden");
  }
  if (settings.toolbarStyle !== undefined && settings.toolbarStyle !== "automatic") {
    tryCall(w, "setToolbarStyle", "window.toolbarStyle", warn, settings.toolbarStyle);
  }
}

/**
 * Move a window's macOS traffic lights (the adopted one, or one `openWindow` made), after its
 * title bar style (a style change puts the buttons back). The runtime answers `false` where the
 * OS has no such buttons (Windows, Linux), which is not an error; a runtime without
 * `setWindowButtonPosition` (the stock one) is a warning. Nothing throws.
 *
 * @param win The `Deno.BrowserWindow`.
 * @param position The close button's top-left corner, in points from the window's top-left.
 * @param warn Where warnings go.
 */
export function applyWindowButtonPosition(
  win: unknown,
  position: DesktopWindowButtonPosition,
  warn: (message: string) => void = (m) => console.warn(`desktop: ${m}`),
): void {
  if (typeof win !== "object" || win === null) return;
  const key = "window.windowButtonPosition";
  tryCall(win as ConfigurableWindow, "setWindowButtonPosition", key, warn, position);
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
