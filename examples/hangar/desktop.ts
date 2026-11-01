// Entry for `deno desktop`: serves the static export in `out/` and runs the `hangar` extension
// (the VM backend) in this process. The capabilities, the hidden main window, the backend tray with
// its panel and the no-Dock-icon setting come from `desktop.*` through `.deno-desktop/config.json`
// (the runtime part of denext.config.ts), so the config module is never compiled into the app.
//
// The tray's clicks: a plain left click toggles the panel (the runtime's own `Tray.attachPanel`
// does that), a right click opens the tray's menu (the OS does that on macOS and Windows, the tray
// host on Linux). Everything else is answered HERE, in the app's process (lib/tray-driver.ts): the
// menu's items, a double click, a Control-click (the menu, with `popUpMenu()`; the panel ignores a
// click with a modifier) and the tooltip. Not in a page: the main window is hidden, and a hidden
// window's page may be suspended (macOS) until it shows, so a menu item it handled would do nothing.
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";
import { hangarBackend, setHangarWindows } from "./desktop/hangar.ts";
import { createHangarWindows, driveTray } from "./lib/tray-driver.ts";

const caps = await resolveDesktopCapabilities(config, { base: import.meta.url });
const app = await runDesktop({ importMetaUrl: import.meta.url, ...caps });
// The app's data folder (the OS app-support directory), the one the bridge hands the extension's
// methods: the tray driver may reach the backend first, and the backend reads its settings there.
const backend = () => hangarBackend(caps.appSupportDir);

const windows = createHangarWindows(app);
setHangarWindows(windows);
if (app.tray) {
  driveTray(app.tray, windows, {
    overview: async () => (await backend()).overview(),
    start: async (id) => (await backend()).start(id, { headless: true, allowOverBudget: false }),
    shutdown: async (id) => (await backend()).shutdown(id),
  });
}
