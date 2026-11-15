// An app whose `deno.json` lists `"unstable": ["kv"]` and opens Deno KV when its page module
// loads serves under `denext start` from this checkout: the CLI resolves the checkout's deno.json,
// not the app's, so before the app's `"unstable"` list reached the process that runs the app,
// every request failed with `Deno.openKv is not a function`.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startCliServer } from "../e2e/harness.ts";
import { buildInChild } from "../helpers/bounded-build.ts";

const u = (rel: string) => new URL(rel, import.meta.url).href;

Deno.test(
  { name: 'denext start: the app\'s deno.json "unstable" list reaches the server' },
  async () => {
    const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-unstable-kv-" }));
    try {
      await Deno.mkdir(join(dir, "app"));
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({
          unstable: ["kv"],
          imports: {
            "denext": u("../../mod.ts"),
            "denext/jsx-runtime": u("../../src/jsx/jsx-runtime.ts"),
          },
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        }),
      );
      await Deno.writeTextFile(
        join(dir, "app", "layout.tsx"),
        "export default function L({ children }: { children?: unknown }) {\n" +
          "  return <html><body>{children}</body></html>;\n}\n",
      );
      await Deno.writeTextFile(
        join(dir, "app", "page.tsx"),
        `const kv = await Deno.openKv(":memory:");
await kv.set(["greeting"], "from deno kv");
export default async function Page() {
  return <p>{(await kv.get<string>(["greeting"])).value}</p>;
}
`,
      );
      await buildInChild(dir);
      const server = await startCliServer(dir, 120_000);
      try {
        const res = await fetch(server.origin + "/");
        const html = await res.text();
        assertEquals(res.status, 200, html.slice(0, 500));
        assertStringIncludes(html, "<p>from deno kv</p>");
      } finally {
        await server.close();
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);
