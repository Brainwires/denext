import type { DenextConfig } from "denext/server";

// A client-only SPA that Capacitor wraps: `deno task export` writes the static UI to
// out/, which capacitor.config.json's `webDir` points at.
export default {
  mode: "spa",
  spa: {
    entry: "./src/main.tsx",
    title: "denext mobile",
    // viewport-fit=cover lets the page draw under the notch; SAFE_AREA_CSS pads it back.
    head:
      `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />`,
    // The webview loads files from the app bundle and never asks for the .gz variants.
    precompress: false,
    // Stamp out/_denext/ota.json so the DenextOta plugin knows which UI it ships
    // (signed when DENEXT_OTA_SIGNING_KEY holds the private key).
    ota: true,
  },
} satisfies DenextConfig;
