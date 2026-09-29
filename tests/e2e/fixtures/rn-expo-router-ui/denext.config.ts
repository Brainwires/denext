import type { DenextConfig } from "denext/server";

// React Native mode with expo-router/ui's headless tabs (Expo's SDK 57 starter uses them on the
// web): a tab press re-renders the navigator with the same `children`, which denext's implicit
// memo skipped (src/build/use-component-compat.ts), and the shell's deep links route through
// expo-router (EXPO_ROUTER_LINKS in src/build/spa/shared.ts).
export default {
  mode: "spa",
  compatibilityMode: true,
  reactNative: true,
  spa: { entry: "./index.web.ts", title: "rn expo-router/ui e2e" },
} satisfies DenextConfig;
