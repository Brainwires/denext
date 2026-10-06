/**
 * The app's own chrome and system integration in a Deno Desktop window (`denext/desktop/app`):
 * the application menu with keyboard accelerators, tray icons with their menus, the Dock /
 * taskbar badge and attention request, system-wide keyboard shortcuts, and starting the app at
 * login.
 *
 * - The menu, tray, badge and attention calls go to the runtime's `app` capability, which
 *   `runDesktop` registers for every app (no `denext desktop add`). They work under the stock
 *   runtime too; denext's pinned runtime adds accelerators on every OS and menu icons / tooltips
 *   (see {@linkcode appCapabilities}).
 * - {@linkcode registerShortcut} needs `denext desktop add global-shortcuts`, and
 *   {@linkcode setLaunchAtLogin} `denext desktop add launch-at-login`; both need denext's pinned
 *   runtime (elsewhere they reject `unavailable`).
 *
 * The Dock menu (macOS) is `setQuickActions` / `onQuickAction` in `denext/mobile`, the same calls
 * that set an iOS / Android app's home-screen quick actions.
 *
 * A page load (a reload, a navigation) removes the tray icons and releases the shortcuts the
 * previous page created: their handlers went with it. Create them again at startup.
 *
 * Client-safe: web APIs only, nothing runs at import. Off desktop (the web, iOS, Android, SSR) a
 * call rejects `unavailable` without making a request, and a subscription does nothing.
 *
 * @example
 * ```ts
 * import { onAppMenuItem, setAppMenu } from "denext/desktop/app";
 *
 * await setAppMenu([
 *   { label: "File", submenu: [
 *     { id: "new", label: "New Window", accelerator: "CommandOrControl+N" },
 *     "separator",
 *     { role: "quit" },
 *   ] },
 *   { label: "Edit", submenu: [{ role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
 * ]);
 * onAppMenuItem((id) => {
 *   if (id === "new") openWindow();
 * });
 * ```
 *
 * @module
 */

import { bytesToBase64 } from "../mobile/base64.ts";
import { desktopRpc, subscribeDesktopEvent } from "./bridge-client.ts";
import { onAppAction } from "./app-actions.ts";
import { pullQueue } from "./pull.ts";

export {
  type DesktopBridgeError,
  type DesktopErrorCode,
  isDesktopBridgeError,
} from "./bridge-client.ts";

/** A standard menu item the OS draws and handles itself. */
export type AppMenuRole =
  | "about"
  | "hide"
  | "hideOthers"
  | "unhide"
  | "quit"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "minimize"
  | "zoom"
  | "close"
  | "front"
  | "toggleFullScreen";

/** A clickable menu item. */
export interface AppMenuAction {
  /** What {@linkcode onAppMenuItem} (or a tray's `onMenuItem`) reports when it is chosen. */
  readonly id: string;
  /** The label. */
  readonly label: string;
  /**
   * A keyboard shortcut in the `"CommandOrControl+Shift+K"` syntax: in the application menu it
   * fires the item while the window has the focus (every OS under denext's pinned runtime); in a
   * tray menu it is only shown.
   */
  readonly accelerator?: string;
  /** Shown but not selectable. */
  readonly disabled?: boolean;
  /** A checkmark next to the label. */
  readonly checked?: boolean;
  /** Shown on hover (macOS, Linux). */
  readonly tooltip?: string;
  /** A PNG (base64) next to the label, where the backend draws icons. */
  readonly icon?: string;
}

/** A submenu. */
export interface AppSubmenu {
  /** Its label. */
  readonly label: string;
  /** Its items. */
  readonly submenu: readonly AppMenuItem[];
}

/** A standard item (copy, paste, quit, …). */
export interface AppMenuRoleItem {
  /** Which one. */
  readonly role: AppMenuRole;
}

/** One entry of an application, tray or Dock menu. */
export type AppMenuItem = AppMenuAction | AppSubmenu | AppMenuRoleItem | "separator";

/** A session fact the runtime could not report (a runtime before 2.9.7-denext.10, or no answer). */
export type PlatformUnknown = "unknown";

/**
 * The Secret Service's state, as the runtime reads it without starting or unlocking it: `"os"` on
 * macOS and Windows (Keychain, DPAPI); on Linux `"locked"` also covers a missing default keyring
 * and `"activatable"` is installed but not running.
 */
export type SecretServiceState =
  | "available"
  | "locked"
  | "activatable"
  | "absent"
  | "no-session-bus"
  | "os";

/** What this OS and runtime can do ({@linkcode appCapabilities}). */
export interface AppCapabilities {
  /** {@linkcode setAppMenu} works. */
  readonly appMenu: boolean;
  /** Application-menu accelerators fire their items from the keyboard. */
  readonly accelerators: boolean;
  /** Menu item icons are drawn. */
  readonly icons: boolean;
  /** Menu item tooltips are shown. */
  readonly tooltips: boolean;
  /** {@linkcode createTray} works. */
  readonly tray: boolean;
  /** Why {@linkcode createTray} does not work here (`null` when it does): the runtime's reason. */
  readonly trayReason: string | null;
  /**
   * A tray host runs in this session (Linux: a StatusNotifierWatcher, as GNOME has only with the
   * AppIndicator extension, or an XEmbed tray), as the runtime probed it.
   */
  readonly trayHost: boolean | PlatformUnknown;
  /** The Secret Service behind the secure store (and CEF's cookie key). */
  readonly secretService: SecretServiceState | PlatformUnknown;
  /** Linux: `"wayland"`, `"x11"`, `"tty"` (no graphical session) or `"unknown"`; `null` elsewhere. */
  readonly sessionType: "wayland" | "x11" | "tty" | PlatformUnknown | null;
  /**
   * CEF's cookie store: `"os"` (encrypted with a key the OS keeps) or `"basic"` (unencrypted: the
   * Linux login keyring was locked with no one to unlock it); `null` on the WebView backends.
   */
  readonly cookieEncryption: "os" | "basic" | PlatformUnknown | null;
  /** {@linkcode setBadge} works. */
  readonly badge: boolean;
  /**
   * Where the badge shows: `"dock"` (the macOS Dock tile), `"launcher-entry"` (Linux: a count on
   * the app's launcher, where a dock reads it: Ubuntu's dock, Dash to Dock, Plasma's task manager)
   * or `"title"` (a `"(N) "` prefix on the window titles: Windows, Linux without such a dock, and a
   * badge that isn't a number), as the runtime probed it (runtime 2.9.7-denext.11 and later).
   */
  readonly badgeShows: "dock" | "launcher-entry" | "title" | PlatformUnknown;
  /** Linux, when `badgeShows` is `"title"`: why no launcher shows the count (the runtime's). */
  readonly badgeReason: string | null;
  /** {@linkcode bounce} works. */
  readonly bounce: boolean;
  /** `setQuickActions` (in `denext/mobile`) sets the Dock menu (macOS). */
  readonly dockMenu: boolean;
}

/** The wire form of a menu (`submenu` → `children`). */
function menuWire(menu: readonly AppMenuItem[]): unknown[] {
  return menu.map((entry) => {
    if (entry === "separator") return "separator";
    if ("submenu" in entry) return { label: entry.label, children: menuWire(entry.submenu) };
    if ("role" in entry) return { role: entry.role };
    return {
      id: entry.id,
      label: entry.label,
      enabled: entry.disabled !== true,
      ...(entry.checked ? { checked: true } : {}),
      ...(entry.accelerator !== undefined ? { accelerator: entry.accelerator } : {}),
      ...(entry.tooltip !== undefined ? { tooltip: entry.tooltip } : {}),
      ...(entry.icon !== undefined ? { icon: entry.icon } : {}),
    };
  });
}

/** `raw[key]` when it is one of `allowed`, else `"unknown"`. */
function oneOf<T>(raw: Record<string, unknown> | null, key: string, allowed: readonly T[]) {
  const value = raw?.[key] as T;
  return allowed.includes(value) ? value : "unknown";
}

const SECRET_STATES = [
  "available",
  "locked",
  "activatable",
  "absent",
  "no-session-bus",
  "os",
] as const;

/**
 * What the application menu, tray and Dock can do on this OS and runtime, plus the session facts
 * the runtime probed (`Deno.desktop.platformFeatures()`, runtime 2.9.7-denext.10 and later): the
 * tray host, the Secret Service, the session type and the cookie store. A fact an older runtime
 * cannot report reads `"unknown"`.
 *
 * @returns The capabilities.
 */
export async function appCapabilities(): Promise<AppCapabilities> {
  const raw = await desktopRpc<Record<string, unknown>>("app", "capabilities", {});
  const flag = (k: string) => raw?.[k] === true;
  const reason = raw?.trayReason;
  return {
    appMenu: flag("appMenu"),
    accelerators: flag("accelerators"),
    icons: flag("icons"),
    tooltips: flag("tooltips"),
    tray: flag("tray"),
    trayReason: typeof reason === "string" && reason !== ""
      ? reason
      : flag("tray")
      ? null
      : "not reported",
    trayHost: oneOf(raw, "trayHost", [true, false]),
    secretService: oneOf(raw, "secretService", SECRET_STATES),
    sessionType: oneOf(raw, "sessionType", ["wayland", "x11", "tty", null] as const),
    cookieEncryption: oneOf(raw, "cookieEncryption", ["os", "basic", null] as const),
    badge: flag("badge"),
    badgeShows: oneOf(raw, "badgeShows", ["dock", "launcher-entry", "title"] as const),
    badgeReason: typeof raw?.badgeReason === "string" && raw.badgeReason !== ""
      ? raw.badgeReason
      : null,
    bounce: flag("bounce"),
    dockMenu: flag("dockMenu"),
  };
}

/**
 * Call `handler` with fresh {@linkcode appCapabilities} whenever the runtime says what the session
 * provides may have changed (runtime 2.9.7-denext.10 and later, Linux: a tray host started or went
 * away, as when the GNOME AppIndicator extension is enabled while the app runs). Create the tray
 * icon again when `tray` turns `true`. Older runtimes never call it.
 *
 * @param handler Called with the capabilities as they are now.
 * @returns A function that unsubscribes.
 */
export function onAppCapabilitiesChanged(
  handler: (capabilities: AppCapabilities) => void,
): () => void {
  return subscribeDesktopEvent("app", "capabilities", () => {
    appCapabilities().then(handler, () => {});
  });
}

/**
 * Replace the application menu: the macOS menu bar, the window's menu bar on Windows and Linux.
 * Chosen items reach {@linkcode onAppMenuItem}; roles are handled by the OS.
 *
 * @param menu The top-level entries (usually submenus).
 * @returns A promise that settles once the menu is set. It rejects `validation` for a bad entry.
 */
export async function setAppMenu(menu: readonly AppMenuItem[]): Promise<void> {
  await desktopRpc("app", "setAppMenu", { menu: menuWire(menu) });
}

/**
 * Call `handler` with the `id` of each application-menu item the user chooses (by click or
 * accelerator).
 *
 * @param handler Called with the item's id.
 * @returns A function that unsubscribes.
 */
export function onAppMenuItem(handler: (id: string) => void): () => void {
  return onAppAction((action) => {
    if (action.source === "menu") handler(action.id);
  });
}

/**
 * Show a badge on the app icon: the Dock icon on macOS, the taskbar button on Windows. On Linux a
 * count shows on the app's launcher where a dock reads launcher badges (runtime 2.9.7-denext.11:
 * Ubuntu's dock, Dash to Dock, Plasma's task manager), else as a prefix of the window titles;
 * `appCapabilities().badgeShows` says which. `null`, `""` or `0` removes it.
 *
 * @param badge The text or count.
 * @returns A promise that settles once it is shown.
 */
export async function setBadge(badge: string | number | null): Promise<void> {
  const text = badge === null || badge === 0 || badge === "" ? null : String(badge);
  await desktopRpc("app", "setBadge", { text });
}

/**
 * Ask for the user's attention: bounce the Dock icon (macOS), flash the taskbar button (Windows),
 * or mark the window urgent (Linux). Nothing happens while the app is focused.
 *
 * @param options `critical`: keep at it until the app is focused (default: once).
 * @returns A promise that settles once requested.
 */
export async function bounce(options: { readonly critical?: boolean } = {}): Promise<void> {
  await desktopRpc("app", "bounce", { critical: options.critical === true });
}

/** A tray icon's image: PNG bytes, or base64 PNG. */
export type TrayIcon = Uint8Array | string;

/** The settings of a tray icon ({@linkcode createTray}). */
export interface TrayOptions {
  /** The icon (PNG). On macOS a black-and-transparent image is drawn as a template image. */
  readonly icon: TrayIcon;
  /** The icon in dark mode, where the OS tells them apart. */
  readonly iconDark?: TrayIcon | null;
  /** Shown on hover. */
  readonly tooltip?: string | null;
  /** The menu (right-click, or click on macOS when there is no click handler). */
  readonly menu?: readonly AppMenuItem[] | null;
}

/** Where a tray icon is on screen. */
export interface TrayBounds {
  /** The left edge. */
  readonly x: number;
  /** The top edge. */
  readonly y: number;
  /** The width. */
  readonly width: number;
  /** The height. */
  readonly height: number;
}

/** A tray icon the page created. */
export interface AppTray {
  /** Its id. */
  readonly id: string;
  /** Change its icon, tooltip or menu (`null` removes the tooltip / menu / dark icon). */
  update(options: Partial<TrayOptions>): Promise<void>;
  /** Where it is, or `null` where the OS cannot say (Linux). */
  getBounds(): Promise<TrayBounds | null>;
  /** Call `handler` on each click (`"click"` or `"doubleClick"`). Returns the unsubscribe. */
  onClick(handler: (event: "click" | "doubleClick") => void): () => void;
  /** Call `handler` with the id of each menu item chosen. Returns the unsubscribe. */
  onMenuItem(handler: (id: string) => void): () => void;
  /** Remove it. */
  destroy(): Promise<void>;
}

/** An icon on the wire. */
function iconWire(icon: TrayIcon): string {
  return typeof icon === "string" ? icon : bytesToBase64(icon);
}

/** The wire form of tray settings (only what is set). */
function trayWire(options: Partial<TrayOptions>): Record<string, unknown> {
  return {
    ...(options.icon !== undefined ? { icon: iconWire(options.icon) } : {}),
    ...(options.iconDark !== undefined
      ? { iconDark: options.iconDark === null ? null : iconWire(options.iconDark) }
      : {}),
    ...(options.tooltip !== undefined ? { tooltip: options.tooltip } : {}),
    ...(options.menu !== undefined
      ? { menu: options.menu === null ? null : menuWire(options.menu) }
      : {}),
  };
}

/**
 * Add an icon to the system tray (the macOS menu bar's status items, the Windows notification
 * area, Linux's AppIndicator area).
 *
 * @param options The icon, tooltip and menu.
 * @returns The tray icon. It rejects `unsupported` where no tray icon can be shown: a runtime with
 * no tray, or a session with no tray host (stock GNOME without the AppIndicator extension). The
 * error's `data.reason` says which; when the window was hidden (a tray-only app) the runtime shows
 * it, and `data.windowShown` is `true`. {@linkcode appCapabilities} reports the same up front.
 * @example
 * ```ts
 * import { createTray } from "denext/desktop/app";
 *
 * const icon = new Uint8Array(await (await fetch("/tray.png")).arrayBuffer());
 * const tray = await createTray({
 *   icon,
 *   tooltip: "Acme",
 *   menu: [{ id: "show", label: "Show Acme" }, "separator", { role: "quit" }],
 * });
 * tray.onMenuItem((id) => id === "show" && showWindow());
 * ```
 */
export async function createTray(options: TrayOptions): Promise<AppTray> {
  const out = await desktopRpc<{ id?: unknown }>("app", "createTray", trayWire(options));
  const id = String(out?.id ?? "");
  return {
    id,
    update: async (next) => {
      await desktopRpc("app", "updateTray", { id, ...trayWire(next) });
    },
    getBounds: async () => {
      const b = await desktopRpc<TrayBounds | null>("app", "trayBounds", { id });
      return b && typeof b.x === "number" ? b : null;
    },
    onClick: (handler) =>
      onAppAction((a) => {
        if (a.source === "tray" && a.tray === id) handler(a.event);
      }),
    onMenuItem: (handler) =>
      onAppAction((a) => {
        if (a.source === "trayMenu" && a.tray === id) handler(a.id);
      }),
    destroy: async () => {
      await desktopRpc("app", "destroyTray", { id });
    },
  };
}

// --- global shortcuts (cap "globalShortcuts") -------------------------------------------------

/** What global shortcuts can do here ({@linkcode shortcutCapabilities}). */
export interface ShortcutCapabilities {
  /** Registering binds system-wide shortcuts in this session. */
  readonly globalShortcuts: boolean;
  /** The user approves each shortcut and may choose another trigger (Wayland's portal). */
  readonly userBinds: boolean;
}

/** A registered shortcut ({@linkcode registerShortcut}). */
export interface RegisteredShortcut {
  /** Its canonical form (`"CommandOrControl+Shift+K"` → `"Ctrl+Shift+K"`, `"Shift+Super+K"` on macOS). */
  readonly accelerator: string;
  /** Release it. */
  unregister(): Promise<void>;
}

/** The handlers per canonical accelerator. */
const shortcutHandlers = new Map<string, Set<() => void>>();
/** The subscription to presses (while any handler is registered). */
let stopPresses: (() => void) | undefined;

/** Every press, from the runtime's queue. */
const onPress = pullQueue<string>("globalShortcuts", "pressed", (raw) => {
  const acc = (raw as { accelerator?: unknown } | null)?.accelerator;
  return typeof acc === "string" ? acc : undefined;
});

/** Drop `handler` for `accelerator`; the last one gone also stops listening. */
function dropHandler(accelerator: string, handler: () => void): void {
  const set = shortcutHandlers.get(accelerator);
  set?.delete(handler);
  if (set?.size === 0) shortcutHandlers.delete(accelerator);
  if (shortcutHandlers.size === 0) {
    stopPresses?.();
    stopPresses = undefined;
  }
}

/**
 * What global shortcuts can do on this OS and runtime.
 *
 * @returns The capabilities.
 */
export async function shortcutCapabilities(): Promise<ShortcutCapabilities> {
  const raw = await desktopRpc<Record<string, unknown>>("globalShortcuts", "capabilities", {});
  return { globalShortcuts: raw?.globalShortcuts === true, userBinds: raw?.userBinds === true };
}

/**
 * Bind a key combination system-wide: `handler` runs whichever app has the keyboard focus. Needs
 * `denext desktop add global-shortcuts` and denext's pinned runtime.
 *
 * Accelerators: modifiers (`CommandOrControl`, `Control`, `Alt`/`Option`, `Shift`, `Super`/`Meta`,
 * `Command` on macOS) then one key (`A`–`Z`, `0`–`9`, punctuation, `F1`–`F24`, `Space`, `Enter`,
 * arrows, …). A printable key needs a modifier other than Shift.
 *
 * @param accelerator The combination.
 * @param handler Called on each press.
 * @returns The registration. It rejects with code `validation` (does not parse), `conflict`
 * (another app holds it), `already_registered`, `denied` (the user declined, Wayland) or
 * `unsupported` (no global shortcuts here).
 * @example
 * ```ts
 * import { registerShortcut } from "denext/desktop/app";
 *
 * const s = await registerShortcut("CommandOrControl+Shift+Space", () => toggleQuickEntry());
 * // later: await s.unregister();
 * ```
 */
export async function registerShortcut(
  accelerator: string,
  handler: () => void,
): Promise<RegisteredShortcut> {
  const out = await desktopRpc<{ accelerator?: unknown }>(
    "globalShortcuts",
    "register",
    { accelerator },
    { timeoutMs: false },
  );
  const canonical = typeof out?.accelerator === "string" ? out.accelerator : accelerator;
  const set = shortcutHandlers.get(canonical) ?? new Set();
  set.add(handler);
  shortcutHandlers.set(canonical, set);
  stopPresses ??= onPress((acc) => {
    for (const fn of [...shortcutHandlers.get(acc) ?? []]) fn();
  });
  let active = true;
  return {
    accelerator: canonical,
    unregister: async () => {
      if (!active) return;
      active = false;
      dropHandler(canonical, handler);
      if (!shortcutHandlers.has(canonical)) {
        await desktopRpc("globalShortcuts", "unregister", { accelerator: canonical });
      }
    },
  };
}

/**
 * Release a shortcut this app registered (any spelling of it).
 *
 * @param accelerator The combination.
 * @returns Whether it was registered.
 */
export async function unregisterShortcut(accelerator: string): Promise<boolean> {
  const canon = await desktopRpc<{ accelerator?: unknown }>("globalShortcuts", "canonicalize", {
    accelerator,
  });
  const out = await desktopRpc<{ removed?: unknown }>("globalShortcuts", "unregister", {
    accelerator,
  });
  const key = typeof canon?.accelerator === "string" ? canon.accelerator : accelerator;
  for (const fn of [...shortcutHandlers.get(key) ?? []]) dropHandler(key, fn);
  return out?.removed === true;
}

/**
 * Release every shortcut this app registered.
 *
 * @returns A promise that settles once released.
 */
export async function unregisterAllShortcuts(): Promise<void> {
  for (const [acc, set] of [...shortcutHandlers]) for (const fn of [...set]) dropHandler(acc, fn);
  await desktopRpc("globalShortcuts", "unregisterAll", {});
}

/**
 * The shortcuts this app holds, canonical, in registration order.
 *
 * @returns The accelerators.
 */
export async function listShortcuts(): Promise<string[]> {
  const out = await desktopRpc<unknown>("globalShortcuts", "list", {});
  return Array.isArray(out) ? out.filter((a): a is string => typeof a === "string") : [];
}

// --- launch at login (cap "launchAtLogin") ----------------------------------------------------

/**
 * Whether the app starts at login. `requires-approval`: registered, but the user has to allow it
 * in the system settings (macOS Login Items, or a Windows startup entry the user turned off).
 */
export type LaunchAtLoginState = "enabled" | "disabled" | "requires-approval" | "not-supported";

/** A state from the wire. */
function loginState(out: { state?: unknown } | null | undefined): LaunchAtLoginState {
  const s = out?.state;
  return s === "enabled" || s === "disabled" || s === "requires-approval" ? s : "not-supported";
}

/**
 * Whether the app starts when the user logs in. Needs `denext desktop add launch-at-login` and
 * denext's pinned runtime.
 *
 * @returns The state.
 */
export async function getLaunchAtLogin(): Promise<LaunchAtLoginState> {
  return loginState(await desktopRpc<{ state?: unknown }>("launchAtLogin", "get", {}));
}

/**
 * Start the app when the user logs in (or stop): a macOS login item, a Windows `Run` value, a
 * Linux XDG autostart entry. Turn it on only when the user asks.
 *
 * @param enabled On or off.
 * @returns The state afterwards. It rejects `failed` when the OS refused.
 * @example
 * ```ts
 * import { setLaunchAtLogin } from "denext/desktop/app";
 *
 * const state = await setLaunchAtLogin(true);
 * if (state === "requires-approval") showHint("Allow Acme in System Settings › Login Items");
 * ```
 */
export async function setLaunchAtLogin(enabled: boolean): Promise<LaunchAtLoginState> {
  return loginState(await desktopRpc<{ state?: unknown }>("launchAtLogin", "set", { enabled }));
}
