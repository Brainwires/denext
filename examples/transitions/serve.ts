// Build + serve the useTransition example (denext-native, no npm deps) to exercise
// denext's fiber concurrency (time-sliced, interruptible transitions) in a browser.
//
// Run from the denext repo ROOT:
//   deno task example:transitions            # build once, serve
//   deno task example:transitions --dev      # rebuild on each request
//
// Then open http://localhost:3002 and type in the filter — the input stays
// responsive while the large list re-renders as a low-priority transition.
import { fromFileUrl } from "@std/path";
import { buildExamplePage, serveCompat } from "../_shared/serve-compat.ts";

const dir = fromFileUrl(new URL(".", import.meta.url)).replace(/\/$/, "");
const dev = Deno.args.includes("--dev");
const CLIENT_SRC = "/_client/index.js";

serveCompat({
  port: 3002,
  clientSrc: CLIENT_SRC,
  page: await buildExamplePage(dir, dev),
  dev,
  rebuild: () => buildExamplePage(dir, dev),
}, "transitions");
