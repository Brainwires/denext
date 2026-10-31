/**
 * The `window` capability: the page's control over its own Deno Desktop window — state
 * (maximize / minimize / fullscreen), size and size limits, the displays, the title bar and
 * backdrop, a cancelable close, quitting, files dragged in and out, and the OS share sheet over the
 * window (`share`, runtime 2.9.7-denext.20). The page side is `denext/desktop/window` (and
 * `denext/mobile`'s `share`).
 *
 * It is not a `desktop.capabilities` key: `runDesktop` registers it whenever it adopted a window,
 * like the deep-link capabilities. Every method feature-detects its `Deno.BrowserWindow` /
 * `Deno.desktop` member: the stock runtime has the basics (size, position, title, show / hide), and
 * denext's pinned runtime adds the rest; a method the runtime lacks answers `unsupported` (501).
 *
 * Events (all signals: the page re-reads what changed, so a replayed event after a reload is
 * harmless):
 * - `state`: the window was maximized / unmaximized / minimized / restored / entered or left
 *   fullscreen — the page reads `state`.
 * - `display`: displays were added, removed or rescaled — the page reads `screens`.
 * - `closeRequested` `{ id }`: the user asked to close the window while the page guards the close.
 * - `drop`: files were dropped on the window — the page takes them with `takeDrops`.
 * - `titleBarPreferences`: the user changed their title bar settings — the page reads
 *   `titleBarPreferences` (runtime 2.9.7-denext.12).
 * - `focus` / `blur`: the window gained or lost the keyboard focus (every runtime).
 *
 * Overlay windows (a desktop companion, a HUD): the opacity, click-through
 * (`setIgnoreMouseEvents`), a click-catching hit region (`setHitRegion`), every-workspace
 * visibility, the taskbar entry and always-on-top levels. Each is feature-detected on the
 * runtime's `BrowserWindow` and reported by `capabilities`; the ones no runtime has yet answer
 * `unsupported` until it does. Click-through with no way back (no `forward`, and no tray icon to
 * reach the app) is refused: the window could never be clicked again.
 *
 * Close guard. A close event must be answered synchronously, but the page is across the bridge:
 * with the guard on (`setCloseGuard`), a close is prevented and `closeRequested` is emitted; the
 * page acknowledges (`closeAck`, which proves it is alive) and answers (`closeRespond`). A page
 * that never acknowledges cannot keep the window open: a close requested again after
 * {@link UNRESPONSIVE_MS} closes it. A new page load drops the guard.
 *
 * Dropped files are untrusted input like opened files: the page gets READ-ONLY picked handles
 * ({@link PickedPaths} — `read` for a file, `readFolder` for a folder), never authority from a path.
 * Dragging files out takes the same handles, or files in the app's own folders, never a raw path.
 *
 * Runtime-only (imported by `runDesktop`, never a client bundle).
 *
 * @module
 */

import { basename } from "@std/path";
import { base64ToBytes } from "../../mobile/base64.ts";
import type { DesktopAppDirs } from "../app-dirs.ts";
import { type DesktopCapability, DesktopCapError } from "../extension.ts";
import type { DesktopAppApi, DesktopRect, DesktopScreen } from "../launch-events.ts";
import { platformFacts } from "./platform.ts";
import { confineRelative, refuseReservedDataPath } from "../path-scope.ts";
import { PickedPaths } from "../picked-paths.ts";
import { DEFAULT_VIBRANCY } from "../window-config.ts";

/** How long a guarded close may go unacknowledged before a repeated close request wins. */
export const UNRESPONSIVE_MS = 5_000;
/** The most drops kept for the page to take (oldest dropped past it). */
const MAX_QUEUED_DROPS = 16;
/** The most files of one drop that become handles. */
const MAX_FILES_PER_DROP = 1024;
/** The most files one drag-out carries (the runtime's own limit). */
const MAX_DRAG_FILES = 4096;
/** The largest drag icon accepted, as base64 characters. */
const MAX_ICON_CHARS = 2 * 1024 * 1024;
/** The most files one share carries. */
const MAX_SHARE_FILES = 64;
/** The longest title / text / URL a share carries. */
const MAX_SHARE_TEXT = 64 * 1024;
/** How a share sheet can end (`BrowserWindow.share`, runtime 2.9.7-denext.20). */
const SHARE_OUTCOMES = new Set(["completed", "shown", "cancelled", "not_supported", "failed"]);

/** The events the `window` capability emits. */
export const WINDOW_EVENTS: readonly string[] = [
  "state",
  "display",
  "closeRequested",
  "drop",
  "titleBarPreferences",
  "focus",
  "blur",
];

/** The window state events the runtime fires (each becomes a `state` signal). */
const STATE_EVENTS = [
  "maximize",
  "unmaximize",
  "minimize",
  "restore",
  "enterfullscreen",
  "leavefullscreen",
] as const;

/** The slice of `Deno.BrowserWindow` the capability uses; every method is feature-detected. */
interface BrowserWindowLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  maximize?(): void;
  unmaximize?(): void;
  isMaximized?(): boolean;
  minimize?(): void;
  restore?(): void;
  isMinimized?(): boolean;
  setFullScreen?(flag: boolean): void;
  isFullScreen?(): boolean;
  isVisible?(): boolean;
  show?(): void;
  hide?(): void;
  focus?(): void;
  close?(): void;
  getSize?(): [number, number];
  setSize?(width: number, height: number): void;
  getPosition?(): [number, number];
  setPosition?(x: number, y: number): void;
  getBounds?(): DesktopRect;
  setBounds?(bounds: Partial<DesktopRect>): void;
  getContentBounds?(): DesktopRect;
  getNormalBounds?(): DesktopRect;
  getScreen?(): DesktopScreen | null;
  setMinimumSize?(width: number, height: number): void;
  getMinimumSize?(): [number, number];
  setMaximumSize?(width: number, height: number): void;
  getMaximumSize?(): [number, number];
  setTitle?(title: string): void;
  setResizable?(resizable: boolean): void;
  setAlwaysOnTop?(alwaysOnTop: boolean, level?: string): void;
  setOpacity?(opacity: number): void;
  getOpacity?(): number;
  setIgnoreMouseEvents?(ignore: boolean, options?: { forward?: boolean }): void;
  setHitRegion?(rects: DesktopRect[] | null): void;
  setVisibleOnAllWorkspaces?(visible: boolean, options?: { visibleOnFullScreen?: boolean }): void;
  setSkipTaskbar?(skip: boolean): void;
  setTitleBarStyle?(style: string): boolean;
  setWindowButtonPosition?(position: { x: number; y: number } | null): boolean;
  setBackgroundMaterial?(material: string): boolean;
  setVibrancy?(material: string | null): boolean;
  startDrag?(item: { files: string[]; icon?: Uint8Array }): Promise<string>;
  share?(data: {
    title?: string;
    text?: string;
    url?: string;
    files?: string[];
    x?: number;
    y?: number;
  }): Promise<{ outcome?: unknown; target?: unknown; reason?: unknown }>;
}

/** One file of a drop, as the page takes it. */
interface DroppedFile {
  /** A read-only picked handle (`{ directory: { picked: handle } }` with the `fs` capability). */
  readonly handle: string;
  /** The file or folder name. */
  readonly name: string;
  /** The absolute path, for display only. */
  readonly path: string;
  /** `file` or `directory` (a folder handle is recursive, read-only). */
  readonly kind: "file" | "directory";
  /** The size in bytes (0 for a folder). */
  readonly size: number;
}

/** One drop, as the page takes it. */
interface QueuedDrop {
  /** The pointer in CSS pixels of the page (`clientX` / `clientY`). */
  readonly x: number;
  readonly y: number;
  readonly files: DroppedFile[];
}

/** A resolved dropped path: its real path, kind and size, or `undefined` (gone, unreadable). */
export type DroppedPathResolver = (
  path: string,
) => Promise<{ real: string; kind: "file" | "directory"; size: number } | undefined>;

/** The default resolver: the real path of an existing file or directory. */
async function resolveDropped(
  path: string,
): Promise<{ real: string; kind: "file" | "directory"; size: number } | undefined> {
  try {
    const real = await Deno.realPath(path);
    const info = await Deno.stat(real);
    if (info.isFile) return { real, kind: "file", size: info.size };
    if (info.isDirectory) return { real, kind: "directory", size: 0 };
  } catch {
    // Gone between the drop and now, or unreadable: skipped.
  }
  return undefined;
}

/** Options for {@linkcode createWindowController}. */
export interface WindowControllerOptions {
  /** The adopted window (`undefined` outside the desktop runtime: every method is unsupported). */
  readonly window: unknown;
  /** The runtime's app API (`Deno.desktop`, denext's pinned runtime only). */
  readonly api?: DesktopAppApi;
  /** Push an event to the page's stream (the bridge's `emit`). */
  readonly emit: (cap: string, event: string, data: unknown) => void;
  /** End the process once the window closed for good (default `Deno.exit`). */
  readonly exit?: (code: number) => void;
  /**
   * Called once the window closed for good, instead of ending the process: the app decides
   * (another window is open, or `desktop.app.keepAlive`).
   */
  readonly closed?: () => void;
  /**
   * Whether the app has another way in than this window (a tray icon): click-through without
   * `forward` is refused otherwise. Default: none.
   */
  readonly wayBack?: () => boolean;
  /** The per-launch picked-path set (dropped files land here; drag-out resolves handles). */
  readonly picked?: PickedPaths;
  /** The app's own folders, the only paths (besides handles) a drag-out may carry. */
  readonly dirs?: DesktopAppDirs;
  /** Resolve a dropped path (tests). */
  readonly resolveDropped?: DroppedPathResolver;
  /** The clock (tests). */
  readonly now?: () => number;
  /** The OS (tests; default the running one). */
  readonly os?: string;
}

/** What {@linkcode createWindowController} returns. */
export interface WindowController {
  /** The `window` bridge capability. */
  readonly capability: DesktopCapability;
  /**
   * The window's `close` listener hook, called before the app quits: `true` when the close was
   * taken over (prevented, and handed to the page), `false` to let the window close.
   */
  interceptClose(event: Event): boolean;
  /** Subscribe to the window's and the runtime's events (state, displays, drops). */
  install(): void;
  /** Accept one drop (the event handler's path; exported for tests). */
  acceptDrop(detail: unknown): Promise<void>;
}

/** Why a window feature is missing when nothing more specific is known. */
const NO_API = "this Deno Desktop runtime has no API for it (denext's pinned runtime adds it)";

/**
 * `unsupported` (501): this runtime / backend has no such window feature. The reason is in the
 * message and, for the page, in `data.reason`.
 *
 * @param what What the window cannot do ("list the displays").
 * @param reason Why (default: the runtime has no API for it).
 */
function unsupported(what: string, reason: string = NO_API): DesktopCapError {
  return new DesktopCapError("unsupported", `the window cannot ${what}: ${reason}`, {
    status: 501,
    data: { reason },
  });
}

/** A `validation` error. */
function invalid(message: string): DesktopCapError {
  return new DesktopCapError("validation", message);
}

/** A finite number argument (rounded), at least `min`. */
function num(value: unknown, name: string, min = -1e7): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > 1e7) {
    throw invalid(`${name} must be a finite number${min >= 0 ? ` (at least ${min})` : ""}`);
  }
  return Math.round(value);
}

/** A boolean argument. */
function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${name} must be a boolean`);
  return value;
}

/** The args object (or `{}`). */
function argsOf(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null ? args as Record<string, unknown> : {};
}

/** A `{ width, height }` argument pair (0 = no limit on that axis). */
function sizeArgs(args: unknown, min: number): [number, number] {
  const a = argsOf(args);
  return [num(a.width, "width", min), num(a.height, "height", min)];
}

/** The window's bounds from `getBounds`, else `getPosition` + `getSize`, else `null`. */
function boundsOf(win: BrowserWindowLike): DesktopRect | null {
  if (typeof win.getBounds === "function") return win.getBounds();
  if (typeof win.getPosition === "function" && typeof win.getSize === "function") {
    const [x, y] = win.getPosition();
    const [width, height] = win.getSize();
    return { x, y, width, height };
  }
  return null;
}

/** `fn()` when the runtime has it, else `fallback`. */
function read<T>(fn: (() => T) | undefined, self: unknown, fallback: T): T {
  return typeof fn === "function" ? fn.call(self) : fallback;
}

/** The window's state, as the page reads it. */
function stateOf(win: BrowserWindowLike): Record<string, unknown> {
  const bounds = boundsOf(win);
  return {
    maximized: read(win.isMaximized, win, false),
    minimized: read(win.isMinimized, win, false),
    fullscreen: read(win.isFullScreen, win, false),
    visible: read(win.isVisible, win, true),
    bounds,
    contentBounds: read(win.getContentBounds, win, bounds),
    normalBounds: read(win.getNormalBounds, win, bounds),
    screen: read(win.getScreen, win, null),
    minimumSize: read(win.getMinimumSize, win, null),
    maximumSize: read(win.getMaximumSize, win, null),
  };
}

/** What the window can do: the runtime's `windowCapabilities()`, else what the stock API has. */
async function capabilitiesOf(
  win: BrowserWindowLike | undefined,
  api: DesktopAppApi | undefined,
): Promise<Record<string, boolean | string | null>> {
  let reported: Record<string, boolean> | undefined;
  try {
    reported = api?.windowCapabilities?.();
  } catch {
    reported = undefined;
  }
  const has = (name: keyof BrowserWindowLike) => typeof win?.[name] === "function";
  const facts = await platformFacts(api);
  return {
    ...overlayCapabilities(win, has, facts.cookieEncryption),
    state: has("maximize"),
    stateEvents: false,
    sizeConstraints: has("setMinimumSize"),
    screens: typeof api?.screens === "function",
    displayEvents: false,
    titleBarHidden: false,
    titleBarHiddenInset: false,
    windowButtonPosition: false,
    mica: false,
    acrylic: false,
    tabbed: false,
    vibrancy: false,
    normalBounds: false,
    keepAlive: false,
    setPosition: has("setPosition"),
    fileDrop: false,
    fileDropEnterPaths: false,
    fileDragOut: has("startDrag"),
    // The share sheet (runtime 2.9.7-denext.20): macOS and Windows; Linux answers not_supported.
    share: has("share") && Deno.build.os !== "linux",
    fileDialogs: false,
    fileDialogFilesAndDirectories: false,
    fileDialogModal: false,
    ...(reported ?? {}),
    // denext's own: a guarded close needs the pinned runtime's cancelable `close` event.
    closeGuard: typeof api?.quit === "function",
    // Since 2.9.7-denext.5 (the first runtime with `Deno.desktop.shortcuts`) every backend sizes and
    // places windows in device-independent pixels; WebView2 used physical pixels before.
    dipGeometry: typeof api?.shortcuts === "object" ||
      Deno.build.os !== "windows",
    // The session facts that bear on the window (`"unknown"` before runtime 2.9.7-denext.10):
    // Wayland cannot place windows; CEF's cookie store may be unencrypted.
    sessionType: facts.sessionType,
    cookieEncryption: facts.cookieEncryption,
  };
}

/**
 * The overlay features a window has, as far as the runtime's `BrowserWindow` shows (the runtime's
 * own `windowCapabilities()` report, read after, wins): click-through and its pointer forwarding,
 * a hit region, every workspace, the taskbar entry, opacity, always-on-top levels, a transparent
 * background (the system WebView on macOS and Linux: CEF reports a cookie store, WebView2 runs on
 * Windows), non-activating panels and focus events (every runtime with a window).
 */
function overlayCapabilities(
  win: BrowserWindowLike | undefined,
  has: (name: keyof BrowserWindowLike) => boolean,
  cookieEncryption: unknown,
): Record<string, boolean> {
  const cef = cookieEncryption === "os" || cookieEncryption === "basic";
  return {
    clickThrough: has("setIgnoreMouseEvents"),
    clickThroughForward: false,
    hitRegion: has("setHitRegion"),
    visibleOnAllWorkspaces: has("setVisibleOnAllWorkspaces"),
    skipTaskbar: has("setSkipTaskbar"),
    opacity: has("setOpacity"),
    alwaysOnTopLevels: false,
    transparent: win !== undefined && Deno.build.os !== "windows" && !cef,
    nonActivating: win !== undefined,
    focusEvents: win !== undefined,
  };
}

const TITLE_BAR_BUTTONS = new Set(["close", "minimize", "maximize", "appmenu", "menu", "icon"]);
const DOUBLE_CLICKS = new Set(["maximize", "minimize", "shade", "lower", "menu", "none"]);
const COLOR_SCHEMES = new Set(["light", "dark", "no-preference"]);
const TITLE_BAR_SOURCES = new Set(["portal", "gsettings", "default", "os"]);

/**
 * The OS's usual title bar when the runtime can't say (before runtime 2.9.7-denext.12): the
 * traffic lights on the left on macOS, the caption buttons on the right elsewhere (GTK's default
 * layout on Linux), a double click maximizes.
 */
function defaultTitleBar(os: string): Record<string, unknown> {
  const mac = os === "darwin";
  return {
    buttons: mac
      ? { left: ["close", "minimize", "maximize"], right: [] }
      : { left: os === "linux" ? ["menu"] : [], right: ["minimize", "maximize", "close"] },
    side: mac ? "left" : "right",
    doubleClick: "maximize",
    colorScheme: "no-preference",
    accentColor: null,
    font: null,
    source: "unknown",
  };
}

/** A short string, or `null`. */
function shortString(value: unknown, max: number): string | null {
  return typeof value === "string" && value !== "" ? value.slice(0, max) : null;
}

/**
 * The runtime's `titleBarPreferences()` answer, validated (an unexpected value takes the OS's
 * default for that field); the OS's default when it has none.
 */
async function titleBarPreferencesOf(
  api: DesktopAppApi | undefined,
  os: string,
): Promise<Record<string, unknown>> {
  const fallback = defaultTitleBar(os);
  let raw: unknown;
  try {
    raw = await api?.titleBarPreferences?.();
  } catch {
    raw = undefined;
  }
  if (typeof raw !== "object" || raw === null) return fallback;
  const r = raw as Record<string, unknown>;
  const side = (key: "left" | "right") => {
    const list = (r.buttons as Record<string, unknown> | undefined)?.[key];
    return Array.isArray(list) ? list.filter((b) => TITLE_BAR_BUTTONS.has(b as string)) : [];
  };
  const pick = (value: unknown, allowed: Set<string>, key: string) =>
    allowed.has(value as string) ? value : fallback[key];
  const accent = r.accentColor;
  return {
    buttons: { left: side("left"), right: side("right") },
    side: r.side === "left" || r.side === "right" ? r.side : fallback.side,
    doubleClick: pick(r.doubleClick, DOUBLE_CLICKS, "doubleClick"),
    colorScheme: pick(r.colorScheme, COLOR_SCHEMES, "colorScheme"),
    accentColor: typeof accent === "string" && /^#[0-9a-f]{6}$/i.test(accent) ? accent : null,
    font: shortString(r.font, 128),
    source: pick(r.source, TITLE_BAR_SOURCES, "source"),
  };
}

/** Push onto a bounded queue (drop oldest). */
function enqueue<T>(queue: T[], item: T, max: number): void {
  queue.push(item);
  if (queue.length > max) queue.shift();
}

/** The paths of a drop's detail (strings only, capped). */
function dropPaths(detail: unknown): string[] {
  const paths = (detail as { paths?: unknown } | null)?.paths;
  if (!Array.isArray(paths)) return [];
  return paths.filter((p): p is string => typeof p === "string" && p !== "").slice(
    0,
    MAX_FILES_PER_DROP,
  );
}

/** A finite coordinate from a drop's detail (0 otherwise). */
function coord(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The controller's state, shared by the capability's methods and the window's listeners. */
interface WindowState {
  readonly options: WindowControllerOptions;
  readonly win: BrowserWindowLike | undefined;
  readonly api: DesktopAppApi | undefined;
  readonly emit: (event: string, data: unknown) => void;
  readonly exit: (code: number) => void;
  readonly picked: PickedPaths;
  readonly resolve: DroppedPathResolver;
  readonly now: () => number;
  readonly drops: QueuedDrop[];
  guard: boolean;
  pending: { id: string; at: number; acked: boolean } | undefined;
  installed: boolean;
}

/** The window, or `unsupported` outside the desktop runtime. */
function need(s: WindowState): BrowserWindowLike {
  if (!s.win) throw unsupported("reach its window", "no window was adopted (not a desktop run)");
  return s.win;
}

/** Call the window method `name` (or `unsupported` when the runtime lacks it). */
function call<K extends keyof BrowserWindowLike>(
  s: WindowState,
  name: K,
  what: string,
  ...args: unknown[]
): unknown {
  const w = need(s);
  const fn = w[name] as ((...a: unknown[]) => unknown) | undefined;
  if (typeof fn !== "function") {
    throw unsupported(what, `this Deno Desktop runtime has no BrowserWindow.${String(name)}`);
  }
  return fn.apply(w, args);
}

/** {@link call} for a method whose answer the page does not need. */
function act<K extends keyof BrowserWindowLike>(
  s: WindowState,
  name: K,
  what: string,
  ...args: unknown[]
): null {
  call(s, name, what, ...args);
  return null;
}

/**
 * Close the window for good, then end the process — or, with a `closed` hook, let the app decide
 * (another window is open, or the app stays alive).
 */
function finishClose(s: WindowState): void {
  s.guard = false;
  s.pending = undefined;
  try {
    if (typeof s.win?.close === "function") s.win.close();
  } finally {
    // Let the RPC answer flush before the process goes away.
    const closed = s.options.closed;
    setTimeout(() => closed ? closed() : s.exit(0), 0);
  }
}

/** A drag-out item → an absolute path: a picked handle, or a file in the app's folders. */
async function dragPath(s: WindowState, item: unknown): Promise<string> {
  const i = argsOf(item);
  const directory = i.directory;
  const rel = typeof i.path === "string" ? i.path : "";
  const handle = typeof directory === "object" && directory !== null
    ? (directory as { picked?: unknown }).picked
    : undefined;
  if (handle !== undefined) return (await s.picked.resolve(handle, rel, false)).target;
  if (directory !== "data" && directory !== "cache" && directory !== "documents") {
    throw invalid('each item needs directory "data" | "cache" | "documents" | { picked }');
  }
  const dirs = s.options.dirs;
  if (!dirs) throw invalid("the app folders are not available");
  if (rel === "") throw invalid("path must name a file in the app folder");
  const target = await confineRelative(dirs[directory], rel);
  // Never drag the runtime's own state (the engine profile, the updater overlay) out.
  await refuseReservedDataPath(dirs.data, target);
  try {
    await Deno.stat(target);
  } catch {
    throw new DesktopCapError("not_found", "a dragged file does not exist", { status: 404 });
  }
  return target;
}

/** Accept one drop: hand each existing path to the page as a read-only picked handle. */
async function acceptDrop(s: WindowState, detail: unknown): Promise<void> {
  const files: DroppedFile[] = [];
  for (const path of dropPaths(detail)) {
    const found = await s.resolve(path);
    if (!found) continue;
    const handle = s.picked.add(found.real, found.kind === "directory" ? "readFolder" : "read");
    files.push({
      handle,
      name: basename(found.real),
      path: found.real,
      kind: found.kind,
      size: found.size,
    });
  }
  if (files.length === 0) return;
  const d = argsOf(detail);
  enqueue(s.drops, { x: coord(d.x), y: coord(d.y), files }, MAX_QUEUED_DROPS);
  s.emit("drop", null);
}

/** `setBounds`: the given edges and sizes, checked. */
function setBounds(s: WindowState, args: unknown): null {
  const a = argsOf(args);
  const bounds: Record<string, number> = {};
  for (const key of ["x", "y"] as const) {
    if (a[key] !== undefined) bounds[key] = num(a[key], key);
  }
  for (const key of ["width", "height"] as const) {
    if (a[key] !== undefined) bounds[key] = num(a[key], key, 1);
  }
  call(s, "setBounds", "set its bounds", bounds);
  return null;
}

/** `setBackdrop`: vibrancy (macOS), Mica / Acrylic / tabbed (Windows), or none. */
function setBackdrop(s: WindowState, args: unknown): { applied: boolean } {
  const a = argsOf(args);
  const backdrop = a.backdrop;
  if (backdrop === "vibrancy") {
    const material = typeof a.material === "string" ? a.material : DEFAULT_VIBRANCY;
    try {
      return { applied: call(s, "setVibrancy", "show vibrancy", material) === true };
    } catch (err) {
      if (err instanceof TypeError) throw invalid(`unknown vibrancy material`);
      throw err;
    }
  }
  if (backdrop === "none") {
    const w = need(s);
    const cleared = [
      typeof w.setVibrancy === "function" ? w.setVibrancy(null) : false,
      typeof w.setBackgroundMaterial === "function" ? w.setBackgroundMaterial("none") : false,
    ];
    return { applied: cleared.some((c) => c === true) };
  }
  if (backdrop !== "mica" && backdrop !== "acrylic" && backdrop !== "tabbed") {
    throw invalid('backdrop must be "none", "mica", "acrylic", "tabbed" or "vibrancy"');
  }
  return { applied: call(s, "setBackgroundMaterial", "show a backdrop", backdrop) === true };
}

/** `startDrag`: drag files (picked handles or app-folder files) out of the window. */
async function startDrag(s: WindowState, args: unknown): Promise<{ result: string }> {
  const a = argsOf(args);
  if (!Array.isArray(a.items) || a.items.length === 0 || a.items.length > MAX_DRAG_FILES) {
    throw invalid(`items must be 1 to ${MAX_DRAG_FILES} files`);
  }
  const files: string[] = [];
  for (const item of a.items) files.push(await dragPath(s, item));
  let icon: Uint8Array | undefined;
  if (a.icon !== undefined) {
    if (typeof a.icon !== "string" || a.icon.length > MAX_ICON_CHARS) {
      throw invalid("icon must be base64 PNG bytes up to 1.5 MiB");
    }
    icon = base64ToBytes(a.icon);
  }
  const result = await call(s, "startDrag", "drag files out", {
    files,
    ...(icon ? { icon } : {}),
  });
  return { result: result === "dropped" || result === "cancelled" ? result : "failed" };
}

/** An optional share string, bounded. */
function shareText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > MAX_SHARE_TEXT) {
    throw invalid(`${name} must be a string up to ${MAX_SHARE_TEXT} characters`);
  }
  return value;
}

/** What the share sheet gets (`BrowserWindow.share`'s argument). */
interface ShareSheetData {
  title?: string;
  text?: string;
  url?: string;
  files?: string[];
  x?: number;
  y?: number;
}

/** The title / text / url of a share, checked (the url http(s) only). */
function shareTexts(a: Record<string, unknown>): ShareSheetData {
  const data: ShareSheetData = {};
  for (const key of ["title", "text", "url"] as const) {
    const value = shareText(a[key], key);
    if (value !== undefined) data[key] = value;
  }
  if (data.url !== undefined && !/^https?:\/\//i.test(data.url)) {
    throw invalid("url must be an http(s) URL");
  }
  return data;
}

/** The files of a share as absolute paths, resolved like a drag-out's (empty when none). */
async function shareFiles(s: WindowState, raw: unknown): Promise<string[]> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_SHARE_FILES) {
    throw invalid(`files must be an array of at most ${MAX_SHARE_FILES} files`);
  }
  const files: string[] = [];
  for (const item of raw) files.push(await dragPath(s, item));
  return files;
}

/** The share sheet's arguments as the runtime takes them. */
async function shareData(s: WindowState, args: unknown): Promise<ShareSheetData> {
  const a = argsOf(args);
  const data = shareTexts(a);
  const files = await shareFiles(s, a.files);
  if (files.length > 0) data.files = files;
  if (data.text === undefined && data.url === undefined && files.length === 0) {
    throw invalid("share needs text, a url or files");
  }
  if (a.x !== undefined) data.x = num(a.x, "x");
  if (a.y !== undefined) data.y = num(a.y, "y");
  return data;
}

/**
 * `share`: the OS share sheet over the window (macOS `NSSharingServicePicker`, Windows
 * `DataTransferManager`). Files are picked handles or files in the app's folders, never a raw
 * path. Resolves how it ended; a file the app may not read is `forbidden`.
 */
async function share(
  s: WindowState,
  args: unknown,
): Promise<{ outcome: string; target?: string; reason?: string }> {
  const data = await shareData(s, args);
  try {
    return shareResult(await call(s, "share", "show the share sheet", data));
  } catch (err) {
    throw shareError(err);
  }
}

/** The runtime's answer, whitelisted and bounded (an unknown outcome is `failed`). */
function shareResult(raw: unknown): { outcome: string; target?: string; reason?: string } {
  const r = argsOf(raw);
  const outcome = typeof r.outcome === "string" && SHARE_OUTCOMES.has(r.outcome)
    ? r.outcome
    : "failed";
  return {
    outcome,
    ...(typeof r.target === "string" ? { target: r.target.slice(0, 256) } : {}),
    ...(typeof r.reason === "string" ? { reason: r.reason.slice(0, 1024) } : {}),
  };
}

/** A runtime rejection as the page sees it: an unreadable file is `forbidden`. */
function shareError(err: unknown): unknown {
  if (err instanceof Deno.errors.NotCapable) {
    return new DesktopCapError("forbidden", "the app may not read a shared file", { status: 403 });
  }
  if (err instanceof TypeError) return invalid(`share: ${err.message}`);
  return err;
}

/** The methods that read the window and change its state, size and position. */
function windowStateMethods(s: WindowState): DesktopCapability["methods"] {
  const { win, api } = s;
  return {
    capabilities: { handler: () => capabilitiesOf(win, api) },
    titleBarPreferences: {
      handler: () => titleBarPreferencesOf(api, s.options.os ?? Deno.build.os),
    },
    state: { handler: () => stateOf(need(s)) },
    screens: {
      handler: () => {
        if (typeof api?.screens !== "function") throw unsupported("list the displays");
        return api.screens();
      },
    },
    maximize: { handler: () => act(s, "maximize", "maximize") },
    unmaximize: { handler: () => act(s, "unmaximize", "unmaximize") },
    minimize: { handler: () => act(s, "minimize", "minimize") },
    restore: { handler: () => act(s, "restore", "restore") },
    setFullScreen: {
      handler: (args) =>
        act(s, "setFullScreen", "go fullscreen", bool(argsOf(args).fullscreen, "fullscreen")),
    },
    show: { handler: () => act(s, "show", "show the window") },
    hide: { handler: () => act(s, "hide", "hide the window") },
    focus: { handler: () => act(s, "focus", "focus the window") },
    setSize: {
      handler: (args) => act(s, "setSize", "resize", ...sizeArgs(args, 1)),
    },
    setPosition: {
      handler: (args) => {
        const a = argsOf(args);
        call(s, "setPosition", "move", num(a.x, "x"), num(a.y, "y"));
        return null;
      },
    },
    setBounds: { handler: (args) => setBounds(s, args) },
    setMinimumSize: {
      handler: (args) => act(s, "setMinimumSize", "limit its size", ...sizeArgs(args, 0)),
    },
    setMaximumSize: {
      handler: (args) => act(s, "setMaximumSize", "limit its size", ...sizeArgs(args, 0)),
    },
  };
}

/** The methods that change the window's look: title, resizability, title bar and backdrop. */
function windowLookMethods(s: WindowState): DesktopCapability["methods"] {
  return {
    setTitle: {
      handler: (args) => {
        const title = argsOf(args).title;
        if (typeof title !== "string" || title.length > 1024) {
          throw invalid("title must be a string up to 1024 characters");
        }
        call(s, "setTitle", "set its title", title);
        return null;
      },
    },
    setResizable: {
      handler: (args) =>
        act(s, "setResizable", "change resizability", bool(argsOf(args).resizable, "resizable")),
    },
    setAlwaysOnTop: { handler: (args) => setAlwaysOnTop(s, args) },
    setTitleBarStyle: {
      handler: (args) => {
        const style = argsOf(args).style;
        if (style !== "default" && style !== "hidden" && style !== "hiddenInset") {
          throw invalid('style must be "default", "hidden" or "hiddenInset"');
        }
        return { applied: call(s, "setTitleBarStyle", "style its title bar", style) === true };
      },
    },
    setWindowButtonPosition: {
      handler: (args) => {
        const p = argsOf(args).position;
        const position = p === null || p === undefined ? null : {
          x: num(argsOf(p).x, "position.x", 0),
          y: num(argsOf(p).y, "position.y", 0),
        };
        const applied = call(s, "setWindowButtonPosition", "move its window buttons", position);
        return { applied: applied === true };
      },
    },
    setBackdrop: { handler: (args) => setBackdrop(s, args) },
  };
}

/** The always-on-top levels (Electron's names), lowest first. */
const LEVELS = new Set(["floating", "status", "pop-up-menu", "screen-saver"]);
/** The most rectangles a hit region takes. */
const MAX_HIT_RECTS = 64;

/** `setAlwaysOnTop`: on or off, at a level (the runtime ignores it until it has levels). */
function setAlwaysOnTop(s: WindowState, args: unknown): null {
  const a = argsOf(args);
  const on = bool(a.alwaysOnTop, "alwaysOnTop");
  if (a.level === undefined || a.level === "floating" || !on) {
    return act(s, "setAlwaysOnTop", "stay on top", on);
  }
  if (!LEVELS.has(a.level as string)) {
    throw invalid('level must be "floating", "status", "pop-up-menu" or "screen-saver"');
  }
  return act(s, "setAlwaysOnTop", "stay on top", on, a.level);
}

/**
 * `setIgnoreMouseEvents`: let clicks through to what is under the window. Without `forward` the
 * window can never be clicked again, so that needs another way in (a tray icon).
 */
function setIgnoreMouseEvents(s: WindowState, args: unknown): null {
  const a = argsOf(args);
  const ignore = bool(a.ignore, "ignore");
  const forward = a.forward === undefined ? false : bool(a.forward, "forward");
  need(s);
  if (ignore && !forward && s.options.wayBack?.() !== true) {
    throw invalid(
      "click-through without forward needs another way back to the window (a tray icon); " +
        "pass { forward: true } or use setHitRegion",
    );
  }
  return act(s, "setIgnoreMouseEvents", "let clicks through", ignore, { forward });
}

/** `setHitRegion`: the rectangles (page CSS pixels) that catch clicks; `null` the whole window. */
function setHitRegion(s: WindowState, args: unknown): null {
  const raw = argsOf(args).rects;
  if (raw === null || raw === undefined) return act(s, "setHitRegion", "set a hit region", null);
  if (!Array.isArray(raw) || raw.length > MAX_HIT_RECTS) {
    throw invalid(`rects must be an array of at most ${MAX_HIT_RECTS} rectangles, or null`);
  }
  const rects = raw.map((r) => {
    const o = argsOf(r);
    return {
      x: num(o.x, "x"),
      y: num(o.y, "y"),
      width: num(o.width, "width", 0),
      height: num(o.height, "height", 0),
    };
  });
  return act(s, "setHitRegion", "set a hit region", rects);
}

/** The overlay methods: opacity, click-through, hit region, workspaces and the taskbar. */
function windowOverlayMethods(s: WindowState): DesktopCapability["methods"] {
  return {
    setOpacity: {
      handler: (args) => {
        const o = argsOf(args).opacity;
        if (typeof o !== "number" || !Number.isFinite(o) || o < 0 || o > 1) {
          throw invalid("opacity must be a number from 0 to 1");
        }
        return act(s, "setOpacity", "change its opacity", o);
      },
    },
    setIgnoreMouseEvents: { handler: (args) => setIgnoreMouseEvents(s, args) },
    setHitRegion: { handler: (args) => setHitRegion(s, args) },
    setVisibleOnAllWorkspaces: {
      handler: (args) => {
        const a = argsOf(args);
        const visible = bool(a.visible, "visible");
        const visibleOnFullScreen = a.visibleOnFullScreen === undefined
          ? false
          : bool(a.visibleOnFullScreen, "visibleOnFullScreen");
        return act(s, "setVisibleOnAllWorkspaces", "show on every workspace", visible, {
          visibleOnFullScreen,
        });
      },
    },
    setSkipTaskbar: {
      handler: (args) =>
        act(s, "setSkipTaskbar", "leave the taskbar", bool(argsOf(args).skip, "skip")),
    },
  };
}

/** The close-guard, close and quit methods, and the drop / drag-out ones. */
function windowCloseAndDragMethods(s: WindowState): DesktopCapability["methods"] {
  return {
    setCloseGuard: {
      handler: (args) => {
        const enabled = bool(argsOf(args).enabled, "enabled");
        if (enabled && typeof s.api?.quit !== "function") throw unsupported("guard its close");
        s.guard = enabled;
        if (!enabled) s.pending = undefined;
        return null;
      },
    },
    closeAck: {
      handler: (args) => {
        const id = argsOf(args).id;
        if (s.pending === undefined || s.pending.id !== id) return { current: false };
        s.pending.acked = true;
        return { current: true };
      },
    },
    closeRespond: {
      handler: (args) => {
        const a = argsOf(args);
        if (s.pending === undefined || s.pending.id !== a.id) return { closing: false };
        s.pending = undefined;
        if (a.close !== true) return { closing: false };
        finishClose(s);
        return { closing: true };
      },
    },
    close: {
      handler: () => {
        finishClose(s);
        return null;
      },
    },
    quit: {
      handler: () => {
        // Electron's app.quit(): a guarded close keeps the app running (and asks the page).
        if (typeof s.api?.quit === "function") return { quitting: s.api.quit() === true };
        finishClose(s);
        return { quitting: true };
      },
    },
    takeDrops: { handler: () => s.drops.splice(0, s.drops.length) },
    startDrag: {
      timeoutMs: false, // the drag lasts as long as the user holds the button
      handler: (args) => startDrag(s, args),
    },
    share: {
      timeoutMs: false, // the sheet stays up while the user picks a target
      handler: (args) => share(s, args),
    },
  };
}

/** The window's `close` listener hook (see {@linkcode WindowController.interceptClose}). */
function interceptClose(s: WindowState, event: Event): boolean {
  if (!s.guard) return false;
  const at = s.now();
  if (s.pending && !s.pending.acked && at - s.pending.at >= UNRESPONSIVE_MS) {
    // The page never acknowledged the last request: it cannot keep the window open.
    s.pending = undefined;
    return false;
  }
  event.preventDefault();
  if (!s.pending) {
    s.pending = { id: crypto.randomUUID(), at, acked: false };
    s.emit("closeRequested", { id: s.pending.id });
  }
  return true;
}

/** Subscribe to the window's and the runtime's events (once). */
function installWindowEvents(s: WindowState): void {
  const win = s.win;
  if (s.installed || !win) return;
  s.installed = true;
  for (const type of STATE_EVENTS) win.addEventListener(type, () => s.emit("state", null));
  win.addEventListener("drop", (e) => void acceptDrop(s, (e as CustomEvent).detail));
  win.addEventListener("focus", () => s.emit("focus", null));
  win.addEventListener("blur", () => s.emit("blur", null));
  s.api?.addEventListener?.("displaychanged", () => s.emit("display", null));
  // The user's title bar settings changed (runtime 2.9.7-denext.12).
  s.api?.addEventListener?.(
    "titlebarpreferenceschanged",
    () => s.emit("titleBarPreferences", null),
  );
}

/**
 * Create the window controller: the `window` capability, the close hook `runDesktop`'s close
 * listener consults, and the event subscriptions.
 *
 * @param options The adopted window, the runtime API, the emitter and the shared picked-path set.
 * @returns The controller.
 */
export function createWindowController(options: WindowControllerOptions): WindowController {
  const s: WindowState = {
    options,
    win: typeof options.window === "object" && options.window !== null
      ? options.window as BrowserWindowLike
      : undefined,
    api: options.api,
    emit: (event, data) => options.emit("window", event, data),
    exit: options.exit ?? Deno.exit,
    picked: options.picked ?? new PickedPaths(),
    resolve: options.resolveDropped ?? resolveDropped,
    now: options.now ?? Date.now,
    drops: [],
    guard: false,
    pending: undefined,
    installed: false,
  };
  const capability: DesktopCapability = {
    name: "window",
    events: WINDOW_EVENTS,
    onPageLoad: () => {
      // The page that guarded the close, or that files were dropped on, is gone.
      s.guard = false;
      s.pending = undefined;
      s.drops.length = 0;
    },
    methods: {
      ...windowStateMethods(s),
      ...windowLookMethods(s),
      ...windowOverlayMethods(s),
      ...windowCloseAndDragMethods(s),
    },
  };
  return {
    capability,
    acceptDrop: (detail) => acceptDrop(s, detail),
    interceptClose: (event) => interceptClose(s, event),
    install: () => installWindowEvents(s),
  };
}
