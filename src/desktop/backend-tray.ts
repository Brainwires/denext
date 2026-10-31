/**
 * The tray icon the app's backend owns (`desktop.tray` in `denext.config.ts`, `runDesktop({ tray })`
 * in `desktop.ts`): created before any page loads, kept across page reloads, its clicks handed to
 * the backend's handlers and to every window's page (`getTray()` in `denext/desktop/app`), and
 * optionally a panel at the icon (the runtime's `Tray.attachPanel`) placed inside the display's
 * work area, so it opens above a bottom taskbar instead of off screen.
 *
 * Runtime-only (imported by `runDesktop`, never a client bundle).
 *
 * @module
 */

import { bytesToBase64 } from "../mobile/base64.ts";
import type { AppController, BackendTray, TrayLike, TrayPanelLike } from "./caps/app.ts";
import { clickedId } from "./caps/menu.ts";
import { menuWire } from "./menu-wire.ts";
import {
  DEFAULT_PANEL_SIZE,
  type DesktopTrayPanelSettings,
  type DesktopTraySettings,
  type PlacementScreen,
  placeTrayPanel,
} from "./tray-config.ts";
import type { RegisteredWindow, RegistryWindow, WindowRegistry } from "./window-registry.ts";
import {
  isPrimaryClick,
  type TrayEventType,
  type TrayMouseDetail,
  trayMouseDetail,
} from "./tray-events.ts";

export type { TrayEventType, TrayMouseDetail } from "./tray-events.ts";

/** A tray icon image: PNG bytes, or a PNG path in the export (`"/tray.png"`). */
export type DesktopTrayIcon = Uint8Array | string;

/** The backend tray's settings in `runDesktop({ tray })`, laid over `desktop.tray`. */
export interface DesktopTrayOptions {
  /** The icon (overrides `desktop.tray.icon`). */
  readonly icon?: DesktopTrayIcon;
  /** The dark-mode icon. */
  readonly iconDark?: DesktopTrayIcon;
  /** The tooltip. */
  readonly tooltip?: string;
  /** The menu, written like `denext/desktop/app`'s (`{ id, label }`, `{ label, submenu }`, …). */
  readonly menu?: readonly unknown[];
  /** The panel at the icon: `{ url, width?, height?, hideOnBlur? }`. */
  readonly panel?: { url: string; width?: number; height?: number; hideOnBlur?: boolean };
  /**
   * Called on a click on the icon with the primary button (before the pages hear of it), with the
   * runtime's detail (runtime `3.0.0-denext.6`+; else `null`).
   */
  readonly onClick?: (detail: TrayMouseDetail | null) => void;
  /** Called on a double click. */
  readonly onDoubleClick?: (detail: TrayMouseDetail | null) => void;
  /**
   * Called on a right click (runtime `3.0.0-denext.6`+, where `trayRightClick` is reported). The OS
   * opens the tray's menu on a right click by itself; this is for doing something else as well.
   */
  readonly onContextMenu?: (detail: TrayMouseDetail | null) => void;
  /** Called with the id of the menu item chosen. */
  readonly onMenuItem?: (id: string) => void;
}

/** What `update` changes on the backend tray (`null` removes the tooltip / menu / dark icon). */
export interface DesktopTrayUpdate {
  /** The icon, as PNG bytes. */
  readonly icon?: Uint8Array;
  /** The dark-mode icon. */
  readonly iconDark?: Uint8Array | null;
  /** The tooltip. */
  readonly tooltip?: string | null;
  /** The menu. */
  readonly menu?: readonly unknown[] | null;
}

/** The tray panel as the backend drives it. */
export interface DesktopTrayPanelHandle {
  /** The panel's window id (`"panel"`). */
  readonly id: string;
  /** The runtime's `BrowserWindow` of the panel. */
  readonly window: unknown;
  /** Whether it is showing. */
  readonly visible: boolean;
  /** Show it at the icon. */
  show(): void;
  /** Hide it. */
  hide(): void;
  /** Show it when hidden, hide it when shown. */
  toggle(): void;
}

/** The backend tray, as `DesktopRuntime.tray` hands it to `desktop.ts`. */
export interface DesktopTrayHandle {
  /** The runtime's `Deno.Tray`. */
  readonly tray: unknown;
  /** Change the icon, tooltip or menu. */
  update(options: DesktopTrayUpdate): void;
  /** Where the icon is, or `null` where the OS cannot say (Linux). */
  getBounds(): { x: number; y: number; width: number; height: number } | null;
  /** Call `handler` on each primary-button click, with its detail. Returns the unsubscribe. */
  onClick(handler: (detail: TrayMouseDetail | null) => void): () => void;
  /** Call `handler` on each double click. Returns the unsubscribe. */
  onDoubleClick(handler: (detail: TrayMouseDetail | null) => void): () => void;
  /**
   * Call `handler` on each `type` event (`contextmenu`, `auxclick`, `mouseenter`, `mouseleave`,
   * … — runtime `3.0.0-denext.6`+), with its detail. Returns the unsubscribe.
   */
  on(type: TrayEventType, handler: (detail: TrayMouseDetail | null) => void): () => void;
  /**
   * Open the tray's menu at the icon now (runtime `3.0.0-denext.6`+), for another gesture than the
   * right click (which opens it by itself): a Control-click, say. `false` without a menu, on an
   * older runtime, or where the OS can't (Linux: the tray host opens it).
   */
  popUpMenu(): boolean;
  /** Call `handler` with the id of each menu item chosen. Returns the unsubscribe. */
  onMenuItem(handler: (id: string) => void): () => void;
  /** The panel, when `panel` is set and the runtime has `Tray.attachPanel`. */
  readonly panel?: DesktopTrayPanelHandle;
}

/** What `startBackendTray` needs from `runDesktop`. */
export interface BackendTrayContext {
  /** `desktop.tray` from the config. */
  readonly settings?: DesktopTraySettings;
  /** `runDesktop({ tray })`. */
  readonly options?: DesktopTrayOptions;
  /** The `app` capability's controller (it owns every tray). */
  readonly app: AppController;
  /** Read a file of the export (`/tray.png`), or `null` when it has none. */
  readonly readFile: (path: string) => Promise<Uint8Array | null>;
  /** The window registry (the panel joins it as `"panel"`). */
  readonly registry?: WindowRegistry;
  /** The URL a window loads for an app path. */
  readonly appUrl: (path: string) => string;
  /**
   * The displays (`Deno.desktop.screens()`), for the panel's placement (on Linux Wayland with
   * their work areas kept clear of panels the session can't report, `panelPlacementScreens`).
   */
  readonly screens: () => readonly PlacementScreen[];
  /**
   * Whether the runtime makes the panel a layer-shell overlay where it has layer-shell (runtime
   * `3.0.0-denext.7`+): the panel then reports `setPosition` on Wayland. Default not.
   */
  readonly panelOverlay?: boolean;
  /** Where warnings go. */
  readonly warn: (message: string) => void;
}

/** The runtime's `Tray.attachPanel`, as this module calls it. */
type AttachPanel = (options: {
  width: number;
  height: number;
  hideOnBlur: boolean;
  position: (
    icon: { x: number; y: number; width: number; height: number },
    size: { width: number; height: number },
  ) => { x: number; y: number };
}) => TrayPanelLike & { readonly window: RegistryWindow };

/** An icon as the `app` capability's wire takes it (base64), read from the export when a path. */
async function iconWire(
  icon: DesktopTrayIcon,
  readFile: (path: string) => Promise<Uint8Array | null>,
): Promise<string> {
  if (typeof icon !== "string") return bytesToBase64(icon);
  const bytes = await readFile(icon);
  if (!bytes) throw new Error(`desktop: the tray icon ${icon} is not in the export`);
  return bytesToBase64(bytes);
}

/** The keys `runDesktop({ tray })` lays over `desktop.tray`. */
const TRAY_KEYS = ["icon", "iconDark", "tooltip", "menu", "panel"] as const;

/** The tray's settings: `runDesktop({ tray })` over `desktop.tray`, or `undefined` for none. */
function mergedSettings(ctx: BackendTrayContext): Record<string, unknown> | undefined {
  if (!ctx.settings && !ctx.options) return undefined;
  const config = (ctx.settings ?? {}) as Record<string, unknown>;
  const given = (ctx.options ?? {}) as Record<string, unknown>;
  return Object.fromEntries(TRAY_KEYS.map((key) => [key, given[key] ?? config[key]]));
}

/** The wire options `createBackendTray` takes, icons read and menus converted. */
async function wireOptions(
  merged: Record<string, unknown>,
  readFile: (path: string) => Promise<Uint8Array | null>,
): Promise<Record<string, unknown>> {
  if (merged.icon === undefined) throw new Error("desktop: the tray needs an icon");
  return {
    icon: await iconWire(merged.icon as DesktopTrayIcon, readFile),
    ...(merged.iconDark !== undefined
      ? { iconDark: await iconWire(merged.iconDark as DesktopTrayIcon, readFile) }
      : {}),
    ...(merged.tooltip !== undefined ? { tooltip: merged.tooltip } : {}),
    ...(merged.menu !== undefined ? { menu: menuWire(merged.menu as unknown[]) } : {}),
  };
}

/** Subscribe `handler` to the tray's `type` events; the unsubscribe. */
function listen(tray: TrayLike, type: string, handler: (event: Event) => void): () => void {
  tray.addEventListener(type, handler);
  return () => tray.removeEventListener(type, handler);
}

/** Subscribe `handler` to `type` with the event's detail (`click`: the primary button's only). */
function listenMouse(
  tray: TrayLike,
  type: TrayEventType,
  handler: (detail: TrayMouseDetail | null) => void,
): () => void {
  return listen(tray, type, (e) => {
    const detail = trayMouseDetail(e);
    if (type === "click" && !isPrimaryClick(detail)) return;
    handler(detail);
  });
}

/** The panel at the icon (registered as the window `"panel"`), or `undefined` when unavailable. */
function attachPanel(
  ctx: BackendTrayContext,
  backend: BackendTray,
  settings: DesktopTrayPanelSettings,
): DesktopTrayPanelHandle | undefined {
  const attach = (backend.tray as unknown as { attachPanel?: AttachPanel }).attachPanel;
  if (typeof attach !== "function") {
    ctx.warn("desktop.tray.panel needs a Deno Desktop runtime with Tray.attachPanel; ignored");
    return undefined;
  }
  // No url here: the panel is registered (its window token bound) before it loads its page.
  const panel = attach.call(backend.tray, {
    width: settings.width,
    height: settings.height,
    hideOnBlur: settings.hideOnBlur,
    position: (icon, size) => placeTrayPanel(icon, size, ctx.screens()),
  });
  const entry: RegisteredWindow | undefined = ctx.registry?.adopt(panel.window, "panel", "panel", {
    overlay: ctx.panelOverlay === true,
  });
  panel.window.navigate?.(ctx.appUrl(settings.url));
  backend.setPanel(panel);
  return {
    id: entry?.id ?? "panel",
    window: panel.window,
    get visible() {
      return panel.visible;
    },
    show: () => panel.show(),
    hide: () => panel.hide(),
    toggle: () => panel.toggle(),
  };
}

/** The `panel` settings from merged options (defaults filled in), or `undefined`. */
function panelSettings(raw: unknown): DesktopTrayPanelSettings | undefined {
  if (raw === undefined) return undefined;
  const p = raw as { url: string; width?: number; height?: number; hideOnBlur?: boolean };
  return {
    url: p.url,
    width: Math.round(p.width ?? DEFAULT_PANEL_SIZE.width),
    height: Math.round(p.height ?? DEFAULT_PANEL_SIZE.height),
    hideOnBlur: p.hideOnBlur !== false,
  };
}

/** The handle `desktop.ts` gets. */
function trayHandle(
  backend: BackendTray,
  panel: DesktopTrayPanelHandle | undefined,
): DesktopTrayHandle {
  const tray = backend.tray;
  return {
    tray,
    update: (u) => {
      backend.update({
        ...(u.icon !== undefined ? { icon: bytesToBase64(u.icon) } : {}),
        ...(u.iconDark !== undefined
          ? { iconDark: u.iconDark === null ? null : bytesToBase64(u.iconDark) }
          : {}),
        ...(u.tooltip !== undefined ? { tooltip: u.tooltip } : {}),
        ...(u.menu !== undefined ? { menu: u.menu === null ? null : menuWire(u.menu) } : {}),
      });
    },
    getBounds: () => tray.getBounds?.() ?? null,
    onClick: (handler) => listenMouse(tray, "click", handler),
    onDoubleClick: (handler) => listenMouse(tray, "dblclick", handler),
    on: (type, handler) => listenMouse(tray, type, handler),
    popUpMenu: () => typeof tray.popUpMenu === "function" && tray.popUpMenu() === true,
    onMenuItem: (handler) =>
      listen(tray, "menuclick", (e) => {
        const id = clickedId(e);
        if (id !== undefined && backend.menuIds.has(id)) handler(id);
      }),
    ...(panel ? { panel } : {}),
  };
}

/**
 * Create the backend tray from `desktop.tray` and `runDesktop({ tray })`, with its panel and the
 * backend's handlers.
 *
 * @param ctx The settings, the `app` controller, the export reader, the registry and placement.
 * @returns The handle, `{ reason }` when no tray icon can be shown here (a hidden main window was
 *   shown instead), or `undefined` when the app configures no tray.
 */
export async function startBackendTray(
  ctx: BackendTrayContext,
): Promise<DesktopTrayHandle | { reason: string } | undefined> {
  const merged = mergedSettings(ctx);
  if (!merged) return undefined;
  const made = await ctx.app.createBackendTray(await wireOptions(merged, ctx.readFile));
  if ("reason" in made) {
    ctx.warn(`no tray icon here (${made.reason}); the window is shown instead`);
    return made;
  }
  const panelConfig = panelSettings(merged.panel);
  const panel = panelConfig ? attachPanel(ctx, made, panelConfig) : undefined;
  const handle = trayHandle(made, panel);
  const o = ctx.options;
  if (o?.onClick) handle.onClick(o.onClick);
  if (o?.onDoubleClick) handle.onDoubleClick(o.onDoubleClick);
  if (o?.onContextMenu) handle.on("contextmenu", o.onContextMenu);
  if (o?.onMenuItem) handle.onMenuItem(o.onMenuItem);
  return handle;
}
