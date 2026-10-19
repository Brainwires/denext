import type { DenextConfig } from "denext/server";

// React Native mode with @shopify/react-native-skia: CanvasKit's wasm is imported with `?url`
// (emitted and fingerprinted). The strict CSP adds wasm compilation for CanvasKit, nothing more:
// react-native-web's style sheet is the shell's own (hashed) element.
export default {
  mode: "spa",
  compatibilityMode: true,
  reactNative: true,
  spa: {
    entry: "./index.web.tsx",
    title: "rn skia e2e",
    csp: { scriptSrc: ["'wasm-unsafe-eval'"] },
  },
} satisfies DenextConfig;
