import type { DenextConfig } from "denext/server";

// Loopy's desktop window: small, no title bar (Loopy is the drag handle), no backdrop, not
// resizable. The page floats it above other windows and moves it to the bottom-right corner
// (lib/window-setup.ts). Transparent, click-through, non-activating overlay windows are not in
// denext yet, so the window is an opaque card for now.
export default {
  desktop: {
    app: {
      // Keys the OS data folder (where the inbox file lives) and the window's storage.
      identifier: "dev.denext.loopy",
      name: "Loopy",
    },
    window: { width: 260, height: 300, title: "Loopy", resizable: false },
    titleBar: "hidden",
    backdrop: "none",
    // The inbox file (token + port) goes in the app's data folder; desktop.ts writes it, so the
    // packaged app needs write access there. Listening on loopback is in the baseline.
    extraPermissions: { write: ["$APPDATA"] },
    // Just the app bundle: no installers for an example.
    installers: { macos: [], linux: [], windows: [] },
  },
} satisfies DenextConfig;
