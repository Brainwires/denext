/**
 * The page's control over its own Deno Desktop window (`denext/desktop/window`): maximize,
 * minimize, fullscreen and their events, size and size limits, the displays, the title bar and
 * backdrop, the user's title bar preferences ({@linkcode getTitleBarPreferences}), a cancelable
 * close, quitting, and files dragged in ({@linkcode onFileDrop}) and out
 * ({@linkcode startFileDrag}).
 *
 * Each call goes through the desktop runtime's `window` capability, which `runDesktop` registers
 * for every app (no `denext desktop add` needed). The basics (size, position, title, show / hide)
 * work on every runtime; the window state, size limits, displays, title bar styles, backdrops, the
 * guarded close and file drag and drop need denext's pinned Deno Desktop runtime — elsewhere such a
 * call rejects `unsupported`. Ask {@linkcode windowCapabilities} what this OS and backend can do.
 *
 * Coordinates and sizes are the runtime's: CSS pixels for sizes, and screen positions in points on
 * macOS and Linux and in physical pixels on Windows' WebView2 backend.
 *
 * Client-safe: web APIs only, nothing runs at import. Off desktop (the web, iOS, Android, SSR) a
 * call rejects `unavailable` without making a request, and a subscription does nothing.
 *
 * @example
 * ```ts
 * import { getWindowState, maximizeWindow, onCloseRequested } from "denext/desktop/window";
 *
 * if (!(await getWindowState()).maximized) await maximizeWindow();
 * const stop = onCloseRequested(() => confirm("Discard your changes?"));
 * ```
 *
 * @module
 */

import { desktopRpc, hasDesktopBridge, subscribeDesktopEvent } from "./bridge-client.ts";

export {
  type DesktopBridgeError,
  type DesktopErrorCode,
  isDesktopBridgeError,
} from "./bridge-client.ts";

/** The capability every call goes to. */
const CAP = "window";

/** A rectangle in screen coordinates (see the module docs for the units). */
export interface WindowBounds {
  /** The left edge. */
  readonly x: number;
  /** The top edge. */
  readonly y: number;
  /** The width. */
  readonly width: number;
  /** The height. */
  readonly height: number;
}

/** A display. */
export interface WindowScreen {
  /** Identifies the display while it stays connected (not across a reconnect or a restart). */
  readonly id: number;
  /** The whole display. */
  readonly bounds: WindowBounds;
  /** The display minus the menu bar, Dock, taskbar and panels. */
  readonly workArea: WindowBounds;
  /** Physical pixels per CSS pixel on this display. */
  readonly scaleFactor: number;
  /** The primary display (macOS: the one with the menu bar). */
  readonly isPrimary: boolean;
}

/** The window's state ({@linkcode getWindowState}). */
export interface WindowState {
  /** Maximized (zoomed on macOS). */
  readonly maximized: boolean;
  /** Minimized. */
  readonly minimized: boolean;
  /** Fullscreen. */
  readonly fullscreen: boolean;
  /** Shown (not hidden). */
  readonly visible: boolean;
  /** The outer frame, or `null` where the runtime cannot report it. */
  readonly bounds: WindowBounds | null;
  /** The page area. */
  readonly contentBounds: WindowBounds | null;
  /**
   * The bounds the window returns to when it leaves the maximized, minimized or fullscreen state:
   * what to persist to reopen the window where the user left it.
   */
  readonly normalBounds: WindowBounds | null;
  /** The display the window is on (the one it overlaps most), or `null`. */
  readonly screen: WindowScreen | null;
  /** `[width, height]` minimum (`0` = no limit), or `null` where unsupported. */
  readonly minimumSize: readonly [number, number] | null;
  /** `[width, height]` maximum (`0` = no limit), or `null` where unsupported. */
  readonly maximumSize: readonly [number, number] | null;
}

/**
 * What this OS and backend support (`Deno.desktop.windowCapabilities()` plus `closeGuard`). A call
 * for a feature reported `false` changes nothing (or rejects `unsupported`).
 */
export interface WindowCapabilities {
  /** Maximize / minimize / fullscreen. */
  readonly state: boolean;
  /** The events {@linkcode onWindowStateChange} reports. */
  readonly stateEvents: boolean;
  /** {@linkcode setMinimumWindowSize} / {@linkcode setMaximumWindowSize}. */
  readonly sizeConstraints: boolean;
  /** {@linkcode getScreens}. */
  readonly screens: boolean;
  /** {@linkcode onDisplayChanged}. */
  readonly displayEvents: boolean;
  /** `setTitleBarStyle("hidden")`. */
  readonly titleBarHidden: boolean;
  /** `setTitleBarStyle("hiddenInset")`. */
  readonly titleBarHiddenInset: boolean;
  /** {@linkcode setWindowButtonPosition}. */
  readonly windowButtonPosition: boolean;
  /** Windows 11's Mica backdrop. */
  readonly mica: boolean;
  /** Windows 11's Acrylic backdrop (22H2). */
  readonly acrylic: boolean;
  /** Windows 11's tabbed (Mica Alt) backdrop (22H2). */
  readonly tabbed: boolean;
  /** macOS vibrancy. */
  readonly vibrancy: boolean;
  /** `normalBounds` tracks the bounds to return to. */
  readonly normalBounds: boolean;
  /** {@linkcode setWindowPosition} / `setWindowBounds` can move the window (not on Wayland). */
  readonly setPosition: boolean;
  /** {@linkcode onFileDrop} fires. */
  readonly fileDrop: boolean;
  /** {@linkcode startFileDrag} works. */
  readonly fileDragOut: boolean;
  /** Native file dialogs (`pickDocument` / `saveFile` / `pickFolder` in `denext/mobile`). */
  readonly fileDialogs: boolean;
  /** {@linkcode onCloseRequested} can keep the window open. */
  readonly closeGuard: boolean;
  /** Window sizes and positions are CSS (device-independent) pixels on this backend. */
  readonly dipGeometry: boolean;
  /**
   * Linux: `"wayland"` (windows cannot be placed), `"x11"`, `"tty"` or `"unknown"`; `null` on macOS
   * and Windows. `"unknown"` before runtime 2.9.7-denext.10 (no `platformFeatures()` probe).
   */
  readonly sessionType: "wayland" | "x11" | "tty" | "unknown" | null;
  /**
   * CEF's cookie store: `"os"` (encrypted with a key the OS keeps: Windows' DPAPI, the Linux
   * keyring) or `"basic"` (obfuscated with a fixed key, not protected by the OS: always on macOS,
   * where CEF runs with Chromium's mock keychain and its constant key, and on Linux when the login
   * keyring was locked with no one to unlock it); `null` on the WebView backends, `"unknown"`
   * before runtime 2.9.7-denext.10.
   */
  readonly cookieEncryption: "os" | "basic" | "unknown" | null;
  /** Any other key the runtime reports. */
  readonly [key: string]: boolean | string | null;
}

/** A title bar style: `"hidden"` draws the page under a transparent title bar. */
export type TitleBarStyle = "default" | "hidden" | "hiddenInset";

/** A window button, as GTK's decoration layout names them. */
export type TitleBarButton = "close" | "minimize" | "maximize" | "appmenu" | "menu" | "icon";

/**
 * What a double click on a title bar does: `"maximize"` (toggle), `"minimize"`, `"shade"` (roll
 * up), `"lower"`, `"menu"` (the window menu) or `"none"`.
 */
export type TitleBarDoubleClick = "maximize" | "minimize" | "shade" | "lower" | "menu" | "none";

/**
 * How the user set up title bars ({@linkcode getTitleBarPreferences}), for a page that hides the
 * title bar and draws its own: put the window buttons where the user's other windows have them, and
 * make a double click on the drag region do what a double click on a title bar does.
 */
export interface TitleBarPreferences {
  /** The window buttons on each side of the title, in order. */
  readonly buttons: {
    readonly left: readonly TitleBarButton[];
    readonly right: readonly TitleBarButton[];
  };
  /** Where the close button is: macOS `"left"`, Windows `"right"`, Linux per the user's layout. */
  readonly side: "left" | "right";
  /** What a double click on a title bar does. */
  readonly doubleClick: TitleBarDoubleClick;
  /** The colour scheme the user picked. */
  readonly colorScheme: "light" | "dark" | "no-preference";
  /** The accent colour (`"#rrggbb"`), or `null`. */
  readonly accentColor: string | null;
  /** The title bar font (Linux), or `null`. */
  readonly font: string | null;
  /**
   * Where the answer came from: Linux reads xdg-desktop-portal's Settings first (`"portal"`), then
   * GSettings (`"gsettings"`), else GTK's defaults (`"default"`); `"os"` on macOS and Windows;
   * `"unknown"` before runtime 2.9.7-denext.12 (the OS's usual layout then).
   */
  readonly source: "portal" | "gsettings" | "default" | "os" | "unknown";
}

/**
 * A backdrop behind the page, showing where the page's background is transparent: Windows 11's
 * `"mica"`, `"acrylic"`, `"tabbed"`, or macOS `"vibrancy"`; `"none"` removes it.
 */
export type WindowBackdrop = "none" | "mica" | "acrylic" | "tabbed" | "vibrancy";

/** A macOS vibrancy material (`NSVisualEffectMaterial`, Electron's names). */
export type VibrancyMaterial =
  | "titlebar"
  | "selection"
  | "menu"
  | "popover"
  | "sidebar"
  | "header"
  | "sheet"
  | "window"
  | "hud"
  | "fullscreen-ui"
  | "tooltip"
  | "content"
  | "under-window"
  | "under-page";

/** One file dropped on the window. */
export interface DroppedFile {
  /**
   * A READ-ONLY handle for this launch: `readFile(path, { directory: { picked: handle } })` with
   * the `fs` capability (for a folder, `path` is relative to it), and the `denext/mobile` shell
   * functions.
   */
  readonly handle: string;
  /** The file or folder name. */
  readonly name: string;
  /** The absolute path, for display only (it grants nothing). */
  readonly path: string;
  /** `"file"` or `"directory"`. */
  readonly kind: "file" | "directory";
  /** The size in bytes (0 for a folder). */
  readonly size: number;
}

/** Files dropped on the window ({@linkcode onFileDrop}). */
export interface FileDrop {
  /** Where they were dropped: the page's `clientX`, in CSS pixels. */
  readonly x: number;
  /** Where they were dropped: the page's `clientY`, in CSS pixels. */
  readonly y: number;
  /** The files, each with a read-only handle. */
  readonly files: readonly DroppedFile[];
}

/**
 * A file to drag out of the window: a picked item (`{ directory: { picked: handle } }`, with
 * `path` relative to a picked folder), or a file in the app's own folders.
 */
export interface DragOutItem {
  /** `"data"`, `"cache"`, `"documents"` (the app's folders) or `{ picked: handle }`. */
  readonly directory: "data" | "cache" | "documents" | { readonly picked: string };
  /** The path relative to the folder (`""` for a picked file itself). */
  readonly path?: string;
}

/** What a drag-out ended with. */
export type DragOutResult = "dropped" | "cancelled" | "failed";

/** A call with no result. */
async function act(method: string, args: Record<string, unknown> = {}): Promise<void> {
  await desktopRpc(CAP, method, args);
}

/** A chrome call that answers whether this OS / backend applied it. */
async function applied(method: string, args: Record<string, unknown>): Promise<boolean> {
  const out = await desktopRpc<{ applied?: unknown }>(CAP, method, args);
  return out?.applied === true;
}

/**
 * What this OS and backend support.
 *
 * @returns The capabilities.
 */
export async function windowCapabilities(): Promise<WindowCapabilities> {
  return await desktopRpc<WindowCapabilities>(CAP, "capabilities", {});
}

/**
 * The window's state: maximized / minimized / fullscreen / visible, its bounds, and its display.
 *
 * @returns The state.
 */
export async function getWindowState(): Promise<WindowState> {
  return await desktopRpc<WindowState>(CAP, "state", {});
}

/** Maximize the window (zoom on macOS). @returns Once requested (the OS may animate it). */
export async function maximizeWindow(): Promise<void> {
  await act("maximize");
}

/** Leave the maximized state. @returns Once requested. */
export async function unmaximizeWindow(): Promise<void> {
  await act("unmaximize");
}

/** Minimize the window. @returns Once requested. */
export async function minimizeWindow(): Promise<void> {
  await act("minimize");
}

/** Bring the window back from minimized. @returns Once requested. */
export async function restoreWindow(): Promise<void> {
  await act("restore");
}

/**
 * Enter or leave fullscreen.
 *
 * @param fullscreen `true` to enter, `false` to leave.
 * @returns Once requested.
 */
export async function setFullScreen(fullscreen: boolean): Promise<void> {
  await act("setFullScreen", { fullscreen });
}

/** Show the window. @returns Once shown. */
export async function showWindow(): Promise<void> {
  await act("show");
}

/** Hide the window (the app keeps running). @returns Once hidden. */
export async function hideWindow(): Promise<void> {
  await act("hide");
}

/** Bring the window to the front and focus it. @returns Once requested. */
export async function focusWindow(): Promise<void> {
  await act("focus");
}

/**
 * Resize the window's page area.
 *
 * @param width CSS pixels.
 * @param height CSS pixels.
 * @returns Once resized (clamped to the size limits).
 */
export async function setWindowSize(width: number, height: number): Promise<void> {
  await act("setSize", { width, height });
}

/**
 * Move the window's frame (see the module docs for the units).
 *
 * @param x Screen x of the frame's top-left corner.
 * @param y Screen y.
 * @returns Once moved (a position off every display moves it to the primary one).
 */
export async function setWindowPosition(x: number, y: number): Promise<void> {
  await act("setPosition", { x, y });
}

/**
 * Move and / or resize the frame; missing fields keep their value. To reopen a window where the
 * user left it, save `normalBounds` (and `maximized` / `fullscreen`) from
 * {@linkcode getWindowState}, then restore them here on the next launch.
 *
 * @param bounds Any of `x`, `y`, `width`, `height`.
 * @returns Once applied.
 */
export async function setWindowBounds(bounds: Partial<WindowBounds>): Promise<void> {
  await act("setBounds", { ...bounds });
}

/**
 * Limit how small the window can get (`0` = no limit on that axis).
 *
 * @param width CSS pixels.
 * @param height CSS pixels.
 * @returns Once applied.
 */
export async function setMinimumWindowSize(width: number, height: number): Promise<void> {
  await act("setMinimumSize", { width, height });
}

/**
 * Limit how large the window can get (`0` = no limit on that axis).
 *
 * @param width CSS pixels.
 * @param height CSS pixels.
 * @returns Once applied.
 */
export async function setMaximumWindowSize(width: number, height: number): Promise<void> {
  await act("setMaximumSize", { width, height });
}

/**
 * Set the native window title.
 *
 * @param title The title.
 * @returns Once set.
 */
export async function setWindowTitle(title: string): Promise<void> {
  await act("setTitle", { title });
}

/**
 * Allow or forbid resizing by the user.
 *
 * @param resizable Whether the user can resize the window.
 * @returns Once set.
 */
export async function setWindowResizable(resizable: boolean): Promise<void> {
  await act("setResizable", { resizable });
}

/**
 * Keep the window above other windows.
 *
 * @param alwaysOnTop Whether it floats above the others.
 * @returns Once set.
 */
export async function setAlwaysOnTop(alwaysOnTop: boolean): Promise<void> {
  await act("setAlwaysOnTop", { alwaysOnTop });
}

/**
 * Change the title bar style (macOS only): `"hidden"` / `"hiddenInset"` draw the page under a
 * transparent title bar with the traffic lights on top — give the page a drag region
 * ({@linkcode makeWindowDraggable}).
 *
 * @param style The style.
 * @returns Whether this OS / backend applied it.
 */
export async function setTitleBarStyle(style: TitleBarStyle): Promise<boolean> {
  return await applied("setTitleBarStyle", { style });
}

/**
 * Move the macOS traffic lights (the close button's top-left corner, in points from the window's
 * top-left); `null` puts them back.
 *
 * @param position `{ x, y }` or `null`.
 * @returns Whether applied.
 */
export async function setWindowButtonPosition(
  position: { readonly x: number; readonly y: number } | null,
): Promise<boolean> {
  return await applied("setWindowButtonPosition", { position });
}

/**
 * Put a backdrop behind the page: Mica / Acrylic / tabbed Mica on Windows 11, vibrancy on macOS. It
 * shows where the page's background is transparent; `"none"` removes it.
 *
 * @param backdrop The backdrop.
 * @param options `material`: the macOS vibrancy material (default `"under-window"`).
 * @returns Whether this OS / backend applied it (`false` elsewhere, and on the CEF backend).
 */
export async function setWindowBackdrop(
  backdrop: WindowBackdrop,
  options: { readonly material?: VibrancyMaterial } = {},
): Promise<boolean> {
  return await applied("setBackdrop", {
    backdrop,
    ...(options.material !== undefined ? { material: options.material } : {}),
  });
}

/**
 * How the user set up title bars: the window buttons' side and order, the double-click action, the
 * colour scheme and accent colour. For a page that hides the title bar (`desktop.titleBar:
 * "hidden"`) and draws its own; windows with the OS's frame already follow these settings. On Linux
 * it is the desktop's own setting (Plasma's button order, GNOME's `button-layout`), read by the
 * runtime from xdg-desktop-portal; {@linkcode makeWindowDraggable} uses the double-click action.
 *
 * @returns The preferences.
 * @example
 * ```ts
 * import { getTitleBarPreferences, onTitleBarPreferencesChange } from "denext/desktop/window";
 *
 * const place = (p: { side: "left" | "right" }) => document.body.dataset.buttons = p.side;
 * place(await getTitleBarPreferences());
 * onTitleBarPreferencesChange(place);
 * ```
 */
export async function getTitleBarPreferences(): Promise<TitleBarPreferences> {
  return await desktopRpc<TitleBarPreferences>(CAP, "titleBarPreferences", {});
}

/**
 * Call `handler` with the new preferences whenever the user changes them (moves the window buttons,
 * picks another double-click action, colour scheme or accent colour). Needs runtime
 * 2.9.7-denext.12; earlier the handler is never called.
 *
 * @param handler Called with the current preferences.
 * @returns A function that unsubscribes.
 */
export function onTitleBarPreferencesChange(
  handler: (preferences: TitleBarPreferences) => void,
): () => void {
  return subscribeDesktopEvent(CAP, "titleBarPreferences", () => {
    getTitleBarPreferences().then(handler, () => {});
  });
}

/**
 * The connected displays, primary first.
 *
 * @returns The displays.
 */
export async function getScreens(): Promise<WindowScreen[]> {
  const out = await desktopRpc<unknown>(CAP, "screens", {});
  return Array.isArray(out) ? out as WindowScreen[] : [];
}

/**
 * Call `handler` with the window's state whenever it is maximized, unmaximized, minimized,
 * restored, or enters or leaves fullscreen.
 *
 * @param handler Called with the current state.
 * @returns A function that unsubscribes.
 */
export function onWindowStateChange(handler: (state: WindowState) => void): () => void {
  return subscribeDesktopEvent(CAP, "state", () => {
    getWindowState().then(handler, () => {});
  });
}

/**
 * Call `handler` with the displays whenever one is added, removed, rearranged or rescaled.
 *
 * @param handler Called with the current displays.
 * @returns A function that unsubscribes.
 */
export function onDisplayChanged(handler: (screens: WindowScreen[]) => void): () => void {
  return subscribeDesktopEvent(CAP, "display", () => {
    getScreens().then(handler, () => {});
  });
}

/** A close-request handler: return (or resolve) `false` to keep the window open. */
export type CloseRequestHandler = () => boolean | void | Promise<boolean | void>;

/** The page's close handlers (the runtime guards the close while there is one). */
const closeHandlers = new Set<CloseRequestHandler>();
/** The close-request subscription, while there are handlers. */
let closeSubscription: (() => void) | undefined;

/** Ask every handler; the window closes unless one answers `false`. */
async function answerCloseRequest(data: unknown): Promise<void> {
  const id = (data as { id?: unknown } | null)?.id;
  if (typeof id !== "string") return;
  // The acknowledgement proves the page is alive; a replayed (stale) request is not current.
  const ack = await desktopRpc<{ current?: unknown }>(CAP, "closeAck", { id }).catch(() => null);
  if (ack?.current !== true) return;
  let close = true;
  for (const handler of [...closeHandlers]) {
    try {
      if ((await handler()) === false) close = false;
    } catch (err) {
      console.error("denext: an onCloseRequested handler threw; keeping the window open", err);
      close = false;
    }
  }
  await desktopRpc(CAP, "closeRespond", { id, close }).catch(() => {});
}

/**
 * Ask before the window closes (its close button, Cmd+W / Alt+F4, or {@linkcode quitApp}). While a
 * handler is registered the runtime holds every close and calls the handlers; the window closes
 * unless one returns (or resolves) `false`. A page that stops answering cannot keep the window
 * open: a close requested again after 5 seconds without an answer goes through. Quitting from the
 * macOS app menu (Cmd+Q) is not asked. Needs denext's pinned runtime (`closeGuard` in
 * {@linkcode windowCapabilities}); elsewhere the handler is never called and the window closes.
 *
 * @param handler Return `false` to keep the window open (e.g. after a "Discard changes?" prompt).
 * @returns A function that unregisters the handler.
 * @example
 * ```ts
 * import { onCloseRequested } from "denext/desktop/window";
 *
 * onCloseRequested(async () => !hasUnsavedChanges() || await confirmDiscard());
 * ```
 */
export function onCloseRequested(handler: CloseRequestHandler): () => void {
  closeHandlers.add(handler);
  if (closeHandlers.size === 1) {
    closeSubscription = subscribeDesktopEvent(CAP, "closeRequested", (data) => {
      void answerCloseRequest(data);
    });
    desktopRpc(CAP, "setCloseGuard", { enabled: true }).catch(() => {});
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    closeHandlers.delete(handler);
    if (closeHandlers.size > 0) return;
    closeSubscription?.();
    closeSubscription = undefined;
    desktopRpc(CAP, "setCloseGuard", { enabled: false }).catch(() => {});
  };
}

/**
 * Close the window now, without asking the {@linkcode onCloseRequested} handlers (the app quits:
 * a denext desktop app has one window).
 *
 * @returns Once the close was requested.
 */
export async function closeWindow(): Promise<void> {
  await act("close");
}

/**
 * Quit the app, like Electron's `app.quit()`: the {@linkcode onCloseRequested} handlers are asked
 * first, so a guarded close keeps it running.
 *
 * @returns `true` when the app is quitting, `false` when the close is held (the handlers decide).
 */
export async function quitApp(): Promise<boolean> {
  const out = await desktopRpc<{ quitting?: unknown }>(CAP, "quit", {});
  return out?.quitting === true;
}

/** One raw dropped file as a {@linkcode DroppedFile} (or nothing when malformed). */
function toDroppedFile(raw: unknown): DroppedFile[] {
  const f = (raw ?? {}) as Record<string, unknown>;
  if (typeof f.handle !== "string" || f.handle === "") return [];
  return [{
    handle: f.handle,
    name: String(f.name ?? ""),
    path: String(f.path ?? ""),
    kind: f.kind === "directory" ? "directory" : "file",
    size: typeof f.size === "number" ? f.size : 0,
  }];
}

/** Take (and empty) the runtime's queue of drops. */
async function takeDrops(): Promise<FileDrop[]> {
  const raw = await desktopRpc<unknown>(CAP, "takeDrops", {});
  return (Array.isArray(raw) ? raw : []).flatMap((item) => {
    const d = (item ?? {}) as { x?: unknown; y?: unknown; files?: unknown };
    const files = (Array.isArray(d.files) ? d.files : []).flatMap(toDroppedFile);
    if (files.length === 0) return [];
    return [{
      x: typeof d.x === "number" ? d.x : 0,
      y: typeof d.y === "number" ? d.y : 0,
      files,
    }];
  });
}

/**
 * Call `handler` when files or folders are dropped on the window, with a READ-ONLY handle for each
 * (the dropped item is untrusted input: the page reads it through the handle, never by path). The
 * page still gets its own DOM `dragenter` / `dragover` / `drop` events (with `File` objects, for a
 * hover style); this is where the native handles are. Needs denext's pinned runtime (`fileDrop` in
 * {@linkcode windowCapabilities}).
 *
 * @param handler Called once per drop.
 * @returns A function that unsubscribes.
 * @example
 * ```ts
 * import { onFileDrop } from "denext/desktop/window";
 * import { readFile } from "denext/mobile";
 *
 * onFileDrop(async ({ files }) => {
 *   for (const f of files.filter((f) => f.kind === "file")) {
 *     console.log(f.name, await readFile("", { directory: { picked: f.handle } }));
 *   }
 * });
 * ```
 */
export function onFileDrop(handler: (drop: FileDrop) => void): () => void {
  let active = true;
  const stop = subscribeDesktopEvent(CAP, "drop", () => {
    takeDrops().then((drops) => {
      for (const drop of drops) if (active) handler(drop);
    }, () => {});
  });
  return () => {
    active = false;
    stop();
  };
}

/**
 * Drag files out of the window to another app or the desktop, as a copy. Call it while the mouse
 * button is held: from the page's `dragstart` (call `event.preventDefault()` there) or a
 * `pointerdown` followed by a move. Needs denext's pinned runtime (`fileDragOut` in
 * {@linkcode windowCapabilities}).
 *
 * @param items The files: picked handles, or files in the app's folders.
 * @param options `icon`: a PNG (base64) shown under the pointer; the OS's file icon by default.
 * @returns `"dropped"` when a target took the files, `"cancelled"` when the user let go where
 * nothing took them, `"failed"` when the drag never started (no button held, another drag running).
 * @example
 * ```ts
 * import { startFileDrag } from "denext/desktop/window";
 *
 * el.addEventListener("dragstart", (e) => {
 *   e.preventDefault();
 *   void startFileDrag([{ directory: "cache", path: "export/report.pdf" }]);
 * });
 * ```
 */
export async function startFileDrag(
  items: readonly DragOutItem[],
  options: { readonly icon?: string } = {},
): Promise<DragOutResult> {
  const out = await desktopRpc<{ result?: unknown }>(CAP, "startDrag", {
    items: items.map((i) => ({ directory: i.directory, ...(i.path ? { path: i.path } : {}) })),
    ...(options.icon !== undefined ? { icon: options.icon } : {}),
  }, { timeoutMs: false });
  const result = out?.result;
  return result === "dropped" || result === "cancelled" ? result : "failed";
}

/** The slice of a DOM element {@linkcode makeWindowDraggable} uses. */
export interface DraggableElement {
  /** The element's inline style (`app-region: drag` goes here). */
  readonly style: {
    /** Set a CSS property. */
    setProperty(name: string, value: string): void;
    /** Remove a CSS property. */
    removeProperty(name: string): void;
  };
  /** Listen for the pointer events. */
  addEventListener(type: string, listener: (event: Event) => void): void;
  /** Stop listening. */
  removeEventListener(type: string, listener: (event: Event) => void): void;
  /** Keep the pointer while the window moves under it. */
  setPointerCapture?(pointerId: number): void;
  /** Let the pointer go. */
  releasePointerCapture?(pointerId: number): void;
}

/** The interactive elements a drag region leaves alone (they keep their own mouse handling). */
const INTERACTIVE = "button,a,input,select,textarea,label,[contenteditable],[data-no-window-drag]";

/** Whether the engine moves the window itself for `app-region: drag` (Chromium, i.e. CEF). */
function engineHasDragRegions(): boolean {
  const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? "";
  return ua.includes("Chrome/") && !ua.includes("Edg/");
}

/**
 * Screen-position units per CSS pixel. A runtime that reports `dipGeometry` (denext's pinned runtime
 * since 2.9.7-denext.5) moves windows in CSS pixels on every backend; older WebView2 hosts moved
 * them in physical pixels.
 */
function legacyPositionScale(): number {
  const g = globalThis as { navigator?: { userAgent?: string }; devicePixelRatio?: number };
  return (g.navigator?.userAgent ?? "").includes("Edg/") ? g.devicePixelRatio ?? 1 : 1;
}

/**
 * Make `element` a window drag region — what a page needs once the title bar is hidden
 * (`desktop.titleBar: "hidden"`): pressing and dragging it moves the window, like the OS title bar,
 * and a double click does what a double click on a title bar does for this user
 * ({@linkcode TitleBarPreferences.doubleClick}: maximize / restore, minimize, or nothing).
 * Interactive children (buttons, links, inputs, `[data-no-window-drag]`) keep working.
 *
 * It sets CSS `app-region: drag` (the CEF backend moves the window natively, and handles the
 * double click as the OS does) and, on the system WebView backends, moves the window from the
 * pointer through {@linkcode setWindowPosition} and acts on a double click. Off desktop it only
 * sets the CSS (which browsers ignore).
 *
 * @param element The region (a toolbar, a header).
 * @returns A function that turns it back into a normal element.
 */
export function makeWindowDraggable(element: DraggableElement): () => void {
  element.style.setProperty("-webkit-app-region", "drag");
  element.style.setProperty("app-region", "drag");
  const restoreCss = () => {
    element.style.removeProperty("-webkit-app-region");
    element.style.removeProperty("app-region");
  };
  if (engineHasDragRegions() || !hasDesktopBridge()) return restoreCss;
  let scale = legacyPositionScale();
  if (scale !== 1) {
    windowCapabilities().then((caps) => {
      if (caps.dipGeometry) scale = 1;
    }, () => {});
  }
  let drag: { id: number; sx: number; sy: number; origin?: WindowBounds } | undefined;
  let inFlight = false;
  let next: [number, number] | undefined;
  const flush = () => {
    if (inFlight || !next) return;
    const [x, y] = next;
    next = undefined;
    inFlight = true;
    setWindowPosition(x, y).catch(() => {}).finally(() => {
      inFlight = false;
      flush();
    });
  };
  const onDown = (e: Event) => {
    const ev = e as PointerEvent;
    const target = ev.target as { closest?: (s: string) => unknown } | null;
    if (ev.button !== 0 || target?.closest?.(INTERACTIVE)) return;
    const current = { id: ev.pointerId, sx: ev.screenX, sy: ev.screenY } as NonNullable<
      typeof drag
    >;
    drag = current;
    element.setPointerCapture?.(ev.pointerId);
    getWindowState().then((s) => {
      if (drag === current && s.bounds) current.origin = s.bounds;
    }, () => {
      if (drag === current) drag = undefined;
    });
  };
  const onMove = (e: Event) => {
    const ev = e as PointerEvent;
    if (!drag || ev.pointerId !== drag.id || !drag.origin) return;
    next = [
      Math.round(drag.origin.x + (ev.screenX - drag.sx) * scale),
      Math.round(drag.origin.y + (ev.screenY - drag.sy) * scale),
    ];
    flush();
  };
  const onUp = (e: Event) => {
    const ev = e as PointerEvent;
    if (!drag || ev.pointerId !== drag.id) return;
    element.releasePointerCapture?.(ev.pointerId);
    drag = undefined;
  };
  const onDoubleClick = (e: Event) => {
    const ev = e as MouseEvent;
    const target = ev.target as { closest?: (s: string) => unknown } | null;
    if (ev.button !== 0 || target?.closest?.(INTERACTIVE)) return;
    void doubleClickAction().then(runDoubleClick, () => {});
  };
  element.addEventListener("pointerdown", onDown);
  element.addEventListener("pointermove", onMove);
  element.addEventListener("pointerup", onUp);
  element.addEventListener("pointercancel", onUp);
  element.addEventListener("dblclick", onDoubleClick);
  return () => {
    restoreCss();
    element.removeEventListener("pointerdown", onDown);
    element.removeEventListener("pointermove", onMove);
    element.removeEventListener("pointerup", onUp);
    element.removeEventListener("pointercancel", onUp);
    element.removeEventListener("dblclick", onDoubleClick);
    drag = undefined;
  };
}

/**
 * {@linkcode TitleBarPreferences.doubleClick}, read at each double click (the user may have changed
 * it), or `"maximize"` when the runtime can't say.
 */
function doubleClickAction(): Promise<TitleBarDoubleClick> {
  return getTitleBarPreferences().then((p) => p.doubleClick, () => "maximize");
}

/** Do what a double click on a title bar does (shade, lower and the window menu: nothing here). */
async function runDoubleClick(action: TitleBarDoubleClick): Promise<void> {
  if (action === "minimize") return await minimizeWindow();
  if (action !== "maximize") return;
  const state = await getWindowState();
  await (state.maximized ? unmaximizeWindow() : maximizeWindow());
}
