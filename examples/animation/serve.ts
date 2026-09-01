// Build + serve the animation example: `motion` (motion.dev) and `@react-spring/web`
// co-existing in one denext page, both on denext's single React.
//
// Run from the denext repo ROOT:
//   deno task example:animation            # build once, serve
//   deno task example:animation --dev      # rebuild on each request
//
// Then open http://localhost:3003 — both cards animate on load; hover the motion one.
import { fromFileUrl } from "@std/path";
import {
  buildNextCompatPages,
  type BuiltNextCompatPage,
  renderNextCompatPage,
} from "../../src/build/next-compat-build.ts";

const dir = fromFileUrl(new URL(".", import.meta.url)).replace(/\/$/, "");
const dev = Deno.args.includes("--dev");
const CLIENT_SRC = "/_client/index.js";

async function ensureDeps() {
  const r = await new Deno.Command(Deno.execPath(), {
    args: [
      "cache",
      "--allow-scripts",
      "--node-modules-dir=auto",
      "npm:motion@12.23.12",
      "npm:@react-spring/web@9.7.5",
    ],
    cwd: dir,
  }).output();
  if (!r.success) throw new Error("failed to install npm deps");
}

function build(): Promise<BuiltNextCompatPage[]> {
  return buildNextCompatPages({
    projectDir: dir,
    configPath: `${dir}/deno.json`,
    outDir: `${dir}/.denext`,
    pages: [{ routePath: "/", filePath: `${dir}/app/page.tsx` }],
    minify: !dev,
  });
}

await ensureDeps();
let [page] = await build();
console.log(
  `animation example on http://localhost:3003${dev ? "  (dev: rebuilds per request)" : ""}`,
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
