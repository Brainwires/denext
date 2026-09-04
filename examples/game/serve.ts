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
import { buildExamplePage, serveCompat } from "../_shared/serve-compat.ts";

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

await ensureDeps();
// Injected into <head> (renderNextCompatPage only emits <meta charset>): viewport
// + a reset so the canvas fills the window.
const HEAD =
  `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
  `<title>denext × three.js</title>` +
  `<style>*{box-sizing:border-box}html,body{margin:0;height:100%;background:#0b1020;` +
  `overflow:hidden;font-family:system-ui,sans-serif}</style>`;

serveCompat({
  port: PORT,
  clientSrc: CLIENT_SRC,
  page: await buildExamplePage(dir, dev),
  dev,
  rebuild: () => buildExamplePage(dir, dev),
  decorate: (html) => html.replace('<meta charset="utf-8">', `<meta charset="utf-8">${HEAD}`),
  extra: serveAsset,
}, "game");

/** `/assets/*` from the example's public dir, with a content type by extension. */
async function serveAsset(url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/assets/")) return null;
  try {
    const body = await Deno.readFile(`${dir}/public${url.pathname}`);
    return new Response(body, {
      headers: { "content-type": MIME[extname(url.pathname)] ?? "application/octet-stream" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
