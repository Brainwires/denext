/**
 * The `desktop.menu` block of denext.config: the standard window items the backend adds to the
 * application menu (`desktop.menu.window`: New Window, Reopen Closed Window, the open windows,
 * and the app's own `items`) and the app's own top-level menus (`desktop.menu.menus`), as the
 * validator and `runDesktop` read them, plus the checks the runtime calls that change those menus
 * (`setMenu`, `setMenuItemState`, `setWindowMenuAppItems`) share. The behaviour is
 * {@link ./window-menu.ts} and {@link ./app-menus.ts}.
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
  /** The app's own top-level menus, in order. */
  readonly menus?: readonly DesktopMenuSpec[];
}

/**
 * The standard menus a custom top-level menu goes after: the app menu (macOS; elsewhere the start
 * of the bar), then File, Edit, View and Window by their labels. One the bar does not have falls
 * back to the one before it (`"view"` with no View menu is `"edit"`).
 */
export type DesktopMenuAnchor = "app" | "file" | "edit" | "view" | "window";

/** What an entry of a custom menu is. */
export type DesktopMenuItemType = "normal" | "checkbox" | "radio" | "separator" | "submenu";

/** The standard items the runtime's menus know (matched case-insensitively). */
export const MENU_ROLES = [
  "about",
  "hide",
  "hideOthers",
  "unhide",
  "quit",
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "selectAll",
  "minimize",
  "zoom",
  "close",
  "front",
  "toggleFullScreen",
] as const;

/**
 * One entry of a custom menu (`desktop.menu.menus[].items`, `setMenu`): an item (`id`, `label`), a
 * checkbox or a radio item (`type`, with `checked`; radio items of one `group` exclude each other),
 * a submenu (`items`), a separator (`type: "separator"`) or a standard item (`role`).
 */
export interface DesktopMenuItemSpec {
  /** What a click reports (unique among every custom menu's items); clickable items need one. */
  readonly id?: string;
  /** The label (items and submenus). */
  readonly label?: string;
  /** The keyboard shortcut (`"CommandOrControl+Shift+K"`). */
  readonly accelerator?: string;
  /** Selectable (default `true`). */
  readonly enabled?: boolean;
  /** A checkmark next to the label (the initial state of a checkbox or radio item). */
  readonly checked?: boolean;
  /**
   * What it is: `"normal"` (default), `"checkbox"` (a click toggles `checked`), `"radio"` (a click
   * checks it and unchecks the rest of its group), `"separator"`, `"submenu"` (default with `items`).
   */
  readonly type?: DesktopMenuItemType;
  /** A radio item's group (default: the radio items of the same submenu without a group). */
  readonly group?: string;
  /** A submenu's entries. */
  readonly items?: readonly DesktopMenuItemSpec[];
  /** A PNG as base64, where the backend draws menu icons (`appCapabilities().icons`). */
  readonly icon?: string;
  /** A standard item the OS handles (`"copy"`, `"toggleFullScreen"`, …); the other keys are ignored. */
  readonly role?: string;
}

/** A custom top-level menu (`desktop.menu.menus`). */
export interface DesktopMenuSpec {
  /** Its id (`setMenu(id, …)`; unique, at most 64 characters). */
  readonly id: string;
  /** The label in the menu bar. */
  readonly label: string;
  /** The standard menu it goes after (default `"view"`). */
  readonly after?: DesktopMenuAnchor;
  /** Its entries. */
  readonly items: readonly DesktopMenuItemSpec[];
}

/** What `setMenu(menuId, update)` sets: the entries, and optionally a new label and place. */
export interface DesktopMenuUpdate {
  /** The label in the menu bar (required for a menu `setMenu` adds). */
  readonly label?: string;
  /** The standard menu it goes after (a new menu's default `"view"`). */
  readonly after?: DesktopMenuAnchor;
  /** Its entries (they replace the menu's). */
  readonly items: readonly DesktopMenuItemSpec[];
}

/** What `setMenuItemState` changes on an item of a custom menu. */
export interface DesktopMenuItemState {
  /** The checkmark (a radio item checked unchecks the rest of its group). */
  readonly checked?: boolean;
  /** Selectable. */
  readonly enabled?: boolean;
  /** The label. */
  readonly label?: string;
}

/**
 * One of a window's own items in the Window menu (`setWindowMenuAppItems`): shown below the window
 * list while that window is key.
 */
export interface DesktopWindowMenuAppItem {
  /** What a click reports (unique in the window's list); `"separator"` entries need none. */
  readonly id?: string;
  /** The label. */
  readonly label?: string;
  /** A checkmark next to the label (the active document, say). */
  readonly checked?: boolean;
  /** Selectable (default `true`). */
  readonly enabled?: boolean;
  /** The keyboard shortcut. */
  readonly accelerator?: string;
  /** `"normal"` (default) or `"separator"`. */
  readonly type?: "normal" | "separator";
}

/** The most custom top-level menus. */
const MAX_MENUS = 16;
/** The longest menu id. */
const MAX_MENU_ID = 64;
/** The most entries one custom menu holds (every level). */
const MAX_MENU_ENTRIES = 500;
/** The deepest submenu nesting in a custom menu. */
const MAX_MENU_DEPTH = 8;
/** The longest radio group name. */
const MAX_GROUP = 64;
/** The largest base64 icon. */
const MAX_ICON_CHARS = 256 * 1024;
/** The most items a window's Window-menu list holds. */
const MAX_WINDOW_APP_ITEMS = 64;
/** The anchors, in bar order. */
export const MENU_ANCHORS: readonly DesktopMenuAnchor[] = ["app", "file", "edit", "view", "window"];
const ITEM_TYPES = new Set(["normal", "checkbox", "radio", "separator", "submenu"]);

/** `[path, problem]`, the path relative to the value checked. */
type Problem = [string, string];

/** Whether `value` is a plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why an optional boolean key is not one. */
function boolProblem(e: Record<string, unknown>, key: string): Problem | null {
  return e[key] !== undefined && typeof e[key] !== "boolean"
    ? [`.${key}`, "must be a boolean"]
    : null;
}

/** Why an id is not one. */
function idProblem(value: unknown, max = MAX_ITEM_ID): Problem | null {
  return plainText(value, max)
    ? null
    : [".id", `must be a string of 1 to ${max} characters, no control characters`];
}

/** Why a label is not one. */
function labelProblem(value: unknown): Problem | null {
  return plainText(value, MAX_ITEM_LABEL)
    ? null
    : [".label", `must be a string of 1 to ${MAX_ITEM_LABEL} characters`];
}

/** Why an optional accelerator is not one. */
function acceleratorProblem(value: unknown): Problem | null {
  return value === undefined || plainText(value, MAX_ITEM_ACCELERATOR) ? null : [
    ".accelerator",
    `must be a string of 1 to ${MAX_ITEM_ACCELERATOR} characters, like "CommandOrControl+Shift+K"`,
  ];
}

/** The first problem of `checks`, or `null`. */
function first(...checks: (Problem | null)[]): Problem | null {
  return checks.find((c) => c !== null) ?? null;
}

/** What one walk over a custom menu's entries tracks. */
interface MenuWalk {
  /** Entries left in this menu. */
  left: number;
  /** Every item id seen so far (all menus). */
  readonly ids: Set<string>;
}

/** Why an optional radio group name is not one. */
function groupProblem(value: unknown): Problem | null {
  return value === undefined || plainText(value, MAX_GROUP)
    ? null
    : [".group", `must be a string of 1 to ${MAX_GROUP} characters`];
}

/** Why an optional icon is not a base64 PNG. */
function iconProblem(value: unknown): Problem | null {
  if (value === undefined) return null;
  const ok = typeof value === "string" && value !== "" && value.length <= MAX_ICON_CHARS &&
    /^[A-Za-z0-9+/=\s]+$/.test(value);
  return ok ? null : [".icon", "must be a PNG as base64, at most 256 KiB of text"];
}

/** Why a clickable entry (normal, checkbox, radio) is not one. */
function clickableProblem(e: Record<string, unknown>, walk: MenuWalk): Problem | null {
  const problem = first(
    idProblem(e.id),
    labelProblem(e.label),
    acceleratorProblem(e.accelerator),
    boolProblem(e, "enabled"),
    boolProblem(e, "checked"),
    groupProblem(e.group),
    iconProblem(e.icon),
  );
  if (problem) return problem;
  const id = e.id as string;
  if (walk.ids.has(id)) return [".id", `"${id}" is used by another menu item`];
  walk.ids.add(id);
  return null;
}

/** Why an entry's `role` is not a known one. */
function roleProblem(value: unknown): Problem | null {
  const role = String(value).toLowerCase();
  return MENU_ROLES.some((r) => r.toLowerCase() === role)
    ? null
    : [".role", `must be one of ${MENU_ROLES.join(", ")}`];
}

/** Why a submenu entry (`items`, or `type: "submenu"`) is not one. */
function submenuProblem(
  entry: Record<string, unknown>,
  depth: number,
  walk: MenuWalk,
): Problem | null {
  if (entry.type !== undefined && entry.type !== "submenu") {
    return [".type", 'an entry with items is a "submenu"'];
  }
  const problem = first(
    labelProblem(entry.label),
    entry.id !== undefined ? idProblem(entry.id) : null,
    depth >= MAX_MENU_DEPTH ? [".items", `submenus nest at most ${MAX_MENU_DEPTH} deep`] : null,
  );
  if (problem) return problem;
  const inner = entriesProblem(entry.items, depth + 1, walk);
  return inner ? [`.items${inner[0]}`, inner[1]] : null;
}

/** Why one entry of a custom menu is not one, as `[path, problem]`. */
function menuEntryProblem(entry: unknown, depth: number, walk: MenuWalk): Problem | null {
  if (--walk.left < 0) return ["", `a menu holds at most ${MAX_MENU_ENTRIES} entries`];
  if (!isObject(entry)) {
    return ["", "must be an object (an item, a submenu, a separator or a role)"];
  }
  if (entry.type !== undefined && !ITEM_TYPES.has(entry.type as string)) {
    return [".type", 'must be "normal", "checkbox", "radio", "separator" or "submenu"'];
  }
  if (entry.role !== undefined) return roleProblem(entry.role);
  if (entry.type === "separator") return null;
  if (entry.items !== undefined || entry.type === "submenu") {
    return submenuProblem(entry, depth, walk);
  }
  return clickableProblem(entry, walk);
}

/** Why a list of custom-menu entries is not one (`[i].path`). */
function entriesProblem(items: unknown, depth: number, walk: MenuWalk): Problem | null {
  if (!Array.isArray(items)) return ["", "must be an array of menu items"];
  for (const [i, entry] of items.entries()) {
    const problem = menuEntryProblem(entry, depth, walk);
    if (problem) return [`[${i}]${problem[0]}`, problem[1]];
  }
  return null;
}

/**
 * Why `items` is not a custom menu's entries, as `[path, problem]` (the path from the list, like
 * `"[2].items[0].label"`), or `null`. Item ids must not be in `taken` (another menu's), and are
 * added to it.
 *
 * @param items The entries.
 * @param taken The item ids other menus use.
 * @returns The problem, or `null`.
 */
function menuItemsProblem(items: unknown, taken: Set<string> = new Set()): Problem | null {
  return entriesProblem(items, 1, { left: MAX_MENU_ENTRIES, ids: taken });
}

/** Why an optional anchor is not one. */
function anchorProblem(value: unknown): Problem | null {
  return value === undefined || MENU_ANCHORS.includes(value as DesktopMenuAnchor)
    ? null
    : [".after", 'must be "app", "file", "edit", "view" or "window"'];
}

/**
 * Why `update` is not a `setMenu` update, as `[path, problem]`, or `null`. `isNew`: the menu does
 * not exist yet (a label is required). Item ids must not be in `taken`.
 *
 * @param update The update.
 * @param isNew Whether `setMenu` adds the menu.
 * @param taken The item ids other menus use.
 * @returns The problem, or `null`.
 */
export function menuUpdateProblem(
  update: unknown,
  isNew: boolean,
  taken: Set<string> = new Set(),
): Problem | null {
  if (!isObject(update)) return ["", "must be an object with items, or null"];
  const label = update.label !== undefined || isNew ? labelProblem(update.label) : null;
  const problem = first(label, anchorProblem(update.after));
  if (problem) return problem;
  const items = menuItemsProblem(update.items, taken);
  return items ? [`.items${items[0]}`, items[1]] : null;
}

/** Why `menus` is not a `desktop.menu.menus`, as `[key, problem]` (under `desktop.`), or `null`. */
function customMenusProblem(menus: unknown): Problem | null {
  const key = "menu.menus";
  if (!Array.isArray(menus)) return [key, "must be an array of { id, label, after?, items }"];
  if (menus.length > MAX_MENUS) return [key, `holds at most ${MAX_MENUS} menus`];
  const menuIds = new Set<string>();
  const itemIds = new Set<string>();
  for (const [i, menu] of menus.entries()) {
    const at = `${key}[${i}]`;
    if (!isObject(menu)) return [at, "must be an object with an id, a label and items"];
    const problem = first(idProblem(menu.id, MAX_MENU_ID), labelProblem(menu.label)) ??
      anchorProblem(menu.after);
    if (problem) return [`${at}${problem[0]}`, problem[1]];
    if (menuIds.has(menu.id as string)) return [`${at}.id`, `"${menu.id}" is used by another menu`];
    menuIds.add(menu.id as string);
    const items = menuItemsProblem(menu.items, itemIds);
    if (items) return [`${at}.items${items[0]}`, items[1]];
  }
  return null;
}

/**
 * Why `state` is not a `setMenuItemState` state, as `[path, problem]`, or `null`.
 *
 * @param state The state.
 * @returns The problem, or `null`.
 */
export function menuItemStateProblem(state: unknown): Problem | null {
  if (!isObject(state)) return ["", "must be an object with checked, enabled or label"];
  return first(
    boolProblem(state, "checked"),
    boolProblem(state, "enabled"),
    state.label !== undefined ? labelProblem(state.label) : null,
  );
}

/**
 * Why `items` is not a window's Window-menu items (`setWindowMenuAppItems`), as `[path, problem]`,
 * or `null`.
 *
 * @param items The items.
 * @returns The problem, or `null`.
 */
export function windowMenuAppItemsProblem(items: unknown): Problem | null {
  if (!Array.isArray(items)) return ["", "must be an array of { id, label, … }, or null"];
  if (items.length > MAX_WINDOW_APP_ITEMS) {
    return ["", `holds at most ${MAX_WINDOW_APP_ITEMS} items`];
  }
  const seen = new Set<string>();
  for (const [i, entry] of items.entries()) {
    const problem = windowAppItemProblem(entry, seen);
    if (problem) return [`[${i}]${problem[0]}`, problem[1]];
  }
  return null;
}

/** Why one Window-menu app item is not one. */
function windowAppItemProblem(entry: unknown, seen: Set<string>): Problem | null {
  if (!isObject(entry)) return ["", "must be an object with an id and a label"];
  if (entry.type === "separator") return null;
  if (entry.type !== undefined && entry.type !== "normal") {
    return [".type", 'must be "normal" or "separator"'];
  }
  const problem = first(
    idProblem(entry.id),
    labelProblem(entry.label),
    acceleratorProblem(entry.accelerator),
    boolProblem(entry, "checked"),
    boolProblem(entry, "enabled"),
  );
  if (problem) return problem;
  if (seen.has(entry.id as string)) return [".id", `"${entry.id}" is used by another item`];
  seen.add(entry.id as string);
  return null;
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
  const { menus, window } = menu as { menus?: unknown; window?: unknown };
  return (menus !== undefined ? customMenusProblem(menus) : null) ??
    (window !== undefined ? windowSettingsProblem(window) : null);
}

/** Why `w` is not a `desktop.menu.window`, as `[key, problem]`, or `null`. */
function windowSettingsProblem(w: unknown): [string, string] | null {
  if (!isObject(w)) return ["menu.window", "must be an object"];
  return first(
    newWindowProblem(w.newWindow),
    reopenClosedProblem(w.reopenClosed),
    w.list !== undefined && typeof w.list !== "boolean"
      ? ["menu.window.list", "must be a boolean"]
      : null,
  ) ?? (w.items === undefined ? null : windowMenuItemsProblem(w.items));
}

/** Why `desktop.menu.window.newWindow` is not an app path or `false`. */
function newWindowProblem(value: unknown): [string, string] | null {
  return value === undefined || value === false || isAppPath(value)
    ? null
    : ["menu.window.newWindow", 'must be a path of the app, like "/", or false'];
}

/** Why `desktop.menu.window.reopenClosed` is not a boolean or `"list"`. */
function reopenClosedProblem(value: unknown): [string, string] | null {
  return value === undefined || typeof value === "boolean" || value === "list"
    ? null
    : ["menu.window.reopenClosed", 'must be a boolean or "list"'];
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
  const menus = (menu as { menus?: readonly DesktopMenuSpec[] }).menus;
  return {
    ...(w !== undefined ? { window: resolveWindowSettings(w) } : {}),
    ...(menus !== undefined && menus.length > 0 ? { menus: menus.map(copyMenu) } : {}),
  };
}

/** `desktop.menu.window`, checked, as `runDesktop` keeps it. */
function resolveWindowSettings(w: Record<string, unknown>): DesktopWindowMenuSettings {
  return {
    ...(w.newWindow !== undefined ? { newWindow: w.newWindow as string | false } : {}),
    ...(w.reopenClosed !== undefined ? { reopenClosed: w.reopenClosed as boolean | "list" } : {}),
    ...(w.list !== undefined ? { list: w.list as boolean } : {}),
    ...(w.items !== undefined ? { items: resolveItems(w.items as DesktopWindowMenuItem[]) } : {}),
  };
}

/** A checked custom menu as `runDesktop` keeps it (a deep copy). */
function copyMenu(menu: DesktopMenuSpec): DesktopMenuSpec {
  return {
    id: menu.id,
    label: menu.label,
    ...(menu.after !== undefined ? { after: menu.after } : {}),
    items: structuredClone(menu.items) as DesktopMenuItemSpec[],
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
