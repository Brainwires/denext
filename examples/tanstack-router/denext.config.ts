import type { DenextConfig } from "denext/server";

// TanStack Router in library mode = denext SPA mode: denext bundles `spa.entry`, serves
// the shell for every navigation (history-API fallback), and TanStack owns routing in
// the browser. `compatibilityMode` aliases the `react` the router imports to denext.
// This is the shape `denext migrate` writes for a Vite + TanStack Router app.
export default {
  mode: "spa",
  compatibilityMode: true,
  spa: {
    entry: "./src/main.tsx",
    title: "denext + TanStack Router",
    // The element the app renders into. TanStack's scaffold uses `#app` (Vite's uses `#root`).
    rootId: "app",
    loading: '<p class="boot">Loading…</p>',
  },
} satisfies DenextConfig;
