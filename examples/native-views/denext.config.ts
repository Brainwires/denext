// The config is loaded by the CLI, outside this deno.json's import map: import by path (an app
// outside this repository imports "jsr:@denext/denext/mobile").
import { SAFE_AREA_CSS } from "../../src/mobile/mod.ts";
import type { DenextConfig } from "denext/server";

// A client-only SPA that Capacitor wraps: `deno task export` writes the static UI to out/,
// which capacitor.config.json's `webDir` points at.
export default {
  mode: "spa",
  spa: {
    entry: "./src/main.tsx",
    title: "denext native views",
    head:
      `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />` +
      `<style>${SAFE_AREA_CSS}</style>`,
    precompress: false,
  },
} satisfies DenextConfig;
