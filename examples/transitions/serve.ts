// Build + serve the useTransition example (denext-native, no npm deps) to exercise
// denext's cooperative priority scheduler in a real browser.
//
// Run from the denext repo ROOT:
//   deno task example:transitions            # build once, serve
//   deno task example:transitions --dev      # rebuild on each request
//
// Then open http://localhost:3002 and type in the filter — the input stays
// responsive while the large list re-renders as a low-priority transition.
import { fromFileUrl } from "@std/path";
import {
  buildNextCompatPages,
  type BuiltNextCompatPage,
  renderNextCompatPage,
} from "../../src/build/next-compat-build.ts";

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
  `transitions example on http://localhost:3002${dev ? "  (dev: rebuilds per request)" : ""}`,
);

Deno.serve({ port: 3002 }, async (req) => {
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
