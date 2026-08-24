// Entry for `deno desktop` — serves the static export in `out/` inside a native
// window (run `deno task export` first, or `deno task desktop`). The serve + window
// plumbing lives in denext's desktop runtime; pass `import.meta.url` so `out/`
// resolves relative to this entry (works from the packaged app too). To reverse-proxy
// a backend, add `spa.proxy` to `denext.config.ts` and pass it here:
// `import config from "./denext.config.ts"; ... proxy: config.spa?.proxy`.
import { runDesktop } from "denext/desktop";

await runDesktop({ importMetaUrl: import.meta.url });
