import type { DenextConfig } from "denext/server";

// React Native mode on the App Router over the real react-native-web 0.21.2: a Server
// Component page and a "use client" island both import `react-native`.
export default {
  reactNative: true,
} satisfies DenextConfig;
