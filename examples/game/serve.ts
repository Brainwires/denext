// Build + serve the game example — vanilla Three.js (WebGL) running on denext,
// bundled through the next-compat esbuild path (the same one that bundles motion /
// recharts). React/denext owns the HUD; Three.js owns the canvas.
//
// Run from the denext repo ROOT:
//   deno task example:game            # build once, serve
//   deno task example:game --dev      # rebuild on each request
//
// Then open http://localhost:3005
import { extname, fromFileUrl } from "@std/path";
import {
  buildNextCompatPages,
  type BuiltNextCompatPage,
  renderNextCompatPage,
} from "../../src/build/next-compat-build.ts";

const dir = fromFileUrl(new URL(".", import.meta.url)).replace(/\/$/, "");
const dev = Deno.args.includes("--dev");
const CLIENT_SRC = "/_client/index.js";
const PORT = 3005;

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".json": "application/json",
};

async function ensureDeps() {
  const r = await new Deno.Command(Deno.execPath(), {
    args: [
      "cache",
      "--allow-scripts",
      "--node-modules-dir=auto",
      "npm:three@0.169.0",
    ],
    cwd: dir,
  }).output();
  if (!r.success) throw new Error("failed to install npm deps (three)");
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
  `game example on http://localhost:${PORT}${
    dev ? "  (dev: rebuilds per request)" : ""
  }`,
);

// Injected into <head> (renderNextCompatPage only emits <meta charset>): viewport
// + a reset so the canvas fills the window.
const HEAD =
  `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
  `<title>denext × three.js</title>` +
  `<style>*{box-sizing:border-box}html,body{margin:0;height:100%;background:#0b1020;` +
  `overflow:hidden;font-family:system-ui,sans-serif}</style>`;

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  if (dev && url.pathname === "/") [page] = await build();

  if (url.pathname === CLIENT_SRC) {
    return new Response(await Deno.readTextFile(page.clientBundle), {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  }

  if (url.pathname.startsWith("/assets/")) {
    try {
      const body = await Deno.readFile(`${dir}/public${url.pathname}`);
      return new Response(body, {
        headers: {
          "content-type": MIME[extname(url.pathname)] ??
            "application/octet-stream",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  if (url.pathname === "/") {
    const html = (await renderNextCompatPage(page, {}, CLIENT_SRC))
      .replace('<meta charset="utf-8">', `<meta charset="utf-8">${HEAD}`);
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return new Response("Not found", { status: 404 });
});
