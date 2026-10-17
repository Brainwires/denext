import type { DenextConfig } from "denext/server";
import { tanstackStart } from "@denext/tanstack-start";

// TanStack Start's shape, server-rendered by denext: the plugin generates the route tree from
// src/routes, renders every page through TanStack Router's SSR, and hydrates it in the browser.
// `denext export` prerenders it with Start's own `prerender` options: /boom's loader fails on
// purpose (a 500), which would fail the export, so it is left out.
export default {
  compatibilityMode: true,
  plugins: [
    tanstackStart({ prerender: { filter: ({ path }) => path !== "/boom" } }),
  ],
} satisfies DenextConfig;
