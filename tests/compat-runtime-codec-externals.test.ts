// The prebuilt compat runtime keeps denext's native codec packages (`@denext/og`, `photon`,
// `avif`) external in BOTH spellings: a checkout imports them bare, while JSR rewrites the
// published sources to `jsr:@denext/og@^x.y.z`. The `jsr:` spelling used to be resolved as a
// file inside the runtime dir (`readfile '<app>/.denext/server/runtime/jsr:@denext/og@^0.1.2'`).

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type * as esbuild from "../src/build/esbuild/mod.ts";
import { resolveWithinRuntime } from "../src/build/next-compat.ts";

const runtimeDir = join(Deno.cwd(), ".denext", "server", "runtime");

function resolveFrom(path: string): esbuild.OnResolveResult | null {
  return resolveWithinRuntime({
    path,
    importer: join(runtimeDir, "chunk-abc.js"),
    namespace: "denext-runtime",
    resolveDir: runtimeDir,
    kind: "dynamic-import",
    pluginData: undefined,
    with: {},
  });
}

Deno.test("resolveWithinRuntime: a codec package stays external in its bare and jsr: spellings", () => {
  for (
    const spec of [
      "@denext/og",
      "@denext/og/wasm",
      "jsr:@denext/og@^0.1.2",
      "jsr:@denext/photon@^0.3.0",
      "jsr:@denext/avif@0.2.1/mod.ts",
      "jsr:@denext/og",
    ]
  ) {
    assertEquals(resolveFrom(spec), { path: spec, external: true }, spec);
  }
});

Deno.test("resolveWithinRuntime: runtime chunks and node builtins are not codecs", () => {
  assertEquals(resolveFrom("node:async_hooks"), null);
  assertEquals(resolveFrom("./chunk-def.js"), {
    path: join(runtimeDir, "chunk-def.js"),
    namespace: "denext-runtime",
  });
  // A look-alike package name is not one of the codecs.
  assertEquals(resolveFrom("jsr:@denext/ogre@1")?.external, undefined);
});
