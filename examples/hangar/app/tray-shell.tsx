"use client";
// The tray icon and the window's lifecycle, mounted once by the layout (client navigations keep
// it; a full reload makes a new tray, as denext removes the old page's trays). Left click toggles
// the panel, double click opens the full window, the menu (right click) lists the running VMs.
// Closing the window hides it: the app keeps running in the tray until "Quit".

import { useEffect, useRouter } from "denext";
import { type AppMenuItem, type AppTray, createTray } from "denext/desktop/app";
import { onCloseRequested } from "denext/desktop/window";
import { runtimePlatform } from "denext/mobile";
import { MENU, SHUTDOWN_PREFIX, START_PREFIX, trayMenu } from "../lib/tray.ts";
import { hangar } from "./hangar-client.ts";
import { hide, onWindowBlur, showFull, showPanel, togglePanel } from "./window-mode.ts";

/** How often the tooltip and the menu follow the instances. */
const REFRESH_MS = 5000;

export function TrayShell() {
  const router = useRouter();

  useEffect(() => {
    if (runtimePlatform() !== "desktop") return;
    let tray: AppTray | null = null;
    let stopped = false;
    let lastMenu = "";
    const offs: (() => void)[] = [];

    const open = (path: string) => {
      void showFull().then(() => router.push(path));
    };

    const onMenu = (id: string) => {
      if (id === MENU.panel) return void showPanel(tray);
      if (id.startsWith("open:")) return open(id.slice(5));
      if (id.startsWith(SHUTDOWN_PREFIX)) {
        return void hangar.shutdown({ id: id.slice(SHUTDOWN_PREFIX.length) }).catch(console.error);
      }
      if (id.startsWith(START_PREFIX)) {
        // A start over the RAM budget answers needsConfirm: the panel asks.
        void hangar.start({ id: id.slice(START_PREFIX.length), headless: true }).then((r) => {
          if (!r.started) return showPanel(tray);
        }).catch(console.error);
      }
    };

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
      const icon = new Uint8Array(await (await fetch("/tray.png")).arrayBuffer());
      tray = await createTray({ icon, tooltip: "Hangar", menu: trayMenu(null) as AppMenuItem[] });
      if (stopped) return void tray.destroy();
      offs.push(tray.onClick((event) => {
        if (event === "doubleClick") open("/");
        else void togglePanel(tray);
      }));
      offs.push(tray.onMenuItem(onMenu));
      await refresh();
    })().catch((err) => {
      // No tray host (stock GNOME without the AppIndicator extension): the runtime has shown the
      // window, so it becomes the full window.
      console.error("hangar: no tray icon:", err);
      void showFull();
    });

    const timer = setInterval(() => void refresh(), REFRESH_MS);
    offs.push(onCloseRequested(() => {
      void hide();
      return false;
    }));
    globalThis.addEventListener("blur", onWindowBlur);
    return () => {
      stopped = true;
      clearInterval(timer);
      globalThis.removeEventListener("blur", onWindowBlur);
      for (const off of offs) off();
      void tray?.destroy();
    };
  }, []);

  return null;
}
