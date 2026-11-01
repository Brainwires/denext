// The main window's close button from its page: Hangar's windows are opened and shown by the window
// manager in the app's process (lib/tray-driver.ts, through the `hangar` extension's `open`); a page
// only hides its own window. Hangar is an accessory app with no Dock icon
// (`desktop.app.activationPolicy: "accessory"`) except while a full window shows.

import { getWindows, hideWindow } from "denext/desktop/window";
import { setActivationPolicy } from "denext/desktop/app";
import { hangar } from "./hangar-client.ts";

/** Hide the Dock icon again once no full window is showing (macOS; elsewhere nothing). */
async function dockIfNoFullWindows(): Promise<void> {
  const windows = await getWindows().catch(() => []);
  const showing = windows.some((w) => w.kind !== "panel" && w.visible);
  if (!showing) await setActivationPolicy("accessory").catch(() => false);
}

/** Hide this window (the main window's close button): the app stays in the tray. */
export async function hide(): Promise<void> {
  await hideWindow().catch(() => {});
  await dockIfNoFullWindows();
}

/** Open (or bring back) the full window for `path`: `"/"` is the library, the main window. */
export async function openFull(path: string): Promise<void> {
  await hangar.open({ path });
}
