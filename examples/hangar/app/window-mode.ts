// Hangar's windows: the PANEL at the tray icon (denext's backend tray panel, `desktop.tray.panel`:
// frameless, never takes the focus, hides when it loses it), the MAIN window (the library; hidden
// at launch, `desktop.window.show: false`) and one FULL window per page (`openWindow`). Hangar is an
// accessory app with no Dock icon (`desktop.app.activationPolicy: "accessory"`) except while a full
// window shows: then it is a regular app, so that window comes to the front and Cmd-Tab reaches it.

import {
  type DesktopWindowHandle,
  focusWindow,
  getWindows,
  hideWindow,
  openWindow,
  showWindow,
  windowHandle,
} from "denext/desktop/window";
import { hideTrayPanel, setActivationPolicy, showTrayPanel } from "denext/desktop/app";
import { cascadeOrigin, FULL_SIZE, windowTitle } from "../lib/tray.ts";

/** The full windows this page opened, by path (one per page of the app). */
const opened = new Map<string, DesktopWindowHandle>();

/**
 * A regular app with a Dock icon while a full window shows, an accessory one otherwise (macOS;
 * elsewhere nothing). Switching to regular also brings Hangar to the front.
 */
async function dock(visible: boolean): Promise<void> {
  await setActivationPolicy(visible ? "regular" : "accessory").catch(() => false);
}

/** Hide the Dock icon again once no full window is showing. */
async function dockIfNoFullWindows(): Promise<void> {
  const windows = await getWindows().catch(() => []);
  const showing = windows.some((w) => w.kind !== "panel" && w.visible);
  if (!showing) await dock(false);
}

/** Show the main window (the library). */
export async function showMain(): Promise<void> {
  await dock(true);
  await hideTrayPanel().catch(() => false);
  const main = windowHandle("main");
  await main.show();
  await main.focus().catch(() => {});
}

/**
 * Open (or bring back) the full window for `path`: `"/"` is the main window, every other page its
 * own window.
 */
export async function openFull(path: string): Promise<void> {
  if (path === "/") return await showMain();
  await dock(true);
  await hideTrayPanel().catch(() => false);
  const existing = opened.get(path);
  if (existing) {
    try {
      await existing.show();
      await existing.focus();
      return;
    } catch {
      opened.delete(path); // closed meanwhile
    }
  }
  // Its own title, and cascaded from the library window rather than exactly over it.
  const library = await windowHandle("main").getBounds().catch(() => null);
  const origin = cascadeOrigin(library, opened.size + 1);
  const win = await openWindow({ url: path, title: windowTitle(path), ...FULL_SIZE, ...origin });
  opened.set(path, win);
  win.onClosed(() => {
    opened.delete(path);
    void dockIfNoFullWindows();
  });
}

/** Show the panel at the tray icon (the "Show panel" menu item). */
export async function showPanel(): Promise<void> {
  await showTrayPanel().catch(() => false);
}

/** Hide this window (the main window's close button): the app stays in the tray. */
export async function hide(): Promise<void> {
  await hideWindow().catch(() => {});
  await dockIfNoFullWindows();
}

/** Show this window and focus it (no tray host: the main window is the app). */
export async function showSelf(): Promise<void> {
  await showWindow().catch(() => {});
  await focusWindow().catch(() => {});
}
