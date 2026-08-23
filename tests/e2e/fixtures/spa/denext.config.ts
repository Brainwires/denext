// SPA-mode fixture (mode: "spa") for the real-browser E2E. No app/ directory:
// denext bundles src/main.tsx, wraps it in a shell, and serves that shell for
// every navigation. Proves denext's own createRoot mounts a client-only React app
// with NO server-rendered markup.
import type { DenextConfig } from "denext/server";

export default {
  mode: "spa",
  spa: { entry: "./src/main.tsx", title: "denext SPA fixture", rootId: "root" },
} satisfies DenextConfig;
