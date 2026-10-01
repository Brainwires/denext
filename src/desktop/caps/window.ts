/**
 * The `window` capability: the page's control over its own Deno Desktop window — state
 * (maximize / minimize / fullscreen), size and size limits, the displays, the title bar and
 * backdrop, a cancelable close, quitting, and files dragged in and out. The page side is
 * `denext/desktop/window`.
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
import { confineRelative } from "../path-scope.ts";
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
  setAlwaysOnTop?(alwaysOnTop: boolean): void;
  setTitleBarStyle?(style: string): boolean;
  setWindowButtonPosition?(position: { x: number; y: number } | null): boolean;
  setBackgroundMaterial?(material: string): boolean;
  setVibrancy?(material: string | null): boolean;
  startDrag?(item: { files: string[]; icon?: Uint8Array }): Promise<string>;
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
  /** The per-launch picked-path set (dropped files land here; drag-out resolves handles). */
  readonly picked?: PickedPaths;
  /** The app's own folders, the only paths (besides handles) a drag-out may carry. */
  readonly dirs?: DesktopAppDirs;
  /** Resolve a dropped path (tests). */
  readonly resolveDropped?: DroppedPathResolver;
  /** The clock (tests). */
  readonly now?: () => number;
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

/** `unsupported` (501): this runtime / backend has no such window feature. */
function unsupported(what: string): DesktopCapError {
  return new DesktopCapError(
    "unsupported",
    `this Deno Desktop runtime cannot ${what} (denext's pinned runtime adds it)`,
    { status: 501 },
  );
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
function capabilitiesOf(
  win: BrowserWindowLike | undefined,
  api: DesktopAppApi | undefined,
): Record<string, boolean> {
  let reported: Record<string, boolean> | undefined;
  try {
    reported = api?.windowCapabilities?.();
  } catch {
    reported = undefined;
  }
  const has = (name: keyof BrowserWindowLike) => typeof win?.[name] === "function";
  return {
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
    fileDialogs: false,
    fileDialogFilesAndDirectories: false,
    fileDialogModal: false,
    ...(reported ?? {}),
    // denext's own: a guarded close needs the pinned runtime's cancelable `close` event.
    closeGuard: typeof api?.quit === "function",
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

/**
 * Create the window controller: the `window` capability, the close hook `runDesktop`'s close
 * listener consults, and the event subscriptions.
 *
 * @param options The adopted window, the runtime API, the emitter and the shared picked-path set.
 * @returns The controller.
 */
export function createWindowController(options: WindowControllerOptions): WindowController {
  const win = typeof options.window === "object" && options.window !== null
    ? options.window as BrowserWindowLike
    : undefined;
  const api = options.api;
  const emit = (event: string, data: unknown) => options.emit("window", event, data);
  const exit = options.exit ?? Deno.exit;
  const picked = options.picked ?? new PickedPaths();
  const resolve = options.resolveDropped ?? resolveDropped;
  const now = options.now ?? Date.now;
  const drops: QueuedDrop[] = [];
  let guard = false;
  let pending: { id: string; at: number; acked: boolean } | undefined;
  let installed = false;

  /** The window, or `unsupported` outside the desktop runtime. */
  const need = (): BrowserWindowLike => {
    if (!win) throw unsupported("reach its window");
    return win;
  };

  /** Call the window method `name` (or `unsupported` when the runtime lacks it). */
  const call = <K extends keyof BrowserWindowLike>(
    name: K,
    what: string,
    ...args: unknown[]
  ): unknown => {
    const w = need();
    const fn = w[name] as ((...a: unknown[]) => unknown) | undefined;
    if (typeof fn !== "function") throw unsupported(what);
    return fn.apply(w, args);
  };

  /** {@link call} for a method whose answer the page does not need. */
  const act = <K extends keyof BrowserWindowLike>(name: K, what: string, ...args: unknown[]) => {
    call(name, what, ...args);
    return null;
  };

  /** Close the window for good and end the process (the single-window app quits). */
  const finishClose = () => {
    guard = false;
    pending = undefined;
    try {
      if (typeof win?.close === "function") win.close();
    } finally {
      // Let the RPC answer flush before the process goes away.
      setTimeout(() => exit(0), 0);
    }
  };

  /** A drag-out item → an absolute path: a picked handle, or a file in the app's folders. */
  const dragPath = async (item: unknown): Promise<string> => {
    const i = argsOf(item);
    const directory = i.directory;
    const rel = typeof i.path === "string" ? i.path : "";
    const handle = typeof directory === "object" && directory !== null
      ? (directory as { picked?: unknown }).picked
      : undefined;
    if (handle !== undefined) return (await picked.resolve(handle, rel, false)).target;
    if (directory !== "data" && directory !== "cache" && directory !== "documents") {
      throw invalid('each item needs directory "data" | "cache" | "documents" | { picked }');
    }
    if (!options.dirs) throw invalid("the app folders are not available");
    if (rel === "") throw invalid("path must name a file in the app folder");
    const target = await confineRelative(options.dirs[directory], rel);
    try {
      await Deno.stat(target);
    } catch {
      throw new DesktopCapError("not_found", "a dragged file does not exist", { status: 404 });
    }
    return target;
  };

  const acceptDrop = async (detail: unknown): Promise<void> => {
    const files: DroppedFile[] = [];
    for (const path of dropPaths(detail)) {
      const found = await resolve(path);
      if (!found) continue;
      const handle = picked.add(found.real, found.kind === "directory" ? "readFolder" : "read");
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
    enqueue(drops, { x: coord(d.x), y: coord(d.y), files }, MAX_QUEUED_DROPS);
    emit("drop", null);
  };

  const capability: DesktopCapability = {
    name: "window",
    events: ["state", "display", "closeRequested", "drop"],
    onPageLoad: () => {
      // The page that guarded the close, or that files were dropped on, is gone.
      guard = false;
      pending = undefined;
      drops.length = 0;
    },
    methods: {
      capabilities: { handler: () => capabilitiesOf(win, api) },
      state: { handler: () => stateOf(need()) },
      screens: {
        handler: () => {
          if (typeof api?.screens !== "function") throw unsupported("list the displays");
          return api.screens();
        },
      },
      maximize: { handler: () => act("maximize", "maximize") },
      unmaximize: { handler: () => act("unmaximize", "unmaximize") },
      minimize: { handler: () => act("minimize", "minimize") },
      restore: { handler: () => act("restore", "restore") },
      setFullScreen: {
        handler: (args) =>
          act(
            "setFullScreen",
            "go fullscreen",
            bool(argsOf(args).fullscreen, "fullscreen"),
          ),
      },
      show: { handler: () => act("show", "show the window") },
      hide: { handler: () => act("hide", "hide the window") },
      focus: { handler: () => act("focus", "focus the window") },
      setSize: {
        handler: (args) => act("setSize", "resize", ...sizeArgs(args, 1)),
      },
      setPosition: {
        handler: (args) => {
          const a = argsOf(args);
          call("setPosition", "move", num(a.x, "x"), num(a.y, "y"));
          return null;
        },
      },
      setBounds: {
        handler: (args) => {
          const a = argsOf(args);
          const bounds: Record<string, number> = {};
          for (const key of ["x", "y"] as const) {
            if (a[key] !== undefined) bounds[key] = num(a[key], key);
          }
          for (const key of ["width", "height"] as const) {
            if (a[key] !== undefined) bounds[key] = num(a[key], key, 1);
          }
          call("setBounds", "set its bounds", bounds);
          return null;
        },
      },
      setMinimumSize: {
        handler: (args) => act("setMinimumSize", "limit its size", ...sizeArgs(args, 0)),
      },
      setMaximumSize: {
        handler: (args) => act("setMaximumSize", "limit its size", ...sizeArgs(args, 0)),
      },
      setTitle: {
        handler: (args) => {
          const title = argsOf(args).title;
          if (typeof title !== "string" || title.length > 1024) {
            throw invalid("title must be a string up to 1024 characters");
          }
          call("setTitle", "set its title", title);
          return null;
        },
      },
      setResizable: {
        handler: (args) =>
          act("setResizable", "change resizability", bool(argsOf(args).resizable, "resizable")),
      },
      setAlwaysOnTop: {
        handler: (args) =>
          act(
            "setAlwaysOnTop",
            "stay on top",
            bool(argsOf(args).alwaysOnTop, "alwaysOnTop"),
          ),
      },
      setTitleBarStyle: {
        handler: (args) => {
          const style = argsOf(args).style;
          if (style !== "default" && style !== "hidden" && style !== "hiddenInset") {
            throw invalid('style must be "default", "hidden" or "hiddenInset"');
          }
          return { applied: call("setTitleBarStyle", "style its title bar", style) === true };
        },
      },
      setWindowButtonPosition: {
        handler: (args) => {
          const p = argsOf(args).position;
          const position = p === null || p === undefined ? null : {
            x: num(argsOf(p).x, "position.x", 0),
            y: num(argsOf(p).y, "position.y", 0),
          };
          const applied = call("setWindowButtonPosition", "move its window buttons", position);
          return { applied: applied === true };
        },
      },
      setBackdrop: {
        handler: (args) => {
          const a = argsOf(args);
          const backdrop = a.backdrop;
          if (backdrop === "vibrancy") {
            const material = typeof a.material === "string" ? a.material : DEFAULT_VIBRANCY;
            try {
              return { applied: call("setVibrancy", "show vibrancy", material) === true };
            } catch (err) {
              if (err instanceof TypeError) throw invalid(`unknown vibrancy material`);
              throw err;
            }
          }
          if (backdrop === "none") {
            const w = need();
            const cleared = [
              typeof w.setVibrancy === "function" ? w.setVibrancy(null) : false,
              typeof w.setBackgroundMaterial === "function"
                ? w.setBackgroundMaterial("none")
                : false,
            ];
            return { applied: cleared.some((c) => c === true) };
          }
          if (backdrop !== "mica" && backdrop !== "acrylic" && backdrop !== "tabbed") {
            throw invalid('backdrop must be "none", "mica", "acrylic", "tabbed" or "vibrancy"');
          }
          return { applied: call("setBackgroundMaterial", "show a backdrop", backdrop) === true };
        },
      },
      setCloseGuard: {
        handler: (args) => {
          const enabled = bool(argsOf(args).enabled, "enabled");
          if (enabled && typeof api?.quit !== "function") throw unsupported("guard its close");
          guard = enabled;
          if (!enabled) pending = undefined;
          return null;
        },
      },
      closeAck: {
        handler: (args) => {
          const id = argsOf(args).id;
          if (pending === undefined || pending.id !== id) return { current: false };
          pending.acked = true;
          return { current: true };
        },
      },
      closeRespond: {
        handler: (args) => {
          const a = argsOf(args);
          if (pending === undefined || pending.id !== a.id) return { closing: false };
          pending = undefined;
          if (a.close !== true) return { closing: false };
          finishClose();
          return { closing: true };
        },
      },
      close: {
        handler: () => {
          finishClose();
          return null;
        },
      },
      quit: {
        handler: () => {
          // Electron's app.quit(): a guarded close keeps the app running (and asks the page).
          if (typeof api?.quit === "function") return { quitting: api.quit() === true };
          finishClose();
          return { quitting: true };
        },
      },
      takeDrops: { handler: () => drops.splice(0, drops.length) },
      startDrag: {
        timeoutMs: false, // the drag lasts as long as the user holds the button
        handler: async (args) => {
          const a = argsOf(args);
          if (!Array.isArray(a.items) || a.items.length === 0 || a.items.length > MAX_DRAG_FILES) {
            throw invalid(`items must be 1 to ${MAX_DRAG_FILES} files`);
          }
          const files: string[] = [];
          for (const item of a.items) files.push(await dragPath(item));
          let icon: Uint8Array | undefined;
          if (a.icon !== undefined) {
            if (typeof a.icon !== "string" || a.icon.length > MAX_ICON_CHARS) {
              throw invalid("icon must be base64 PNG bytes up to 1.5 MiB");
            }
            icon = base64ToBytes(a.icon);
          }
          const result = await call("startDrag", "drag files out", {
            files,
            ...(icon ? { icon } : {}),
          });
          return { result: result === "dropped" || result === "cancelled" ? result : "failed" };
        },
      },
    },
  };

  return {
    capability,
    acceptDrop,
    interceptClose: (event) => {
      if (!guard) return false;
      const at = now();
      if (pending && !pending.acked && at - pending.at >= UNRESPONSIVE_MS) {
        // The page never acknowledged the last request: it cannot keep the window open.
        pending = undefined;
        return false;
      }
      event.preventDefault();
      if (!pending) {
        pending = { id: crypto.randomUUID(), at, acked: false };
        emit("closeRequested", { id: pending.id });
      }
      return true;
    },
    install: () => {
      if (installed || !win) return;
      installed = true;
      for (const type of STATE_EVENTS) win.addEventListener(type, () => emit("state", null));
      win.addEventListener("drop", (e) => void acceptDrop((e as CustomEvent).detail));
      api?.addEventListener?.("displaychanged", () => emit("display", null));
    },
  };
}
