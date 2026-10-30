import type { DenextConfig } from "denext/server";

// Hangar: a tray-first desktop app over QEMU VMs. The backend is the `hangar` desktop extension
// (desktop/hangar.ts), which runs in the app's Deno process; the page is the UI. denext has no
// windowless launch yet, so desktop.ts hides the one window as soon as it is adopted and the page
// shows it again as the tray panel or a full window (see README.md, "What is approximated").
export default {
  desktop: {
    // Every installer off: an example, packaged by hand (`deno task desktop:package`).
    installers: { macos: [], linux: [], windows: [] },
    app: {
      name: "Hangar",
      identifier: "dev.denext.hangar",
      // A stable origin, so the page's storage survives relaunches.
      origin: "hangar://app",
      // A second launch hands over to the running tray app instead of adding a second tray icon.
      singleInstance: true,
    },
    // The window's launch size is the full window's; the panel resizes it at the tray icon.
    window: { width: 900, height: 640, title: "Hangar" },
    minSize: { width: 320, height: 360 },
    capabilities: {
      // "Copy the ssh command" and friends.
      clipboard: true,
      // The backend: the VM library, instances and images.
      extensions: ["./desktop/hangar.ts"],
    },
    extraPermissions: {
      // QEMU is started through /bin/sh, and a force stop signals an exact pid: `Deno.kill` needs
      // Deno's unscoped run permission.
      run: ["*"],
      // Creating VMs and images in the library folder, and the settings file.
      write: ["~/VMs"],
      // The RAM budget reads the host's memory.
      sys: ["systemMemoryInfo"],
      env: ["HOME"],
    },
  },
} satisfies DenextConfig;
