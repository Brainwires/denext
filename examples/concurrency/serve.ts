// Build + serve the concurrency example (denext-native, no npm deps) to exercise
// denext's fiber concurrency — time-slicing + interruption — in a real browser.
//
// Run from the denext repo ROOT:
//   deno task example:concurrency            # build once, serve
//   deno task example:concurrency --dev      # rebuild on each request
//
// Then open http://localhost:3003 and drag the slider (Concurrent vs Blocking) —
// in Concurrent mode the spinner and FPS keep moving and the text field stays
// typable while a huge grid re-renders; the started/committed counter shows the
// in-flight renders interruption threw away.
import { fromFileUrl } from "@std/path";
import { buildExamplePage, serveCompat } from "../_shared/serve-compat.ts";

const dir = fromFileUrl(new URL(".", import.meta.url)).replace(/\/$/, "");
const dev = Deno.args.includes("--dev");
const CLIENT_SRC = "/_client/index.js";

serveCompat({
  port: 3003,
  clientSrc: CLIENT_SRC,
  page: await buildExamplePage(dir, dev),
  dev,
  rebuild: () => buildExamplePage(dir, dev),
}, "concurrency");
