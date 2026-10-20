// The CLI's module re-exec logic (src/build/module-config.ts): which app configs
// need a merged framework+app config, how imports merge, and that the merged config
// (plus the manual-node_modules symlink) lands on disk. No network — the drizzle
// e2e (tests/e2e/drizzle.e2e.test.ts) covers the live end-to-end path.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  acquireFwdepsInstall,
  configAnchorsResolution,
  mergeModuleConfig,
  readConfig,
  readImportsAbsolute,
  resolvesInThisProcess,
  unresolvedImportKeys,
  writeMergedModuleConfig,
} from "../src/build/module-config.ts";
import { denoJson } from "../src/build/scaffold.ts";

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

Deno.test("configAnchorsResolution: an import-map key the running process cannot resolve anchors", () => {
  // What the running CLI's config resolves (a stand-in for import.meta.resolve).
  const known = new Set(["denext", "denext/server", "@std/path", "@std/path/posix"]);
  const resolves = (key: string) => known.has(key);
  // An app-only prefix (a Gleam build's `@gleam/`) or bare key: the merged config is needed,
  // or an app server module importing it is "not in import map" (B2).
  assert(
    configAnchorsResolution({ imports: { "@gleam/": "./gleam/build/dev/javascript/" } }, resolves),
  );
  assert(configAnchorsResolution({ imports: { "@db/pg": "jsr:@db/postgres" } }, resolves));
  assertEquals(
    unresolvedImportKeys(
      { imports: { denext: "../mod.ts", "denext/mobile": "../m.ts" } },
      resolves,
    ),
    ["denext/mobile"],
  );
  // Keys the process resolves keep a plain project off the re-exec (startup cost, no --allow-run).
  assert(!configAnchorsResolution({ imports: { denext: "../../mod.ts" } }, resolves));
  assert(
    !configAnchorsResolution({
      imports: { "denext/server": "../s.ts", "@std/path/posix": "jsr:@std/path/posix" },
    }, resolves),
  );
  assert(!configAnchorsResolution({}, resolves));
  assertEquals(unresolvedImportKeys({}, resolves), []);
  // Without a resolver only the manual / npm: rule applies (the CSS stage's check).
  assert(!configAnchorsResolution({ imports: { "@gleam/": "./gleam/" } }));
});

Deno.test("resolvesInThisProcess: asks Deno's resolver under the config this process runs with", () => {
  // The test runs under the framework's config: its map, a jsr: entry's subpaths, its workspace.
  assert(resolvesInThisProcess("denext/server"));
  assert(resolvesInThisProcess("@std/path"));
  assert(resolvesInThisProcess("@std/path/posix"));
  assert(resolvesInThisProcess("@denext/htmx"));
  assert(!resolvesInThisProcess("@gleam/"));
  assert(!resolvesInThisProcess("@gleam/app.mjs"));
  assert(!resolvesInThisProcess("denext-not-a-key"));
});

Deno.test("the source checkout's framework config does not anchor the repo's plain examples", async () => {
  // The startup-cost guard: an example that maps only what the framework config resolves must
  // not start re-exec'ing. examples/hello maps denext's own entries and nothing else.
  const root = fromFileUrl(new URL("..", import.meta.url));
  for (const example of ["hello", "htmx", "pages-router", "typed-api"]) {
    const cfg = await readConfig(join(root, "examples", example, "deno.json"));
    assertEquals(
      unresolvedImportKeys(cfg, resolvesInThisProcess),
      [],
      `examples/${example} would re-exec`,
    );
  }
});

Deno.test("a scaffolded app's map, passed to the CLI with --config, anchors nothing", async () => {
  // R1: a source checkout runs a scaffolded app's least-privilege `start` task (no --allow-run)
  // as `deno run --config <app>/deno.json <checkout>/cli.ts start`, with the app's denext keys
  // pointed into the checkout. Checked against the framework config's own map, keys it lacks
  // (`denext/`, the template's `denext/deploy`) re-exec'd that run into NotCapable; asked of the
  // resolver the CLI actually runs under, every key resolves and nothing re-runs.
  const dir = await Deno.makeTempDir({ prefix: "denext_scaffold_resolve_" });
  try {
    const fw = new URL("../", import.meta.url).href;
    const cfg = JSON.parse(denoJson({ dir })) as { imports: Record<string, string> };
    assert("denext/deploy" in cfg.imports, Object.keys(cfg.imports).join(", "));
    Object.assign(cfg.imports, {
      "denext": `${fw}mod.ts`,
      "denext/": `${fw}src/`,
      "denext/jsx-runtime": `${fw}src/jsx/jsx-runtime.ts`,
      "denext/jsx-dev-runtime": `${fw}src/jsx/jsx-runtime.ts`,
      "denext/server": `${fw}src/server/mod.ts`,
      "denext/client": `${fw}src/client/mod.ts`,
      "denext/testing": `${fw}src/testing/mod.ts`,
      "denext/auth": `${fw}src/server/auth/public.ts`,
      "denext/deploy": `${fw}src/deploy/mod.ts`,
    });
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify(cfg, null, 2));
    const probe = join(dir, "probe.ts");
    await Deno.writeTextFile(
      probe,
      `import { readConfig, resolvesInThisProcess, unresolvedImportKeys } from ${
        JSON.stringify(`${fw}src/build/module-config.ts`)
      };\n` +
        `const cfg = await readConfig(${JSON.stringify(join(dir, "deno.json"))});\n` +
        `console.log(JSON.stringify(unresolvedImportKeys(cfg, resolvesInThisProcess)));\n`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-read", "--config", join(dir, "deno.json"), probe],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    assertEquals(out.code, 0, dec.decode(out.stderr));
    assertEquals(JSON.parse(dec.decode(out.stdout)), []);
    // The framework config alone lacks them: the old static check's false positive.
    assert(!resolvesInThisProcess("denext/"));
    assert(!resolvesInThisProcess("denext/deploy"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a re-exec the CLI may not spawn fails with the way out, not NotCapable", async () => {
  // A source checkout's CLI under the framework's config, an app mapping a key only it knows, and
  // no --allow-run: the module re-exec cannot run, so the CLI says what to do instead.
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_reexec_refused_" }));
  try {
    await Deno.mkdir(join(dir, "app"));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { "@gleam/": "./gleam/" } }),
    );
    await Deno.writeTextFile(join(dir, "app", "page.tsx"), "export default () => null;\n");
    const root = fromFileUrl(new URL("..", import.meta.url));
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--config",
        join(root, "deno.json"),
        "--allow-read",
        "--allow-env",
        "--allow-net",
        "--allow-write=.denext",
        join(root, "cli.ts"),
        "start",
        ".",
      ],
      cwd: dir,
      stdin: "null", // no terminal: Deno cannot ask for --allow-run, so the CLI refuses up front
      stdout: "piped",
      stderr: "piped",
      // On stock Deno: the module gate's refusal, past the toolchain gate's (scaffold-start.test.ts).
      env: { NO_COLOR: "1", DENEXT_DENO: "stock" },
    }).output();
    const stderr = new TextDecoder().decode(out.stderr);
    assert(out.code !== 0, stderr);
    assert(!stderr.includes("NotCapable"), stderr);
    assert(stderr.includes("has no --allow-run"), stderr);
    assert(stderr.includes("(@gleam/)"), stderr);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
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

Deno.test("satisfiesRange: caret, tilde, plain and 0.x ranges (npm semantics)", async () => {
  const { satisfiesRange } = await import("../src/build/module-config.ts");
  assertEquals(satisfiesRange("3.4.1", "^3.2.0"), true);
  assertEquals(satisfiesRange("3.1.9", "^3.2.0"), false);
  assertEquals(satisfiesRange("4.0.0", "^3.2.0"), false);
  assertEquals(satisfiesRange("3.2.0", "^3.2.0"), true);
  assertEquals(satisfiesRange("3.2.7", "~3.2.1"), true);
  assertEquals(satisfiesRange("3.3.0", "~3.2.1"), false);
  assertEquals(satisfiesRange("0.25.3", "^0.25.0"), true);
  assertEquals(satisfiesRange("0.26.0", "^0.25.0"), false);
  assertEquals(satisfiesRange("1.2.3", "1.2.3"), true);
  assertEquals(satisfiesRange("1.2.2", "1.2.3"), false);
  assertEquals(satisfiesRange("2.0.0", ">=2"), true);
});

Deno.test("pinNpmToLock: pins to the highest locked version in range; unlocked deps keep their range", async () => {
  const { pinNpmToLock } = await import("../src/build/module-config.ts");
  const lock = {
    npm: {
      "esbuild@0.25.3": {},
      "esbuild@0.25.9": {},
      "esbuild@0.26.0": {},
      "@mdx-js/mdx@3.0.0": {},
      "@mdx-js/mdx@3.1.0": {},
    },
  };
  const npm = {
    esbuild: "npm:esbuild@^0.25.0",
    "@mdx-js/mdx": "npm:@mdx-js/mdx@^3.0.0",
    sass: "npm:sass@^1.80.0",
    bare: "npm:bare",
  };
  assertEquals(pinNpmToLock(npm, lock), {
    esbuild: "npm:esbuild@0.25.9",
    "@mdx-js/mdx": "npm:@mdx-js/mdx@3.1.0",
    sass: "npm:sass@^1.80.0",
    bare: "npm:bare",
  });
  assertEquals(pinNpmToLock({ esbuild: "npm:esbuild@^0.25.0" }, {}), {
    esbuild: "npm:esbuild@^0.25.0",
  });
});
