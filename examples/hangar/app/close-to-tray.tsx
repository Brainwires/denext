"use client";
// The main window's close-to-tray: closing it hides it, and the app keeps running in the tray until
// "Quit", which the guard lets through (`reason: "quit"`). The tray itself (its menu, double click
// and tooltip) is driven from the app's process (desktop.ts, lib/tray-driver.ts), never from this
// page: the main window is hidden at launch, and a hidden window's page may be suspended (macOS)
// until it shows.

import { useEffect } from "denext";
import { currentWindowId, onCloseRequested } from "denext/desktop/window";
import { runtimePlatform } from "denext/mobile";
import { hide } from "./window-mode.ts";

export function CloseToTray() {
  useEffect(() => {
    if (runtimePlatform() !== "desktop") return;
    let off: (() => void) | undefined;
    let stopped = false;
    void currentWindowId().then((id) => {
      if (id !== "main" || stopped) return;
      off = onCloseRequested(({ reason }) => {
        // "Quit" (the tray menu, quitApp()) quits; only the close button hides to the tray.
        if (reason === "quit") return true;
        void hide();
        return false;
      });
    }).catch((err) => console.error("hangar: close-to-tray:", err));
    return () => {
      stopped = true;
      off?.();
    };
  }, []);

  return null;
}
