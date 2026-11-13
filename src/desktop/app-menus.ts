/**
 * The app's own top-level menus (`desktop.menu.menus`, `setMenu`), their items' state (app-wide
 * and per window, `setMenuItemState`) and each window's own items in the Window menu
 * (`setWindowMenuAppItems`): the model the `app` capability ({@link ./caps/app.ts}) builds each
 * window's menu bar from.
 *
 * State: an item's state for a window is its definition, then the app-wide state set on it, then
 * the state set for that window (`{ windowId }`), each key on its own. A window's menu bar is
 * built with that window's state, so whichever window is key shows its own (on macOS the runtime
 * swaps the menu bar as windows take the focus; on Windows and Linux each window has its own bar).
 * A window's state and items go with it when it closes.
 *
 * Clicks: a checkbox toggles, a radio item checks itself and unchecks the rest of its group (the
 * radio items of the same top-level menu with the same `group`, or with none, of the same submenu).
 * The new state is kept where the item's state came from: for the key window when its `checked`
 * was set for that window (any of the group's, for a radio item), else app-wide.
 *
 * Native ids: a custom item is {@linkcode MENU_ITEM_PREFIX} + its id, a window's own item
 * {@linkcode WINDOW_APP_ITEM_PREFIX} + the window id (URI-encoded) + `:` + its id, so they never
 * collide with a page's `setAppMenu` items (which may not use the prefixes).
 *
 * Runtime-only (imported by the `app` capability, never a client bundle).
 *
 * @module
 */

import { base64ToBytes } from "../mobile/base64.ts";
import { DesktopCapError } from "./extension.ts";
import type { DesktopMenuItem } from "./launch-events.ts";
import {
  type DesktopMenuAnchor,
  type DesktopMenuItemSpec,
  type DesktopMenuItemState,
  type DesktopMenuSpec,
  type DesktopMenuUpdate,
  type DesktopWindowMenuAppItem,
  menuItemStateProblem,
  menuUpdateProblem,
  windowMenuAppItemsProblem,
} from "./menu-config.ts";

/** The native id prefix of a custom menu's items. */
export const MENU_ITEM_PREFIX = "denext:menu:";
/** The native id prefix of a window's own Window-menu items. */
export const WINDOW_APP_ITEM_PREFIX = "denext:window:app:";

/**
 * What the backend's handlers (`runDesktop({ onAppMenuItem })`, an extension's
 * `host.onAppMenuItem`) get with a click on a custom menu's item or a window's own Window-menu item.
 */
export interface DesktopAppMenuItemContext {
  /** A custom menu's item (`"menu"`) or a window's own Window-menu item (`"windowMenu"`). */
  readonly source: "menu" | "windowMenu";
  /**
   * The key window when the item was chosen (the app window focused last, else the one opened
   * last), with its app key when it has one; `null` with no app window open.
   */
  readonly keyWindow: { readonly id: string; readonly key?: string } | null;
  /** A custom item's top-level menu id. */
  readonly menu?: string;
  /** A checkbox's or radio item's state after the click (the menu shows it already). */
  readonly checked?: boolean;
  /** The window a Window-menu item belongs to (`setWindowMenuAppItems`). */
  readonly windowId?: string;
}

/** A handler of custom-menu clicks: the item's id and the click's context. */
export type DesktopAppMenuItemHandler = (
  id: string,
  ctx: DesktopAppMenuItemContext,
) => void | Promise<void>;

/**
 * The custom menus as the backend drives them (`runDesktop`'s result, an extension's host). Each
 * call throws a `DesktopCapError` (`validation`, `not_found` for a window not open, `unsupported`
 * where the runtime sets no application menu).
 */
export interface DesktopAppMenusApi {
  /**
   * Replace a custom top-level menu's entries (and optionally its label and place), add one (a
   * `label` is required then), or remove one with `null` (a configured one too, until it is set
   * again). Item ids stay unique across every custom menu. The app-wide state set on the menu's
   * items is dropped (the new entries carry their own); a window's state stays for ids still there.
   */
  setMenu(menuId: string, menu: DesktopMenuUpdate | null): void;
  /**
   * Change a custom item's `checked`, `enabled` or `label`: app-wide, or with `{ windowId }` for
   * that window only, shown while it is key (and in its own menu bar on Windows and Linux) over the
   * app-wide state. Checking a radio item unchecks the rest of its group at the same level. The
   * window's state goes when it closes.
   */
  setMenuItemState(
    itemId: string,
    state: DesktopMenuItemState,
    options?: { readonly windowId?: string },
  ): void;
  /**
   * Window `windowId`'s own items in the Window menu, below the window list after a separator,
   * shown while that window is key; `null` (or `[]`) clears them, and they go when it closes.
   */
  setWindowMenuAppItems(windowId: string, items: readonly DesktopWindowMenuAppItem[] | null): void;
  /**
   * Call `fn` once per click on a custom menu's item or a window's own Window-menu item, with its
   * id and {@linkcode DesktopAppMenuItemContext} (the key window, the menu, a checkbox's or radio
   * item's new state). The pages hear the same clicks through `onAppMenuItem`. A throw or a
   * rejection is logged. Returns the unsubscribe.
   */
  onAppMenuItem(fn: DesktopAppMenuItemHandler): () => void;
}

/** A custom top-level menu, built for one window. */
export interface BuiltMenu {
  /** The standard menu it goes after. */
  readonly after: DesktopMenuAnchor;
  /** Its place among the custom menus (config order, then the order `setMenu` added them). */
  readonly order: number;
  /** The submenu. */
  readonly entry: DesktopMenuItem;
}

/** What a click on a custom item or a window's own item is. */
export type AppMenuClick =
  | {
    readonly source: "menu";
    /** The item's id. */
    readonly id: string;
    /** Its top-level menu's id. */
    readonly menu: string;
    /** A checkbox's or radio item's state after the click. */
    readonly checked?: boolean;
    /** The window whose state changed, `null` for the app-wide state, `undefined` for none. */
    readonly changed?: string | null;
  }
  | {
    readonly source: "windowMenu";
    /** The item's id. */
    readonly id: string;
    /** The window whose item it is. */
    readonly windowId: string;
  };

/** Options for {@linkcode createAppMenus}. */
export interface AppMenusOptions {
  /** `desktop.menu.menus`, checked. */
  readonly menus?: readonly DesktopMenuSpec[];
  /** Whether window `id` is open (per-window calls on any other are `not_found`). */
  readonly hasWindow: (id: string) => boolean;
}

/** What {@linkcode createAppMenus} returns. */
export interface AppMenus {
  /** Whether the app uses any of this: custom menus, or one of the calls was made. */
  active(): boolean;
  /** `setMenu`: replace, add (`label` required) or (`null`) remove a custom menu. */
  setMenu(menuId: unknown, update: unknown): void;
  /**
   * `setMenuItemState`: app-wide, or for window `windowId`. Returns the window whose menu changed,
   * or `null` for every window.
   */
  setItemState(itemId: unknown, state: unknown, windowId?: unknown): string | null;
  /** `setWindowMenuAppItems`: window `windowId`'s own Window-menu items (`null` clears them). */
  setWindowAppItems(windowId: string, items: unknown): void;
  /** Window `windowId` closed: its state and items go. */
  windowClosed(windowId: string): void;
  /** The custom menus as window `windowId` shows them (`undefined`: the app-wide state). */
  menusFor(windowId?: string): BuiltMenu[];
  /** Window `windowId`'s own Window-menu items, native. */
  appItemsFor(windowId?: string): DesktopMenuItem[];
  /** A native menu click: what it is, with the state changed, or `undefined` for none of these. */
  click(nativeId: string, keyWindowId?: string): AppMenuClick | undefined;
}

/** A clickable item of a custom menu, as the model tracks it. */
interface TrackedItem {
  readonly id: string;
  readonly menu: string;
  readonly kind: "normal" | "checkbox" | "radio";
  /** A radio item's group key (scoped to its top-level menu). */
  readonly group?: string;
  readonly spec: DesktopMenuItemSpec;
  readonly icon?: Uint8Array;
}

/** A custom menu as kept. */
interface TrackedMenu {
  readonly id: string;
  label: string;
  after: DesktopMenuAnchor;
  items: readonly DesktopMenuItemSpec[];
  readonly order: number;
}

/** The model's state. */
interface ModelState {
  readonly options: AppMenusOptions;
  readonly menus: TrackedMenu[];
  readonly items: Map<string, TrackedItem>;
  readonly appState: Map<string, DesktopMenuItemState>;
  readonly windowState: Map<string, Map<string, DesktopMenuItemState>>;
  readonly appItems: Map<string, readonly DesktopWindowMenuAppItem[]>;
  used: boolean;
  nextOrder: number;
}

/** A `validation` error. */
function invalid(message: string): DesktopCapError {
  return new DesktopCapError("validation", `menu: ${message}`);
}

/** `[path, problem]` as a `validation` error on `what`. */
function fail(what: string, problem: [string, string]): never {
  throw invalid(`${what}${problem[0]} ${problem[1]}`);
}

/** Whether a spec is a submenu. */
function isSubmenuSpec(spec: DesktopMenuItemSpec): boolean {
  return spec.items !== undefined || spec.type === "submenu";
}

/** Whether a spec is a clickable item (not a role, separator or submenu). */
function isClickableSpec(spec: DesktopMenuItemSpec): boolean {
  return spec.role === undefined && spec.type !== "separator" && !isSubmenuSpec(spec);
}

/** Track one clickable item of `menu`; `level` names its submenu (a radio item's default group). */
function trackItem(st: ModelState, menu: TrackedMenu, spec: DesktopMenuItemSpec, level: string) {
  const kind = spec.type === "checkbox" || spec.type === "radio" ? spec.type : "normal";
  const group = kind === "radio"
    ? { group: `${menu.id}\u0000${spec.group ?? `\u0000${level}`}` }
    : {};
  st.items.set(spec.id!, { id: spec.id!, menu: menu.id, kind, ...group, spec, ...iconOf(spec) });
}

/** Track `menu`'s clickable items (walking submenus), each radio item with its group key. */
function trackItems(st: ModelState, menu: TrackedMenu): void {
  const walk = (items: readonly DesktopMenuItemSpec[], level: string) => {
    items.forEach((spec, i) => {
      if (isSubmenuSpec(spec)) walk(spec.items ?? [], `${level}/${i}`);
      else if (isClickableSpec(spec)) trackItem(st, menu, spec, level);
    });
  };
  walk(menu.items, "");
}

/** An item's icon as bytes; one that does not decode is left out (the item shows without it). */
function iconOf(spec: DesktopMenuItemSpec): { icon?: Uint8Array } {
  if (spec.icon === undefined) return {};
  try {
    return { icon: base64ToBytes(spec.icon) };
  } catch {
    return {};
  }
}

/** Forget `menuId`'s items (and their app-wide state); window state only for ids not in `keep`. */
function untrackItems(st: ModelState, menuId: string, keep: ReadonlySet<string>): void {
  for (const [id, item] of st.items) {
    if (item.menu !== menuId) continue;
    st.items.delete(id);
    st.appState.delete(id);
    if (keep.has(id)) continue;
    for (const states of st.windowState.values()) states.delete(id);
  }
}

/** The item ids of every custom menu but `menuId`. */
function idsOutside(st: ModelState, menuId: string): Set<string> {
  const ids = new Set<string>();
  for (const item of st.items.values()) if (item.menu !== menuId) ids.add(item.id);
  return ids;
}

/** The clickable item ids of a list of entries (all levels). */
function idsOf(items: readonly DesktopMenuItemSpec[], into = new Set<string>()): Set<string> {
  for (const spec of items) {
    if (spec.items) idsOf(spec.items, into);
    else if (spec.id !== undefined && spec.role === undefined) into.add(spec.id);
  }
  return into;
}

/** Add a menu (checked). */
function addMenu(st: ModelState, spec: DesktopMenuSpec): void {
  const menu: TrackedMenu = {
    id: spec.id,
    label: spec.label,
    after: spec.after ?? "view",
    items: structuredClone(spec.items) as DesktopMenuItemSpec[],
    order: st.nextOrder++,
  };
  st.menus.push(menu);
  trackItems(st, menu);
}

/** A `setMenu` menu id, checked. */
function checkMenuId(menuId: unknown): string {
  if (typeof menuId === "string" && menuId !== "" && menuId.length <= 64) return menuId;
  throw invalid("menuId must be a string of 1 to 64 characters");
}

/** Remove menu `menuId` (and its items' state); nothing when it is not there. */
function removeMenu(st: ModelState, menuId: string): void {
  const index = st.menus.findIndex((m) => m.id === menuId);
  if (index < 0) return;
  untrackItems(st, menuId, new Set());
  st.menus.splice(index, 1);
}

/** A checked `setMenu` update. */
type MenuUpdate = { label?: string; after?: DesktopMenuAnchor; items: DesktopMenuItemSpec[] };

/** Replace menu `menu`'s entries (and label / place) with a checked update. */
function replaceMenu(st: ModelState, menu: TrackedMenu, u: MenuUpdate): void {
  untrackItems(st, menu.id, idsOf(u.items));
  menu.label = u.label ?? menu.label;
  menu.after = u.after ?? menu.after;
  menu.items = structuredClone(u.items);
  trackItems(st, menu);
}

/** `setMenu`. */
function setMenu(st: ModelState, rawId: unknown, update: unknown): void {
  const menuId = checkMenuId(rawId);
  st.used = true;
  if (update === null) return removeMenu(st, menuId);
  const menu = st.menus.find((m) => m.id === menuId);
  const problem = menuUpdateProblem(update, menu === undefined, idsOutside(st, menuId));
  if (problem) fail(`setMenu("${menuId}")`, problem);
  const u = update as MenuUpdate;
  if (menu) return replaceMenu(st, menu, u);
  addMenu(st, {
    id: menuId,
    label: u.label!,
    ...(u.after ? { after: u.after } : {}),
    items: u.items,
  });
}

/** The radio items of `group`. */
function groupOf(st: ModelState, group: string): TrackedItem[] {
  return [...st.items.values()].filter((i) => i.group === group);
}

/** Merge `patch` into the state `id` has in `states`. */
function patchState(
  states: Map<string, DesktopMenuItemState>,
  id: string,
  patch: DesktopMenuItemState,
): void {
  states.set(id, { ...states.get(id), ...patch });
}

/** The state map of `windowId` (made on first use), or the app-wide one for `undefined`. */
function statesOf(st: ModelState, windowId: string | undefined): Map<string, DesktopMenuItemState> {
  if (windowId === undefined) return st.appState;
  let states = st.windowState.get(windowId);
  if (!states) st.windowState.set(windowId, states = new Map());
  return states;
}

/** Check `item` (a radio item unchecks the rest of its group) in `states`. */
function setChecked(
  st: ModelState,
  states: Map<string, DesktopMenuItemState>,
  item: TrackedItem,
  checked: boolean,
): void {
  if (item.kind === "radio" && checked && item.group !== undefined) {
    for (const other of groupOf(st, item.group)) {
      if (other.id !== item.id) patchState(states, other.id, { checked: false });
    }
  }
  patchState(states, item.id, { checked });
}

/** A per-window call's window: `undefined` (app-wide), or an open window's id, else `not_found`. */
function checkWindow(st: ModelState, windowId: unknown): string | undefined {
  if (windowId === undefined) return undefined;
  if (typeof windowId === "string" && st.options.hasWindow(windowId)) return windowId;
  throw new DesktopCapError("not_found", "no such window", { status: 404 });
}

/** `setMenuItemState`: the window whose menu changed, or `null` for every window. */
function setItemState(
  st: ModelState,
  itemId: unknown,
  state: unknown,
  rawWindow: unknown,
): string | null {
  st.used = true;
  const item = typeof itemId === "string" ? st.items.get(itemId) : undefined;
  if (!item) throw invalid(`no custom menu item "${String(itemId).slice(0, 128)}"`);
  const problem = menuItemStateProblem(state);
  if (problem) fail(`setMenuItemState("${item.id}")`, problem);
  const windowId = checkWindow(st, rawWindow);
  const states = statesOf(st, windowId);
  const { checked, ...rest } = definedOnly(state as DesktopMenuItemState);
  if (Object.keys(rest).length > 0) patchState(states, item.id, rest);
  if (checked !== undefined) setChecked(st, states, item, checked);
  return windowId ?? null;
}

/** `state` without its `undefined` keys (so a layer never hides the one below with one). */
function definedOnly(state: DesktopMenuItemState | undefined): DesktopMenuItemState {
  return Object.fromEntries(Object.entries(state ?? {}).filter(([, v]) => v !== undefined));
}

/** The state an item shows: its definition, then the app-wide state, then window `windowId`'s. */
interface ShownState {
  readonly label: string;
  readonly checked: boolean;
  readonly enabled: boolean;
}

/** Item `id`'s state as window `windowId` shows it. */
function effective(st: ModelState, item: TrackedItem, windowId?: string): ShownState {
  const own = windowId !== undefined ? st.windowState.get(windowId)?.get(item.id) : undefined;
  return {
    label: item.spec.label ?? "",
    checked: item.spec.checked === true,
    enabled: item.spec.enabled !== false,
    ...definedOnly(st.appState.get(item.id)),
    ...definedOnly(own),
  } as ShownState;
}

/** A role entry. */
function roleEntry(role: string): DesktopMenuItem {
  return { role: { role } };
}

/** Build a custom menu's entries for window `windowId`. */
function buildEntries(
  st: ModelState,
  items: readonly DesktopMenuItemSpec[],
  windowId: string | undefined,
): DesktopMenuItem[] {
  return items.map((spec): DesktopMenuItem => {
    if (spec.role !== undefined) return roleEntry(spec.role);
    if (spec.type === "separator") return "separator";
    if (isSubmenuSpec(spec)) {
      return {
        submenu: { label: spec.label ?? "", items: buildEntries(st, spec.items ?? [], windowId) },
      };
    }
    const item = st.items.get(spec.id!)!;
    const now = effective(st, item, windowId);
    return {
      item: {
        id: MENU_ITEM_PREFIX + item.id,
        label: now.label,
        enabled: now.enabled,
        ...(now.checked ? { checked: true } : {}),
        ...(spec.accelerator !== undefined ? { accelerator: spec.accelerator } : {}),
        ...(item.icon ? { icon: item.icon } : {}),
      },
    };
  });
}

/** Window `windowId`'s own items, native. */
function appItemsFor(st: ModelState, windowId: string | undefined): DesktopMenuItem[] {
  if (windowId === undefined) return [];
  const items = st.appItems.get(windowId) ?? [];
  const prefix = `${WINDOW_APP_ITEM_PREFIX}${encodeURIComponent(windowId)}:`;
  return items.map((i): DesktopMenuItem =>
    i.type === "separator" ? "separator" : {
      item: {
        id: prefix + i.id,
        label: i.label!,
        enabled: i.enabled !== false,
        ...(i.checked ? { checked: true } : {}),
        ...(i.accelerator !== undefined ? { accelerator: i.accelerator } : {}),
      },
    }
  );
}

/** Whether `windowId` set `checked` on `item` (any of its group, for a radio item). */
function checkedForWindow(
  st: ModelState,
  item: TrackedItem,
  windowId: string | undefined,
): boolean {
  if (windowId === undefined) return false;
  const states = st.windowState.get(windowId);
  if (!states) return false;
  const members = item.group !== undefined ? groupOf(st, item.group) : [item];
  return members.some((m) => states.get(m.id)?.checked !== undefined);
}

/** A click on custom item `id`: toggle its state where it lives. */
function clickItem(st: ModelState, id: string, keyWindowId?: string): AppMenuClick | undefined {
  const item = st.items.get(id);
  if (!item) return undefined;
  if (!effective(st, item, keyWindowId).enabled) return undefined;
  if (item.kind === "normal") return { source: "menu", id, menu: item.menu };
  const scope = checkedForWindow(st, item, keyWindowId) ? keyWindowId : undefined;
  const checked = item.kind === "radio" ? true : !effective(st, item, keyWindowId).checked;
  setChecked(st, statesOf(st, scope), item, checked);
  return { source: "menu", id, menu: item.menu, checked, changed: scope ?? null };
}

/** A click on one of a window's own items. */
function clickAppItem(st: ModelState, rest: string): AppMenuClick | undefined {
  const sep = rest.indexOf(":");
  if (sep < 0) return undefined;
  let windowId: string;
  try {
    windowId = decodeURIComponent(rest.slice(0, sep));
  } catch {
    return undefined;
  }
  const id = rest.slice(sep + 1);
  const item = st.appItems.get(windowId)?.find((i) => i.type !== "separator" && i.id === id);
  if (!item || item.enabled === false) return undefined;
  return { source: "windowMenu", id, windowId };
}

/** `setWindowMenuAppItems`: window `windowId`'s own items (`null` clears them). */
function setWindowAppItems(st: ModelState, windowId: string, items: unknown): void {
  st.used = true;
  checkWindow(st, windowId);
  if (items === null) {
    st.appItems.delete(windowId);
    return;
  }
  const problem = windowMenuAppItemsProblem(items);
  if (problem) fail("setWindowMenuAppItems: items", problem);
  st.appItems.set(windowId, structuredClone(items) as DesktopWindowMenuAppItem[]);
}

/** A native click: a custom item's, a window's own item's, or none of these. */
function click(st: ModelState, nativeId: string, keyWindowId?: string): AppMenuClick | undefined {
  if (nativeId.startsWith(MENU_ITEM_PREFIX)) {
    return clickItem(st, nativeId.slice(MENU_ITEM_PREFIX.length), keyWindowId);
  }
  if (nativeId.startsWith(WINDOW_APP_ITEM_PREFIX)) {
    return clickAppItem(st, nativeId.slice(WINDOW_APP_ITEM_PREFIX.length));
  }
  return undefined;
}

/**
 * Create the model over `desktop.menu.menus`.
 *
 * @param options The configured menus and the window check.
 * @returns The model.
 */
export function createAppMenus(options: AppMenusOptions): AppMenus {
  const st: ModelState = {
    options,
    menus: [],
    items: new Map(),
    appState: new Map(),
    windowState: new Map(),
    appItems: new Map(),
    used: false,
    nextOrder: 0,
  };
  for (const menu of options.menus ?? []) addMenu(st, menu);
  return {
    active: () => st.used || st.menus.length > 0,
    setMenu: (menuId, update) => setMenu(st, menuId, update),
    setItemState: (itemId, state, windowId) => setItemState(st, itemId, state, windowId),
    setWindowAppItems: (windowId, items) => setWindowAppItems(st, windowId, items),
    windowClosed: (windowId) => {
      st.windowState.delete(windowId);
      st.appItems.delete(windowId);
    },
    menusFor: (windowId) =>
      st.menus.map((m) => ({
        after: m.after,
        order: m.order,
        entry: { submenu: { label: m.label, items: buildEntries(st, m.items, windowId) } },
      })),
    appItemsFor: (windowId) => appItemsFor(st, windowId),
    click: (nativeId, keyWindowId) => click(st, nativeId, keyWindowId),
  };
}
