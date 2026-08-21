import type { DenextConfig } from "denext/server";

// SPA mode ("React but not Next"): no `app/` directory. denext bundles
// `spa.entry`, wraps it in an HTML shell, and serves that shell for every
// navigation (history-API fallback). The app owns its own routing/state; denext
// just provides the bundler, the CSS pipeline, the dev server, and — via
// `deno task export` + `deno desktop` — native packaging.
export default {
  mode: "spa",
  spa: {
    entry: "./src/main.tsx",
    title: "denext SPA example",
  },
} satisfies DenextConfig;
