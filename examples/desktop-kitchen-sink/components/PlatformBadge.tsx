"use client";
// The plain file: what the web target renders. The desktop export takes `PlatformBadge.desktop.tsx`
// instead (platform-specific files), in its server render and its client bundle alike; the window
// test's navigation phase (`app/navigation.tsx`) asserts both. Imported through the `@/` alias.

import { useEffect } from "denext";

/** The file this is: what the exported HTML and the hydrated island each name. */
const FILE = "web";

export function PlatformBadge() {
  useEffect(() => {
    document.querySelector("[data-kitchen-platform]")?.setAttribute("data-kitchen-hydrated", FILE);
  }, []);
  return <small data-kitchen-platform={FILE}>platform file: {FILE}</small>;
}
