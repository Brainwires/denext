/**
 * The standard window items of the application menu (`desktop.menu.window`): New Window
 * (Cmd/Ctrl+N), Reopen Closed Window (Cmd/Ctrl+Shift+T, Chromium's and Safari's shortcut) and
 * the list of open windows, each focusing its window — as a "Window" submenu the backend adds to
 * the application menu. A page's `setAppMenu` keeps its menu: the backend's items are merged into
 * its "Window" submenu when it has one, else the submenu is appended (see `setBackendMenu` in
 * {@link ./caps/app.ts}). On macOS the submenu starts with the standard Minimize / Zoom / Bring
 * All to Front roles, as the OS's Window menu does.
 *
 * New Window opens `newWindow`'s app path with a fresh key (`window-1`, `window-2`, …: the lowest
 * not open, so a reopened window gets its frame back), unless `desktop.ts` supplies the window
 * (`runDesktop({ newWindow })`). Reopen Closed Window opens the last of the keyed windows the user
 * closed (the registry keeps them, most recent first) again as a page with its key (its frame comes
 * back from the store; a resource an extension disposed with it does not). A window closed by a
 * quit is not kept. With `reopenClosed: "list"` it is a submenu of them instead, by title, at most
 * {@linkcode MAX_REOPEN_LISTED}, each reopening its own key (the first keeps Cmd/Ctrl+Shift+T).
 *
 * The app's own items (`items`) follow denext's, before the window list. Their ids are prefixed
 * with {@linkcode APP_ITEM_PREFIX} in the native menu (a page's `setAppMenu` may not use it), so
 * they never collide with a page's items, and their clicks never reach a page's queue: each click
 * is handed once to `onItem` with the item's own id and the key window ({@linkcode
 * DesktopWindowMenuItemContext}).
 *
 * Runtime-only (imported by `setUpDesktopWindows`, never a client bundle).
 *
 * @module
 */

import type { DesktopMenuItem } from "./launch-events.ts";
import type { DesktopWindowMenuSettings } from "./menu-config.ts";
import type { ClosedWindow, RegisteredWindow, WindowRegistry } from "./window-registry.ts";
import type { DesktopOpenWindowOptions } from "./app-windows.ts";

/** The most closed windows `reopenClosed: "list"` lists. */
const MAX_REOPEN_LISTED = 10;
/** The ids of the backend's items (never a page's). */
const NEW_ID = "denext:window:new";
const REOPEN_ID = "denext:window:reopen";
const REOPEN_PREFIX = "denext:window:reopen:";
const REOPEN_ACCELERATOR = "CommandOrControl+Shift+T";
const FOCUS_PREFIX = "denext:window:focus:";
/**
 * The prefix of the app's own items' ids in the native menu (`desktop.menu.window.items`): a page's
 * application menu may not use it, so a click on one is always the backend's.
 */
export const APP_ITEM_PREFIX = "denext:window:item:";

/**
 * What `runDesktop({ onWindowMenuItem })` and an extension's `host.onWindowMenuItem` get with a
 * click on one of the app's own Window-menu items (`desktop.menu.window.items`).
 */
export interface DesktopWindowMenuItemContext {
  /**
   * The key window when the item was chosen (the app window focused last, else the one opened
   * last): its id and, when it was opened with one, its app key. `null` with no app window open
   * (the tray panel does not count).
   */
  readonly keyWindow: { readonly id: string; readonly key?: string } | null;
}

/**
 * A handler of the app's own Window-menu items: the item's `id` (as configured, without the
 * prefix) and the key window. Called once per click; a throw or a rejection is logged.
 */
export type DesktopWindowMenuItemHandler = (
  id: string,
  ctx: DesktopWindowMenuItemContext,
) => void | Promise<void>;

/** What `runDesktop({ newWindow })` receives: the windows open now. */
export interface DesktopNewWindowContext {
  /** The open windows' ids and keys. */
  readonly windows: readonly { readonly id: string; readonly key?: string }[];
  /** The key New Window would use (`window-N`, the lowest not open). */
  readonly suggestedKey: string;
  /** The app path `desktop.menu.window.newWindow` names, if set. */
  readonly url?: string;
}

/**
 * How `desktop.ts` supplies the window New Window opens (`runDesktop({ newWindow })`): the open
 * options (`url` and `key` at least; a key already open is a `validation` error), or `undefined`
 * to open nothing. Without it New Window opens `desktop.menu.window.newWindow` with the suggested
 * key.
 */
export type DesktopNewWindowHandler = (
  ctx: DesktopNewWindowContext,
) => DesktopOpenWindowOptions | undefined;

/** A menu the backend contributes to the application menu ({@link ./caps/app.ts}). */
export interface BackendMenu {
  /** The "Window" submenu's items. */
  readonly items: DesktopMenuItem[];
  /** Its item ids. */
  readonly ids: ReadonlySet<string>;
  /** One of them was chosen. */
  readonly onClick: (id: string) => void;
}

/** Options for {@linkcode createWindowMenu}. */
export interface WindowMenuOptions {
  readonly settings: DesktopWindowMenuSettings;
  readonly registry: WindowRegistry;
  /** Set (or clear) the backend's submenu on the application menu. */
  readonly setBackendMenu: (menu: BackendMenu | undefined) => void;
  /** `desktop.ts`'s New Window, if any. */
  readonly newWindow?: DesktopNewWindowHandler;
  /** One of the app's own items (`settings.items`) was chosen: its configured id. */
  readonly onItem?: (id: string) => void;
  /** The running OS (default `Deno.build.os`). */
  readonly os?: string;
  /** Where warnings go. */
  readonly warn: (message: string) => void;
}

/** What {@linkcode createWindowMenu} returns. */
export interface WindowMenu {
  /** Build the submenu now and follow the windows (once the registry's lifecycle is live). */
  install(): void;
  /** The recently closed keyed windows, most recent first (the registry's; tests). */
  closed(): readonly ClosedWindow[];
  /** Do what the item `id` does (the menu click; tests). */
  choose(id: string): void;
  /** Build the submenu again (a title changed, a key was forgotten). */
  refresh(): void;
}

/** The menu's state. */
interface MenuState {
  readonly options: WindowMenuOptions;
  readonly os: string;
  installed: boolean;
}

/** The lowest `window-N` key no open window has. */
function suggestedKey(st: MenuState): string {
  const taken = new Set(st.options.registry.list().map((w) => w.key));
  for (let n = 1;; n++) {
    const key = `window-${n}`;
    if (!taken.has(key)) return key;
  }
}

/** An item. */
function item(
  id: string,
  label: string,
  extra: { accelerator?: string; enabled?: boolean; checked?: boolean } = {},
): DesktopMenuItem {
  return {
    item: {
      id,
      label,
      enabled: extra.enabled ?? true,
      ...(extra.accelerator !== undefined ? { accelerator: extra.accelerator } : {}),
      ...(extra.checked ? { checked: true } : {}),
    },
  };
}

/** A window's label in the list: its title, else its key, else its id. */
function labelOf(w: RegisteredWindow): string {
  return w.title ?? w.key ?? w.id;
}

/** Reopen Closed Window: one item, or with `"list"` a submenu of the closed windows. */
function reopenItems(st: MenuState, ids: Set<string>): DesktopMenuItem {
  const closed = st.options.registry.recentlyClosed();
  ids.add(REOPEN_ID);
  if (st.options.settings.reopenClosed !== "list" || closed.length === 0) {
    return item(REOPEN_ID, "Reopen Closed Window", {
      accelerator: REOPEN_ACCELERATOR,
      enabled: closed.length > 0,
    });
  }
  const items = closed.slice(0, MAX_REOPEN_LISTED).map((c, i) => {
    const id = REOPEN_PREFIX + c.key;
    ids.add(id);
    return item(id, c.title ?? c.key, i === 0 ? { accelerator: REOPEN_ACCELERATOR } : {});
  });
  return { submenu: { label: "Reopen Closed Window", items } };
}

/** Start a new group: a separator unless the submenu is empty or ends with one. */
function separate(items: DesktopMenuItem[]): void {
  if (items.length > 0 && items.at(-1) !== "separator") items.push("separator");
}

/** Add items as a group (`entries` as `[id, label, accelerator?]`), their ids to `ids`. */
function addGroup(
  items: DesktopMenuItem[],
  ids: Set<string>,
  entries: readonly (readonly [string, string, string?])[],
): void {
  if (entries.length === 0) return;
  separate(items);
  for (const [id, label, accelerator] of entries) {
    items.push(item(id, label, accelerator ? { accelerator } : {}));
    ids.add(id);
  }
}

/** New Window and Reopen Closed Window, as configured. */
function denextItems(st: MenuState, items: DesktopMenuItem[], ids: Set<string>): void {
  const s = st.options.settings;
  if (typeof s.newWindow === "string" || st.options.newWindow !== undefined) {
    items.push(item(NEW_ID, "New Window", { accelerator: "CommandOrControl+N" }));
    ids.add(NEW_ID);
  }
  if (s.reopenClosed === true || s.reopenClosed === "list") items.push(reopenItems(st, ids));
}

/** The submenu's items now. */
function build(st: MenuState): { items: DesktopMenuItem[]; ids: Set<string> } {
  const s = st.options.settings;
  const items: DesktopMenuItem[] = [];
  const ids = new Set<string>();
  const mac = st.os === "darwin";
  if (mac) items.push({ role: { role: "minimize" } }, { role: { role: "zoom" } }, "separator");
  denextItems(st, items, ids);
  addGroup(
    items,
    ids,
    (s.items ?? []).map((own) => [APP_ITEM_PREFIX + own.id, own.label, own.accelerator] as const),
  );
  if (s.list === true) {
    const windows = st.options.registry.list().filter((w) => w.kind !== "panel");
    addGroup(items, ids, windows.map((w) => [FOCUS_PREFIX + w.id, labelOf(w)] as const));
  }
  if (mac && items.length > 3) items.push("separator", { role: { role: "front" } });
  return { items, ids };
}

/** Set the submenu from the state now. */
function apply(st: MenuState): void {
  const { items, ids } = build(st);
  st.options.setBackendMenu({ items, ids, onClick: (id) => choose(st, id) });
}

/** Open a window for a menu item; a failure is a warning (the menu stays). */
function openFor(st: MenuState, what: string, options: DesktopOpenWindowOptions): void {
  try {
    st.options.registry.open(options);
  } catch (err) {
    st.options.warn(`${what} could not open a window: ${err instanceof Error ? err.message : err}`);
  }
}

/** New Window: `desktop.ts`'s window, else the configured path with the suggested key. */
function newWindow(st: MenuState): void {
  const key = suggestedKey(st);
  const url = st.options.settings.newWindow;
  const handler = st.options.newWindow;
  const options = handler
    ? handler({
      windows: st.options.registry.list().map((w) => ({
        id: w.id,
        ...(w.key !== undefined ? { key: w.key } : {}),
      })),
      suggestedKey: key,
      ...(typeof url === "string" ? { url } : {}),
    })
    : typeof url === "string"
    ? { url, key }
    : undefined;
  if (options) openFor(st, "New Window", options);
}

/**
 * Reopen Closed Window: `key`'s closed window, or the most recently closed keyed window not open
 * again already.
 */
function reopenClosed(st: MenuState, key?: string): void {
  const last = st.options.registry.takeRecentlyClosed(key);
  if (last) openFor(st, "Reopen Closed Window", { url: last.url, key: last.key });
  else apply(st);
}

/** Do what the item `id` does. */
function choose(st: MenuState, id: string): void {
  if (id === NEW_ID) return newWindow(st);
  if (id === REOPEN_ID) return reopenClosed(st);
  if (id.startsWith(REOPEN_PREFIX)) return reopenClosed(st, id.slice(REOPEN_PREFIX.length));
  if (id.startsWith(APP_ITEM_PREFIX)) return st.options.onItem?.(id.slice(APP_ITEM_PREFIX.length));
  if (id.startsWith(FOCUS_PREFIX)) focusWindow(st, id.slice(FOCUS_PREFIX.length));
}

/** Show and focus window `windowId` (the list's item); gone: nothing. */
function focusWindow(st: MenuState, windowId: string): void {
  const w = st.options.registry.get(windowId);
  try {
    w?.window.show?.();
    w?.window.focus?.();
  } catch { /* closing */ }
}

/**
 * Create the window menu: the "Window" submenu's items from the settings and the open windows,
 * kept up to date as windows open and close, and the recently closed keyed windows.
 *
 * @param options The settings, the registry, the app controller's `setBackendMenu`.
 * @returns The menu.
 */
export function createWindowMenu(options: WindowMenuOptions): WindowMenu {
  const st: MenuState = { options, os: options.os ?? Deno.build.os, installed: false };
  return {
    install: () => {
      const lifecycle = options.registry.lifecycle;
      lifecycle.onWindowOpened(() => apply(st));
      lifecycle.onWindowClosed(() => apply(st));
      st.installed = true;
      apply(st);
    },
    closed: () => options.registry.recentlyClosed(),
    choose: (id) => choose(st, id),
    refresh: () => {
      if (st.installed) apply(st);
    },
  };
}
