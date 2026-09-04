// Build + serve the animation example: `motion` (motion.dev) and `@react-spring/web`
// co-existing in one denext page, both on denext's single React.
//
// Run from the denext repo ROOT:
//   deno task example:animation            # build once, serve
//   deno task example:animation --dev      # rebuild on each request
//
// Then open http://localhost:3003 — both cards animate on load; hover the motion one.
import { fromFileUrl } from "@std/path";
import { buildExamplePage, serveCompat } from "../_shared/serve-compat.ts";

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

await ensureDeps();
serveCompat({
  port: 3003,
  clientSrc: CLIENT_SRC,
  page: await buildExamplePage(dir, dev),
  dev,
  rebuild: () => buildExamplePage(dir, dev),
}, "animation");
