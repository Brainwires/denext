// Build + serve the next-compat example. Demonstrates a REAL npm React library
// (@radix-ui/react-collapsible) running on denext — SSR + hydration.
//
// Run from the denext repo ROOT (this example imports denext's build layer by
// relative path, so it needs the framework's deno.json / import map):
//
//   deno task example:next-compat            # build once, serve (prod-like)
//   deno task example:next-compat --dev      # rebuild on each request
//
// (equivalently: deno run -A --config deno.json examples/next-compat/serve.ts)
// Then open http://localhost:3000 and click "Toggle details".
import { fromFileUrl } from "@std/path";
import {
  buildNextCompatPages,
  type BuiltNextCompatPage,
  renderNextCompatPage,
} from "../../src/build/next-compat-build.ts";

const dir = fromFileUrl(new URL(".", import.meta.url)).replace(/\/$/, "");
const dev = Deno.args.includes("--dev");
const CLIENT_SRC = "/_client/index.js";

/** Ensure the npm deps are installed (esbuild resolves them from node_modules). */
async function ensureDeps() {
  const r = await new Deno.Command(Deno.execPath(), {
    args: [
      "cache",
      "--allow-scripts",
      "--node-modules-dir=auto",
      "npm:@radix-ui/react-collapsible@1.1.12",
    ],
    cwd: dir,
  }).output();
  if (!r.success) throw new Error("failed to install npm deps");
}

async function build(): Promise<BuiltNextCompatPage> {
  const [page] = await buildNextCompatPages({
    projectDir: dir,
    configPath: `${dir}/deno.json`,
    outDir: `${dir}/.denext`,
    pages: [{ routePath: "/", filePath: `${dir}/app/page.tsx` }],
    minify: !dev,
  });
  return page;
}

await ensureDeps();
let page = await build();
console.log(
  `next-compat example on http://localhost:3000${dev ? "  (dev: rebuilds per request)" : ""}`,
);

Deno.serve({ port: 3000 }, async (req) => {
  const url = new URL(req.url);
  if (dev && url.pathname === "/") page = await build();
  if (url.pathname === CLIENT_SRC) {
    return new Response(await Deno.readTextFile(page.clientBundle), {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  }
  if (url.pathname === "/") {
    const html = await renderNextCompatPage(
      page,
      { params: { slug: "home" } },
      CLIENT_SRC,
    );
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response("Not found", { status: 404 });
});
