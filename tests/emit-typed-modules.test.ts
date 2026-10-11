// emitTypedModules: best effort, but a failed write is reported (once per target), not swallowed.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { emitTypedModules } from "../src/build/emit-typed-modules.ts";
import type { RouteManifest } from "../src/router/manifest.ts";

const EMPTY = {
  pages: [],
  api: [],
  rootLayout: null,
  rootNotFound: null,
  rootGlobalError: null,
} as unknown as RouteManifest;

Deno.test("emitTypedModules: an unwritable outDir warns once per target and never throws", async () => {
  const tmp = await Deno.makeTempDir();
  const outDir = join(tmp, "missing", ".denext"); // parent absent → every write fails
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    await emitTypedModules(EMPTY, { outDir, configPath: join(tmp, "deno.json") });
    await emitTypedModules(EMPTY, { outDir, configPath: join(tmp, "deno.json") }); // a rescan
  } finally {
    console.warn = warn;
    await Deno.remove(tmp, { recursive: true });
  }
  assertEquals(warnings.length, 2, warnings.join("\n"));
  assertStringIncludes(warnings[0], join(outDir, "routes.ts"));
  assertStringIncludes(warnings[1], join(outDir, "api.ts"));
  assertStringIncludes(warnings[0], "editor types may be stale");
});
