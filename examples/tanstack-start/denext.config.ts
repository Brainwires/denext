import type { DenextConfig } from "denext/server";
import { tanstackStart } from "@denext/tanstack-start";

// TanStack Start's shape, server-rendered by denext: the plugin generates the route tree from
// src/routes, renders every page through TanStack Router's SSR, and hydrates it in the browser.
export default {
  compatibilityMode: true,
  plugins: [tanstackStart()],
} satisfies DenextConfig;
