// SPA-mode fixture for the phone-navigation e2e: a HistoryStack over the browser's own history
// (no router), whose root screen is a VirtualList of SwipeableRows and whose thread screens are
// pushed on top. Driven with real (CDP-emulated) touches by tests/e2e/phone-nav.e2e.test.ts.
import type { DenextConfig } from "denext/server";

export default {
  mode: "spa",
  spa: { entry: "./src/main.tsx", title: "denext phone-nav fixture", rootId: "root" },
} satisfies DenextConfig;
