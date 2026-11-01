/**
 * How `runDesktop` sets up the app's windows and chrome: the window registry over the adopted main
 * window (each window's `window` capability, the `windows` capability), the `app` capability, the
 * launch settings of `desktop.app` (`keepAlive`, `dock`) and `desktop.window` (always on top,
 * opacity, taskbar, workspaces), the macOS Dock's reopen click, the backend tray and its panel, and
 * what `desktop.ts` gets to drive them (`DesktopRuntime.windows`, `.tray`, `.setDockVisible`).
 *
 * Runtime-only (imported by `runDesktop`, never a client bundle).
 *
 * @module
 */

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
  createWindowRegistry,
  type RegisteredWindow,
  type RegistryWindow,
  type WindowConstructor,
  type WindowRegistry,
} from "./window-registry.ts";
import {
  applyDesktopWindowSettings,
  type DesktopAppSettings,
  type DesktopWindowSettings,
} from "./window-config.ts";

/** One of the app's windows, as `desktop.ts` drives it (`DesktopRuntime.windows`). */
export interface DesktopWindowRef {
  /** Its id (`"main"`, `"panel"`, `"window-1"`, …): what pages' handles name it by. */
  readonly id: string;
  /** What it is. */
  readonly kind: "main" | "panel" | "window";
  /** The runtime's `Deno.BrowserWindow`. */
  readonly window: unknown;
  /** Show it. */
  show(): void;
  /** Hide it. */
  hide(): void;
  /** Bring it to the front and focus it. */
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
}

/** The options of a window `desktop.ts` or a page opens (`openWindow` in `denext/desktop/window`). */
export interface DesktopOpenWindowOptions {
  /** The page: a path of the app (`"/vm?id=1"`). */
  readonly url: string;
  /** The title. */
  readonly title?: string;
  /** Width in CSS pixels. */
  readonly width?: number;
  /** Height in CSS pixels. */
  readonly height?: number;
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
}

/** The app's windows, as `desktop.ts` drives them (`DesktopRuntime.windows`). */
export interface DesktopWindows {
  /** Open a window on a page of the app. Throws on bad options or with no desktop runtime. */
  open(options: DesktopOpenWindowOptions): DesktopWindowRef;
  /** A window by id, or `undefined` once it closed. */
  get(id: string): DesktopWindowRef | undefined;
  /** The open windows. */
  list(): DesktopWindowRef[];
}

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
  /** End the process (default `Deno.exit`). */
  readonly exit?: (code: number) => void;
  /** The running OS (default `Deno.build.os`). */
  readonly os?: string;
  /** Where warnings go. */
  readonly warn?: (message: string) => void;
  /**
   * The Deno Desktop runtime's version (default `Deno.version.deno`): from `3.0.0-denext.7` the
   * main window with `desktop.window.overlay` and the tray panel are layer-shell overlays where
   * the compositor has layer-shell, so they report `setPosition` on Wayland.
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
  /** Set the URL resolver new windows load with (known once the server listens). */
  setAppUrl(appUrl: (path: string) => string): void;
}

/** The setup's state. */
interface SetupState {
  readonly options: DesktopWindowsOptions;
  readonly dock: DockLike | undefined;
  readonly os: string;
  readonly warn: (message: string) => void;
  registry?: WindowRegistry;
  app?: AppController;
  appUrl: (path: string) => string;
  hasTray: boolean;
  /** `desktop.ts`'s `onClosed` handlers, by window id. */
  readonly closedHandlers: Map<string, Set<() => void>>;
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

/** Tell the runtime whether the app quits with its last window (`Deno.desktop`). */
function applyKeepAlive(st: SetupState): void {
  const api = st.options.api;
  if (!api || !("quitOnLastWindowClosed" in api)) return;
  try {
    api.quitOnLastWindowClosed = !keepAliveOf(st);
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
 * Whether the app starts with no Dock icon: `desktop.app.activationPolicy: "accessory"` or
 * `desktop.app.dock: false`. From runtime `3.0.0-denext.6` the launch file already started it so;
 * applying it again here covers an older runtime (where the icon shows until now).
 */
function startsAccessory(st: SetupState): boolean {
  const app = st.options.appSettings;
  return app?.activationPolicy === "accessory" || app?.dock === false;
}

/** A registered window as `desktop.ts` sees it. */
function ref(st: SetupState, entry: RegisteredWindow): DesktopWindowRef {
  const w = entry.window;
  return {
    id: entry.id,
    kind: entry.kind,
    window: w,
    show: () => w.show?.(),
    hide: () => w.hide?.(),
    focus: () => w.focus?.(),
    close: () => st.registry?.close(entry.id),
    navigate: (path) => {
      const at = st.registry?.get(entry.id);
      if (!at) return;
      w.navigate?.(st.appUrl(path));
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
    list: () => st.registry?.list().map((e) => ref(st, e)) ?? [],
  };
}

/** The macOS Dock icon was clicked with no window showing: show the main window again. */
function onDockReopen(st: SetupState, event: Event): void {
  const visible = (event as CustomEvent<{ hasVisibleWindows?: unknown }>).detail
    ?.hasVisibleWindows;
  if (visible === true) return;
  const main = st.registry?.get("main")?.window;
  main?.show?.();
  main?.focus?.();
}

/** Make the registry, the `window` / `windows` / `app` capabilities over the adopted window. */
function buildControllers(st: SetupState, win: RegistryWindow): DesktopCapability[] {
  const o = st.options;
  st.registry = createWindowRegistry({
    ...(typeof o.BrowserWindow === "function"
      ? { BrowserWindow: o.BrowserWindow as WindowConstructor }
      : {}),
    appUrl: (path) => st.appUrl(path),
    emit: o.emit,
    keepAlive: () => keepAliveOf(st),
    onClosed: (id) => {
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
        ...(o.picked ? { picked: o.picked } : {}),
        ...(o.dirs ? { dirs: o.dirs } : {}),
      }),
  });
  st.registry.adopt(win, "main", "main", {
    overlay: o.windowSettings?.overlay === true && overlayRuntime(st),
  });
  st.app = createAppController({
    window: win,
    api: o.api,
    emit: o.emit,
    ...(st.dock ? { dock: st.dock } : {}),
    os: st.os,
    windows: () => st.registry?.list().map((w) => w.id) ?? ["main"],
  });
  return [st.registry.router, st.registry.capability, st.app.capability];
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
  };
  const win = typeof options.window === "object" && options.window !== null
    ? options.window as RegistryWindow
    : undefined;
  applyDesktopWindowSettings(win, options.windowSettings, st.warn);
  const capabilities = win ? buildControllers(st, win) : [];
  applyKeepAlive(st);
  if (startsAccessory(st) && win) setDock(st, false);
  return {
    capabilities,
    ...(st.registry ? { registry: st.registry } : {}),
    ...(st.app ? { app: st.app } : {}),
    keepAlive: () => keepAliveOf(st),
    interceptMainClose: (event) =>
      st.registry?.get("main")?.controller.interceptClose(event) ?? false,
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
      st.dock?.addEventListener("reopen", (e) => onDockReopen(st, e));
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
    setAppUrl: (appUrl) => {
      st.appUrl = appUrl;
    },
  };
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
} {
  return {
    windows: {
      open: () => {
        throw new Error("desktop: this launch has no windows (a sidecar's child)");
      },
      get: () => undefined,
      list: () => [],
    },
    setDockVisible: () => false,
    setActivationPolicy: () => false,
    getActivationPolicy: () => null,
  };
}
