// Entry for `deno desktop`: serves the static export in `out/` inside a native window. The serve +
// window + capability-bridge plumbing lives in denext's desktop runtime; the native capabilities
// come from `desktop.capabilities` in the config (default deny).
import config from "./denext.config.ts";
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";

await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
});
