// Entry for `deno desktop` — serves the static export in `out/` inside a native
// window (run `deno task export` first, or `deno task desktop`). The serve + window
// plumbing lives in denext's desktop runtime; pass `import.meta.url` so `out/`
// resolves relative to this entry (works from the packaged app too). Native
// capabilities come from `desktop.capabilities` in `denext.config.ts` (default deny), and a
// backend reverse proxy from `spa.proxy`. Both arrive through `.deno-desktop/config.json`, the
// runtime part of the config that every export, build and `denext desktop` command rewrites, so
// the config module is never compiled into the app.
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";

await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
});
