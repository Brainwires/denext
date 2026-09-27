import type { DenextConfig } from "denext/server";

// React Native mode with the real react-native-windows / react-native-macos installed: React
// Native mode resolves both to react-native-web plus denext's desktop shims, never reading them.
export default {
  mode: "spa",
  compatibilityMode: true,
  reactNative: true,
  spa: { entry: "./src/main.tsx", title: "rn desktop e2e" },
} satisfies DenextConfig;
