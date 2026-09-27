// Entry for `deno desktop`: serves the static export in `out/` inside a native window. The
// serve + window + capability-bridge plumbing lives in denext's desktop runtime.
import { runDesktop } from "denext/desktop";

await runDesktop({ importMetaUrl: import.meta.url });
