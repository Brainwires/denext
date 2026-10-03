import type { DenextConfig } from "denext/server";

// A React Native app (react-native-web) in a Deno Desktop window. `reactNative: true` builds
// the app's own RN source for the DOM; `denext desktop run` exports it and opens it in a native
// window. `desktop.capabilities` is the allowlist of what the page may ask the desktop runtime
// for (`denext desktop add <capability>` writes it), and the package scripts derive the app's
// Deno permissions from it.
export default {
  mode: "spa",
  compatibilityMode: true,
  reactNative: true,
  spa: { entry: "./src/main.tsx", title: "RN on desktop" },
  desktop: {
    // Unique per app: keys the OS storage dirs and the secureStore keychain service (secureStore
    // refuses to start without it). Kept equal to deno.json's desktop.app.identifier.
    app: { identifier: "dev.denext.rn-desktop" },
    capabilities: {
      secureStore: true,
      contextMenu: true,
      clipboard: true,
      shell: {
        openExternal: ["https:"],
        openPath: false,
        reveal: false,
        trash: false,
      },
    },
  },
} satisfies DenextConfig;
