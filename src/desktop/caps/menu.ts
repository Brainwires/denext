/**
 * Native menus from the page: the wire form every menu RPC takes (context menu, application menu,
 * tray menu, dock menu) checked and converted to the runtime's `Deno.MenuItem`, plus the ids the
 * menu can report, so a click on anything else is ignored.
 *
 * Wire form (an array of):
 * - `{ id, label, enabled?, checked?, accelerator?, tooltip?, icon? }`: an item (`icon` a base64
 *   PNG, `accelerator` in the `"CommandOrControl+Shift+K"` syntax);
 * - `{ label, children }`: a submenu;
 * - `{ role }`: a standard item (`"copy"`, `"quit"`, …, see `MENU_ROLES`);
 * - `"separator"` (or `{ separator: true }`).
 *
 * Runtime-only (imported by the capability modules, never a client bundle).
 *
 * @module
 */

import { base64ToBytes } from "../../mobile/base64.ts";
import { DesktopCapError } from "../extension.ts";
import type { DesktopMenuItem } from "../launch-events.ts";

/** The standard items the runtime's menus know (case-insensitive there; spelled like Electron here). */
const MENU_ROLES = [
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

/** The deepest submenu nesting accepted. */
const MAX_DEPTH = 8;
/** The most entries one menu may have (all levels). */
const MAX_ITEMS = 500;
/** The longest label / id / tooltip accepted. */
const MAX_LABEL = 256;
/** The longest accelerator accepted. */
const MAX_ACCELERATOR = 64;
/** The largest base64 icon accepted. */
const MAX_ICON_CHARS = 256 * 1024;

/** A menu converted for the runtime, with the ids its items report. */
export interface NativeMenu {
  readonly items: DesktopMenuItem[];
  readonly ids: Set<string>;
}

/** A `validation` error for a menu. */
function invalid(message: string): DesktopCapError {
  return new DesktopCapError("validation", `menu: ${message}`);
}

/** A bounded string, or a `validation` error. */
function str(value: unknown, name: string, max = MAX_LABEL): string {
  if (typeof value !== "string" || value.length > max) {
    throw invalid(`${name} must be a string up to ${max} characters`);
  }
  return value;
}

/** A base64 PNG as bytes. */
function iconBytes(value: unknown): Uint8Array {
  const b64 = str(value, "icon", MAX_ICON_CHARS);
  try {
    return base64ToBytes(b64);
  } catch {
    throw invalid("icon must be base64 PNG bytes");
  }
}

/** A role, in the runtime's spelling (the runtime matches it case-insensitively). */
function role(value: unknown): DesktopMenuItem {
  const name = String(value);
  if (!MENU_ROLES.some((r) => r.toLowerCase() === name.toLowerCase())) {
    throw invalid(`unknown role "${name.slice(0, 40)}"`);
  }
  return { role: { role: name } };
}

/** One clickable item. */
function item(x: Record<string, unknown>, ids: Set<string>): DesktopMenuItem {
  const id = str(x.id, "id");
  if (id === "") throw invalid("an item needs a non-empty id");
  ids.add(id);
  return {
    item: {
      label: str(x.label, "label"),
      id,
      enabled: x.enabled !== false,
      ...(x.checked === true ? { checked: true } : {}),
      ...(x.accelerator !== undefined
        ? { accelerator: str(x.accelerator, "accelerator", MAX_ACCELERATOR) }
        : {}),
      ...(x.tooltip !== undefined ? { tooltip: str(x.tooltip, "tooltip") } : {}),
      ...(x.icon !== undefined ? { icon: iconBytes(x.icon) } : {}),
    },
  };
}

/** Convert one level of entries, counting into `budget`. */
function convert(
  raw: unknown,
  depth: number,
  ids: Set<string>,
  budget: { left: number },
): DesktopMenuItem[] {
  if (!Array.isArray(raw)) throw invalid("must be an array");
  if (depth > MAX_DEPTH) throw invalid(`submenus nest at most ${MAX_DEPTH} deep`);
  return raw.map((entry): DesktopMenuItem => {
    if (--budget.left < 0) throw invalid(`at most ${MAX_ITEMS} entries`);
    if (entry === "separator") return "separator";
    if (typeof entry !== "object" || entry === null) throw invalid("an entry must be an object");
    const x = entry as Record<string, unknown>;
    if (x.separator === true) return "separator";
    if (x.role !== undefined) return role(x.role);
    if (x.children !== undefined) {
      return {
        submenu: {
          label: str(x.label, "label"),
          items: convert(x.children, depth + 1, ids, budget),
        },
      };
    }
    return item(x, ids);
  });
}

/**
 * Check a menu from the page and convert it for the runtime.
 *
 * @param raw The wire menu (see the module docs).
 * @returns The runtime's items and the ids they can report. Throws `validation` for a bad entry.
 */
export function nativeMenu(raw: unknown): NativeMenu {
  const ids = new Set<string>();
  return { items: convert(raw, 1, ids, { left: MAX_ITEMS }), ids };
}

/** The `id` of a runtime `menuclick` event (`detail.id`), else `undefined`. */
export function clickedId(event: Event): string | undefined {
  const id = ((event as CustomEvent).detail as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" ? id : undefined;
}
