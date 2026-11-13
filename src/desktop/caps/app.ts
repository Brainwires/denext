/**
 * The `app` capability: the application menu, tray icons, the dock / taskbar badge and attention
 * request, and the dock menu — what `denext/desktop/app` (and, for the dock menu,
 * `setQuickActions` in `denext/mobile`) drives from the page. `runDesktop` registers it for every
 * app (no `denext desktop add`): it needs no Deno permission, and the page only changes the app's
 * own chrome.
 *
 * Runtime APIs: `BrowserWindow.setApplicationMenu`, `Deno.Tray`, `Deno.dock`. They exist under the
 * stock runtime too; denext's pinned runtime adds keyboard accelerators on every OS
 * (`Deno.desktop.menuCapabilities()`), menu icons and tooltips. The dock menu is macOS-only (the
 * OS has no other). A badge is the Dock icon's on macOS, a prefix of the window titles on Windows,
 * and on Linux a count on the app's launcher where a dock reads launcher badges (runtime
 * 2.9.7-denext.11), else the same title prefix.
 *
 * Tray icons follow the runtime's probe of the session (`Deno.desktop.platformFeatures()`, runtime
 * 2.9.7-denext.10 and later): where no tray host runs (stock GNOME without the AppIndicator
 * extension), `capabilities` reports `tray: false` with the runtime's reason and `createTray`
 * rejects `unsupported` with it, never a dead icon. A tray-only app (its window hidden) gets its
 * window shown instead, so it is never unreachable. Without the probe the facts read `"unknown"`.
 *
 * Clicks are PULLED (an `action` signal, then `take`), so each is delivered once, never again after
 * a reload. Each window has its own queue: a page tray's clicks go to the window whose page made
 * it; the app menu's, the dock menu's and the backend tray's go to every window. The current user
 * activity (Handoff and Spotlight, macOS; runtime 2.9.7-denext.20) and the activities the user
 * continues are `./user-activity.ts`'s. A new page load removes the trays that window's previous
 * page created (their click handlers went with it); the application menu and the dock menu stay
 * until a new page sets its own.
 *
 * The backend tray (`desktop.tray` / `runDesktop({ tray })`) is made here too ({@linkcode
 * AppController.createBackendTray}), as the tray `"app"`: pages reach it like their own (update,
 * bounds, clicks) but cannot destroy it, and no page load removes it. Its panel
 * (`Tray.attachPanel`) is shown, hidden and toggled with `panel`. The Dock icon is shown or hidden
 * with `setDockVisible` (macOS), and a click on it with no window showing is `dockReopen`.
 *
 * From runtime 3.0.0-denext.6 a tray's clicks carry the runtime's `TrayMouseEvent` detail (button,
 * modifiers, position, double), a right click is also `contextmenu`, a middle click `auxclick`, and
 * hover is `mouseenter` / `mouseleave` (`../tray-events.ts`); `popUpMenu` opens a tray's menu at the
 * icon, `capabilities` folds in `Deno.Tray.capabilities()`, and `setActivationPolicy` /
 * `getActivationPolicy` drive the macOS activation policy (`Deno.dock`). Each is feature-detected.
 *
 * The application menu's clicks (the page's items and the backend's "Window" submenu) come from
 * `Deno.desktop`'s `"menuclick"` from runtime `FIRST_APP_MENU_EVENT_RUNTIME` (whichever
 * window is key, and after the main window closed), else from the window whose menu it is.
 *
 * The app's own top-level menus (`desktop.menu.menus`, `setMenu`) and each window's own Window-menu
 * items (`setWindowMenuAppItems`) are `../app-menus.ts`'s model. Once the app uses them, every app
 * window gets its own menu bar built with its state (the tray panel never; on Windows and Linux no
 * overlay or frameless window either): on macOS the runtime swaps the menu bar as windows take the
 * focus, and the app-level menu (`Deno.desktop.setApplicationMenu`, where the runtime has it) holds
 * the app-wide state for when no window with a menu is key. Until then the menu is set on the main
 * window only, as before. With no page menu the bar is the managed one: on macOS the app menu and
 * Edit (the standard roles), then the custom menus and Window.
 *
 * Runtime-only (imported by `runDesktop`, never a client bundle).
 *
 * @module
 */

import { base64ToBytes } from "../../mobile/base64.ts";
import { supportsAppMenuEvent } from "../../build/deno-version.ts";
import { type DesktopCapability, DesktopCapError } from "../extension.ts";
import type { DesktopAppApi, DesktopMenuItem } from "../launch-events.ts";
import { APP_ITEM_PREFIX, type BackendMenu, windowSubmenuItems } from "../window-menu.ts";
import {
  type AppMenuClick,
  type AppMenus,
  createAppMenus,
  type DesktopAppMenuItemContext,
  MENU_ITEM_PREFIX,
  WINDOW_APP_ITEM_PREFIX,
} from "../app-menus.ts";
import type { DesktopMenuSpec } from "../menu-config.ts";
import { insertCustomMenus, managedBar, mergeWindowSubmenu } from "../menu-bar.ts";
import { clickedId, nativeMenu } from "./menu.ts";
import { platformFacts, reasonText } from "./platform.ts";
import { createPullQueue, type PullQueue } from "./queue.ts";
import { createUserActivity, type UserActivityHandle } from "./user-activity.ts";
import {
  isPrimaryClick,
  trayCapabilitiesOf,
  type TrayMouseDetail,
  trayMouseDetail,
} from "../tray-events.ts";

/** The most tray icons the page may hold. */
const MAX_TRAYS = 8;
/** The largest base64 icon accepted. */
const MAX_ICON_CHARS = 1024 * 1024;
/** The longest tooltip / badge accepted. */
const MAX_TEXT = 256;

/** `Deno.Tray`, as far as this module uses it. */
export interface TrayLike extends EventTarget {
  setIcon(png: Uint8Array): void;
  setIconDark?(png: Uint8Array | null): void;
  setTooltip(text: string | null): void;
  setMenu(menu: DesktopMenuItem[] | null): void;
  getBounds?(): { x: number; y: number; width: number; height: number } | null;
  /** Open the tray's menu at the icon (runtime `3.0.0-denext.6`+); `false` where it can't. */
  popUpMenu?(): boolean;
  destroy(): void;
}

/** `Deno.Tray`: the constructor, and (runtime `3.0.0-denext.6`+) its static `capabilities()`. */
export type TrayConstructor = (new () => TrayLike) & { capabilities?(): unknown };

/** The macOS activation policies (`Deno.dock.setActivationPolicy`). */
export type ActivationPolicy = "regular" | "accessory" | "prohibited";

/** `Deno.dock`, as far as this module uses it. */
export interface DockLike extends EventTarget {
  setBadge(text: string | null): void;
  bounce(critical?: boolean): void;
  setMenu?(menu: DesktopMenuItem[] | null): void;
  setVisible?(visible: boolean): void;
  /** The activation policy (runtime `3.0.0-denext.6`+, macOS); `false` where there is none. */
  setActivationPolicy?(policy: ActivationPolicy): boolean;
  /** The current activation policy, or `null` where there is none. */
  getActivationPolicy?(): ActivationPolicy | null;
}

/** The id pages know the backend tray by. */
export const BACKEND_TRAY_ID = "app";

/** A tray panel (the runtime's `Tray.attachPanel` handle), as far as this module uses it. */
export interface TrayPanelLike {
  readonly visible: boolean;
  show(): void;
  hide(): void;
  toggle(): void;
}

/** The backend tray, as `runDesktop` drives it. */
export interface BackendTray {
  /** The runtime's tray. */
  readonly tray: TrayLike;
  /** Change the icon, tooltip or menu (the wire shape of `updateTray`: base64 icons, menu items). */
  update(options: Record<string, unknown>): void;
  /** The ids of the current menu's items. */
  readonly menuIds: ReadonlySet<string>;
  /** Attach the panel the pages show and hide with `panel`. */
  setPanel(panel: TrayPanelLike): void;
}

/**
 * A tray event on the wire: `click` / `doubleClick` (the names before runtime `3.0.0-denext.6`)
 * and the DOM names of the events that runtime added.
 */
type TrayWireEvent =
  | "click"
  | "doubleClick"
  | "contextmenu"
  | "auxclick"
  | "mouseenter"
  | "mouseleave";

/** The key window when a menu item was chosen (`null` with no app window open). */
type KeyWindowRef = { readonly id: string; readonly key?: string } | null;

/** One click the page takes. */
type AppAction =
  | {
    readonly source: "menu";
    readonly id: string;
    /** The page's own item (`setAppMenu`), a custom menu's, or a window's own Window-menu item. */
    readonly kind: "appMenu" | "menu" | "windowMenu";
    readonly keyWindow: KeyWindowRef;
    /** A custom item's top-level menu. */
    readonly menu?: string;
    /** A checkbox's or radio item's state after the click. */
    readonly checked?: boolean;
    /** The window a Window-menu item belongs to. */
    readonly windowId?: string;
  }
  | { readonly source: "dock"; readonly id: string }
  | {
    readonly source: "tray";
    readonly tray: string;
    readonly event: TrayWireEvent;
    /** The runtime's `TrayMouseEvent` detail (runtime `3.0.0-denext.6`+), else absent. */
    readonly detail?: TrayMouseDetail;
  }
  | { readonly source: "trayMenu"; readonly tray: string; readonly id: string }
  | { readonly source: "dockReopen"; readonly hasVisibleWindows: boolean };

/** Options for {@linkcode createAppController}. */
export interface AppControllerOptions {
  /** The adopted `Deno.BrowserWindow`. */
  readonly window: unknown;
  /** The runtime's app API (`Deno.desktop`), when it has one. */
  readonly api?: DesktopAppApi;
  /** Push an event to the pages (the bridge's `emit`): every window's, or only `target`'s. */
  readonly emit: (cap: string, event: string, data: unknown, target?: string) => void;
  /** The `Deno.Tray` constructor (default the runtime's); tests pass a fake. */
  readonly Tray?: TrayConstructor;
  /** `Deno.dock` (default the runtime's); tests pass a fake. */
  readonly dock?: DockLike;
  /** The running OS (default `Deno.build.os`). */
  readonly os?: string;
  /** The open windows' ids (every window gets the app-wide clicks); default only `"main"`. */
  readonly windows?: () => readonly string[];
  /**
   * The Deno Desktop runtime's version (default `Deno.version.deno`): from
   * `FIRST_APP_MENU_EVENT_RUNTIME` the application menu's clicks are `Deno.desktop`'s
   * (`api`), not the main window's.
   */
  readonly runtimeVersion?: string;
  /** `desktop.menu.menus`, checked. */
  readonly menus?: readonly DesktopMenuSpec[];
  /**
   * The windows that get a menu bar of their own once the app uses custom menus or Window-menu
   * items (default only the main window).
   */
  readonly menuWindows?: () => readonly { readonly id: string; readonly window: unknown }[];
  /** Whether window `id` is open (default: one of {@linkcode menuWindows}). */
  readonly hasWindow?: (id: string) => boolean;
  /** The key window (default none). */
  readonly keyWindow?: () => { readonly id: string; readonly key?: string } | undefined;
  /** A custom item or a window's own Window-menu item was chosen: the backend's handlers. */
  readonly onMenuItem?: (id: string, ctx: DesktopAppMenuItemContext) => void;
}

/** What {@linkcode createAppController} returns. */
export interface AppController {
  /** The `app` bridge capability. */
  readonly capability: DesktopCapability;
  /** Listen for the application menu's and the dock's clicks (once). */
  install(): void;
  /**
   * Make the backend tray (`"app"`): never removed by a page load, clicks to every window. `null`
   * with the reason when no tray icon can be shown here (no `Deno.Tray`, no tray host); then a
   * hidden main window is shown, so the app stays reachable.
   */
  createBackendTray(options: Record<string, unknown>): Promise<BackendTray | { reason: string }>;
  /** Whether a tray icon (the backend's or a page's) is showing: a way back into the app. */
  hasTray(): boolean;
  /**
   * Set (or clear) the backend's "Window" submenu (`desktop.menu.window`): merged into the page's
   * application menu — into its own "Window" submenu when it has one, else appended — and the
   * application menu re-applied. Its clicks go to the submenu's `onClick`, never to the pages.
   */
  setBackendMenu(menu: BackendMenu | undefined): void;
  /** A window closed for good: remove the trays its page made, its queue and its menu state. */
  windowClosed(windowId: string): void;
  /** A window opened: it gets its menu bar (once the app uses custom menus). */
  windowOpened(windowId: string): void;
  /** `setMenu` from the backend: throws a {@linkcode DesktopCapError} for a bad update. */
  setMenu(menuId: string, update: unknown): void;
  /** `setMenuItemState` from the backend. */
  setMenuItemState(itemId: string, state: unknown, windowId?: string): void;
  /** `setWindowMenuAppItems` from the backend, for any window. */
  setWindowMenuAppItems(windowId: string, items: unknown): void;
  /** Queue an action for every window (the backend tray's clicks; tests). */
  broadcast(action: AppAction): void;
  /**
   * The backend tray is being made: pages asking for it (`backendTray`) wait for `pending`, so a
   * page that loads first still finds it.
   */
  backendTrayPending(pending: Promise<unknown>): void;
}

/** A `validation` error. */
function invalid(message: string): DesktopCapError {
  return new DesktopCapError("validation", message);
}

/** Why a feature is missing when the runtime does not say: it has no API for it. */
const NO_API = "this Deno Desktop runtime has no API for it";

/** Why the badge / attention request is missing. */
const NO_DOCK = "this Deno Desktop runtime has no Deno.dock";

/**
 * `unsupported` (501), with the reason in the message and as `data.reason` for the page.
 *
 * @param what The feature ("a tray icon").
 * @param reason Why it is missing here (default: the runtime has no API for it).
 * @param extra More detail for the page (`data`).
 */
function unsupported(
  what: string,
  reason: string = NO_API,
  extra: Record<string, unknown> = {},
): DesktopCapError {
  return new DesktopCapError("unsupported", `${what} is not available here: ${reason}`, {
    status: 501,
    data: { reason, ...extra },
  });
}

/** The reason in a runtime's `NotSupported` from `new Deno.Tray()`, or `undefined` for another error. */
function trayNotSupported(err: unknown): string | undefined {
  const name = (err as { name?: unknown } | null)?.name;
  if (name !== "NotSupported") return undefined;
  const message = err instanceof Error ? err.message : "";
  // The runtime words it "Tray icons are not available here: <reason>".
  return reasonText(message.replace(/^.*?not available here:\s*/i, "")) ?? "no tray host";
}

/** The arguments object (or `{}`). */
function argsOf(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null ? args as Record<string, unknown> : {};
}

/** A base64 PNG as bytes. */
function png(value: unknown, name: string): Uint8Array {
  if (typeof value !== "string" || value === "" || value.length > MAX_ICON_CHARS) {
    throw invalid(`${name} must be a base64 PNG up to 1 MiB`);
  }
  try {
    return base64ToBytes(value);
  } catch {
    throw invalid(`${name} must be base64 PNG bytes`);
  }
}

/** A short optional text (`null` clears). */
function shortText(value: unknown, name: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_TEXT) {
    throw invalid(`${name} must be a string up to ${MAX_TEXT} characters`);
  }
  return value;
}

/** The runtime's `Deno.Tray` / `Deno.dock`, when present. */
function runtimeChrome(): { Tray?: TrayConstructor; dock?: DockLike } {
  const d = Deno as unknown as { Tray?: unknown; dock?: unknown };
  return {
    ...(typeof d.Tray === "function" ? { Tray: d.Tray as TrayConstructor } : {}),
    ...(typeof d.dock === "object" && d.dock !== null ? { dock: d.dock as DockLike } : {}),
  };
}

/** One live tray (a page's, or the backend's). */
interface LiveTray {
  readonly tray: TrayLike;
  ids: Set<string>;
  /** The window whose page made it; `undefined` for the backend tray (every window). */
  readonly owner: string | undefined;
  /** The backend tray's panel. */
  panel?: TrayPanelLike;
}

/** The adopted window, as far as this module uses it. */
type AppWindow = EventTarget & {
  setApplicationMenu?(menu: DesktopMenuItem[]): void;
  setSkipTaskbar?(skip: boolean): void;
  isVisible?(): boolean;
  show?(): void;
};

/** The controller's state, shared by the capability's methods and its listeners. */
interface AppState {
  readonly options: AppControllerOptions;
  readonly Tray: TrayConstructor | undefined;
  readonly dock: DockLike | undefined;
  readonly os: string;
  readonly win: AppWindow | undefined;
  readonly queues: Map<string, PullQueue<AppAction>>;
  readonly trays: Map<string, LiveTray>;
  appMenuIds: Set<string>;
  /** The page's application menu, as last set (merged with the backend's submenu). */
  pageMenu: DesktopMenuItem[] | undefined;
  /** The backend's "Window" submenu (`desktop.menu.window`), if any. */
  backendMenu: BackendMenu | undefined;
  /** The custom menus, their state and the windows' own Window-menu items. */
  readonly model: AppMenus;
  /** The menus were last applied per window (the model active). */
  perWindow: boolean;
  /** Windows whose own `"menuclick"` is listened to (a runtime without app-level clicks). */
  readonly listened: WeakSet<object>;
  dockMenuIds: Set<string>;
  nextTray: number;
  installed: boolean;
  readonly activity: UserActivityHandle;
  /** Settles once the backend tray is made (or failed). */
  trayPending: Promise<unknown>;
}

/**
 * The "Window" submenu for window `windowId`: the backend's items and the window's own, with the
 * macOS roles; `undefined` when there is nothing to show (on the managed macOS bar of an app using
 * custom menus, the roles alone).
 */
function windowSubmenuFor(
  s: AppState,
  windowId: string | undefined,
): DesktopMenuItem[] | undefined {
  const body = s.backendMenu?.items ?? [];
  const extra = s.model.appItemsFor(windowId);
  if (body.length === 0 && extra.length === 0) {
    const managed = s.pageMenu === undefined && s.model.active() && s.os === "darwin";
    return managed ? windowSubmenuItems(s.os, []) : undefined;
  }
  return windowSubmenuItems(s.os, body, extra);
}

/**
 * The menu bar for window `windowId` (`undefined`: the app-wide state): the page's menu, else the
 * managed one, with the "Window" submenu merged in and the custom menus placed. Before the app
 * uses custom menus or Window-menu items, the page's menu with the backend's submenu, as ever.
 */
function barFor(s: AppState, windowId?: string): DesktopMenuItem[] | undefined {
  const active = s.model.active();
  if (!active && !s.backendMenu) return s.pageMenu;
  const bar = mergeWindowSubmenu(s.pageMenu ?? managedBar(s.os), windowSubmenuFor(s, windowId));
  return active ? insertCustomMenus(bar, s.model.menusFor(windowId), s.os) : bar;
}

/** Set `menu` as `win`'s application menu; a failure is a warning. */
function setWindowMenu(win: AppWindow | undefined, menu: DesktopMenuItem[]): void {
  if (typeof win?.setApplicationMenu !== "function") return;
  try {
    win.setApplicationMenu(menu);
  } catch (err) {
    console.warn(
      `desktop: the application menu could not be set: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** The windows that get their own menu bar (default the main window). */
function menuTargets(s: AppState): readonly { readonly id: string; readonly window: unknown }[] {
  return s.options.menuWindows?.() ?? (s.win ? [{ id: "main", window: s.win }] : []);
}

/**
 * On a runtime whose application-menu clicks come from the window, listen to `win`'s too (once):
 * it has a menu of its own now.
 */
function listenToWindowMenu(s: AppState, win: AppWindow): void {
  if (win === s.win || s.listened.has(win) || appMenuClickTarget(s) !== s.win) return;
  s.listened.add(win);
  win.addEventListener("menuclick", (e) => onAppMenuClick(s, e));
}

/**
 * Apply the application menu where the runtime can: on the main window alone while the app uses
 * no custom menus; else each window's own bar (`only`: that window's alone, unless the bars were
 * not per window yet), and on macOS the app-level menu with the app-wide state.
 */
function applyAppMenu(s: AppState, only?: string): void {
  if (!s.model.active()) {
    const menu = barFor(s);
    if (menu !== undefined) setWindowMenu(s.win, menu);
    return;
  }
  // The first time per window: every window's bar, whatever changed.
  const scope = s.perWindow ? only : undefined;
  s.perWindow = true;
  applyPerWindow(s, scope);
  if (scope === undefined && s.os === "darwin") applyAppLevelMenu(s);
}

/** Each window's own bar (`only`: that window's alone). */
function applyPerWindow(s: AppState, only: string | undefined): void {
  for (const target of menuTargets(s)) {
    const win = target.window as AppWindow | undefined;
    if (!win || (only !== undefined && target.id !== only)) continue;
    setWindowMenu(win, barFor(s, target.id) ?? []);
    listenToWindowMenu(s, win);
  }
}

/** macOS: the app-level menu (no window's: shown when the key window has none of its own). */
function applyAppLevelMenu(s: AppState): void {
  const api = s.options.api;
  if (typeof api?.setApplicationMenu !== "function") return;
  try {
    api.setApplicationMenu(barFor(s) ?? []);
  } catch { /* an older runtime's: the key window's menu stays */ }
}

/** Whether the dock menu can be set here (macOS with `Deno.dock.setMenu`). */
function dockMenuWorks(s: AppState): boolean {
  return s.os === "darwin" && typeof s.dock?.setMenu === "function";
}

/** The window's action queue (made on first use; its signal goes to that window only). */
function queueFor(s: AppState, windowId: string): PullQueue<AppAction> {
  let queue = s.queues.get(windowId);
  if (!queue) {
    queue = createPullQueue<AppAction>(() => s.options.emit("app", "action", null, windowId));
    s.queues.set(windowId, queue);
  }
  return queue;
}

/** Queue `action` for `owner`, or for every open window. */
function pushAction(s: AppState, action: AppAction, owner?: string): void {
  const targets = owner !== undefined ? [owner] : s.options.windows?.() ?? ["main"];
  for (const id of targets) queueFor(s, id).push(action);
}

/** The live tray `args.id` names, or a `validation` error. */
function trayOf(s: AppState, args: unknown): LiveTray {
  const id = argsOf(args).id;
  const live = typeof id === "string" ? s.trays.get(id) : undefined;
  if (!live) throw invalid("no such tray");
  return live;
}

/** The id the quit role reports where a tray draws it as an item of the controller's (Windows). */
const TRAY_QUIT_ID = "denext:role:quit";

/**
 * A tray menu as `os` can draw it. Windows' tray menu (the runtime's) draws a role as an empty row
 * that does nothing: there the quit role is a "Quit" item the controller answers, and the other
 * roles, which only macOS has (`about`, `hide`, …), are left out. Unchanged elsewhere.
 */
function trayMenuFor(os: string, items: DesktopMenuItem[]): DesktopMenuItem[] {
  if (os !== "windows") return items;
  return items.flatMap((entry): DesktopMenuItem[] => {
    if (typeof entry !== "object") return [entry];
    if ("role" in entry) {
      if (entry.role.role.toLowerCase() !== "quit") return [];
      return [{ item: { label: "Quit", id: TRAY_QUIT_ID, enabled: true } }];
    }
    if ("submenu" in entry) {
      const { label, items: children } = entry.submenu;
      return [{ submenu: { label, items: trayMenuFor(os, children) } }];
    }
    return [entry];
  });
}

/** Apply the optional `icon` / `iconDark` / `tooltip` / `menu` of `a` to a tray. */
function applyTray(s: AppState, live: LiveTray, a: Record<string, unknown>): void {
  if (a.icon !== undefined) live.tray.setIcon(png(a.icon, "icon"));
  if (a.iconDark !== undefined) {
    live.tray.setIconDark?.(a.iconDark === null ? null : png(a.iconDark, "iconDark"));
  }
  if (a.tooltip !== undefined) live.tray.setTooltip(shortText(a.tooltip, "tooltip"));
  if (a.menu !== undefined) applyTrayMenu(s, live, a.menu);
}

/** Set a tray's menu (`null` removes it) and the ids its items report. */
function applyTrayMenu(s: AppState, live: LiveTray, raw: unknown): void {
  if (raw === null) {
    live.ids = new Set();
    live.tray.setMenu(null);
    return;
  }
  const menu = nativeMenu(raw);
  live.ids = menu.ids;
  live.tray.setMenu(trayMenuFor(s.os, menu.items));
}

/**
 * Why no tray icon can be shown here (`undefined` when one can): no `Deno.Tray`, or the probe
 * found no tray host.
 */
async function trayMissing(s: AppState): Promise<string | undefined> {
  if (!s.Tray) return NO_API;
  const facts = await platformFacts(s.options.api);
  return facts.trayHost === false ? facts.trayReason ?? "no tray host in this session" : undefined;
}

/**
 * `unsupported` for a tray icon, after showing a hidden window: a tray-only app would otherwise
 * be left with no way in. `data.windowShown` says whether it did.
 */
function noTray(s: AppState, reason: string): DesktopCapError {
  const win = s.win;
  let windowShown = false;
  try {
    if (win?.isVisible?.() === false && typeof win.show === "function") {
      win.show();
      windowShown = true;
    }
  } catch { /* the window is gone; nothing to show */ }
  return unsupported("a tray icon", reason, { windowShown });
}

/** A new `Deno.Tray`, or `unsupported` with the runtime's reason when it has no tray host. */
function newTray(s: AppState, T: new () => TrayLike): TrayLike {
  try {
    return new T();
  } catch (err) {
    const reason = trayNotSupported(err);
    if (reason !== undefined) throw noTray(s, reason);
    throw err;
  }
}

/** The runtime tray events, by the wire name the page takes them under. */
const TRAY_WIRE: ReadonlyArray<readonly [string, TrayWireEvent]> = [
  ["click", "click"],
  ["dblclick", "doubleClick"],
  ["contextmenu", "contextmenu"],
  ["auxclick", "auxclick"],
  ["mouseenter", "mouseenter"],
  ["mouseleave", "mouseleave"],
];

/**
 * Queue a tray's mouse events for `owner` (or every window), with the runtime's detail where it
 * has one. A `click` is the primary button's only: a right click comes as `contextmenu`, a middle
 * one as `auxclick` (runtime `3.0.0-denext.6` fires `click` for every button).
 */
function forwardTrayEvents(
  s: AppState,
  tray: TrayLike,
  id: string,
  owner: string | undefined,
): void {
  for (const [type, event] of TRAY_WIRE) {
    tray.addEventListener(type, (e) => {
      const detail = trayMouseDetail(e);
      if (type === "click" && !isPrimaryClick(detail)) return;
      pushAction(s, { source: "tray", tray: id, event, ...(detail ? { detail } : {}) }, owner);
    });
  }
}

/** A new live tray (icon, texts, menu) whose clicks go to `owner`'s queue, or every window's. */
function liveTray(
  s: AppState,
  id: string,
  args: Record<string, unknown>,
  owner: string | undefined,
): LiveTray {
  const icon = png(args.icon, "icon");
  const live: LiveTray = { tray: newTray(s, s.Tray!), ids: new Set(), owner };
  live.tray.setIcon(icon);
  applyTray(s, live, { ...args, icon: undefined });
  forwardTrayEvents(s, live.tray, id, owner);
  live.tray.addEventListener("menuclick", (e) => {
    const item = clickedId(e);
    if (item === TRAY_QUIT_ID) {
      s.options.api?.quit?.();
      return;
    }
    if (item !== undefined && live.ids.has(item)) {
      pushAction(s, { source: "trayMenu", tray: id, id: item }, owner);
    }
  });
  s.trays.set(id, live);
  return live;
}

/** `createTray`: a new tray icon whose clicks and menu clicks the calling window's page takes. */
async function createTray(
  s: AppState,
  args: unknown,
  windowId: string,
): Promise<{ id: string }> {
  const missing = await trayMissing(s);
  if (missing !== undefined) throw noTray(s, missing);
  const pageTrays = [...s.trays.values()].filter((t) => t.owner !== undefined).length;
  if (pageTrays >= MAX_TRAYS) throw invalid(`at most ${MAX_TRAYS} tray icons`);
  const id = String(s.nextTray++);
  liveTray(s, id, argsOf(args), windowId);
  return { id };
}

/** Destroy the trays `windowId`'s page created (never the backend tray). */
function destroyTrays(s: AppState, windowId: string): void {
  for (const [id, live] of s.trays) {
    if (live.owner !== windowId) continue;
    try {
      live.tray.destroy();
    } catch { /* already gone */ }
    s.trays.delete(id);
  }
}

/** The backend tray's handle for `runDesktop`. */
function backendHandle(s: AppState, live: LiveTray): BackendTray {
  return {
    tray: live.tray,
    update: (options) => applyTray(s, live, options),
    get menuIds() {
      return live.ids;
    },
    setPanel: (panel) => {
      live.panel = panel;
    },
  };
}

/** `createBackendTray`: the tray `"app"`, or why there can be none. */
async function createBackendTray(
  s: AppState,
  options: Record<string, unknown>,
): Promise<BackendTray | { reason: string }> {
  if (s.trays.has(BACKEND_TRAY_ID)) throw new Error("desktop: the backend tray exists already");
  const missing = await trayMissing(s);
  if (missing !== undefined) {
    noTray(s, missing); // shows a hidden window
    return { reason: missing };
  }
  try {
    return backendHandle(s, liveTray(s, BACKEND_TRAY_ID, options, undefined));
  } catch (err) {
    if (err instanceof DesktopCapError && err.code === "unsupported") {
      return { reason: String((err.data as { reason?: unknown } | undefined)?.reason) };
    }
    throw err;
  }
}

/** `panel`: show, hide or toggle the backend tray's panel; `{ visible }` after. */
function trayPanel(s: AppState, args: unknown): { visible: boolean } {
  const panel = s.trays.get(BACKEND_TRAY_ID)?.panel;
  if (!panel) throw unsupported("a tray panel", "the app has no desktop.tray.panel");
  const action = argsOf(args).action;
  if (action === "show") panel.show();
  else if (action === "hide") panel.hide();
  else if (action === "toggle") panel.toggle();
  else if (action !== "state") throw invalid('action must be "show", "hide", "toggle" or "state"');
  return { visible: panel.visible };
}

/** `capabilities`: what the menus, tray, dock and session support here. */
async function appCapabilities(s: AppState) {
  const caps = s.options.api?.menuCapabilities?.() ?? {};
  const facts = await platformFacts(s.options.api);
  const trayReason = (await trayMissing(s)) ?? null;
  const dock = s.dock;
  return {
    appMenu: caps.appMenu ?? typeof s.win?.setApplicationMenu === "function",
    accelerators: caps.accelerators === true,
    icons: caps.icons === true,
    tooltips: caps.tooltips === true,
    destructive: caps.destructive === true,
    ...customMenuCapabilities(s),
    tray: trayReason === null,
    trayReason,
    trayHost: facts.trayHost,
    secretService: facts.secretService,
    sessionType: facts.sessionType,
    cookieEncryption: facts.cookieEncryption,
    badge: typeof dock?.setBadge === "function",
    badgeShows: facts.badge,
    badgeReason: facts.badgeReason,
    sandbox: facts.sandbox,
    sandboxReason: facts.sandboxReason,
    fileChooser: facts.fileChooser,
    fileChooserReason: facts.fileChooserReason,
    windowBlur: facts.windowBlur,
    windowBlurReason: facts.windowBlurReason,
    passkeys: facts.passkeys,
    passkeysReason: facts.passkeysReason,
    microphoneAccess: facts.microphoneAccess,
    microphoneAccessReason: facts.microphoneAccessReason,
    cameraAccess: facts.cameraAccess,
    cameraAccessReason: facts.cameraAccessReason,
    bounce: typeof dock?.bounce === "function",
    dockMenu: dockMenuWorks(s),
    ...trayAndDockCapabilities(s, trayReason === null),
  };
}

/** Whether the custom menus' calls work, and whether the runtime has an app-level menu. */
function customMenuCapabilities(s: AppState) {
  const win = s.win;
  const api = s.options.api;
  return {
    customMenus: typeof win?.setApplicationMenu === "function",
    appLevelMenu: typeof api?.setApplicationMenu === "function",
  };
}

/**
 * The Dock icon's visibility and activation policy, the backend tray, and the tray events this OS
 * delivers (`Deno.Tray.capabilities()`), as `capabilities` reports them.
 */
function trayAndDockCapabilities(s: AppState, trayAvailable: boolean) {
  const events = trayCapabilitiesOf(s.Tray, trayAvailable);
  return {
    dockVisibility: s.os === "darwin" && typeof s.dock?.setVisible === "function",
    activationPolicy: s.os === "darwin" && typeof s.dock?.setActivationPolicy === "function",
    backendTray: s.trays.has(BACKEND_TRAY_ID),
    trayPanel: s.trays.get(BACKEND_TRAY_ID)?.panel !== undefined,
    trayClick: events.click,
    trayDoubleClick: events.doubleClick,
    trayRightClick: events.rightClick,
    trayMiddleClick: events.middleClick,
    trayHover: events.hover,
    trayModifiers: events.modifiers,
    trayPosition: events.position,
    trayPopUpMenu: events.popUpMenu,
  };
}

/** The app menu, dock menu, badge and attention-request methods. */
function menuAndDockMethods(s: AppState): DesktopCapability["methods"] {
  return {
    capabilities: { handler: () => appCapabilities(s) },
    setAppMenu: {
      handler: (args) => {
        const win = s.win;
        if (typeof win?.setApplicationMenu !== "function") {
          throw unsupported(
            "an app menu",
            win
              ? "this Deno Desktop runtime has no BrowserWindow.setApplicationMenu"
              : "no app window",
          );
        }
        const { items, ids } = nativeMenu(argsOf(args).menu);
        // The app's own Window-menu items (`desktop.menu.window.items`), the custom menus' and the
        // windows' own items are the backend's.
        for (const id of ids) {
          const reserved = RESERVED_PREFIXES.find((p) => id.startsWith(p));
          if (reserved) {
            throw invalid(`menu: the id prefix "${reserved}" is reserved for the backend`);
          }
        }
        s.pageMenu = items;
        s.appMenuIds = ids;
        applyAppMenu(s);
        return null;
      },
    },
    setDockMenu: {
      handler: (args) => {
        if (!dockMenuWorks(s)) return { applied: false };
        const raw = argsOf(args).menu;
        const menu = raw === null || (Array.isArray(raw) && raw.length === 0)
          ? null
          : nativeMenu(raw);
        s.dock!.setMenu!(menu?.items ?? null);
        s.dockMenuIds = menu?.ids ?? new Set();
        return { applied: true };
      },
    },
    setBadge: {
      handler: (args) => {
        const dock = s.dock;
        if (typeof dock?.setBadge !== "function") throw unsupported("a badge", NO_DOCK);
        // The runtime takes a string: `null` would show as the text "null"; "" clears the badge.
        dock.setBadge(shortText(argsOf(args).text, "text") ?? "");
        return null;
      },
    },
    bounce: {
      handler: (args) => {
        const dock = s.dock;
        if (typeof dock?.bounce !== "function") {
          throw unsupported("an attention request", NO_DOCK);
        }
        dock.bounce(argsOf(args).critical === true);
        return null;
      },
    },
    setDockVisible: {
      handler: (args) => {
        const visible = argsOf(args).visible;
        if (typeof visible !== "boolean") throw invalid("visible must be a boolean");
        // macOS only (the activation policy); Windows and Linux have no app-level icon.
        if (s.os !== "darwin" || typeof s.dock?.setVisible !== "function") {
          return { applied: false };
        }
        s.dock.setVisible(visible);
        return { applied: true };
      },
    },
    setActivationPolicy: { handler: (args) => setActivationPolicy(s, args) },
    getActivationPolicy: {
      handler: () => {
        if (s.os !== "darwin") return { policy: null };
        const policy = s.dock?.getActivationPolicy?.() ?? null;
        return { policy: POLICIES.has(policy as string) ? policy : null };
      },
    },
  };
}

/** The id prefixes a page's `setAppMenu` may not use. */
const RESERVED_PREFIXES = [APP_ITEM_PREFIX, MENU_ITEM_PREFIX, WINDOW_APP_ITEM_PREFIX];

/** `unsupported` unless the runtime can set an application menu here. */
function requireAppMenu(s: AppState): void {
  if (typeof s.win?.setApplicationMenu === "function") return;
  throw unsupported(
    "an app menu",
    s.win ? "this Deno Desktop runtime has no BrowserWindow.setApplicationMenu" : "no app window",
  );
}

/** The custom menus' and the Window menu's own items' methods (`setMenu`, …). */
function customMenuMethods(s: AppState): DesktopCapability["methods"] {
  return {
    setMenu: {
      handler: (args) => {
        const a = argsOf(args);
        setMenu(s, a.menuId, a.menu);
        return null;
      },
    },
    setMenuItemState: {
      handler: (args) => {
        const a = argsOf(args);
        setMenuItemState(s, a.itemId, a.state, a.windowId ?? undefined);
        return null;
      },
    },
    setWindowMenuAppItems: {
      handler: (args, ctx) => {
        setWindowMenuAppItems(s, ctx?.windowId ?? "main", argsOf(args).items);
        return null;
      },
    },
  };
}

/** `setMenu`, then the menus follow. */
function setMenu(s: AppState, menuId: unknown, update: unknown): void {
  requireAppMenu(s);
  s.model.setMenu(menuId, update);
  applyAppMenu(s);
}

/** `setMenuItemState`, then the menu of the window it changed (or every window's) follows. */
function setMenuItemState(s: AppState, itemId: unknown, state: unknown, windowId: unknown): void {
  requireAppMenu(s);
  const changed = s.model.setItemState(itemId, state, windowId);
  applyAppMenu(s, changed ?? undefined);
}

/** `setWindowMenuAppItems` for window `windowId`, then its menu follows. */
function setWindowMenuAppItems(s: AppState, windowId: string, items: unknown): void {
  requireAppMenu(s);
  s.model.setWindowAppItems(windowId, items);
  applyAppMenu(s, windowId);
}

/** The activation policies `setActivationPolicy` takes. */
const POLICIES = new Set<string>(["regular", "accessory", "prohibited"]);

/**
 * `setActivationPolicy`: the macOS activation policy (`Deno.dock.setActivationPolicy`, runtime
 * `3.0.0-denext.6`+); on an older runtime `"regular"` / `"accessory"` show / hide the Dock icon.
 * On Windows and Linux, which have no policy, `"regular"` shows the main window's taskbar entry and
 * the others hide it (as `desktop.app.activationPolicy: "accessory"` does at launch).
 */
function setActivationPolicy(s: AppState, args: unknown): { applied: boolean } {
  const policy = argsOf(args).policy;
  if (typeof policy !== "string" || !POLICIES.has(policy)) {
    throw invalid('policy must be "regular", "accessory" or "prohibited"');
  }
  if (s.os !== "darwin") return { applied: setMainTaskbar(s, policy === "regular") };
  const dock = s.dock;
  if (!dock) return { applied: false };
  if (typeof dock.setActivationPolicy === "function") {
    return { applied: dock.setActivationPolicy(policy as ActivationPolicy) === true };
  }
  if (policy === "prohibited" || typeof dock.setVisible !== "function") return { applied: false };
  dock.setVisible(policy === "regular");
  return { applied: true };
}

/** Show or hide the main window's taskbar entry (Windows, Linux); whether the runtime can. */
function setMainTaskbar(s: AppState, visible: boolean): boolean {
  if (typeof s.win?.setSkipTaskbar !== "function") return false;
  s.win.setSkipTaskbar(!visible);
  return true;
}

/** The tray methods, and `take` (the clicks queued for the page). */
function trayMethods(s: AppState): DesktopCapability["methods"] {
  return {
    createTray: { handler: (args, ctx) => createTray(s, args, ctx?.windowId ?? "main") },
    updateTray: {
      handler: (args) => {
        applyTray(s, trayOf(s, args), argsOf(args));
        return null;
      },
    },
    destroyTray: {
      handler: (args) => {
        const live = trayOf(s, args);
        if (live.owner === undefined) throw invalid("the app's own tray cannot be removed");
        s.trays.delete(String(argsOf(args).id));
        live.tray.destroy();
        return null;
      },
    },
    trayBounds: {
      handler: (args) => trayOf(s, args).tray.getBounds?.() ?? null,
    },
    popUpMenu: {
      handler: (args) => {
        const tray = trayOf(s, args).tray;
        return { shown: typeof tray.popUpMenu === "function" && tray.popUpMenu() === true };
      },
    },
    backendTray: {
      handler: async () => {
        await s.trayPending;
        return { id: s.trays.has(BACKEND_TRAY_ID) ? BACKEND_TRAY_ID : null };
      },
    },
    panel: { handler: (args) => trayPanel(s, args) },
    take: { handler: (_args, ctx) => queueFor(s, ctx?.windowId ?? "main").take() },
  };
}

/** The key window as a click reports it. */
function keyWindowOf(s: AppState): KeyWindowRef {
  const key = s.options.keyWindow?.();
  return key ? { id: key.id, ...(key.key !== undefined ? { key: key.key } : {}) } : null;
}

/**
 * An application-menu click: the backend's submenu handles its own items; a custom item's or a
 * window's own item's state follows, then the pages and the backend's handlers hear of it; the
 * page's own items go to the pages.
 */
function onAppMenuClick(s: AppState, e: Event): void {
  const id = clickedId(e);
  if (id === undefined) return;
  if (s.backendMenu?.ids.has(id)) return s.backendMenu.onClick(id);
  const keyWindow = keyWindowOf(s);
  const custom = s.model.click(id, keyWindow?.id);
  if (custom) return customClicked(s, custom, keyWindow);
  if (s.appMenuIds.has(id)) pushAction(s, { source: "menu", id, kind: "appMenu", keyWindow });
}

/**
 * A custom item (to every window's page) or a window's own Window-menu item (to that window's page)
 * was chosen: the menus follow a state change, then the pages and the backend hear of it.
 */
function customClicked(s: AppState, click: AppMenuClick, keyWindow: KeyWindowRef): void {
  if (click.source === "menu") {
    if (click.changed !== undefined) applyAppMenu(s, click.changed ?? undefined);
    const checked = click.checked !== undefined ? { checked: click.checked } : {};
    pushAction(s, {
      source: "menu",
      id: click.id,
      kind: "menu",
      keyWindow,
      menu: click.menu,
      ...checked,
    });
    s.options.onMenuItem?.(click.id, { source: "menu", keyWindow, menu: click.menu, ...checked });
    return;
  }
  const { id, windowId } = click;
  pushAction(s, { source: "menu", id, kind: "windowMenu", keyWindow, windowId }, windowId);
  s.options.onMenuItem?.(id, { source: "windowMenu", keyWindow, windowId });
}

/**
 * Where the application menu's clicks arrive: `Deno.desktop` on a runtime that delivers them
 * app-wide (from `FIRST_APP_MENU_EVENT_RUNTIME`, with a listener API), else the main
 * window. Only one of them, so a click is never handled twice.
 */
function appMenuClickTarget(s: AppState): Pick<EventTarget, "addEventListener"> | undefined {
  const api = s.options.api;
  const version = s.options.runtimeVersion ?? Deno.version.deno;
  if (typeof api?.addEventListener === "function" && supportsAppMenuEvent(version)) {
    return api as Pick<EventTarget, "addEventListener">;
  }
  return s.win;
}

/** Listen for the application menu's and the dock's clicks, and the session probe's changes (once). */
function installAppEvents(s: AppState): void {
  if (s.installed) return;
  s.installed = true;
  s.activity.install();
  appMenuClickTarget(s)?.addEventListener("menuclick", (e) => onAppMenuClick(s, e));
  s.dock?.addEventListener("menuclick", (e) => {
    const id = clickedId(e);
    if (id !== undefined && s.dockMenuIds.has(id)) pushAction(s, { source: "dock", id });
  });
  // macOS: the Dock icon was clicked (the runtime leaves what happens to the app).
  s.dock?.addEventListener("reopen", (e) => {
    const visible = (e as CustomEvent<{ hasVisibleWindows?: unknown }>).detail?.hasVisibleWindows;
    pushAction(s, { source: "dockReopen", hasVisibleWindows: visible === true });
  });
  // The session probe's answer may have changed (a tray host came or went): the page re-reads
  // the capabilities (`onAppCapabilitiesChanged`).
  s.options.api?.addEventListener?.(
    "platformfeatureschanged",
    () => s.options.emit("app", "capabilities", null),
  );
}

/**
 * Create the `app` capability over the adopted window, `Deno.Tray` and `Deno.dock`.
 *
 * @param options The window, runtime APIs and the bridge's emitter.
 * @returns The capability and its installer.
 */
export function createAppController(options: AppControllerOptions): AppController {
  const chrome = runtimeChrome();
  const s: AppState = {
    options,
    Tray: options.Tray ?? chrome.Tray,
    dock: options.dock ?? chrome.dock,
    os: options.os ?? Deno.build.os,
    win: options.window as AppWindow | undefined,
    queues: new Map(),
    trays: new Map(),
    appMenuIds: new Set(),
    pageMenu: undefined,
    backendMenu: undefined,
    model: createAppMenus({
      ...(options.menus ? { menus: options.menus } : {}),
      hasWindow: options.hasWindow ??
        ((id) => (options.menuWindows?.() ?? [{ id: "main" }]).some((w) => w.id === id)),
    }),
    perWindow: false,
    listened: new WeakSet(),
    dockMenuIds: new Set(),
    nextTray: 1,
    installed: false,
    activity: createUserActivity(options.api, options.emit),
    trayPending: Promise.resolve(),
  };
  const capability: DesktopCapability = {
    name: "app",
    methods: {
      ...menuAndDockMethods(s),
      ...customMenuMethods(s),
      ...trayMethods(s),
      ...s.activity.methods,
    },
    events: ["action", "activity"],
    perWindow: true,
    onPageLoad: (windowId = "main") => {
      destroyTrays(s, windowId);
      s.queues.get(windowId)?.clear();
    },
  };
  return {
    capability,
    install: () => installAppEvents(s),
    createBackendTray: (opts) => createBackendTray(s, opts),
    hasTray: () => s.trays.size > 0,
    setBackendMenu: (menu) => {
      s.backendMenu = menu;
      applyAppMenu(s);
    },
    windowClosed: (windowId) => {
      destroyTrays(s, windowId);
      s.queues.delete(windowId);
      s.model.windowClosed(windowId);
    },
    windowOpened: (windowId) => {
      if (s.model.active()) applyAppMenu(s, windowId);
    },
    setMenu: (menuId, update) => setMenu(s, menuId, update),
    setMenuItemState: (itemId, state, windowId) => setMenuItemState(s, itemId, state, windowId),
    setWindowMenuAppItems: (windowId, items) => setWindowMenuAppItems(s, windowId, items),
    broadcast: (action) => pushAction(s, action),
    backendTrayPending: (pending) => {
      s.trayPending = pending.catch(() => {});
    },
  };
}
