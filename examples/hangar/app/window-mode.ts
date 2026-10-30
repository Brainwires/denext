// The one window as Hangar's two kinds of window: the PANEL (small, on top, at the tray icon,
// hidden when it loses focus) and the FULL window (resizable, normal). denext has one window per
// app today, so both are that window, resized and moved; README.md lists the gaps.

import {
  focusWindow,
  getScreens,
  hideWindow,
  setAlwaysOnTop,
  setWindowBounds,
  setWindowResizable,
  showWindow,
} from "denext/desktop/window";
import type { AppTray } from "denext/desktop/app";
import { FULL_SIZE, PANEL_SIZE, panelBounds, workAreaAt } from "../lib/tray.ts";

/** What the window is being used as. */
export type WindowMode = "hidden" | "panel" | "full";

let mode: WindowMode = "hidden";
/** When the panel last hid itself on blur (a click on the tray icon blurs it first). */
let blurHiddenAt = 0;

function setMode(next: WindowMode) {
  mode = next;
  document.documentElement.dataset.mode = next;
}

/** Show the window as the panel at the tray icon. */
export async function showPanel(tray: AppTray | null): Promise<void> {
  const icon = tray ? await tray.getBounds().catch(() => null) : null;
  const screens = await getScreens().catch(() => []);
  const area = workAreaAt(screens, icon) ?? { x: 0, y: 0, width: 1280, height: 800 };
  setMode("panel");
  await setWindowResizable(false).catch(() => {});
  await setAlwaysOnTop(true).catch(() => {});
  await setWindowBounds(panelBounds(icon, area, PANEL_SIZE)).catch(() => {});
  await showWindow();
  await focusWindow().catch(() => {});
}

/** Toggle the panel (a tray click). A click right after the panel hid on blur closes it. */
export async function togglePanel(tray: AppTray | null): Promise<void> {
  if (mode === "panel" || Date.now() - blurHiddenAt < 400) {
    await hide();
    return;
  }
  await showPanel(tray);
}

/** Show the window as a full window, centred on its display. */
export async function showFull(): Promise<void> {
  const screens = await getScreens().catch(() => []);
  const area = workAreaAt(screens, null);
  setMode("full");
  await setAlwaysOnTop(false).catch(() => {});
  await setWindowResizable(true).catch(() => {});
  await setWindowBounds({
    ...FULL_SIZE,
    ...(area
      ? {
        x: Math.round(area.x + (area.width - FULL_SIZE.width) / 2),
        y: Math.round(area.y + (area.height - FULL_SIZE.height) / 2),
      }
      : {}),
  }).catch(() => {});
  await showWindow();
  await focusWindow().catch(() => {});
}

/** Hide the window; the app stays in the tray. */
export async function hide(): Promise<void> {
  setMode("hidden");
  await hideWindow().catch(() => {});
}

/** The panel lost focus: hide it (a full window stays). */
export function onWindowBlur(): void {
  if (mode !== "panel") return;
  blurHiddenAt = Date.now();
  void hide();
}
