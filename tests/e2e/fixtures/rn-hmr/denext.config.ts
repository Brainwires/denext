import type { DenextConfig } from "denext/server";

// React Native mode on the per-module dev loop: an edit to a component module hot-swaps it
// with its hook state kept (Fast Refresh), exercised in headless Chromium.
export default {
  mode: "spa",
  compatibilityMode: true,
  reactNative: true,
  spa: { entry: "./src/main.tsx", title: "rn hmr e2e" },
} satisfies DenextConfig;
