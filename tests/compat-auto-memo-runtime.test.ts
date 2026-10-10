// The auto-memo compiler's runtime (`c` / `memoValue`, imported by every memoized module) in a
// compatibility-mode SPA export is the ONE prebuilt runtime instance. The compiler emits an
// absolute framework URL (`…/src/runtime/compiler-runtime.ts`); in the browser bundle that URL
// used to fall through to the deno-loader, which bundled a SECOND copy of denext's hooks module
// next to the compiler output (it only worked because the dispatcher lives on a global symbol).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { staticExport } from "../src/build/export.ts";
import type { Platform } from "../src/build/platform-extensions.ts";
import { compatRuntimeFileForUrl, runtimeEntryPoints } from "../src/build/next-compat.ts";
import { frameworkFileUrl, frameworkRootUrl } from "../src/build/bundle.ts";
import { transformModule } from "../src/build/compiler.ts";

/** The hook dispatcher's own error text: one per copy of denext's hooks in a bundle. */
const DISPATCHER = "no dispatcher installed";

/** A component the auto-memo compiler memoizes (asserted below). */
const CARD = `import { useState } from "denext";\n` +
  `function Label({ v }: { v: string }) { return <b>{v}</b>; }\n` +
  `export function Card({ title }: { title: string }) {\n` +
  `  const [n] = useState(0);\n  const label = title.toUpperCase();\n` +
  `  return <p data-n={n}><Label v={label} /></p>;\n}\n`;

/** Occurrences of `needle` in `hay`. */
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

Deno.test("a framework URL of a prebuilt entry maps to its runtime file; anything else does not", () => {
  const root = frameworkRootUrl();
  for (const [name, url] of Object.entries(runtimeEntryPoints(root))) {
    assertEquals(compatRuntimeFileForUrl(url), `${name}.js`);
  }
  assertEquals(
    compatRuntimeFileForUrl(frameworkFileUrl("src/runtime/compiler-runtime.ts")),
    "compiler-runtime.js",
  );
  // A framework module that is not a prebuilt entry, and a URL outside the framework.
  assertEquals(compatRuntimeFileForUrl(frameworkFileUrl("src/runtime/hooks.ts")), undefined);
  assertEquals(
    compatRuntimeFileForUrl("file:///elsewhere/src/runtime/compiler-runtime.ts"),
    undefined,
  );
});

Deno.test("the auto-memo compiler imports its runtime from a prebuilt entry URL", async () => {
  const { code, changed } = await transformModule(CARD, "file:///app/src/Card.tsx", {
    absolutize: false,
  });
  assert(changed, "the fixture component is memoized");
  const url = code.match(/_dnxMemo } from ("[^"]+")/)?.[1];
  assert(url, code);
  assertEquals(compatRuntimeFileForUrl(JSON.parse(url)), "compiler-runtime.js");
});

/** A compat SPA with `reactCompiler: true` and a memoizable component. */
async function project(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_auto_memo_rt_" });
  const files: Record<string, string> = {
    "deno.json": JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      // Unmapped: a `denext` specifier that falls through to the deno-loader fails the export.
      imports: {},
    }),
    "denext.config.ts": `export default { mode: "spa", spa: { entry: "./src/main.tsx" }, ` +
      `compatibilityMode: true, reactCompiler: true };\n`,
    "src/main.tsx": `import { createRoot } from "denext/react-dom/client";\n` +
      `import { Card } from "./Card.tsx";\n` +
      `createRoot(document.getElementById("root")!).render(<Card title="memo_card" />);\n`,
    "src/Card.tsx": CARD,
  };
  for (const [name, src] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), src);
  }
  return dir;
}

/** Every client `.js` file of an export, concatenated. */
async function clientJs(outDir: string): Promise<string> {
  const client = join(outDir, "_denext", "client");
  let js = "";
  for await (const e of Deno.readDir(client)) {
    if (e.isFile && e.name.endsWith(".js")) js += await Deno.readTextFile(join(client, e.name));
  }
  return js;
}

for (const platform of ["web", "ios", "macos"] as const satisfies readonly Platform[]) {
  Deno.test(`compat SPA export --platform ${platform} with reactCompiler: one copy of denext's hooks`, async () => {
    const dir = await project();
    try {
      const js = await clientJs((await staticExport(dir, { platform })).outDir);
      assertStringIncludes(js, "memo_card");
      assertEquals(count(js, DISPATCHER), 1, "exactly one copy of denext's hooks");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}
