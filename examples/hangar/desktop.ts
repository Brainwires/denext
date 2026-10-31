// Entry for `deno desktop`: serves the static export in `out/` and runs the `hangar` extension
// (the VM backend) in this process. The capabilities, the hidden main window, the backend tray with
// its panel and the no-Dock-icon setting come from `desktop.*` through `.deno-desktop/config.json`
// (the runtime part of denext.config.ts), so the config module is never compiled into the app.
//
// The tray's clicks: a plain left click toggles the panel (the runtime's own `Tray.attachPanel`
// does that), a right click opens the tray's menu (the OS does that on macOS and Windows, the tray
// host on Linux), and a Control-click, macOS' right click for a one-button mouse, opens the menu
// here with `popUpMenu()` (runtime 3.0.0-denext.6; the panel ignores a click with a modifier). The
// main page (app/tray-shell.tsx) handles the menu's items, double clicks and the tooltip.
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";

const app = await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
});

app.tray?.onClick((click) => {
  if (click?.modifiers.ctrl) app.tray?.popUpMenu();
});
