/**
 * The application menu bar as the `app` capability ({@link ./caps/app.ts}) sets it: the managed bar
 * with no page menu (on macOS the app menu and Edit), the "Window" submenu merged into a bar, and
 * the custom top-level menus placed after their anchors (the macOS app menu, File, Edit, View,
 * Window).
 *
 * Runtime-only (imported by the `app` capability, never a client bundle).
 *
 * @module
 */

import type { BuiltMenu } from "./app-menus.ts";
import type { DesktopMenuItem } from "./launch-events.ts";
import { type DesktopMenuAnchor, MENU_ANCHORS } from "./menu-config.ts";

/** The label of the submenu the backend's window items join (case-insensitive). */
const WINDOW_SUBMENU_LABEL = "window";

/** A top-level label as the anchors match it: trimmed, lower-case, no `&` mnemonic. */
function normLabel(label: string): string {
  return label.replaceAll("&", "").trim().toLowerCase();
}

/** Whether `entry` is a submenu. */
function isSubmenu(
  entry: DesktopMenuItem,
): entry is { submenu: { label: string; items: DesktopMenuItem[] } } {
  return typeof entry === "object" && "submenu" in entry;
}

/** A role entry. */
const role = (name: string): DesktopMenuItem => ({ role: { role: name } });

/**
 * The managed menu bar with no page menu: on macOS the app menu and Edit with the standard roles
 * (AppKit shows the first submenu under the app's name, and the editing shortcuts need Edit's
 * items); nothing elsewhere, where the window's own menu bar needs neither.
 *
 * @param os The running OS.
 * @returns The bar's entries.
 */
export function managedBar(os: string): DesktopMenuItem[] {
  if (os !== "darwin") return [];
  return [
    {
      submenu: {
        label: "App",
        items: [
          role("about"),
          "separator",
          role("hide"),
          role("hideOthers"),
          role("unhide"),
          "separator",
          role("quit"),
        ],
      },
    },
    {
      submenu: {
        label: "Edit",
        items: [
          role("undo"),
          role("redo"),
          "separator",
          role("cut"),
          role("copy"),
          role("paste"),
          role("selectAll"),
        ],
      },
    },
  ];
}

/**
 * `bar` with the "Window" submenu merged in: into its own "Window" submenu (after a separator)
 * when it has one, else appended.
 *
 * @param bar The menu bar.
 * @param items The submenu's entries (`undefined`: none to merge).
 * @returns The bar with the submenu.
 */
export function mergeWindowSubmenu(
  bar: readonly DesktopMenuItem[],
  items: DesktopMenuItem[] | undefined,
): DesktopMenuItem[] {
  if (!items) return [...bar];
  let merged = false;
  const out = bar.map((entry): DesktopMenuItem => {
    if (merged || !isSubmenu(entry) || normLabel(entry.submenu.label) !== WINDOW_SUBMENU_LABEL) {
      return entry;
    }
    merged = true;
    const own = entry.submenu.items;
    const joined = own.length > 0 && items.length > 0
      ? [...own, "separator" as const, ...items]
      : [...own, ...items];
    return { submenu: { label: entry.submenu.label, items: joined } };
  });
  if (!merged) out.push({ submenu: { label: "Window", items } });
  return out;
}

/**
 * Where each anchor puts a custom menu in `bar`: after the index returned (`-1`: at the start).
 * `"app"` is the macOS app menu (the first submenu), elsewhere the start; the others are the
 * submenus labelled File, Edit, View and Window, each falling back to the anchor before it.
 */
function anchorPositions(
  bar: readonly DesktopMenuItem[],
  os: string,
): Map<DesktopMenuAnchor, number> {
  const at = new Map<DesktopMenuAnchor, number>();
  let prev = os === "darwin" && bar.length > 0 && isSubmenu(bar[0]) ? 0 : -1;
  for (const anchor of MENU_ANCHORS) {
    if (anchor !== "app") {
      const i = bar.findIndex((e) => isSubmenu(e) && normLabel(e.submenu.label) === anchor);
      if (i >= 0) prev = i;
    }
    at.set(anchor, prev);
  }
  return at;
}

/**
 * `bar` with the custom menus placed after their anchors, in anchor then menu order.
 *
 * @param bar The menu bar.
 * @param menus The custom menus, built.
 * @param os The running OS (`"app"` is the first submenu on macOS, the start elsewhere).
 * @returns The bar with the menus.
 */
export function insertCustomMenus(
  bar: readonly DesktopMenuItem[],
  menus: readonly BuiltMenu[],
  os: string,
): DesktopMenuItem[] {
  if (menus.length === 0) return [...bar];
  const at = anchorPositions(bar, os);
  const rank = (a: DesktopMenuAnchor) => MENU_ANCHORS.indexOf(a);
  const sorted = [...menus].sort((a, b) =>
    at.get(a.after)! - at.get(b.after)! || rank(a.after) - rank(b.after) || a.order - b.order
  );
  const out: DesktopMenuItem[] = [];
  const place = (pos: number) => {
    for (const m of sorted) if (at.get(m.after) === pos) out.push(m.entry);
  };
  place(-1);
  bar.forEach((entry, i) => {
    out.push(entry);
    place(i);
  });
  return out;
}
