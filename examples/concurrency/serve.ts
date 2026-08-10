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
import {
  buildNextCompatPages,
  type BuiltNextCompatPage,
  renderNextCompatPage,
} from "../../src/build/next-compat-build.ts";
import { fromFileUrl } from "@std/path";

const dir = fromFileUrl(new URL(".", import.meta.url)).replace(/\/$/, "");
const dev = Deno.args.includes("--dev");
const CLIENT_SRC = "/_client/index.js";

function build(): Promise<BuiltNextCompatPage[]> {
  return buildNextCompatPages({
    projectDir: dir,
    configPath: `${dir}/deno.json`,
    outDir: `${dir}/.denext`,
    pages: [{ routePath: "/", filePath: `${dir}/app/page.tsx` }],
    minify: !dev,
  });
}

let [page] = await build();
console.log(
  `concurrency example on http://localhost:3003${dev ? "  (dev: rebuilds per request)" : ""}`,
);

Deno.serve({ port: 3003 }, async (req) => {
  const url = new URL(req.url);
  if (dev && url.pathname === "/") [page] = await build();
  if (url.pathname === CLIENT_SRC) {
    return new Response(await Deno.readTextFile(page.clientBundle), {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  }
  if (url.pathname === "/") {
    const html = await renderNextCompatPage(page, {}, CLIENT_SRC);
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response("Not found", { status: 404 });
});
