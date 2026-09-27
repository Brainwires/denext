import type { DenextConfig } from "denext/server";

// The denext side of the scroll benchmark: a client-only SPA that Capacitor wraps
// (`deno task export` writes out/, capacitor.config.json's `webDir`).
export default {
  mode: "spa",
  // The list libraries are npm packages that import `react`: the compat build aliases it
  // to denext for every module in the graph.
  compatibilityMode: true,
  // Only for the `rnw-flatlist` impl: `react-native` resolves to react-native-web. The flag is
  // app-wide (denext has no per-route resolve mode); it changes nothing for the other impls,
  // which never import `react-native`.
  reactNative: true,
  spa: {
    entry: "./src/main.tsx",
    title: "denext scroll bench",
    head: `<meta name="viewport" content="width=device-width, initial-scale=1" />`,
    // The WebView loads files from the APK and never asks for the .gz variants.
    precompress: false,
  },
} satisfies DenextConfig;
