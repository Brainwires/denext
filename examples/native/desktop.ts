// Entry for `deno desktop` — serves the static export in `out/` inside a native
// window (run `deno task export` first, or `deno task desktop`). The serve + window
// plumbing lives in denext's desktop runtime; pass `import.meta.url` so `out/`
// resolves relative to this entry (works from the packaged app too). Native
// capabilities come from `desktop.capabilities` in `denext.config.ts` (default deny).
// To reverse-proxy a backend, add `spa.proxy` to `denext.config.ts` and pass
// `proxy: config.spa?.proxy` below.
import config from "./denext.config.ts";
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";

await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
});
