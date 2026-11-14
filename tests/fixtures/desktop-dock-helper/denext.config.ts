// The Dock helper's end-to-end probe (e2e.sh): a tray-style app (accessory, kept alive with no
// window) whose Dock icon shows only while a window is open. desktop.ts opens and closes its window
// on commands e2e.sh writes into the app's data folder.
import type { DenextConfig } from "denext/server";

export default {
  desktop: {
    installers: { macos: [], linux: [], windows: [] },
    app: {
      name: "DockHelperProbe",
      identifier: "dev.denext.dock-helper-probe",
      keepAlive: true,
      dock: "while-window-open",
    },
    // Hidden at launch: e2e.sh opens a keyed window when it wants one.
    window: { title: "DockHelperProbe", show: false },
    // The command files and the state log, in the app's data folder.
    extraPermissions: { write: ["$APPDATA"] },
  },
} satisfies DenextConfig;
