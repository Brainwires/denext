// The tray and the windows, driven from the app's process (desktop.ts), never from a page: a window
// that does not show may have its page suspended (WKWebView on macOS suspends a page that is not on
// screen), so a menu item handled by the hidden main window's page waited until that window showed
// again. Here the backend tray's menu items, its double click and its tooltip are answered by the
// backend, and every full window is opened by one window manager (the panel's buttons reach it
// through the `hangar` extension's `open`).
//
// No Deno or DOM APIs: it works over the slices of denext's `DesktopRuntime` it is handed, so the
// tests run it with fakes.

import type { Overview } from "./types.ts";
import {
  cascadeOrigin,
  FULL_SIZE,
  MENU,
  SHUTDOWN_PREFIX,
  START_PREFIX,
  trayMenu,
  windowTitle,
} from "./tray.ts";

/** How often the tooltip and the menu follow the instances. */
export const REFRESH_MS = 5000;

/** One window, as `DesktopRuntime.windows` hands it. */
export interface HangarWindowRef {
  readonly id: string;
  readonly kind: "main" | "panel" | "window";
  readonly visible: boolean;
  show(): void;
  focus(): void;
  getBounds(): { x: number; y: number } | null;
  onClosed(handler: () => void): () => void;
}

/** The slice of the tray handle (`DesktopRuntime.tray`) Hangar drives. */
export interface HangarTray {
  update(options: { tooltip?: string; menu?: readonly unknown[] }): void;
  onClick(handler: (detail: { modifiers: { ctrl: boolean } } | null) => void): () => void;
  onDoubleClick(handler: () => void): () => void;
  on(type: "mouseenter", handler: () => void): () => void;
  onMenuItem(handler: (id: string) => void): () => void;
  popUpMenu(): boolean;
  readonly panel?: { show(): void; hide(): void };
}

/** The slice of `DesktopRuntime` Hangar's windows need. */
export interface HangarDesktop {
  readonly windows: {
    open(options: {
      url: string;
      title: string;
      width: number;
      height: number;
      x?: number;
      y?: number;
    }): HangarWindowRef;
    get(id: string): HangarWindowRef | undefined;
    list(): HangarWindowRef[];
  };
  readonly tray?: HangarTray;
  setActivationPolicy(policy: "regular" | "accessory"): boolean;
}

/** The window manager: the panel, the main window (the library) and one window per other page. */
export interface HangarWindows {
  /** Open (or bring back) the full window for `path`: `"/"` is the main window. */
  openFull(path: string): void;
  /** Show the panel at the tray icon. */
  showPanel(): void;
  /**
   * A regular app (Dock icon; the library's taskbar entry on Windows and Linux) while a full
   * window shows, an accessory one otherwise.
   */
  syncDock(): void;
}

/**
 * Hangar's windows. An accessory app with no Dock icon, except while a full window shows: then a
 * regular one, so that window comes to the front and Cmd-Tab reaches it.
 *
 * @param app The runtime's windows, tray and activation policy.
 */
export function createHangarWindows(app: HangarDesktop): HangarWindows {
  /** The full windows opened, by path (one per page of the app). */
  const opened = new Map<string, HangarWindowRef>();

  const syncDock = () => {
    const showing = app.windows.list().some((w) => w.kind !== "panel" && w.visible);
    app.setActivationPolicy(showing ? "regular" : "accessory");
  };
  /** Switching to regular first also brings Hangar to the front. */
  const front = (win: HangarWindowRef) => {
    app.setActivationPolicy("regular");
    app.tray?.panel?.hide();
    win.show();
    win.focus();
  };

  return {
    openFull: (path) => {
      const main = path === "/" ? app.windows.get("main") : undefined;
      if (main) return front(main);
      const existing = opened.get(path);
      if (existing && app.windows.get(existing.id)) return front(existing);
      app.setActivationPolicy("regular");
      app.tray?.panel?.hide();
      // Its own title, and cascaded from the library window rather than exactly over it.
      const library = app.windows.get("main")?.getBounds() ?? null;
      const win = app.windows.open({
        url: path,
        title: windowTitle(path),
        ...FULL_SIZE,
        ...cascadeOrigin(library, opened.size + 1),
      });
      opened.set(path, win);
      win.onClosed(() => {
        if (opened.get(path) === win) opened.delete(path);
        syncDock();
      });
      win.focus();
    },
    showPanel: () => app.tray?.panel?.show(),
    syncDock,
  };
}

/** What the tray driver asks the VM backend. */
export interface TrayBackend {
  overview(): Promise<Overview>;
  start(id: string): Promise<{ started: boolean }>;
  shutdown(id: string): Promise<unknown>;
}

/**
 * Answer a tray menu item: a window, the panel, or a VM's start / shutdown.
 *
 * @param id The item's id (`lib/tray.ts`'s `MENU` and prefixes).
 */
export async function onTrayMenu(
  id: string,
  windows: HangarWindows,
  backend: TrayBackend,
): Promise<void> {
  if (id === MENU.panel) return windows.showPanel();
  if (id.startsWith("open:")) return windows.openFull(id.slice(5));
  if (id.startsWith(SHUTDOWN_PREFIX)) {
    await backend.shutdown(id.slice(SHUTDOWN_PREFIX.length));
    return;
  }
  if (id.startsWith(START_PREFIX)) {
    // A start over the RAM budget answers started: false: the panel asks.
    const r = await backend.start(id.slice(START_PREFIX.length));
    if (!r.started) windows.showPanel();
  }
}

/** A running tray driver. */
export interface TrayDriver {
  /** Bring the tooltip and the menu up to date now. */
  refresh(): Promise<void>;
  /** Stop listening and refreshing. */
  stop(): void;
}

/**
 * Drive the backend tray: its menu items, a double click (the library), a Control-click (the menu,
 * for a one-button mouse; the panel ignores a click with a modifier), and the tooltip and the menu,
 * refreshed every few seconds and as soon as the pointer is over the icon (macOS and Windows).
 *
 * @param tray The backend tray.
 * @param windows The window manager.
 * @param backend The VM backend.
 * @param onError Where a failed action goes (default `console.error`).
 */
export function driveTray(
  tray: HangarTray,
  windows: HangarWindows,
  backend: TrayBackend,
  onError: (err: unknown) => void = (err) => console.error("hangar: tray:", err),
): TrayDriver {
  let lastMenu = "";
  let stopped = false;
  const refresh = async () => {
    if (stopped) return;
    const overview = await backend.overview().catch(() => null);
    if (!overview || stopped) return;
    const menu = trayMenu(overview);
    const key = JSON.stringify(menu);
    try {
      // The menu only when it changed: a menu replaced while open closes on some platforms.
      tray.update({ tooltip: overview.tooltip, ...(key !== lastMenu ? { menu } : {}) });
      lastMenu = key;
    } catch (err) {
      onError(err);
    }
  };
  const offs = [
    tray.onMenuItem((id) => void onTrayMenu(id, windows, backend).catch(onError)),
    tray.onDoubleClick(() => windows.openFull("/")),
    tray.onClick((click) => {
      if (click?.modifiers.ctrl) tray.popUpMenu();
    }),
    tray.on("mouseenter", () => void refresh()),
  ];
  const timer = setInterval(() => void refresh(), REFRESH_MS);
  void refresh();
  return {
    refresh,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      for (const off of offs) off();
    },
  };
}
