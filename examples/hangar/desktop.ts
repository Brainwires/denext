// Entry for `deno desktop`: serves the static export in `out/` and runs the `hangar` extension
// (the VM backend) in this process. The capabilities, the hidden main window, the backend tray with
// its panel and the no-Dock-icon setting come from `desktop.*` through `.deno-desktop/config.json`
// (the runtime part of denext.config.ts), so the config module is never compiled into the app.
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";

await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
});
