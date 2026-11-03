// A Next.js drop-in route reads a file beside itself through `import.meta.url` (an OG image route
// loading its font: `fs.readFile(new URL("./Inter-SemiBold.ttf", import.meta.url))`). The compat
// server bundle is one file under `.denext/server/`, so unless each bundled module's
// `import.meta` is pinned to its source file, the URL resolves against the bundle (ENOENT, a 500).

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { startProdOrigin } from "../helpers/prod-origin.ts";
import { buildInChild } from "../helpers/bounded-build.ts";

const FONT = "not really a font, but bytes beside the route\n";

const FILES: Record<string, string> = {
  "deno.json": JSON.stringify({ nodeModulesDir: "auto", imports: {} }),
  "denext.config.ts": "export default { compatibilityMode: true };\n",
  "app/layout.tsx": `import type { ReactNode } from "react";
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
  "app/page.tsx": `import { readFileSync } from "node:fs";
import { join } from "node:path";
export default function Home() {
  const text = readFileSync(join(import.meta.dirname!, "api", "og", "Inter-SemiBold.ttf"), "utf8");
  return <h1>{"page read " + text.length + " " + import.meta.filename!.endsWith("page.tsx")}</h1>;
}
`,
  "app/api/og/route.tsx": `import fs from "node:fs/promises";
export async function GET() {
  const font = await fs.readFile(new URL("./Inter-SemiBold.ttf", import.meta.url));
  const fetched = await fetch(new URL("./Inter-SemiBold.ttf", import.meta.url));
  return Response.json({
    read: new TextDecoder().decode(font),
    fetched: await fetched.text(),
    meta: { ...import.meta }.url === import.meta.url,
  });
}
`,
  "app/api/og/Inter-SemiBold.ttf": FONT,
};

Deno.test({
  name: "next-compat: import.meta.url in a bundled server module names its source file",
}, async () => {
  const root = await Deno.makeTempDir({ prefix: "denext_nc_meta_url_" });
  const controller = new AbortController();
  let server: Deno.HttpServer | undefined;
  try {
    const built = join(root, "built");
    for (const [rel, src] of Object.entries(FILES)) {
      await Deno.mkdir(join(built, rel, ".."), { recursive: true });
      await Deno.writeTextFile(join(built, rel), src);
    }
    await buildInChild(built);
    // The project and its `.denext` move together (a container image, a compiled binary): the
    // pins are relative to the bundle, not the build machine's absolute path.
    const dir = join(root, "moved");
    await Deno.rename(built, dir);
    const started = await startProdOrigin(dir, controller.signal);
    server = started.server;

    const og = await fetch(`${started.origin}/api/og`);
    const body = await og.text();
    assertEquals(og.status, 200, body);
    assertEquals(JSON.parse(body), { read: FONT, fetched: FONT, meta: true });

    const home = await fetch(`${started.origin}/`);
    const html = await home.text();
    assertEquals(home.status, 200, html);
    assertEquals(/page read (\d+) (\w+)/.exec(html)?.slice(1), [String(FONT.length), "true"]);
  } finally {
    controller.abort();
    await server?.finished;
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
