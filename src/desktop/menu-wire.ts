/**
 * Menus as pages write them (`denext/desktop/app`'s `AppMenuItem`: `submenu`, `disabled`) → the
 * wire shape the `app` capability takes (`children`, `enabled`), which `./caps/menu.ts` then
 * checks. Shared by the page side and by `runDesktop` for `desktop.tray.menu`, which is written
 * like a page's menu.
 *
 * Client-safe: no Deno APIs.
 *
 * @module
 */

/** A menu entry as written: `"separator"`, `{ role }`, `{ label, submenu }` or an action. */
export type MenuSource = unknown;

/**
 * Convert a menu to the `app` capability's wire shape. Entries are passed through as far as their
 * shape goes; the capability validates them.
 *
 * @param menu The entries.
 * @returns The wire entries.
 */
export function menuWire(menu: readonly MenuSource[]): unknown[] {
  return menu.map((entry) => {
    if (typeof entry !== "object" || entry === null) return entry;
    const e = entry as Record<string, unknown>;
    if (Array.isArray(e.submenu)) return { label: e.label, children: menuWire(e.submenu) };
    if (e.role !== undefined) return { role: e.role };
    return actionWire(e);
  });
}

/** The optional keys an action passes through as they are, when set. */
const PASSED = ["accelerator", "tooltip", "icon"] as const;

/** A clickable item on the wire. */
function actionWire(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: e.id, label: e.label, enabled: e.disabled !== true };
  if (e.checked) out.checked = true;
  for (const key of PASSED) if (e[key] !== undefined) out[key] = e[key];
  if (e.destructive) out.destructive = true;
  return out;
}
