import type { DenextConfig } from "denext/server";

// A plain React Native mode app under denext's strict CSP, with no opt-ins: react-native-web's
// style sheet and React Native mode's own rules (TextInput's placeholder, a list's hidden
// scrollbar) must apply without `style-src 'unsafe-inline'`.
export default {
  mode: "spa",
  compatibilityMode: true,
  reactNative: true,
  spa: { entry: "./src/main.tsx", title: "rn csp e2e", csp: "strict" },
} satisfies DenextConfig;
