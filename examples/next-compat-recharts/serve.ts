// Build + serve the recharts next-compat example. Demonstrates a REAL npm chart
// library built on React **class components** (recharts) running on denext —
// enabled by `classComponents: true`, server-rendered to SVG, then hydrated.
//
// Run from the denext repo ROOT (this example imports denext's build layer by
// relative path, so it needs the framework's deno.json / import map):
//
//   deno task example:next-compat-recharts            # build once, serve (prod-like)
//   deno task example:next-compat-recharts --dev      # rebuild on each request
//
// Then open http://localhost:3001 — the line chart is real recharts, SSR'd on
// denext's single React and hydrated (hover a point for the tooltip).
import { fromFileUrl } from "@std/path";
import { serveCompat } from "../_shared/serve-compat.ts";
import {
  buildNextCompatPages,
  type BuiltNextCompatPage,
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
      "npm:recharts@2.15.0",
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
    // recharts is built on React class components — required for this example.
    classComponents: true,
    minify: !dev,
  });
  return page;
}

await ensureDeps();
serveCompat({
  port: 3001,
  clientSrc: CLIENT_SRC,
  page: await build(),
  dev,
  rebuild: () => build(),
}, "recharts");
