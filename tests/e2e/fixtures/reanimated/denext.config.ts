import type { DenextConfig } from "denext/server";

// React Native mode over the real Reanimated 4 / react-native-worklets / gesture-handler web
// builds, with no Babel plugin: denext's worklets pass stamps `__closure` / `__workletHash`.
export default {
  mode: "spa",
  compatibilityMode: true,
  reactNative: true,
  spa: { entry: "./src/main.tsx", title: "reanimated e2e" },
} satisfies DenextConfig;
