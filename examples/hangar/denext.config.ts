import type { DenextConfig, DesktopTrayMenuItem } from "denext/server";
import { PANEL_SIZE, trayMenu } from "./lib/tray.ts";

// Hangar: a tray-first desktop app over QEMU VMs. The backend is the `hangar` desktop extension
// (desktop/hangar.ts), which runs in the app's Deno process; the pages are the UI. It starts with
// no window and no Dock icon: the tray icon (owned by the backend, made before any page loads) is
// the way in. A left click toggles the panel at the icon, a right click opens the menu, a double
// click or the menu opens the library (the main window, hidden at launch) or a page in a window of
// its own.
export default {
  desktop: {
    // Every installer off: an example, packaged by hand (`deno task desktop:package`).
    installers: { macos: [], linux: [], windows: [] },
    app: {
      name: "Hangar",
      identifier: "dev.denext.hangar",
      // The app icon on each OS (icons/: original art, 1024 px; the .ico holds 16 to 256 px).
      icons: {
        macos: "./icons/macos.png",
        linux: "./icons/linux.png",
        windows: "./icons/windows.ico",
      },
      // A stable origin, so the page's storage survives relaunches.
      origin: "hangar://app",
      // A second launch hands over to the running tray app instead of adding a second tray icon.
      singleInstance: true,
      // Keep running with every window closed (the tray sets this too; said here for clarity).
      keepAlive: true,
      // A menu-bar app: the accessory activation policy, so no Dock icon or menu bar from the first
      // frame (runtime 3.0.0-denext.6). window-mode.ts switches to "regular" while a full window is
      // open, and back.
      activationPolicy: "accessory",
    },
    // The main window: the library. Hidden at launch; its page still loads and drives the tray's
    // menu and tooltip (app/tray-shell.tsx).
    window: { width: 900, height: 640, title: "Hangar", show: false },
    minSize: { width: 320, height: 360 },
    tray: {
      icon: "/tray.png",
      tooltip: "Hangar",
      // The menu until the main page has the overview (it updates it every few seconds).
      // (A config form has no bare "separator" strings: `{ separator: true }`; the first menu
      // has no submenus.)
      menu: trayMenu(null).flatMap((item): DesktopTrayMenuItem[] =>
        item === "separator" ? [{ separator: true }] : "submenu" in item ? [] : [item]
      ),
      panel: { url: "/panel", ...PANEL_SIZE },
    },
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
