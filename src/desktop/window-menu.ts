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
 * (`runDesktop({ newWindow })`). Reopen Closed Window keeps the keyed windows the user closed, most
 * recent first, and opens the last one again as a page with its key (its frame comes back from the
 * store; a resource an extension disposed with it does not). A window closed by a quit is not kept.
 *
 * Runtime-only (imported by `setUpDesktopWindows`, never a client bundle).
 *
 * @module
 */

import type { DesktopMenuItem } from "./launch-events.ts";
import type { DesktopWindowMenuSettings } from "./menu-config.ts";
import type { RegisteredWindow, WindowRegistry } from "./window-registry.ts";
import type { DesktopOpenWindowOptions } from "./app-windows.ts";

/** The most recently closed windows Reopen Closed Window remembers. */
const MAX_REOPEN = 16;
/** The ids of the backend's items (never a page's). */
const NEW_ID = "denext:window:new";
const REOPEN_ID = "denext:window:reopen";
const FOCUS_PREFIX = "denext:window:focus:";

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
  /** The running OS (default `Deno.build.os`). */
  readonly os?: string;
  /** Where warnings go. */
  readonly warn: (message: string) => void;
}

/** What {@linkcode createWindowMenu} returns. */
export interface WindowMenu {
  /** Build the submenu now and follow the windows (once the registry's lifecycle is live). */
  install(): void;
  /** The recently closed keyed windows, most recent first (tests). */
  closed(): readonly { readonly key: string; readonly url: string }[];
  /** Do what the item `id` does (the menu click; tests). */
  choose(id: string): void;
  /**
   * A window closed (the registry's `onClosed`): a keyed window the user closed, not a quit's, is
   * remembered for Reopen Closed Window, most recent first, each key once.
   */
  windowClosed(entry: RegisteredWindow, appQuitting: boolean): void;
}

/** A closed window Reopen Closed Window can bring back. */
interface ClosedWindow {
  readonly key: string;
  readonly url: string;
}

/** The menu's state. */
interface MenuState {
  readonly options: WindowMenuOptions;
  readonly closed: ClosedWindow[];
  readonly os: string;
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

/** The submenu's items now. */
function build(st: MenuState): { items: DesktopMenuItem[]; ids: Set<string> } {
  const s = st.options.settings;
  const items: DesktopMenuItem[] = [];
  const ids = new Set<string>();
  if (st.os === "darwin") {
    items.push({ role: { role: "minimize" } }, { role: { role: "zoom" } }, "separator");
  }
  if (typeof s.newWindow === "string" || st.options.newWindow !== undefined) {
    items.push(item(NEW_ID, "New Window", { accelerator: "CommandOrControl+N" }));
    ids.add(NEW_ID);
  }
  if (s.reopenClosed === true) {
    items.push(item(REOPEN_ID, "Reopen Closed Window", {
      accelerator: "CommandOrControl+Shift+T",
      enabled: st.closed.length > 0,
    }));
    ids.add(REOPEN_ID);
  }
  if (s.list === true) {
    const windows = st.options.registry.list().filter((w) => w.kind !== "panel");
    if (items.length > 0 && windows.length > 0 && items.at(-1) !== "separator") {
      items.push("separator");
    }
    for (const w of windows) {
      const id = FOCUS_PREFIX + w.id;
      items.push(item(id, labelOf(w)));
      ids.add(id);
    }
  }
  if (st.os === "darwin" && items.length > 3) items.push("separator", { role: { role: "front" } });
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

/** Reopen Closed Window: the most recently closed keyed window not open again already. */
function reopenClosed(st: MenuState): void {
  while (st.closed.length > 0) {
    const last = st.closed.shift()!;
    if (st.options.registry.byKey(last.key)) continue;
    openFor(st, "Reopen Closed Window", { url: last.url, key: last.key });
    return;
  }
  apply(st);
}

/** Do what the item `id` does. */
function choose(st: MenuState, id: string): void {
  if (id === NEW_ID) return newWindow(st);
  if (id === REOPEN_ID) return reopenClosed(st);
  if (!id.startsWith(FOCUS_PREFIX)) return;
  const w = st.options.registry.get(id.slice(FOCUS_PREFIX.length));
  if (!w) return;
  try {
    w.window.show?.();
    w.window.focus?.();
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
  const st: MenuState = { options, closed: [], os: options.os ?? Deno.build.os };
  return {
    install: () => {
      const lifecycle = options.registry.lifecycle;
      lifecycle.onWindowOpened(() => apply(st));
      lifecycle.onWindowClosed(() => apply(st));
      apply(st);
    },
    closed: () => [...st.closed],
    choose: (id) => choose(st, id),
    windowClosed: (entry, appQuitting) => {
      if (appQuitting || entry.key === undefined || entry.kind !== "window") return;
      const key = entry.key;
      const kept = st.closed.filter((c) => c.key !== key);
      st.closed.splice(0, st.closed.length, { key, url: entry.url }, ...kept);
      st.closed.length = Math.min(st.closed.length, MAX_REOPEN);
    },
  };
}
