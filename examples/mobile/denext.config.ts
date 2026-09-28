// The config is loaded by the CLI, outside this deno.json's import map: import by path (an app
// outside this repository imports "jsr:@denext/denext/mobile").
import { SAFE_AREA_CSS } from "../../src/mobile/mod.ts";
import type { DenextConfig } from "denext/server";

// A client-only SPA that Capacitor wraps: `deno task export` writes the static UI to
// out/, which capacitor.config.json's `webDir` points at.
export default {
  mode: "spa",
  spa: {
    entry: "./src/main.tsx",
    title: "denext mobile",
    // viewport-fit=cover lets the page draw under the notch; SAFE_AREA_CSS pads it back. It is
    // an inline <style> here (not injected at runtime), so the CSP below allows it by hash.
    head:
      `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />` +
      `<style>${SAFE_AREA_CSS}</style>`,
    // denext's strict CSP as a <meta> in out/index.html: scripts and styles from the app only.
    // connect-src also allows http(s) because the OTA section fetches the manifest from a
    // server on your LAN (`deno task ota:serve`, a user-typed http://<ip>:8787). blob: images
    // cover picker previews; data: carries <SystemIcon>'s natively rendered SF Symbols (a CSS
    // mask). Everything native (Capacitor plugins) is outside the page's CSP.
    csp: { connectSrc: ["http:", "https:"], imgSrc: ["blob:", "data:"] },
    // The webview loads files from the app bundle and never asks for the .gz variants.
    precompress: false,
    // Stamp out/_denext/ota.json so the DenextOta plugin knows which UI it ships
    // (signed when DENEXT_OTA_SIGNING_KEY holds the private key).
    ota: true,
  },
  // `denext mobile build android --flavor staging`: the same app under another id and name, so a
  // staging build installs next to the release one. Undone when the build ends.
  mobile: {
    flavors: {
      staging: { appIdSuffix: ".staging", appName: "denext mobile (staging)" },
    },
  },
} satisfies DenextConfig;
