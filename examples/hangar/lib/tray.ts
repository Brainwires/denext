// The tray's pure parts: where the panel goes relative to the tray icon, and the tray menu built
// from the overview. No Deno or DOM APIs, so the page imports them and the tests run them.

import { formatBytes } from "./format.ts";
import type { Overview } from "./types.ts";

/** A rectangle in screen coordinates. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The panel's size. */
export const PANEL_SIZE = { width: 360, height: 480 } as const;
/** The full window's size. */
export const FULL_SIZE = { width: 900, height: 640 } as const;
/** The gap between the tray icon and the panel. */
const GAP = 6;

/**
 * Where the panel goes: under a tray icon in a top bar (macOS, most Linux panels), above one in a
 * bottom bar (Windows' taskbar), centred on the icon and kept inside the work area. Without the
 * icon's bounds (Linux, where the OS does not say) it goes in the work area's top-right corner.
 *
 * @param tray The tray icon's bounds, or `null`.
 * @param workArea The display's work area (the screen minus menu bar, Dock and taskbar).
 * @param size The panel's size.
 */
export function panelBounds(
  tray: Rect | null,
  workArea: Rect,
  size: { width: number; height: number } = PANEL_SIZE,
): Rect {
  const maxX = workArea.x + workArea.width - size.width;
  const maxY = workArea.y + workArea.height - size.height;
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(Math.max(v, lo), hi));
  if (!tray) {
    return { x: Math.max(workArea.x, maxX - GAP), y: workArea.y + GAP, ...size };
  }
  const centreX = tray.x + tray.width / 2 - size.width / 2;
  const iconInTopHalf = tray.y + tray.height / 2 < workArea.y + workArea.height / 2;
  const y = iconInTopHalf ? tray.y + tray.height + GAP : tray.y - size.height - GAP;
  return {
    x: clamp(centreX, workArea.x, Math.max(workArea.x, maxX)),
    y: clamp(y, workArea.y, Math.max(workArea.y, maxY)),
    ...size,
  };
}

/** The display a point is on (its work area), else the first. */
export function workAreaAt<S extends { bounds: Rect; workArea: Rect }>(
  screens: readonly S[],
  point: { x: number; y: number } | null,
): Rect | null {
  if (screens.length === 0) return null;
  const hit = point &&
    screens.find((s) =>
      point.x >= s.bounds.x && point.x < s.bounds.x + s.bounds.width &&
      point.y >= s.bounds.y && point.y < s.bounds.y + s.bounds.height
    );
  return (hit || screens[0]).workArea;
}

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
