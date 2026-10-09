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

/** A window size in CSS pixels. */
export interface DesktopWindowSize {
  /** Width (at least 1). */
  readonly width: number;
  /** Height (at least 1). */
  readonly height: number;
}

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
}

/** The macOS vibrancy material `desktop.backdrop: "vibrancy"` puts behind the page. */
export const DEFAULT_VIBRANCY = "under-window";

const TITLE_BARS = ["default", "hidden", "hiddenInset"] as const;
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

/** `desktop.window`'s own keys. */
function windowKeys(raw: unknown): Pick<
  DesktopWindowSettings,
  "width" | "height" | "title" | "resizable"
> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null) throw bad("window", "must be an object");
  const w = raw as { width?: unknown; height?: unknown; title?: unknown; resizable?: unknown };
  if (w.title !== undefined && typeof w.title !== "string") {
    throw bad("window.title", "must be a string");
  }
  if (w.resizable !== undefined && typeof w.resizable !== "boolean") {
    throw bad("window.resizable", "must be a boolean");
  }
  const width = pixels(w.width, "window.width");
  const height = pixels(w.height, "window.height");
  return {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(w.title !== undefined ? { title: w.title as string } : {}),
    ...(w.resizable !== undefined ? { resizable: w.resizable as boolean } : {}),
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
    warn(`desktop.${key} needs denext's pinned Deno Desktop runtime; ignored`);
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
}
