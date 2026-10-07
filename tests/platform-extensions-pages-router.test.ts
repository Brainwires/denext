// Platform-specific files in a Pages Router app (`@denext/pages-router`): its server render loads
// the app's modules through denext's loader, which takes the web target's `Label.web.tsx`, so
// its client bundles must take the same file or hydration sees other markup.

import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { build } from "../src/build/build.ts";
import { startProdServer } from "../src/build/prod-server.ts";
import { startDevServer } from "../src/build/dev-server.ts";
import { resolveProject } from "../src/build/paths.ts";

const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;

/** A Pages Router app whose page imports `components/Label.tsx`, which has a `.web` variant. */
async function pagesApp(): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_platform_pages_" }));
  const files: Record<string, string> = {
    "deno.json": JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "@denext/denext" },
      imports: {
        "@denext/denext": abs("mod.ts"),
        "@denext/denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "@denext/denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
        "@denext/denext/client": abs("src/client/mod.ts"),
        "@denext/denext/server": abs("src/server/mod.ts"),
        "@denext/denext/bundle": abs("src/build/plugin-bundle.ts"),
        "@denext/pages-router": abs("packages/pages-router/mod.ts"),
        "@denext/pages-router/router": abs("packages/pages-router/router.ts"),
        "@denext/pages-router/link": abs("packages/pages-router/link.ts"),
        "@denext/pages-router/document": abs("packages/pages-router/src/document.ts"),
        "@denext/pages-router/client-runtime": abs("packages/pages-router/src/client-runtime.ts"),
      },
    }),
    "denext.config.ts": `import { pagesRouter } from "@denext/pages-router";\n` +
      `export default { plugins: [pagesRouter()] };\n`,
    "pages/index.tsx": `import { label } from "../components/Label.tsx";\n` +
      `export default function Home() { return <main>{label}</main>; }\n`,
    "components/Label.tsx": `export const label = "PLAIN_LABEL";\n`,
    "components/Label.web.tsx": `export const label = "WEB_LABEL";\n`,
  };
  for (const [name, src] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), src);
  }
  return dir;
}

for (const mode of ["build + start", "dev"] as const) {
  Deno.test(`Pages Router (${mode}): the server render and the client bundle take the same platform file`, async () => {
    const dir = await pagesApp();
    const controller = new AbortController();
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const onListen = ({ port }: { port: number }) => resolve(port);
        const opts = { port: 0, hostname: "127.0.0.1", signal: controller.signal, onListen };
        if (mode === "dev") {
          resolveProject(dir).then((paths) => startDevServer({ paths, ...opts })).catch(reject);
        } else {
          build(dir).then(() => startProdServer({ projectDir: dir, ...opts })).catch(reject);
        }
      });
      const base = `http://127.0.0.1:${port}`;
      const html = await (await fetch(`${base}/`)).text();
      assertStringIncludes(html, "WEB_LABEL", "the server render took the .web file");
      // Every client chunk the page loads, and the chunks they import.
      const seen = new Set<string>();
      const pending = [...html.matchAll(/\/_denext\/pages\/[\w.-]+\.js/g)].map((m) => m[0]);
      assert(pending.length > 0, "the page loads a client bundle");
      let js = "";
      while (pending.length > 0) {
        const url = pending.pop()!;
        if (seen.has(url)) continue;
        seen.add(url);
        const code = await (await fetch(base + url)).text();
        js += code;
        for (const m of code.matchAll(/["']\.\/([\w.-]+\.js)["']/g)) {
          pending.push(`/_denext/pages/${m[1]}`);
        }
      }
      assertStringIncludes(js, "WEB_LABEL", "the client bundle took the .web file");
      assert(!js.includes("PLAIN_LABEL"), "the client bundle left the plain file out");
    } finally {
      controller.abort();
      await new Promise((r) => setTimeout(r, 100));
      await Deno.remove(dir, { recursive: true });
    }
  });
}
