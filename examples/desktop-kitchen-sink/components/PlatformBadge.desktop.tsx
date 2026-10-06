"use client";
// The desktop variant of `PlatformBadge.tsx` (macOS, Windows and Linux): the window test's
// navigation phase asserts the packaged app's exported HTML rendered this file and its client
// bundle hydrated it, on every OS.

import { useEffect } from "denext";

/** The file this is: what the exported HTML and the hydrated island each name. */
const FILE = "desktop";

export function PlatformBadge() {
  useEffect(() => {
    document.querySelector("[data-kitchen-platform]")?.setAttribute("data-kitchen-hydrated", FILE);
  }, []);
  return <small data-kitchen-platform={FILE}>platform file: {FILE}</small>;
}
