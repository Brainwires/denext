"use client";
// The tray icon's menu and tooltip, and the main window's close-to-tray. The tray itself is the
// backend's (`desktop.tray` in denext.config.ts): it exists before any page loads and survives
// reloads, a left click toggles the panel natively, and a right click opens the menu (desktop.ts).
// Only the MAIN window's page (hidden at launch, but loaded) drives it, so the panel and the full
// windows don't each update it. The tooltip follows the instances every few seconds and again as
// soon as the pointer is over the icon (`mouseenter`, macOS and Windows).

import { useEffect } from "denext";
import { type AppMenuItem, type AppTray, getTray } from "denext/desktop/app";
import { currentWindowId, onCloseRequested } from "denext/desktop/window";
import { runtimePlatform } from "denext/mobile";
import { MENU, SHUTDOWN_PREFIX, START_PREFIX, trayMenu } from "../lib/tray.ts";
import { hangar } from "./hangar-client.ts";
import { hide, openFull, showPanel, showSelf } from "./window-mode.ts";

/** How often the tooltip and the menu follow the instances. */
const REFRESH_MS = 5000;

/** What a tray menu item does. */
function onMenu(id: string): void {
  if (id === MENU.panel) return void showPanel();
  if (id.startsWith("open:")) return void openFull(id.slice(5));
  if (id.startsWith(SHUTDOWN_PREFIX)) {
    return void hangar.shutdown({ id: id.slice(SHUTDOWN_PREFIX.length) }).catch(console.error);
  }
  if (id.startsWith(START_PREFIX)) {
    // A start over the RAM budget answers needsConfirm: the panel asks.
    void hangar.start({ id: id.slice(START_PREFIX.length), headless: true }).then((r) => {
      if (!r.started) return showPanel();
    }).catch(console.error);
  }
}

export function TrayShell() {
  useEffect(() => {
    if (runtimePlatform() !== "desktop") return;
    let tray: AppTray | null = null;
    let stopped = false;
    let lastMenu = "";
    const offs: (() => void)[] = [];

    const refresh = async () => {
      if (!tray || stopped) return;
      const overview = await hangar.overview().catch(() => null);
      if (!overview || stopped) return;
      const menu = trayMenu(overview);
      const key = JSON.stringify(menu);
      await tray.update({
        tooltip: overview.tooltip,
        // Only when it changed: a menu replaced while open closes on some platforms.
        ...(key !== lastMenu ? { menu: menu as AppMenuItem[] } : {}),
      }).catch(() => {});
      lastMenu = key;
    };

    (async () => {
      if ((await currentWindowId()) !== "main") return;
      // Closing the main window hides it: the app keeps running in the tray until "Quit".
      offs.push(onCloseRequested(() => {
        void hide();
        return false;
      }));
      tray = await getTray();
      if (stopped) return;
      if (!tray) {
        // No tray host (stock GNOME without the AppIndicator extension): the runtime showed this
        // window, which is the app now.
        await showSelf();
        return;
      }
      offs.push(tray.onClick((event) => {
        if (event === "doubleClick") void openFull("/");
      }));
      offs.push(tray.on("mouseenter", () => void refresh()));
      offs.push(tray.onMenuItem(onMenu));
      await refresh();
    })().catch((err) => console.error("hangar: tray:", err));

    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      for (const off of offs) off();
    };
  }, []);

  return null;
}
