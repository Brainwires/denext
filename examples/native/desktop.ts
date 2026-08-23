// Entry for `deno desktop` — it wraps this Deno.serve() handler in a native
// window. Serves the static export in `out/`; run `deno task export` first, or
// use `deno task desktop`, which exports then launches the window.
import { serveDir } from "@std/http/file-server";

// Closing the window (macOS red traffic-light / Cmd-W) should quit the whole app.
// `deno desktop` only auto-exits when no windows are open AND there are no live async
// tasks — but the `Deno.serve()` below is a permanently-live task, so without this the
// close button appears to do nothing (the process lingers). Adopt the initial window
// (the first `new Deno.BrowserWindow()` adopts it) and exit on its `close` event.
try {
  // `Deno.BrowserWindow` exists only under `deno desktop`; not in the ambient types.
  // deno-lint-ignore no-explicit-any
  const BrowserWindow = (Deno as any).BrowserWindow;
  if (typeof BrowserWindow === "function") {
    new BrowserWindow().addEventListener("close", () => Deno.exit(0));
  }
} catch { /* not under `deno desktop` (e.g. plain `deno run`) — no-op */ }

Deno.serve((req) => serveDir(req, { fsRoot: "out", quiet: true }));
