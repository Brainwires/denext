import type { DenextConfig } from "denext/server";

// Loopy's desktop window: a small transparent, frameless overlay that never takes the focus from
// the app you are typing in, floats above other windows on every Space, and stays off the Dock and
// the taskbar. The page lets clicks through everywhere but Loopy and its bubble where the runtime
// can (lib/window-setup.ts). With no Dock icon the tray icon is the way back: show / hide Loopy,
// quit (desktop.ts).
export default {
  desktop: {
    app: {
      // Keys the OS data folder (where the inbox file lives) and the window's storage.
      identifier: "dev.denext.loopy",
      name: "Loopy",
      // A companion, not an app you switch to: no Dock icon (the tray brings Loopy back).
      dock: false,
    },
    window: {
      width: 260,
      height: 300,
      title: "Loopy",
      resizable: false,
      // Creation-time (written to .deno-desktop/app.json): Loopy stands on the desktop itself.
      frameless: true,
      transparent: true,
      focusable: false,
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      skipTaskbar: true,
    },
    backdrop: "none",
    tray: {
      icon: "/tray.png",
      tooltip: "Loopy",
      menu: [
        { id: "show", label: "Show Loopy" },
        { id: "hide", label: "Hide Loopy" },
        { separator: true },
        { role: "quit" },
      ],
    },
    // The inbox file (token + port) goes in the app's data folder; desktop.ts writes it, so the
    // packaged app needs write access there. Listening on loopback is in the baseline.
    extraPermissions: { write: ["$APPDATA"] },
    // Just the app bundle: no installers for an example.
    installers: { macos: [], linux: [], windows: [] },
  },
} satisfies DenextConfig;
