"use client";
// The window test's secondary window (`app/checks.ts`, "windows: a secondary window …"): opened at
// `/second?kitchen=secondary`, this page renames itself (the injected title reporter must carry the
// new `document.title` to the window's label) and, once its window is focused, sends the app-menu
// click the runtime would send while it is the key window (`kitchen.synthetic` on its own window,
// then `Deno.desktop`'s app-wide event). The main page's `onAppMenuItem` must hear it exactly once.
// Inert on any other load of `/second`.

import { useEffect } from "denext";
import { desktopExtension } from "denext/desktop/client";

/** The query that marks the secondary window's load. */
export const SECONDARY_QUERY = "kitchen=secondary";
/** The title this page reports. */
export const SECONDARY_TITLE = "Kitchen secondary window";
/** The app-menu item the click names (set by the main page's check). */
export const SECONDARY_MENU_ID = "kitchen-secondary";

type Kitchen = Record<string, (args?: unknown) => Promise<unknown>>;
const kitchen = desktopExtension("kitchen") as unknown as Kitchen;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function SecondaryWindow() {
  useEffect(() => {
    if (!location.search.includes(SECONDARY_QUERY)) return;
    document.title = SECONDARY_TITLE;
    void (async () => {
      // The main page focuses this window; give the OS a moment, then click as the key window.
      for (let i = 0; i < 30 && !document.hasFocus(); i++) await sleep(100);
      await sleep(400); // past the title reporter's debounce
      await kitchen.synthetic({
        kind: "window",
        type: "menuclick",
        detail: { id: SECONDARY_MENU_ID },
      });
    })().catch((err) => console.error("kitchen: the secondary window's click failed", err));
  }, []);
  return null;
}
