import type { DenextConfig } from "denext/server";
import { tanstackStart } from "@denext/tanstack-start";

// TanStack Start's shape, server-rendered by denext: the plugin generates the route tree from
// src/routes, renders every page through TanStack Router's SSR, and hydrates it in the browser.
// `denext export` prerenders it with Start's own `prerender` options: /boom's loader fails on
// purpose (a 500), which would fail the export, so it is left out. Start's `spa` adds the SPA
// shell (`_shell.html`, the root route alone, rendered at `/`) a static host falls back to, and
// its `sitemap` writes `sitemap.xml` and `pages.json`.
export default {
  compatibilityMode: true,
  plugins: [
    tanstackStart({
      prerender: { filter: ({ path }) => path !== "/boom" },
      spa: { enabled: true },
      sitemap: { host: "https://example.com" },
    }),
  ],
} satisfies DenextConfig;
