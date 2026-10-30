// Entry for `deno desktop`: serves the static export in `out/` and runs the `hangar` extension
// (the VM backend) in this process. The capabilities come from `desktop.capabilities` through
// `.deno-desktop/config.json` (the runtime part of denext.config.ts), so the config module is never
// compiled into the app.
//
// Tray-first, approximated: denext opens the app's one window at launch and has no option to keep
// it hidden, so it is hidden here as soon as it is adopted. The page still loads in it (the tray
// icon is the page's: `app/tray-shell.tsx`) and shows it again as the panel or a full window.
// README.md lists what native support would replace this with.
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";

const app = await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
});

// `window` is the adopted `Deno.BrowserWindow` (`undefined` under a plain `deno run`).
const win = app.window as { hide?: () => void } | undefined;
if (!app.sidecarChild) win?.hide?.();
