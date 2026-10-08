// SPA-mode fixture for `client:*` deferred mounts (tests/e2e/spa-islands.e2e.test.ts): each
// directive component mounts, and its module loads, only when its trigger fires.
import type { DenextConfig } from "denext/server";

export default {
  mode: "spa",
  spa: { entry: "./src/main.tsx", title: "denext SPA islands fixture", rootId: "root" },
} satisfies DenextConfig;
