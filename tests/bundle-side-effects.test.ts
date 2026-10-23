// Module-level side effects in the `denext` root entry's graph: a statement the bundler must keep
// (a call it can't prove pure, a property assigned to a function declaration) keeps the module's
// code in every app that imports anything from `denext`, used or not. A client-only app that
// imports `createRoot` and two hooks must ship none of the hooks, navigation or routing code it
// never calls; the same modules ship to an app that calls them. The bundle's source maps (kept by
// `DENEXT_SOURCEMAPS=hidden`) say which modules contributed bytes. Shells out to `deno bundle`.

import { assert } from "@std/assert";
import { join } from "@std/path";
import { bundleSourceFiles } from "../src/build/bundle.ts";
import { attributeBytes } from "../src/build/sourcemap-attribution.ts";

const ROOT = new URL("../", import.meta.url).href;

/** Modules a client-only app that never calls them must not ship (each held by a side effect once). */
const SIDE_EFFECT_FREE = [
  "src/utils/use-async-effect.ts", // `useAsyncEffect.wrap = …` on a function declaration
  "src/client/navigation.ts", // the location read and `LinkStatusContext` at module level
  "src/runtime/layout-segments.ts", // `LayoutSegmentContext`
  "src/router/segments.ts", // route-pattern hrefs, reached through navigation.ts
];

/** Bundle `entry` (minified, as production) and return every module that contributed bytes. */
async function shippedModules(entry: string): Promise<string[]> {
  const dir = await Deno.makeTempDir({ prefix: "denext_side_effects_" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": `${ROOT}mod.ts`,
          "denext/jsx-runtime": `${ROOT}src/jsx/jsx-runtime.ts`,
          "denext/client": `${ROOT}src/client/mod.ts`,
        },
      }),
    );
    const previous = Deno.env.get("DENEXT_SOURCEMAPS");
    Deno.env.set("DENEXT_SOURCEMAPS", "hidden");
    try {
      const out = await bundleSourceFiles(entry, {
        configPath: join(dir, "deno.json"),
        minify: true,
      });
      const modules: string[] = [];
      for (const [name, code] of out.files) {
        const map = out.maps?.get(`${name}.map`);
        assert(map, `no source map for ${name}`);
        for (const [source, bytes] of attributeBytes(code, map)) {
          if (bytes > 0) modules.push(source.replaceAll("\\", "/"));
        }
      }
      return modules;
    } finally {
      if (previous === undefined) Deno.env.delete("DENEXT_SOURCEMAPS");
      else Deno.env.set("DENEXT_SOURCEMAPS", previous);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const ships = (modules: string[], path: string) => modules.some((m) => m.endsWith(path));

Deno.test("bundle: importing createRoot and hooks from denext ships no module it never calls", async () => {
  const modules = await shippedModules(
    `import { createRoot } from "denext/client";\n` +
      `import { useEffect, useState } from "denext";\n` +
      `(globalThis as Record<string, unknown>).x = [createRoot, useEffect, useState];\n`,
  );
  assert(ships(modules, "src/client/fiber/commit.ts"), "the reconciler is attributed");
  for (const path of SIDE_EFFECT_FREE) {
    assert(!ships(modules, path), `${path} ships to an app that never calls it`);
  }
});

Deno.test("bundle: the same modules ship to an app that calls them", async () => {
  const modules = await shippedModules(
    `import { Link, useAsyncEffect, useSelectedLayoutSegment } from "denext";\n` +
      `(globalThis as Record<string, unknown>).x = [Link, useAsyncEffect, useSelectedLayoutSegment];\n`,
  );
  for (const path of SIDE_EFFECT_FREE) assert(ships(modules, path), `${path} is missing`);
});
