// The CLI's module re-exec logic (src/build/module-config.ts): which app configs
// need a merged framework+app config, how imports merge, and that the merged config
// (plus the manual-node_modules symlink) lands on disk. No network — the drizzle
// e2e (tests/e2e/drizzle.e2e.test.ts) covers the live end-to-end path.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  configAnchorsResolution,
  mergeModuleConfig,
  readImportsAbsolute,
  writeMergedModuleConfig,
} from "../src/build/module-config.ts";

Deno.test("configAnchorsResolution: manual node_modules or npm: imports anchor", () => {
  // Anchors: needs the merged config.
  assert(configAnchorsResolution({ nodeModulesDir: "manual" }));
  assert(configAnchorsResolution({ imports: { "drizzle-orm": "npm:drizzle-orm@^0.44" } }));
  assert(configAnchorsResolution({ nodeModulesDir: "manual", imports: { x: "./x.ts" } }));

  // Does NOT anchor: plain projects run unchanged (this is the regression guard for
  // the `nodeModulesDir: "auto"` examples that must NOT start re-exec'ing).
  assert(!configAnchorsResolution({ nodeModulesDir: "auto" }));
  assert(!configAnchorsResolution({ nodeModulesDir: "none" }));
  assert(!configAnchorsResolution({}));
  assert(
    !configAnchorsResolution({ imports: { denext: "../../mod.ts", "@db/pg": "jsr:@db/postgres" } }),
  );
});

Deno.test("mergeModuleConfig: app imports win on overlap; passthrough of compilerOptions + nodeModulesDir", () => {
  const merged = mergeModuleConfig(
    { denext: "file:///fw/mod.ts", esbuild: "npm:esbuild@^0.24" },
    { denext: "file:///app/mod.ts", "drizzle-orm": "npm:drizzle-orm@^0.44" },
    { nodeModulesDir: "manual", compilerOptions: { jsx: "react-jsx" } },
  );
  const imports = merged.imports as Record<string, string>;
  assertEquals(imports["denext"], "file:///app/mod.ts"); // app wins
  assertEquals(imports["esbuild"], "npm:esbuild@^0.24"); // framework kept
  assertEquals(imports["drizzle-orm"], "npm:drizzle-orm@^0.44"); // app added
  assertEquals(merged.nodeModulesDir, "manual");
  assertEquals(merged.compilerOptions, { jsx: "react-jsx" });
});

Deno.test("mergeModuleConfig: 'none'/absent nodeModulesDir is dropped", () => {
  assertEquals(mergeModuleConfig({}, {}, { nodeModulesDir: "none" }).nodeModulesDir, undefined);
  assertEquals(mergeModuleConfig({}, {}, {}).nodeModulesDir, undefined);
});

Deno.test("readImportsAbsolute: relative values → file: URLs; npm:/jsr: pass through", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { denext: "./mod.ts", up: "../x.ts", orm: "npm:drizzle-orm" } }),
    );
    const map = await readImportsAbsolute(join(dir, "deno.json"));
    assert(map["denext"].startsWith("file://") && map["denext"].endsWith("/mod.ts"));
    assert(map["up"].startsWith("file://") && map["up"].endsWith("/x.ts"));
    assertEquals(map["orm"], "npm:drizzle-orm"); // bare specifier untouched
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeMergedModuleConfig: writes merged config + links manual node_modules", async () => {
  const project = await Deno.makeTempDir();
  try {
    // A stand-in project: framework config + an app config with a manual dir + npm dep.
    const fwConfig = join(project, "fw.json");
    const appConfig = join(project, "deno.json");
    await Deno.writeTextFile(
      fwConfig,
      JSON.stringify({ imports: { esbuild: "npm:esbuild@^0.24" } }),
    );
    await Deno.writeTextFile(
      appConfig,
      JSON.stringify({
        nodeModulesDir: "manual",
        imports: { "drizzle-orm": "npm:drizzle-orm@^0.44" },
      }),
    );
    await Deno.mkdir(join(project, "node_modules"));
    const outDir = join(project, ".denext");

    const written = await writeMergedModuleConfig(outDir, appConfig, fwConfig);
    assertEquals(written, join(outDir, "module-config.json"));

    const cfg = JSON.parse(await Deno.readTextFile(written)) as {
      imports: Record<string, string>;
      nodeModulesDir?: string;
    };
    assertEquals(cfg.nodeModulesDir, "manual");
    assertEquals(cfg.imports["esbuild"], "npm:esbuild@^0.24");
    assertEquals(cfg.imports["drizzle-orm"], "npm:drizzle-orm@^0.44");

    // The manual node_modules is anchored to the config's dir (.denext), so the
    // project's real node_modules must be linked in beside it.
    const link = await Deno.lstat(join(outDir, "node_modules"));
    assert(link.isSymlink, "node_modules should be a symlink into the project root");
    const realTarget = await Deno.realPath(join(outDir, "node_modules"));
    assertEquals(realTarget, await Deno.realPath(join(project, "node_modules")));
  } finally {
    await Deno.remove(project, { recursive: true });
  }
});

Deno.test("writeMergedModuleConfig: no symlink for a non-manual project", async () => {
  const project = await Deno.makeTempDir();
  try {
    const fwConfig = join(project, "fw.json");
    const appConfig = join(project, "deno.json");
    await Deno.writeTextFile(fwConfig, JSON.stringify({ imports: {} }));
    await Deno.writeTextFile(appConfig, JSON.stringify({ imports: { orm: "npm:some-orm" } }));
    const outDir = join(project, ".denext");
    await writeMergedModuleConfig(outDir, appConfig, fwConfig);
    let linked = false;
    try {
      await Deno.lstat(join(outDir, "node_modules"));
      linked = true;
    } catch { /* expected: no link */ }
    assert(!linked, "a non-manual project must not get a node_modules symlink");
  } finally {
    await Deno.remove(project, { recursive: true });
  }
});
