/**
 * The `desktop.menu` block of denext.config: the standard window items the backend adds to the
 * application menu (`desktop.menu.window`: New Window, Reopen Closed Window, the open windows,
 * and the app's own `items`), as the validator and `runDesktop` read it. The behaviour is {@link ./window-menu.ts}.
 *
 * Client-safe: no Deno APIs.
 *
 * @module
 */

import { isAppPath } from "./tray-config.ts";

/** The most app items `desktop.menu.window.items` may hold. */
const MAX_WINDOW_MENU_ITEMS = 32;
/** The longest item id accepted. */
const MAX_ITEM_ID = 128;
/** The longest label accepted. */
const MAX_ITEM_LABEL = 256;
/** The longest accelerator accepted. */
const MAX_ITEM_ACCELERATOR = 64;

/** One of the app's own items in the "Window" submenu (`desktop.menu.window.items`). */
export interface DesktopWindowMenuItem {
  /** What a click reports to `onWindowMenuItem` (unique among the items). */
  readonly id: string;
  /** The label. */
  readonly label: string;
  /** The keyboard shortcut (`"CommandOrControl+Shift+W"`). */
  readonly accelerator?: string;
}

/** The standard window items (`desktop.menu.window`), resolved. */
export interface DesktopWindowMenuSettings {
  /** The app path New Window (Cmd/Ctrl+N) opens; `false` or unset: no item. */
  readonly newWindow?: string | false;
  /**
   * Reopen Closed Window (Cmd/Ctrl+Shift+T) over the recently closed keyed windows; `"list"`: a
   * submenu of them by title, most recent first, each reopening its window.
   */
  readonly reopenClosed?: boolean | "list";
  /** List the open windows, each focusing its window when chosen. */
  readonly list?: boolean;
  /**
   * The app's own items, after denext's: a click reaches the backend once (`runDesktop({
   * onWindowMenuItem })`, an extension's `host.onWindowMenuItem`), never the pages.
   */
  readonly items?: readonly DesktopWindowMenuItem[];
}

/** `desktop.menu`, resolved. */
export interface DesktopMenuSettings {
  /** The standard window items. */
  readonly window?: DesktopWindowMenuSettings;
}

/**
 * Why `menu` is not a `desktop.menu`, as `[key, problem]` (the key under `desktop.`), or `null`.
 *
 * @param menu The configured value.
 * @returns The problem, or `null`.
 */
export function desktopMenuProblem(menu: unknown): [string, string] | null {
  if (menu === undefined) return null;
  if (typeof menu !== "object" || menu === null || Array.isArray(menu)) {
    return ["menu", "must be an object"];
  }
  const w = (menu as { window?: unknown }).window;
  if (w === undefined) return null;
  if (typeof w !== "object" || w === null || Array.isArray(w)) {
    return ["menu.window", "must be an object"];
  }
  const o = w as Record<string, unknown>;
  if (o.newWindow !== undefined && o.newWindow !== false && !isAppPath(o.newWindow)) {
    return ["menu.window.newWindow", 'must be a path of the app, like "/", or false'];
  }
  if (
    o.reopenClosed !== undefined && typeof o.reopenClosed !== "boolean" &&
    o.reopenClosed !== "list"
  ) {
    return ["menu.window.reopenClosed", 'must be a boolean or "list"'];
  }
  if (o.list !== undefined && typeof o.list !== "boolean") {
    return ["menu.window.list", "must be a boolean"];
  }
  return o.items === undefined ? null : windowMenuItemsProblem(o.items);
}

/** Whether `value` is a string of 1 to `max` characters with no control character. */
function plainText(value: unknown, max: number): boolean {
  if (typeof value !== "string" || value === "" || value.length > max) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

/** Why one item is not an item, as `[field, problem]`, or `null`. */
function windowMenuItemProblem(entry: unknown): [string, string] | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return ["", "must be an object with an id and a label"];
  }
  const e = entry as Record<string, unknown>;
  if (!plainText(e.id, MAX_ITEM_ID)) {
    return [".id", `must be a string of 1 to ${MAX_ITEM_ID} characters, no control characters`];
  }
  if (!plainText(e.label, MAX_ITEM_LABEL)) {
    return [".label", `must be a string of 1 to ${MAX_ITEM_LABEL} characters`];
  }
  if (e.accelerator !== undefined && !plainText(e.accelerator, MAX_ITEM_ACCELERATOR)) {
    return [
      ".accelerator",
      `must be a string of 1 to ${MAX_ITEM_ACCELERATOR} characters, like "CommandOrControl+Shift+W"`,
    ];
  }
  return null;
}

/** Why `items` is not a `desktop.menu.window.items`, as `[key, problem]`, or `null`. */
function windowMenuItemsProblem(items: unknown): [string, string] | null {
  const key = "menu.window.items";
  if (!Array.isArray(items)) return [key, "must be an array of { id, label, accelerator? }"];
  if (items.length > MAX_WINDOW_MENU_ITEMS) {
    return [key, `holds at most ${MAX_WINDOW_MENU_ITEMS} items`];
  }
  const seen = new Set<string>();
  for (const [i, entry] of items.entries()) {
    const problem = windowMenuItemProblem(entry);
    if (problem) return [`${key}[${i}]${problem[0]}`, problem[1]];
    const id = (entry as { id: string }).id;
    if (seen.has(id)) return [`${key}[${i}].id`, `"${id}" is used by another item`];
    seen.add(id);
  }
  return null;
}

/**
 * `desktop.menu` as `runDesktop` applies it, or `undefined` when unset. Throws for an invalid one
 * (the validator reports the same problem at config load).
 *
 * @param desktop The `desktop` block of the config.
 * @returns The settings.
 */
export function resolveDesktopMenuSettings(desktop: unknown): DesktopMenuSettings | undefined {
  const menu = (desktop as { menu?: unknown } | null | undefined)?.menu;
  if (menu === undefined) return undefined;
  const problem = desktopMenuProblem(menu);
  if (problem) throw new Error(`desktop: invalid desktop.${problem[0]}: ${problem[1]}`);
  const w = (menu as { window?: Record<string, unknown> }).window;
  if (w === undefined) return {};
  return {
    window: {
      ...(w.newWindow !== undefined ? { newWindow: w.newWindow as string | false } : {}),
      ...(w.reopenClosed !== undefined ? { reopenClosed: w.reopenClosed as boolean | "list" } : {}),
      ...(w.list !== undefined ? { list: w.list as boolean } : {}),
      ...(w.items !== undefined ? { items: resolveItems(w.items as DesktopWindowMenuItem[]) } : {}),
    },
  };
}

/** The checked items as `runDesktop` keeps them (a copy, unknown keys dropped). */
function resolveItems(items: readonly DesktopWindowMenuItem[]): DesktopWindowMenuItem[] {
  return items.map((i) => ({
    id: i.id,
    label: i.label,
    ...(i.accelerator !== undefined ? { accelerator: i.accelerator } : {}),
  }));
}
