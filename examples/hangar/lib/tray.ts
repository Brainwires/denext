// The tray's pure parts: the window sizes and the tray menu built from the overview (denext places
// the panel at the icon). No Deno or DOM APIs, so the page imports them and the tests run them.

import { formatBytes } from "./format.ts";
import type { Overview } from "./types.ts";

/** The panel's size (`desktop.tray.panel` in denext.config.ts). */
export const PANEL_SIZE = { width: 360, height: 480 } as const;
/** A full window's size. */
export const FULL_SIZE = { width: 900, height: 640 } as const;

/** A tray menu entry (the subset of `denext/desktop/app`'s `AppMenuItem` Hangar uses). */
export type TrayMenuItem =
  | { readonly id: string; readonly label: string; readonly disabled?: boolean }
  | { readonly label: string; readonly submenu: readonly TrayMenuItem[] }
  | { readonly role: "quit" }
  | "separator";

/** The menu's fixed actions. */
export const MENU = {
  panel: "panel",
  library: "open:/",
  images: "open:/images",
  create: "open:/create",
  settings: "open:/settings",
} as const;

/** A menu item id that shuts a VM down. */
export const SHUTDOWN_PREFIX = "shutdown:";
/** A menu item id that starts a VM headless. */
export const START_PREFIX = "start:";

/**
 * The tray menu: the running VMs (each with a shutdown item), a submenu to start a stopped one
 * headless, and the windows.
 *
 * @param overview The current overview, or `null` before the first one arrives.
 */
export function trayMenu(overview: Overview | null): TrayMenuItem[] {
  const items: TrayMenuItem[] = [];
  const rows = overview?.vms ?? [];
  const running = rows.filter((r) => r.instance);
  if (running.length === 0) items.push({ id: "none", label: "No VMs running", disabled: true });
  for (const r of running) {
    items.push({
      label: `${r.vm.name}: ${formatBytes(r.instance!.rssBytes)}`,
      submenu: [{ id: `${SHUTDOWN_PREFIX}${r.vm.id}`, label: "Shut down" }],
    });
  }
  const startable = rows.filter((r) => !r.instance && !r.ambiguous && r.vm.headlessCapable);
  if (startable.length > 0) {
    items.push({
      label: "Start headless",
      submenu: startable.map((r) => ({ id: `${START_PREFIX}${r.vm.id}`, label: r.vm.name })),
    });
  }
  items.push(
    "separator",
    { id: MENU.panel, label: "Show panel" },
    { id: MENU.library, label: "Open Hangar" },
    { id: MENU.images, label: "Images" },
    { id: MENU.create, label: "New VM" },
    { id: MENU.settings, label: "Settings" },
    "separator",
    { role: "quit" },
  );
  return items;
}
