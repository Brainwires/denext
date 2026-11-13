/**
 * How `runDesktop` sets up the app's windows and chrome: the window registry over the adopted main
 * window (each window's `window` capability, the `windows` capability), the `app` capability, the
 * launch settings of `desktop.app` (`keepAlive`, `dock`) and `desktop.window` (always on top,
 * opacity, taskbar, workspaces), the macOS Dock's reopen click (the most recently closed keyed
 * window, `runDesktop({ onDockReopen })`'s window, else the main window), a second launch of a
 * single-instance app (`runDesktop({ onSecondInstance })`, else the Dock's default with no window
 * showing), the backend tray and its panel, and what `desktop.ts` gets to drive them
 * (`DesktopRuntime.windows`, `.tray`, `.setDockVisible`, `.onDockReopen`).
 *
 * Runtime-only (imported by `runDesktop`, never a client bundle).
 *
 * @module
 */

import type { DesktopWillNavigateHandler } from "./will-navigate.ts";
import {
  type ActivationPolicy,
  type AppController,
  createAppController,
  type DockLike,
} from "./caps/app.ts";
import { createWindowController } from "./caps/window.ts";
import type { DesktopCapability } from "./extension.ts";
import type { DesktopAppApi } from "./launch-events.ts";
import type { DesktopAppDirs } from "./app-dirs.ts";
import type { PickedPaths } from "./picked-paths.ts";
import {
  type DesktopTrayHandle,
  type DesktopTrayOptions,
  startBackendTray,
} from "./backend-tray.ts";
import {
  type DesktopTraySettings,
  panelPlacementScreens,
  type PlacementScreen,
} from "./tray-config.ts";
import { platformFacts } from "./caps/platform.ts";
import { supportsInitialOverlay } from "../build/deno-version.ts";
import {
  type ClosedWindow,
  createWindowRegistry,
  type RegisteredWindow,
  type RegistryWindow,
  type WindowConstructor,
  type WindowRegistry,
} from "./window-registry.ts";
import { registerAppLifecycle, type WindowLifecycle } from "./window-lifecycle.ts";
import { type DockPresence, startDockHelper } from "./dock-helper.ts";
import {
  createWindowMenu,
  type DesktopNewWindowHandler,
  type DesktopWindowMenuItemHandler,
  type WindowMenu,
} from "./window-menu.ts";
import type { DesktopMenuSettings } from "./menu-config.ts";
import type { SessionWindow } from "./window-store.ts";
import type { CreateWebViewOptions, WebViewHandle } from "./webview.ts";
import type { DesktopWebViewSettings } from "./webview-config.ts";
import {
  applyDesktopWindowSettings,
  type DesktopAppSettings,
  type DesktopWindowSettings,
  withDefaultWindowSize,
} from "./window-config.ts";

/** One of the app's windows, as `desktop.ts` drives it (`DesktopRuntime.windows`). */
export interface DesktopWindowRef {
  /** Its id (`"main"`, `"panel"`, `"window-1"`, …): what pages' handles name it by. */
  readonly id: string;
  /** What it is. */
  readonly kind: "main" | "panel" | "window";
  /** The app-chosen key it was opened with (`windows.open({ key })`), if any. */
  readonly key?: string;
  /** The runtime's `Deno.BrowserWindow`. */
  readonly window: unknown;
  /** Show it. */
  show(): void;
  /** Hide it. */
  hide(): void;
  /**
   * Bring it to the front and focus it. On macOS it activates the app without changing the
   * activation policy: how an accessory (tray) app shows its window with no Dock icon.
   */
  focus(): void;
  /** Close it for good (the app quits once its last window is gone, unless kept alive). */
  close(): void;
  /** Load another page of the app (`"/settings"`). */
  navigate(path: string): void;
  /** Whether it is showing (`true` where the runtime cannot say). */
  readonly visible: boolean;
  /** Where it is on screen, or `null` where the runtime cannot say (Wayland, an older runtime). */
  getBounds(): { x: number; y: number; width: number; height: number } | null;
  /**
   * Call `handler` once the window has closed for good (by the user, `close()` or its page). A
   * handler added after it closed is never called. Returns the unsubscribe.
   */
  onClosed(handler: () => void): () => void;
  /**
   * Open an embedded web view of another site inside this window, above its page (the page's
   * `createWebView` from `denext/desktop/window`, owned by `desktop.ts`): the same checks
   * (`http:` / `https:` only, never the app's own origin, `desktop.webViews.allowedOrigins`) and
   * the same per-window `desktop.webViews.limit`, shared with the views its pages made. The view
   * closes with the window; its events reach this handle only, never the page.
   *
   * @param options The URL, where it sits (CSS pixels of the window's page viewport) and its
   *   policies.
   * @returns Its handle (`capture` resolves a `Blob`). Rejects with a `DesktopCapError`:
   *   `unsupported` on a runtime without web views, `not_allowed_url`, `limit`, `validation`.
   */
  createWebView(options: CreateWebViewOptions): Promise<WebViewHandle>;
}

/** The options of a window `desktop.ts` or a page opens (`openWindow` in `denext/desktop/window`). */
export interface DesktopOpenWindowOptions {
  /** The page: a path of the app (`"/vm?id=1"`). */
  readonly url: string;
  /** The title. */
  readonly title?: string;
  /** Width in CSS pixels (over a saved frame and {@linkcode defaultWidth}). */
  readonly width?: number;
  /** Height in CSS pixels (over a saved frame and {@linkcode defaultHeight}). */
  readonly height?: number;
  /**
   * The width when neither `width` nor the key's saved frame gives one (a first open, no `key`,
   * or `restoreBounds: false`): `width` > the saved frame > `defaultWidth` > the runtime's size.
   */
  readonly defaultWidth?: number;
  /** The height when neither `height` nor the key's saved frame gives one. */
  readonly defaultHeight?: number;
  /**
   * The title bar style (macOS; elsewhere the runtime answers it has none): default
   * `desktop.titleBar`, as the main window gets it. `"default"` keeps the OS's title bar; a
   * frameless window has none to style.
   */
  readonly titleBar?: "default" | "hidden" | "hiddenInset";
  /**
   * Where the macOS traffic lights sit (the close button's top-left corner, in points from the
   * window's top-left): default `desktop.window.windowButtonPosition`, as the main window gets it;
   * `null` keeps the OS's place. A frameless window has none.
   */
  readonly windowButtonPosition?: { readonly x: number; readonly y: number } | null;
  /**
   * Whether the native title bar draws the title text: default `desktop.window.titleVisibility`,
   * as the main window gets it. `"hidden"` keeps the title bar, its buttons and its drag area.
   */
  readonly titleVisibility?: "visible" | "hidden";
  /**
   * The macOS toolbar style that lays the title bar out: default `desktop.window.toolbarStyle`, as
   * the main window gets it. Refused with the `"hidden"` title bar and on a frameless window.
   */
  readonly toolbarStyle?: "automatic" | "unified" | "unifiedCompact" | "expanded";
  /**
   * The smallest size the user can resize it to, in CSS pixels: default `desktop.minSize`, as the
   * main window gets it. Each side 1 to 10000; refused `validation` when larger than the
   * `maxSize` it ends up with (its own or the inherited one).
   */
  readonly minSize?: { readonly width: number; readonly height: number };
  /** The largest size the user can resize it to: default `desktop.maxSize`, as the main window gets it. */
  readonly maxSize?: { readonly width: number; readonly height: number };
  /** Screen x of the top-left corner. */
  readonly x?: number;
  /** Screen y of the top-left corner. */
  readonly y?: number;
  /** Whether the user can resize it (default `true`). */
  readonly resizable?: boolean;
  /** No title bar or chrome. */
  readonly frameless?: boolean;
  /** A transparent background (macOS, Linux with the system WebView, Windows from runtime 3.0.0-denext.6). */
  readonly transparent?: boolean;
  /**
   * A desktop overlay surface (runtime `3.0.0-denext.6`+): on a Wayland compositor with
   * wlr-layer-shell (wlroots, KDE Plasma, COSMIC) a layer above every window, on every workspace and
   * out of the task list (`layerShell` in the window capabilities); an ordinary window elsewhere.
   */
  readonly overlay?: boolean;
  /** `false`: a non-activating panel that never takes the focus. */
  readonly focusable?: boolean;
  /** Float above other windows (`true` = `"floating"`, or a level). */
  readonly alwaysOnTop?: boolean | "floating" | "status" | "pop-up-menu" | "screen-saver";
  /** The window's opacity, 0–1. */
  readonly opacity?: number;
  /** Off the taskbar (where the runtime can). */
  readonly skipTaskbar?: boolean;
  /** On every Space / virtual desktop (where the runtime can). */
  readonly visibleOnAllWorkspaces?: boolean;
  /**
   * `false`: its page keeps its timers' rate while the window is not on screen (Electron's
   * `backgroundThrottling`; default `true`, throttled, never frozen). Creation time only; runtime
   * 3.0.0-denext.8 (an older one ignores it).
   */
  readonly backgroundThrottling?: boolean;
  /** Show it once created (default `true`). */
  readonly show?: boolean;
  /** The capabilities its pages may call (default: all; `window` always). */
  readonly capabilities?: readonly string[];
  /**
   * An app-chosen key, unique among the open windows (a duplicate is a `validation` error): 1 to
   * 64 letters, digits, `.`, `_`, `:` or `-`. The window is found again with
   * {@linkcode DesktopWindows.byKey}; its frame (bounds and display) is saved to the app support
   * folder as it moves and when it closes, and restored the next time the key opens; and it is in
   * the next launch's {@linkcode DesktopWindows.lastSession} when the app quits with it open.
   */
  readonly key?: string;
  /**
   * With a `key`: whether the saved frame fills in the bounds this call leaves out (`x`, `y`,
   * `width`, `height`; default `true`). The result is clamped onto a display connected now; macOS
   * Spaces are not restored.
   */
  readonly restoreBounds?: boolean;
}

/** The app's windows, as `desktop.ts` drives them (`DesktopRuntime.windows`). */
export interface DesktopWindows {
  /** Open a window on a page of the app. Throws on bad options or with no desktop runtime. */
  open(options: DesktopOpenWindowOptions): DesktopWindowRef;
  /** A window by id, or `undefined` once it closed. */
  get(id: string): DesktopWindowRef | undefined;
  /** The open window opened with `key`, or `undefined`. */
  byKey(key: string): DesktopWindowRef | undefined;
  /** The open windows. */
  list(): DesktopWindowRef[];
  /**
   * The keyed windows open when the app last quit (each with its key, app path and saved bounds),
   * from the window store in the app support folder; `desktop.app.restoreWindows: true` reopens
   * them at launch. Empty on the first launch, or when the store could not be read.
   */
  lastSession(): readonly SessionWindow[];
  /**
   * Forget the keyed window `key`: it leaves the windows Reopen Closed Window and the Dock's
   * reopen click bring back (the Window menu follows) and {@linkcode lastSession}, as persisted in
   * the window store, so the next launch does not restore it either. Its saved frame is kept, and
   * an open window with the key is not affected (it is in the next session if open at the quit).
   */
  forget(key: string): void;
}

/** What `runDesktop({ onDockReopen })` receives: the keyed windows the user closed. */
export interface DesktopDockReopenContext {
  /** The keyed windows the user closed (not a quit's), most recent first, each key once. */
  readonly closed: readonly ClosedWindow[];
}

/**
 * What the macOS Dock icon's click opens when no window is showing (`runDesktop({ onDockReopen
 * })`): the open options, or `undefined` for nothing at all. Without it the click reopens the
 * most recently closed keyed window, else shows the main window.
 */
export type DesktopDockReopenHandler = (
  ctx: DesktopDockReopenContext,
) => DesktopOpenWindowOptions | undefined;

/** A Dock icon click as {@linkcode DesktopWindowsSetup.onDockReopen} reports it. */
export interface DesktopDockReopenEvent {
  /** Whether a window of the app was showing (the click then only activates the app). */
  readonly hasVisibleWindows: boolean;
}

/**
 * A later launch of the app while it runs, forwarded by the single-instance lock
 * (`desktop.app.singleInstance`; `Deno.desktop`'s `"secondinstance"`).
 */
export interface DesktopSecondInstanceEvent {
  /** The second launch's command-line arguments, after the executable. */
  readonly args: readonly string[];
  /** The second launch's working directory. */
  readonly cwd: string;
}

/**
 * What a second launch of the app opens (`runDesktop({ onSecondInstance })`): called for every
 * one, window showing or not, it answers the open options, or `undefined` for nothing more.
 * Without it a second launch with no window showing opens what the Dock's reopen would.
 */
export type DesktopSecondInstanceHandler = (
  event: DesktopSecondInstanceEvent,
) => DesktopOpenWindowOptions | undefined;

/** What {@linkcode setUpDesktopWindows} needs. */
export interface DesktopWindowsOptions {
  /** The adopted main window (`undefined` outside the desktop runtime). */
  readonly window: unknown;
  /** The runtime's `Deno.BrowserWindow` (to open more). */
  readonly BrowserWindow?: unknown;
  /** `Deno.desktop`. */
  readonly api?: DesktopAppApi;
  /** `Deno.dock` (default the runtime's). */
  readonly dock?: DockLike;
  /** Push an event to the pages: every window's, or `target`'s. */
  readonly emit: (cap: string, event: string, data: unknown, target?: string) => void;
  /** `desktop.window` / `desktop.titleBar` / … as resolved. */
  readonly windowSettings?: DesktopWindowSettings;
  /** `desktop.app`'s `keepAlive` / `dock`. */
  readonly appSettings?: DesktopAppSettings;
  /** Whether the app has a backend tray (config or `runDesktop({ tray })`). */
  readonly wantsTray: boolean;
  /** The picked-path set (dropped files). */
  readonly picked?: PickedPaths;
  /** The app's own folders (drag-out). */
  readonly dirs?: DesktopAppDirs;
  /** `desktop.webViews` as resolved (default: 8 per window, any http(s) origin). */
  readonly webViews?: DesktopWebViewSettings;
  /**
   * The app's own origins besides the one its pages load from (`desktop.app.origin`, a dev
   * server's): a web view never loads them.
   */
  readonly appOrigins?: () => readonly string[];
  /** The app support folder (the window store's home; none: frames kept for this launch only). */
  readonly appSupportDir?: string;
  /** `desktop.menu` as resolved (the standard window items). */
  readonly menuSettings?: DesktopMenuSettings;
  /** `desktop.ts`'s New Window (`runDesktop({ newWindow })`). */
  readonly newWindow?: DesktopNewWindowHandler;
  /** `desktop.ts`'s Dock reopen (`runDesktop({ onDockReopen })`). */
  readonly onDockReopen?: DesktopDockReopenHandler;
  /** `desktop.ts`'s handler of the app's own Window-menu items (`runDesktop({ onWindowMenuItem })`). */
  readonly onWindowMenuItem?: DesktopWindowMenuItemHandler;
  /** `desktop.ts`'s second launch (`runDesktop({ onSecondInstance })`). */
  readonly onSecondInstance?: DesktopSecondInstanceHandler;
  /** End the process (default `Deno.exit`). */
  readonly exit?: (code: number) => void;
  /** The running OS (default `Deno.build.os`). */
  readonly os?: string;
  /** Where warnings go. */
  readonly warn?: (message: string) => void;
  /**
   * The Deno Desktop runtime's version (default `Deno.version.deno`): from `3.0.0-denext.7` the
   * main window with `desktop.window.overlay` and the tray panel are layer-shell overlays where
   * the compositor has layer-shell, so they report `setPosition` on Wayland; from
   * `FIRST_APP_MENU_EVENT_RUNTIME` the application menu's clicks come from `Deno.desktop`.
   */
  readonly runtimeVersion?: string;
}

/** What {@linkcode setUpDesktopWindows} returns. */
export interface DesktopWindowsSetup {
  /** The `window`, `windows` and `app` capabilities (none outside the desktop runtime). */
  readonly capabilities: DesktopCapability[];
  /** The registry (`undefined` outside the desktop runtime). */
  readonly registry?: WindowRegistry;
  /** The `app` controller (`undefined` outside the desktop runtime). */
  readonly app?: AppController;
  /** Whether the app stays up with no window. */
  keepAlive(): boolean;
  /** The main window's close listener hook: `true` when a guard took the close over. */
  interceptMainClose(event: Event): boolean;
  /** The main window closed (by the user): drop it, then quit unless kept alive. */
  mainClosed(): void;
  /** A page's `window.close()` (its window token, if it has one): close that window. */
  closeFromPage(windowToken: string | null | undefined): void;
  /** Subscribe to the runtime's events (once the bridge exists). */
  install(): void;
  /**
   * Make the backend tray and its panel (before the server starts, so the first page finds it).
   * `appUrl` turns an app path into the URL a window loads; `readFile` reads the export.
   */
  startTray(ctx: {
    readonly options?: DesktopTrayOptions;
    readonly settings?: DesktopTraySettings;
    readonly appUrl: (path: string) => string;
    readonly readFile: (path: string) => Promise<Uint8Array | null>;
  }): Promise<DesktopTrayHandle | undefined>;
  /** The app's windows for `desktop.ts`. */
  readonly windows: DesktopWindows;
  /** Show or hide the macOS Dock icon; whether it applied. */
  setDockVisible(visible: boolean): boolean;
  /**
   * Set the macOS activation policy (on Windows and Linux the main window's taskbar entry); whether
   * it applied.
   */
  setActivationPolicy(policy: ActivationPolicy): boolean;
  /** The macOS activation policy, or `null` where there is none. */
  getActivationPolicy(): ActivationPolicy | null;
  /**
   * Call `fn` on every click on the macOS Dock icon (the runtime's `Deno.dock` `"reopen"`), with
   * whether a window was showing; the built-in reopen still runs. Returns the unsubscribe (a no-op
   * where there is no Dock).
   */
  onDockReopen(fn: (event: DesktopDockReopenEvent) => void): () => void;
  /** Set the URL resolver new windows load with (known once the server listens). */
  setAppUrl(appUrl: (path: string) => string): void;
  /** The window lifecycle (the extensions' hooks and quit guards; `undefined` outside the runtime). */
  readonly lifecycle?: WindowLifecycle;
  /** The standard window items of the application menu (`desktop.menu.window`), if configured. */
  readonly menu?: WindowMenu;
  /**
   * Reopen the keyed windows of the last session (`desktop.app.restoreWindows`), once the app URL
   * is known; how many were reopened (a window that cannot be reopened is a warning).
   */
  restoreSession(): number;
  /**
   * Call `fn` once per click on one of the app's own Window-menu items
   * (`desktop.menu.window.items`), after `runDesktop({ onWindowMenuItem })`'s handler: an
   * extension host's `onWindowMenuItem`. Returns the unsubscribe.
   */
  onWindowMenuItem(fn: DesktopWindowMenuItemHandler): () => void;
  /**
   * Call `fn` on every second launch of the app (`Deno.desktop`'s `"secondinstance"`), after what
   * `runDesktop({ onSecondInstance })` opens: an extension host's `onSecondInstance`, or a
   * capability's static hook. A throw or a rejection is a warning. Returns the unsubscribe (a
   * subscription nothing calls without the pinned runtime).
   */
  onSecondInstance(fn: DesktopSecondInstanceListener): () => void;
}

/** A subscriber to the app's second launches (an extension's). */
export type DesktopSecondInstanceListener = (
  event: DesktopSecondInstanceEvent,
) => void | Promise<void>;

/** The setup's state. */
interface SetupState {
  readonly options: DesktopWindowsOptions;
  readonly dock: DockLike | undefined;
  readonly os: string;
  readonly warn: (message: string) => void;
  registry?: WindowRegistry;
  app?: AppController;
  menu?: WindowMenu;
  appUrl: (path: string) => string;
  hasTray: boolean;
  /** `desktop.ts`'s `onClosed` handlers, by window id. */
  readonly closedHandlers: Map<string, Set<() => void>>;
  /** The extensions' handlers of the app's own Window-menu items. */
  readonly menuItemHandlers: Set<DesktopWindowMenuItemHandler>;
  /** The extensions' second-launch subscribers. */
  readonly secondInstanceHandlers: Set<DesktopSecondInstanceListener>;
  /** The Dock helper's presence (`desktop.app.dock: "while-window-open"`, macOS), once started. */
  dockPresence?: DockPresence;
}

/** The runtime's `Deno.dock`, when present. */
function runtimeDock(): DockLike | undefined {
  const d = (Deno as unknown as { dock?: unknown }).dock;
  return typeof d === "object" && d !== null ? d as DockLike : undefined;
}

/** `keepAlive`: as configured, else on when the app has a tray. */
function keepAliveOf(st: SetupState): boolean {
  return st.options.appSettings?.keepAlive ?? st.hasTray;
}

/**
 * Tell the runtime whether the app quits with its last window (`Deno.desktop`): not when it is
 * kept alive, and not while the lifecycle has quit hooks to run first — the registry then ends the
 * process itself once they ran, where the runtime would end the loop before they could.
 */
function applyKeepAlive(st: SetupState): void {
  const api = st.options.api;
  if (!api || !("quitOnLastWindowClosed" in api)) return;
  try {
    api.quitOnLastWindowClosed = !keepAliveOf(st) &&
      !(st.registry?.lifecycle.hasQuitWork() ?? false);
  } catch { /* a runtime with a read-only flag */ }
}

/** Show / hide the Dock icon (macOS); on Windows and Linux, the main window's taskbar entry. */
function setDock(st: SetupState, visible: boolean): boolean {
  if (st.os === "darwin") {
    if (typeof st.dock?.setVisible !== "function") return false;
    st.dock.setVisible(visible);
    return true;
  }
  const main = st.registry?.get("main")?.window as { setSkipTaskbar?(skip: boolean): void };
  if (typeof main?.setSkipTaskbar !== "function") return false;
  main.setSkipTaskbar(!visible);
  return true;
}

/**
 * Set the macOS activation policy (`Deno.dock.setActivationPolicy`, runtime `3.0.0-denext.6`+);
 * on an older runtime `"regular"` / `"accessory"` show / hide the Dock icon instead. On Windows and
 * Linux, which have no policy, `"regular"` shows the main window's taskbar entry and the others
 * hide it, as `desktop.app.activationPolicy: "accessory"` hides it at launch.
 */
function setPolicy(st: SetupState, policy: ActivationPolicy): boolean {
  if (st.os !== "darwin") return setDock(st, policy === "regular");
  if (!st.dock) return false;
  if (typeof st.dock.setActivationPolicy === "function") {
    return st.dock.setActivationPolicy(policy) === true;
  }
  if (policy === "prohibited") return false;
  return setDock(st, policy === "regular");
}

/** The macOS activation policy, or `null` (no `Deno.dock.getActivationPolicy`, not macOS). */
function getPolicy(st: SetupState): ActivationPolicy | null {
  if (st.os !== "darwin") return null;
  return st.dock?.getActivationPolicy?.() ?? null;
}

/**
 * Whether the app starts with no Dock icon: `desktop.app.activationPolicy: "accessory"`,
 * `desktop.app.dock: false`, or (macOS only: elsewhere a window's taskbar entry already lasts as
 * long as the window) `dock: "while-window-open"`. From runtime `3.0.0-denext.6` the launch file
 * already started it so; applying it again here covers an older runtime (where the icon shows until
 * now).
 */
function startsAccessory(st: SetupState): boolean {
  const app = st.options.appSettings;
  return app?.activationPolicy === "accessory" || app?.dock === false ||
    (app?.dock === "while-window-open" && st.os === "darwin");
}

/** The app's own origins: the one its pages load from, and the configured / dev ones. */
function appOrigins(st: SetupState): string[] {
  const out = [...(st.options.appOrigins?.() ?? [])];
  try {
    out.push(new URL(st.appUrl("/")).origin);
  } catch { /* no app URL yet */ }
  return out;
}

/** A registered window as `desktop.ts` sees it. */
function ref(st: SetupState, entry: RegisteredWindow): DesktopWindowRef {
  const w = entry.window;
  return {
    id: entry.id,
    kind: entry.kind,
    ...(entry.key !== undefined ? { key: entry.key } : {}),
    window: w,
    show: () => w.show?.(),
    hide: () => w.hide?.(),
    focus: () => w.focus?.(),
    close: () => st.registry?.close(entry.id),
    navigate: (path) => {
      const at = st.registry?.get(entry.id);
      if (!at) return;
      st.registry?.navigate(entry.id, path);
    },
    get visible() {
      try {
        return w.isVisible?.() ?? true;
      } catch {
        return false; // closing
      }
    },
    getBounds: () => {
      try {
        return w.getBounds?.() ?? null;
      } catch {
        return null; // closing, or no position here
      }
    },
    createWebView: (options) => entry.controller.createWebView(options),
    onClosed: (handler) => {
      if (st.registry?.get(entry.id)?.window !== w) return () => {};
      let set = st.closedHandlers.get(entry.id);
      if (!set) st.closedHandlers.set(entry.id, set = new Set());
      const once = () => handler();
      set.add(once);
      return () => void set.delete(once);
    },
  };
}

/** Window `id` closed for good: run `desktop.ts`'s handlers for it (each once). */
function runClosedHandlers(st: SetupState, id: string): void {
  const set = st.closedHandlers.get(id);
  st.closedHandlers.delete(id);
  for (const handler of set ?? []) {
    try {
      handler();
    } catch (err) {
      st.warn(`a window's onClosed handler threw: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** The `DesktopRuntime.windows` API. */
function windowsApi(st: SetupState): DesktopWindows {
  return {
    open: (options) => {
      if (!st.registry) throw new Error("desktop: no desktop runtime to open a window in");
      return ref(st, st.registry.open(options));
    },
    get: (id) => {
      const entry = st.registry?.get(id);
      return entry ? ref(st, entry) : undefined;
    },
    byKey: (key) => {
      const entry = st.registry?.byKey(key);
      return entry ? ref(st, entry) : undefined;
    },
    list: () => st.registry?.list().map((e) => ref(st, e)) ?? [],
    lastSession: () => st.registry?.lastSession() ?? [],
    forget: (key) => {
      if (st.registry?.forget(key)) st.menu?.refresh();
    },
  };
}

/** Reopen the last session's keyed windows (`desktop.app.restoreWindows`); how many reopened. */
function restoreSession(st: SetupState): number {
  if (st.options.appSettings?.restoreWindows !== true || !st.registry) return 0;
  let n = 0;
  for (const { key, url } of st.registry.lastSession()) {
    if (st.registry.byKey(key)) continue; // opened already (desktop.ts did)
    try {
      st.registry.open({ url, key });
      n++;
    } catch (err) {
      st.warn(
        `the window "${key}" of the last session could not be reopened: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }
  return n;
}

/** Whether a Dock `"reopen"` event says a window was showing. */
function hadVisibleWindows(event: Event): boolean {
  return (event as CustomEvent<{ hasVisibleWindows?: unknown }>).detail?.hasVisibleWindows === true;
}

/**
 * The macOS Dock icon was clicked with no window showing: `desktop.ts`'s window
 * (`runDesktop({ onDockReopen })`, `undefined` for none), else the most recently closed keyed
 * window, else the main window shown again. A window that cannot open is a warning.
 */
function onDockReopen(st: SetupState, event: Event): void {
  const registry = st.registry;
  if (hadVisibleWindows(event) || !registry) return;
  const options = dockReopenWindow(st, registry);
  if (!options) return;
  try {
    registry.open(options);
  } catch (err) {
    st.warn(
      `the Dock's reopen could not open a window: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * The window the Dock's reopen opens: `desktop.ts`'s, else the most recently closed keyed one;
 * with neither, the main window is shown again and nothing opens.
 */
function dockReopenWindow(
  st: SetupState,
  registry: WindowRegistry,
): DesktopOpenWindowOptions | undefined {
  const handler = st.options.onDockReopen;
  if (handler) return handler({ closed: registry.recentlyClosed() });
  return defaultReopenWindow(registry);
}

/**
 * The reopen with no handler (the Dock's, a second launch's): the most recently closed keyed
 * window's options, else the main window shown again and `undefined`.
 */
function defaultReopenWindow(registry: WindowRegistry): DesktopOpenWindowOptions | undefined {
  const last = registry.takeRecentlyClosed();
  if (last) return { url: last.url, key: last.key };
  const main = registry.get("main")?.window;
  main?.show?.();
  main?.focus?.();
  return undefined;
}

/** Subscribe `fn` to the Dock's `"reopen"` clicks; the unsubscribe. */
function subscribeDockReopen(
  dock: DockLike | undefined,
  fn: (event: DesktopDockReopenEvent) => void,
): () => void {
  if (!dock) return () => {};
  const listener = (e: Event) => fn({ hasVisibleWindows: hadVisibleWindows(e) });
  dock.addEventListener("reopen", listener);
  return () => dock.removeEventListener("reopen", listener);
}

/** A `"secondinstance"` event's arguments and working directory (malformed parts read as none). */
function secondInstanceOf(event: Event): DesktopSecondInstanceEvent {
  const detail = (event as CustomEvent<{ args?: unknown; cwd?: unknown }>).detail;
  const args = Array.isArray(detail?.args)
    ? detail.args.filter((a): a is string => typeof a === "string")
    : [];
  return { args, cwd: typeof detail?.cwd === "string" ? detail.cwd : "" };
}

/** Whether one of the app's windows (not the tray panel) is showing. */
function hasShowingWindow(registry: WindowRegistry): boolean {
  return registry.list().some((entry) => {
    if (entry.kind === "panel") return false;
    try {
      return entry.window.isVisible?.() ?? true;
    } catch {
      return false; // closing
    }
  });
}

/** `desktop.ts`'s window for a second launch, else the default reopen with no window showing. */
function secondInstanceWindow(
  st: SetupState,
  registry: WindowRegistry,
  event: DesktopSecondInstanceEvent,
): DesktopOpenWindowOptions | undefined {
  const handler = st.options.onSecondInstance;
  if (handler) return handler(event);
  return hasShowingWindow(registry) ? undefined : defaultReopenWindow(registry);
}

/** Call an extension's second-launch subscriber; a throw or a rejection is a warning. */
function callSecondInstanceListener(
  st: SetupState,
  fn: DesktopSecondInstanceListener,
  event: DesktopSecondInstanceEvent,
): void {
  const failed = (err: unknown) =>
    st.warn(`a second-launch handler failed: ${err instanceof Error ? err.message : err}`);
  try {
    const out = fn(event);
    if (out && typeof (out as Promise<void>).then === "function") {
      (out as Promise<void>).then(undefined, failed);
    }
  } catch (err) {
    failed(err);
  }
}

/**
 * The app was launched again (`desktop.app.singleInstance`): open `desktop.ts`'s window (or, with
 * no handler and no window showing, the Dock's default), then tell the extensions. The runtime
 * raised a showing window already, and the deep links and files the launch carried are the launch
 * router's. A handler that throws or a window that cannot open is a warning.
 */
function onSecondInstance(st: SetupState, raw: Event): void {
  const event = secondInstanceOf(raw);
  const registry = st.registry;
  if (registry) {
    try {
      const options = secondInstanceWindow(st, registry, event);
      if (options) registry.open(options);
    } catch (err) {
      st.warn(
        `a second launch could not open a window: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  for (const fn of [...st.secondInstanceHandlers]) callSecondInstanceListener(st, fn, event);
}

/**
 * What opened windows take from the main window's settings: the title bar, its title visibility,
 * its toolbar style, its buttons and the size limits (`desktop.minSize` / `desktop.maxSize`).
 */
function inheritedChrome(
  w: DesktopWindowSettings | undefined,
): Pick<
  DesktopWindowSettings,
  "titleBar" | "windowButtonPosition" | "titleVisibility" | "toolbarStyle" | "minSize" | "maxSize"
> {
  return {
    ...(w?.titleBar !== undefined ? { titleBar: w.titleBar } : {}),
    ...(w?.windowButtonPosition !== undefined
      ? { windowButtonPosition: w.windowButtonPosition }
      : {}),
    ...(w?.titleVisibility !== undefined ? { titleVisibility: w.titleVisibility } : {}),
    ...(w?.toolbarStyle !== undefined ? { toolbarStyle: w.toolbarStyle } : {}),
    ...(w?.minSize !== undefined ? { minSize: w.minSize } : {}),
    ...(w?.maxSize !== undefined ? { maxSize: w.maxSize } : {}),
  };
}

/** The registry over the adopted window (its windows' controllers, the store, the lifecycle). */
function createRegistry(st: SetupState): WindowRegistry {
  const o = st.options;
  return createWindowRegistry({
    ...(typeof o.BrowserWindow === "function"
      ? { BrowserWindow: o.BrowserWindow as WindowConstructor }
      : {}),
    ...(o.api ? { api: o.api } : {}),
    ...(o.appSettings?.maxWindows !== undefined ? { maxWindows: o.appSettings.maxWindows } : {}),
    ...(o.appSupportDir !== undefined ? { appSupportDir: o.appSupportDir } : {}),
    warn: st.warn,
    onQuitWorkChanged: () => applyKeepAlive(st),
    appUrl: (path) => st.appUrl(path),
    emit: (cap, event, data, target) => {
      o.emit(cap, event, data, target);
      // A window opened, closed or took the focus: the Dock helper follows at once (it also polls).
      if (cap === "windows") st.dockPresence?.sync();
    },
    keepAlive: () => keepAliveOf(st),
    ...inheritedChrome(o.windowSettings),
    onTitleChanged: () => st.menu?.refresh(),
    onClosed: (id, entry) => {
      entry.controller.windowClosed();
      st.app?.windowClosed(id);
      runClosedHandlers(st, id);
    },
    ...(o.exit ? { exit: o.exit } : {}),
    controller: (window, id, closed, overlay) =>
      createWindowController({
        window,
        api: o.api,
        overlay,
        emit: (cap, event, data) => o.emit(cap, event, data, id),
        closed,
        wayBack: () => st.app?.hasTray() === true,
        ...(o.webViews ? { webViews: () => o.webViews! } : {}),
        appOrigins: () => appOrigins(st),
        ...(o.picked ? { picked: o.picked } : {}),
        ...(o.dirs ? { dirs: o.dirs } : {}),
      }),
  });
}

/** Adopt the main window: its overlay flag, its key and title, and the size the config set. */
function adoptMain(st: SetupState, registry: WindowRegistry, win: RegistryWindow): void {
  const ws = st.options.windowSettings;
  registry.adopt(win, "main", "main", {
    overlay: ws?.overlay === true && overlayRuntime(st),
    ...(ws?.key !== undefined ? { key: ws.key } : {}),
    ...(ws?.title !== undefined ? { title: ws.title } : {}),
    configured: {
      ...(ws?.width !== undefined ? { width: ws.width } : {}),
      ...(ws?.height !== undefined ? { height: ws.height } : {}),
    },
  });
}

/** Call `fn` for a Window-menu item; a throw or a rejection is a warning. */
function callMenuItemHandler(
  st: SetupState,
  fn: DesktopWindowMenuItemHandler,
  id: string,
  ctx: Parameters<DesktopWindowMenuItemHandler>[1],
): void {
  const failed = (err: unknown) =>
    st.warn(`the Window menu item "${id}" failed: ${err instanceof Error ? err.message : err}`);
  try {
    const out = fn(id, ctx);
    if (out && typeof (out as Promise<void>).then === "function") {
      (out as Promise<void>).then(undefined, failed);
    }
  } catch (err) {
    failed(err);
  }
}

/**
 * One of the app's own Window-menu items was chosen: hand it, once, to `desktop.ts`'s handler and
 * to every extension's, with the key window (`null` with no app window open).
 */
function windowMenuItemChosen(st: SetupState, registry: WindowRegistry, id: string): void {
  const key = registry.keyWindow();
  const ctx = {
    keyWindow: key ? { id: key.id, ...(key.key !== undefined ? { key: key.key } : {}) } : null,
  };
  const handlers = [
    ...(st.options.onWindowMenuItem ? [st.options.onWindowMenuItem] : []),
    ...st.menuItemHandlers,
  ];
  if (handlers.length === 0) {
    st.warn(
      `the Window menu item "${id}" was chosen, but nothing handles it ` +
        "(runDesktop({ onWindowMenuItem }) or an extension's host.onWindowMenuItem)",
    );
  }
  for (const fn of handlers) callMenuItemHandler(st, fn, id, ctx);
}

/** The window menu (`desktop.menu.window`, `runDesktop({ newWindow })`), when either is set. */
function createMenu(
  st: SetupState,
  registry: WindowRegistry,
  app: AppController,
): WindowMenu | undefined {
  const o = st.options;
  const windowMenu = o.menuSettings?.window;
  if (!windowMenu && !o.newWindow) return undefined;
  return createWindowMenu({
    settings: windowMenu ?? {},
    registry,
    setBackendMenu: (menu) => app.setBackendMenu(menu),
    ...(o.newWindow ? { newWindow: o.newWindow } : {}),
    onItem: (id) => windowMenuItemChosen(st, registry, id),
    os: st.os,
    warn: st.warn,
  });
}

/** Make the registry, the `window` / `windows` / `app` capabilities over the adopted window. */
function buildControllers(st: SetupState, win: RegistryWindow): DesktopCapability[] {
  const o = st.options;
  const registry = st.registry ?? createRegistry(st);
  st.registry = registry;
  adoptMain(st, registry, win);
  // The full-app updater's install quits through the lifecycle (its guards and hooks run first).
  registerAppLifecycle(registry.lifecycle);
  const app = createAppController({
    window: win,
    api: o.api,
    emit: o.emit,
    ...(st.dock ? { dock: st.dock } : {}),
    os: st.os,
    windows: () => st.registry?.list().map((w) => w.id) ?? ["main"],
    ...(o.runtimeVersion !== undefined ? { runtimeVersion: o.runtimeVersion } : {}),
  });
  st.app = app;
  st.menu = createMenu(st, registry, app);
  return [registry.router, registry.capability, app.capability];
}

/**
 * Set up the app's windows over the adopted main window: the registry and capabilities, the
 * `desktop.app` / `desktop.window` launch settings, and the backend tray (with {@linkcode
 * DesktopWindowsSetup.startTray}).
 *
 * @param options The adopted window, the runtime APIs, the emitter and the settings.
 * @returns The setup.
 */
export function setUpDesktopWindows(options: DesktopWindowsOptions): DesktopWindowsSetup {
  const st: SetupState = {
    options,
    dock: options.dock ?? runtimeDock(),
    os: options.os ?? Deno.build.os,
    warn: options.warn ?? ((m) => console.warn(`desktop: ${m}`)),
    appUrl: (path) => path,
    hasTray: options.wantsTray,
    closedHandlers: new Map(),
    menuItemHandlers: new Set(),
    secondInstanceHandlers: new Set(),
  };
  const win = typeof options.window === "object" && options.window !== null
    ? options.window as RegistryWindow
    : undefined;
  // The registry (and its window store) first: the main window's default size applies only when
  // its key has no saved frame.
  if (win) st.registry = createRegistry(st);
  const key = options.windowSettings?.key;
  const saved = key !== undefined && st.registry?.hasSavedFrame(key) === true;
  applyDesktopWindowSettings(win, withDefaultWindowSize(options.windowSettings, saved), st.warn);
  const capabilities = win ? buildControllers(st, win) : [];
  applyKeepAlive(st);
  if (startsAccessory(st) && win) setDock(st, false);
  return {
    capabilities,
    ...(st.registry ? { registry: st.registry } : {}),
    ...(st.app ? { app: st.app } : {}),
    keepAlive: () => keepAliveOf(st),
    interceptMainClose: (event) => st.registry?.interceptClose("main", event) ?? false,
    mainClosed: () => {
      if (st.registry) st.registry.closed("main");
      else (options.exit ?? Deno.exit)(0);
    },
    closeFromPage: (token) => {
      const id = (token ? st.registry?.resolveToken(token) : undefined) ?? "main";
      if (!st.registry) return (options.exit ?? Deno.exit)(0);
      st.registry.close(id);
    },
    install: () => {
      st.app?.install();
      st.registry?.lifecycle.install();
      st.menu?.install();
      installDockHelper(st);
      st.dock?.addEventListener("reopen", (e) => onDockReopen(st, e));
      // `Deno.desktop` of the pinned runtime only (none outside it, or before launch events).
      if (typeof options.api?.addEventListener === "function") {
        options.api.addEventListener("secondinstance", (e) => onSecondInstance(st, e));
      }
    },
    startTray: async (ctx) => {
      if (!st.app) return undefined;
      const app = st.app;
      const making = panelScreens(options.api).then((screens) =>
        startBackendTray({
          ...ctx,
          app,
          ...(st.registry ? { registry: st.registry } : {}),
          screens,
          panelOverlay: overlayRuntime(st),
          warn: st.warn,
        })
      );
      st.app.backendTrayPending(making);
      const made = await making;
      if (made !== undefined && !("reason" in made)) return made;
      // No tray after all (none configured, or no tray host): keep-alive follows.
      st.hasTray = false;
      applyKeepAlive(st);
      return undefined;
    },
    windows: windowsApi(st),
    setDockVisible: (visible) => setDock(st, visible),
    setActivationPolicy: (policy) => setPolicy(st, policy),
    getActivationPolicy: () => getPolicy(st),
    onDockReopen: (fn) => subscribeDockReopen(st.dock, fn),
    setAppUrl: (appUrl) => {
      st.appUrl = appUrl;
    },
    ...(st.registry ? { lifecycle: st.registry.lifecycle } : {}),
    ...(st.menu ? { menu: st.menu } : {}),
    restoreSession: () => restoreSession(st),
    onWindowMenuItem: (fn) => {
      st.menuItemHandlers.add(fn);
      return () => void st.menuItemHandlers.delete(fn);
    },
    onSecondInstance: (fn) => {
      st.secondInstanceHandlers.add(fn);
      return () => void st.secondInstanceHandlers.delete(fn);
    },
  };
}

/**
 * `desktop.app.dock: "while-window-open"` on macOS: start the Dock helper's presence over the
 * registry (a Dock icon while a window shows; src/desktop/dock-helper.ts). The helper's Quit closes
 * the app's windows and never quits it. A failure to start is a warning: the app stays accessory.
 */
function installDockHelper(st: SetupState): void {
  const registry = st.registry;
  if (st.os !== "darwin" || st.options.appSettings?.dock !== "while-window-open" || !registry) {
    return;
  }
  startDockHelper({
    windows: () => registry.list(),
    keyWindow: () => registry.keyWindow(),
    // The helper's Quit closes the windows, never the app: each as its close button would, so a
    // page that guards its close is asked (a synthetic cancelable `close` through the same hook).
    closeWindow: (id) => {
      if (!registry.interceptClose(id, new Event("close", { cancelable: true }))) {
        registry.close(id);
      }
    },
    dataDir: st.options.dirs?.data ?? st.options.appSupportDir,
    warn: st.warn,
  }).then(
    (presence) => {
      st.dockPresence = presence;
    },
    (err) =>
      st.warn(`the Dock helper could not start: ${err instanceof Error ? err.message : err}`),
  );
}

/** Whether the runtime makes overlay main windows and tray panels (`3.0.0-denext.7`+). */
function overlayRuntime(st: SetupState): boolean {
  return supportsInitialOverlay(st.options.runtimeVersion ?? Deno.version.deno);
}

/**
 * The displays for the tray panel's placement: on Linux Wayland, where GDK reports each whole
 * display as its work area, kept clear of the panels the session can't report — unless the
 * runtime anchors a layer surface to its nearest edges (`layerShellEdgeAnchor`), where the
 * compositor's own exclusive zones keep it clear.
 */
async function panelScreens(
  api: DesktopAppApi | undefined,
): Promise<() => readonly PlacementScreen[]> {
  const facts = await platformFacts(api);
  let edgeAnchored = false;
  try {
    edgeAnchored = api?.windowCapabilities?.()?.layerShellEdgeAnchor === true;
  } catch { /* an older runtime: none */ }
  const guess = facts.sessionType === "wayland" && !edgeAnchored;
  return () => panelPlacementScreens(screensOf(api), guess);
}

/** The displays, for the tray panel's placement (none without the pinned runtime). */
function screensOf(api: DesktopAppApi | undefined): readonly PlacementScreen[] {
  try {
    return api?.screens?.() ?? [];
  } catch {
    return [];
  }
}

/**
 * The windows API of a launch that has no windows (a sidecar's child): opening one throws, there
 * are none to find, and the Dock is left alone.
 *
 * @returns `windows`, `setDockVisible` and the activation policy for such a `DesktopRuntime`.
 */
export function noDesktopWindows(): {
  windows: DesktopWindows;
  setDockVisible(visible: boolean): boolean;
  setActivationPolicy(policy: ActivationPolicy): boolean;
  getActivationPolicy(): ActivationPolicy | null;
  onDockReopen(fn: (event: DesktopDockReopenEvent) => void): () => void;
  onSecondInstance(fn: DesktopSecondInstanceListener): () => void;
  onWillNavigate(fn: DesktopWillNavigateHandler): () => void;
} {
  return {
    windows: {
      open: () => {
        throw new Error("desktop: this launch has no windows (a sidecar's child)");
      },
      get: () => undefined,
      byKey: () => undefined,
      list: () => [],
      lastSession: () => [],
      forget: () => {},
    },
    setDockVisible: () => false,
    setActivationPolicy: () => false,
    getActivationPolicy: () => null,
    onDockReopen: () => () => {},
    onSecondInstance: () => () => {},
    onWillNavigate: () => () => {},
  };
}
