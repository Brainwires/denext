import type { DenextConfig } from "denext/server";

// Multiwindow: keyed windows whose frames and session come back, the standard Window menu items,
// and a per-window counter (the `counters` extension) that outlives its window.
export default {
  desktop: {
    installers: { macos: [], linux: [], windows: [] },
    app: {
      name: "Multiwindow",
      identifier: "dev.denext.multiwindow",
      // Stay up with every window closed: a counter can be picked up by the next window.
      keepAlive: true,
      // Reopen at launch the keyed windows that were open at the last quit, at their frames.
      restoreWindows: true,
      maxWindows: 8,
    },
    // The main window is the "workspace": its key makes its frame come back too.
    window: { key: "workspace", title: "Workspace", width: 640, height: 420 },
    // New Window (Cmd/Ctrl+N, the page and key desktop.ts decides), Reopen Closed Window
    // (Cmd/Ctrl+Shift+T) and the open windows, as a Window submenu of the application menu.
    menu: { window: { newWindow: "/", reopenClosed: true, list: true } },
    capabilities: {
      extensions: ["./desktop/counters.ts"],
    },
  },
} satisfies DenextConfig;
