import type { DenextConfig } from "denext/server";

// React Native mode over the real react-native-web 0.21.2: the React Native core exports it
// lacks (PermissionsAndroid, ToastAndroid, ActionSheetIOS, useAnimatedValue, …) and the
// safe-area / Platform behaviour, exercised in headless Chromium.
export default {
  mode: "spa",
  compatibilityMode: true,
  reactNative: true,
  spa: { entry: "./src/main.tsx", title: "rn core e2e" },
} satisfies DenextConfig;
