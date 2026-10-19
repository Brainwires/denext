import type { DenextConfig } from "denext/server";

// The app's backend: route handlers only. The Capacitor shell's WebView calls it from
// `capacitor://localhost` (iOS) and `https://localhost` (Android), so those origins may.
export default {
  cors: { origins: ["capacitor://localhost", "https://localhost"] },
} satisfies DenextConfig;
