// Entry for `deno desktop` — it wraps this Deno.serve() handler in a native
// window. Serves the static export in `out/`; run `deno task export` first, or
// use `deno task desktop`, which exports then launches the window.
import { serveDir } from "@std/http/file-server";

Deno.serve((req) => serveDir(req, { fsRoot: "out", quiet: true }));
