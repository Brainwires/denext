import type { DenextConfig } from "denext/server";

// React Native mode with the real expo-router: its `Stack` / `Tabs` are drawn by
// denext/navigation's StackView / TabsView over expo-router's own React Navigation copy.
export default {
  mode: "spa",
  compatibilityMode: true,
  reactNative: true,
  spa: { entry: "./index.web.ts", title: "rn expo-router e2e" },
} satisfies DenextConfig;
