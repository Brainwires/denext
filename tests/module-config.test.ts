// The CLI's module re-exec logic (src/build/module-config.ts): which app configs
// need a merged framework+app config, how imports merge, and that the merged config
// (plus the manual-node_modules symlink) lands on disk. No network — the drizzle
// e2e (tests/e2e/drizzle.e2e.test.ts) covers the live end-to-end path.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  acquireFwdepsInstall,
  configAnchorsResolution,
  mergeModuleConfig,
  readConfig,
  readImportsAbsolute,
  writeMergedModuleConfig,
} from "../src/build/module-config.ts";

Deno.test("acquireFwdepsInstall: serializes concurrent installs, skips when already done", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_fwlock_" });
  const lock = join(dir, ".install.lock");
  try {
    // Already cached → skip the install entirely, never touch the lock.
    assertEquals(await acquireFwdepsInstall(lock, () => Promise.resolve(true)), false);
    assertEquals(await Deno.stat(lock).then(() => true, () => false), false);

    // Not cached, no lock held → WE acquire it (caller must install + release).
    assertEquals(await acquireFwdepsInstall(lock, () => Promise.resolve(false)), true);
    assert(await Deno.stat(lock).then(() => true, () => false), "lock acquired");

    // Lock now held (by the acquire above). A concurrent caller waits; once the cache
    // becomes ready (the holder finished) it returns false — it must NOT install too.
    let ready = false;
    const waiter = acquireFwdepsInstall(lock, () => Promise.resolve(ready));
    setTimeout(() => (ready = true), 300); // simulate the holder completing the install
    assertEquals(await waiter, false);

    await Deno.remove(lock).catch(() => {}); // holder releases
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readConfig: parses JSONC (comments/trailing commas), warns only on real breakage", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_readcfg_" });
  try {
    // A deno.json with comments + a trailing comma is valid JSONC; JSON.parse would have
    // failed → silently dropped the import map. It must now parse cleanly.
    const jsonc = join(dir, "deno.jsonc");
    await Deno.writeTextFile(
      jsonc,
      `{\n  // the app's imports\n  "imports": { "denext": "../mod.ts", },\n}`,
    );
    assertEquals((await readConfig(jsonc)).imports, { denext: "../mod.ts" });

    // A missing file is `{}` with NO warning (an app need not have its own deno.json).
    const original = console.warn;
    let warned = false;
    console.warn = () => (warned = true);
    try {
      assertEquals(await readConfig(join(dir, "nope.json")), {});
      assert(!warned, "a missing config must not warn");

      // A genuinely malformed file is `{}` WITH a warning (not silent), so the dropped
      // import map is diagnosable rather than surfacing later as "not in import map".
      const broken = join(dir, "broken.json");
      await Deno.writeTextFile(broken, `{ "imports": { oops `);
      assertEquals(await readConfig(broken), {});
      assert(warned, "a malformed config must warn");
    } finally {
      console.warn = original;
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

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

Deno.test("writeMergedModuleConfig: writes the merged config for a manual app", async () => {
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

    // The writer is pure: it does NOT create a node_modules beside the config. The
    // framework build deps are installed there by the CLI re-exec (a network step,
    // covered by the manual-node_modules e2e), never by this config writer.
    let linked = false;
    try {
      await Deno.lstat(join(outDir, "node_modules"));
      linked = true;
    } catch { /* expected: writer creates no link */ }
    assert(!linked, "writeMergedModuleConfig must not create a node_modules");
  } finally {
    await Deno.remove(project, { recursive: true });
  }
});

Deno.test("writeMergedModuleConfig: npm:-anchored (non-manual) app drops nodeModulesDir", async () => {
  const project = await Deno.makeTempDir();
  try {
    const fwConfig = join(project, "fw.json");
    const appConfig = join(project, "deno.json");
    await Deno.writeTextFile(fwConfig, JSON.stringify({ imports: {} }));
    await Deno.writeTextFile(appConfig, JSON.stringify({ imports: { orm: "npm:some-orm" } }));
    const outDir = join(project, ".denext");
    const written = await writeMergedModuleConfig(outDir, appConfig, fwConfig);
    const cfg = JSON.parse(await Deno.readTextFile(written)) as { nodeModulesDir?: string };
    // No manual dir → Deno resolves npm from its global cache; the merged config must
    // NOT pin a nodeModulesDir (and no node_modules is created).
    assertEquals(cfg.nodeModulesDir, undefined);
    let linked = false;
    try {
      await Deno.lstat(join(outDir, "node_modules"));
      linked = true;
    } catch { /* expected: no link */ }
    assert(!linked, "a non-manual project must not get a node_modules");
  } finally {
    await Deno.remove(project, { recursive: true });
  }
});
