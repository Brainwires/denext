// Entry for `deno desktop`: serves the static export in `out/` inside a native window. The
// serve + window + capability-bridge plumbing lives in denext's desktop runtime; the native
// capabilities come from `desktop.capabilities` in the config (default deny), through
// `.deno-desktop/config.json` (the runtime part of denext.config.ts that every export and
// `denext desktop` command rewrites), so the config module is never compiled into the app.
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";

await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
});
