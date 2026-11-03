// An app running denext from a local checkout (src/build/local-checkout-imports.ts): migrate maps
// only the deps the app's graph can reach (never the CLI's own), never overrides a key the app
// maps itself and reports the clash, and `denext doctor` flags an entry at another major.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join, toFileUrl } from "@std/path";
import {
  frameworkRuntimeDeps,
  layeredFrameworkImports,
  localCheckoutOf,
  majorClashes,
  ownVersionMismatches,
  planFrameworkDeps,
} from "../src/build/local-checkout-imports.ts";
import { checkMigration } from "../src/build/migrate-check.ts";
import { ensureMergedConfig } from "../src/build/dev-unbundled/resolve.ts";
import { createUnbundledState } from "../src/build/dev-unbundled/state.ts";
import { buildAppCss } from "../src/build/css.ts";
import { writeMergedModuleConfig } from "../src/build/module-config.ts";
import { migrateProject } from "../src/build/migrate.ts";
import { importVersionsCheck, localCheckoutImportsCheck } from "../src/cli/commands/doctor.ts";
import { createMigrateCommand } from "../src/cli/commands/migrate.ts";
import { capture, makeCtx } from "./_cli-coverage-helpers.ts";

type Files = Record<string, string | Record<string, unknown>>;

async function withTree(files: Files, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_local_checkout_" });
  try {
    for (const [name, body] of Object.entries(files)) {
      await Deno.mkdir(dirname(join(dir, name)), { recursive: true });
      const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
      await Deno.writeTextFile(join(dir, name), text);
    }
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * A denext checkout in miniature: the public entry imports `@std/path` and `ws`; only the CLI
 * (`./cli` → cli.ts → src/build/migrate.ts) imports `effect`; the root import map also lists a
 * test-only `jsqr`, as the real one does.
 */
function checkout(prefix = "denext"): Files {
  return {
    [`${prefix}/deno.json`]: {
      name: "@denext/denext",
      exports: { ".": "./mod.ts", "./server": "./src/server/mod.ts", "./cli": "./cli.ts" },
      imports: {
        "denext": "./mod.ts",
        "@std/path": "jsr:@std/path@^1.0.0",
        "ws": "npm:ws@^8",
        "effect": "npm:effect@^3.22.0",
        "jsqr": "npm:jsqr@1.4.0",
      },
    },
    [`${prefix}/mod.ts`]: `export * from "./src/server/mod.ts";\n`,
    [`${prefix}/src/server/mod.ts`]: `import { join } from "@std/path";\n` +
      `export const j = join;\nexport const proxy = () => import("./proxy.ts");\n`,
    [`${prefix}/src/server/proxy.ts`]: `import WebSocket from "ws";\nexport { WebSocket };\n`,
    [`${prefix}/cli.ts`]: `import "./src/build/migrate.ts";\n`,
    [`${prefix}/src/build/migrate.ts`]: `import { Effect } from "effect";\nexport { Effect };\n`,
  };
}

/** A minimal Vite React SPA at `apps/web`, depending on `extraDeps`. */
function viteApp(extraDeps: Record<string, string> = {}): Files {
  return {
    "apps/web/package.json": {
      name: "web",
      dependencies: { react: "^19", "react-dom": "^19", ...extraDeps },
      devDependencies: { vite: "^8.0.0" },
    },
    "apps/web/vite.config.ts": "export default {};\n",
    "apps/web/index.html": `<!doctype html><html><head><title>app</title></head><body>` +
      `<div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`,
    "apps/web/src/main.tsx": `import { createRoot } from "react-dom/client";\n` +
      `createRoot(document.getElementById("root")!).render(<p>hi</p>);\n`,
  };
}

Deno.test("frameworkRuntimeDeps: what the app's graph reaches, never the CLI's or the tests' deps", async () => {
  await withTree(checkout(), async (root) => {
    assertEquals(await frameworkRuntimeDeps(join(root, "denext")), {
      "@std/path": "jsr:@std/path@^1.0.0",
      "ws": "npm:ws@^8",
    });
  });
});

Deno.test("planFrameworkDeps: the app's own entry wins; another major is a clash", () => {
  const framework = {
    "@std/path": "jsr:@std/path@^1.0.0",
    "ws": "npm:ws@^8",
    "sass": "npm:sass@^1.80.0",
    "@std/fs": "jsr:@std/fs@^1.0.0",
    "@std/yaml": "jsr:@std/yaml@^1.0.0",
  };
  const plan = planFrameworkDeps(framework, {
    imports: {
      "@std/path": "jsr:@std/path@^0.224.0", // another major: kept, reported
      "@std/fs": "jsr:@std/fs@^1.2.0", // the same major: kept, quiet
    },
    deps: { ws: "^8.18.0", sass: "catalog:" }, // resolved from node_modules: not mapped
  });
  assertEquals(plan.entries, [
    ["@std/path", "jsr:@std/path@^0.224.0"],
    ["@std/fs", "jsr:@std/fs@^1.2.0"],
    ["@std/yaml", "jsr:@std/yaml@^1.0.0"],
  ]);
  assertEquals(plan.clashes, [
    { name: "@std/path", app: "jsr:@std/path@^0.224.0", denext: "jsr:@std/path@^1.0.0" },
    // A range that names no major can't be shown compatible.
    { name: "sass", app: "sass@catalog: (package.json)", denext: "npm:sass@^1.80.0" },
  ]);
});

Deno.test("majorClashes: only registry entries at another major or of another package", () => {
  const needed = {
    "@std/path": "jsr:@std/path@^1.0.0",
    "ws": "npm:ws@^8",
    "@std/fs": "jsr:@std/fs@^1.0.0",
    "@std/yaml": "jsr:@std/yaml@^1.0.0",
  };
  assertEquals(
    majorClashes({
      "@std/path": "jsr:@std/path@0.224.0",
      "ws": "npm:isomorphic-ws@^8",
      "@std/fs": "./vendor/fs/mod.ts", // the app's own copy: its choice
      "@std/yaml": "jsr:@std/yaml@^1.0.1",
    }, needed),
    [
      { name: "@std/path", app: "jsr:@std/path@0.224.0", denext: "jsr:@std/path@^1.0.0" },
      { name: "ws", app: "npm:isomorphic-ws@^8", denext: "npm:ws@^8" },
    ],
  );
});

Deno.test("migrate --denext-local-path: no CLI-only dep, and the app's mapped key is kept and reported", async () => {
  await withTree({ ...checkout(), ...viteApp() }, async (root) => {
    const dir = join(root, "apps/web");
    const local = join(root, "denext");
    const first = await migrateProject(dir, { denextLocalPath: local });
    const imports = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))).imports;
    assertEquals(imports.effect, undefined, "only the checkout's CLI imports effect");
    assertEquals(imports.jsqr, undefined, "nothing the app reaches imports jsqr");
    assertEquals(imports["@std/path"], "jsr:@std/path@^1.0.0");
    assertEquals(first.importClashes, undefined);
    // The app maps @std/path at another major in its (migrate-generated) deno.json: a re-run
    // keeps it and reports the clash instead of putting denext's back.
    const cfg = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    cfg.imports["@std/path"] = "jsr:@std/path@^0.224.0";
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify(cfg, null, 2));
    const again = await migrateProject(dir, { denextLocalPath: local });
    const after = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))).imports;
    assertEquals(after["@std/path"], "jsr:@std/path@^0.224.0");
    assertEquals(again.importClashes, [
      { name: "@std/path", app: "jsr:@std/path@^0.224.0", denext: "jsr:@std/path@^1.0.0" },
    ]);
  });
});

Deno.test("migrate --denext-local-path: a package.json dep at another major stays the app's", async () => {
  await withTree({ ...checkout(), ...viteApp({ ws: "^7.5.0" }) }, async (root) => {
    const dir = join(root, "apps/web");
    const r = await migrateProject(dir, { denextLocalPath: join(root, "denext") });
    const imports = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))).imports;
    assert(!String(imports.ws).includes("@^8"), `the app's own ws, not denext's: ${imports.ws}`);
    assertEquals(r.importClashes, [
      { name: "ws", app: "ws@^7.5.0 (package.json)", denext: "npm:ws@^8" },
    ]);
  });
});

Deno.test("localCheckoutOf: the checkout behind a path or file: URL denext entry", async () => {
  await withTree({ ...checkout(), "app/deno.json": "{}" }, async (root) => {
    const app = join(root, "app");
    const mod = join(root, "denext", "mod.ts");
    assertEquals(await localCheckoutOf(app, { denext: mod }), join(root, "denext"));
    assertEquals(await localCheckoutOf(app, { denext: toFileUrl(mod).href }), join(root, "denext"));
    assertEquals(await localCheckoutOf(app, { denext: "../denext/mod.ts" }), join(root, "denext"));
    assertEquals(await localCheckoutOf(app, { denext: "jsr:@denext/denext@^4.11.0" }), null);
    assertEquals(await localCheckoutOf(app, {}), null);
    assertEquals(await localCheckoutOf(app, { denext: join(root, "nowhere", "mod.ts") }), null);
  });
});

Deno.test("denext doctor: flags an import-map entry at another major than the local checkout's", async () => {
  await withTree(checkout(), async (root) => {
    const app = join(root, "app");
    const write = (imports: Record<string, string>) =>
      Deno.mkdir(app, { recursive: true }).then(() =>
        Deno.writeTextFile(join(app, "deno.json"), JSON.stringify({ imports }))
      );
    const denext = join(root, "denext", "mod.ts");
    // `effect` is not one the checkout's runtime needs: the app's Effect 4 is no clash.
    await write({ denext, "@std/path": "jsr:@std/path@^0.224.0", effect: "npm:effect@^4.0.0" });
    const bad = await localCheckoutImportsCheck(app);
    assert(bad && !bad.ok && !bad.critical, JSON.stringify(bad));
    assertStringIncludes(
      bad.detail,
      "@std/path: the app has jsr:@std/path@^0.224.0, denext's checkout maps jsr:@std/path@^1.0.0",
    );
    assert(!bad.detail.includes("effect"), bad.detail);
    await write({ denext, "@std/path": "jsr:@std/path@^1.1.0", ws: "npm:ws@^8" });
    const good = await localCheckoutImportsCheck(app);
    assert(good?.ok, JSON.stringify(good));
    await write({ denext: "jsr:@denext/denext@^4.11.0", "@std/path": "jsr:@std/path@^0.224.0" });
    assertEquals(await localCheckoutImportsCheck(app), null, "a JSR denext carries its own deps");
  });
});

Deno.test("migrate CLI --denext-local-path: prints each clash with the app's and the checkout's specifier", async () => {
  await withTree({ ...checkout(), ...viteApp({ ws: "^7.5.0" }) }, async (root) => {
    const dir = join(root, "apps/web");
    const out = capture();
    try {
      await createMigrateCommand(() => Promise.resolve({ code: 0 })).run(makeCtx({
        positionals: [dir],
        flags: { "denext-local-path": join(root, "denext") },
      }));
    } finally {
      out.restore();
    }
    const printed = out.logs.join("\n");
    assertStringIncludes(printed, "the app's entry was kept");
    assertStringIncludes(
      printed,
      "ws: the app has ws@^7.5.0 (package.json), denext's checkout maps npm:ws@^8",
    );
  });
});

// ── the merged configs a build / dev process runs under ───────────────────────

Deno.test("dev merged config: denext's test-only `effect` never shadows the app's own", async () => {
  // The app depends on Effect 4 and leaves `effect` unmapped (it resolves from node_modules), as a
  // pnpm workspace does; denext's root import map lists `effect@^3` for its @denext/effect tests.
  await withTree({
    "package.json": { name: "app", dependencies: { effect: "4.0.0-beta.1" } },
    "deno.json": { imports: {} },
  }, async (dir) => {
    const st = createUnbundledState({
      projectDir: dir,
      appDir: join(dir, "app"),
      configPath: join(dir, "deno.json"),
      outDir: join(dir, ".denext"),
    });
    const merged = JSON.parse(await Deno.readTextFile(await ensureMergedConfig(st))).imports;
    assertEquals(merged.effect, undefined, "the app's node_modules effect resolves, not denext's");
    assertEquals(merged.jsqr, undefined, "a dep only denext's tests import");
    assertStringIncludes(merged["@std/path"], "jsr:@std/path", "one denext's modules import");
    assert(merged["denext"], "denext's own entries stay");
  });
});

Deno.test("CSS config: a package the app has in node_modules stays the app's", async () => {
  await withTree({
    "package.json": { name: "app" },
    "node_modules/effect/package.json": { name: "effect", version: "4.0.0" },
    "deno.json": { imports: {} },
    "app/layout.tsx": `import "./globals.css";\nexport default () => null;\n`,
    "app/globals.css": "body { margin: 0; }\n",
  }, async (dir) => {
    const css = await buildAppCss({
      projectDir: dir,
      configPath: join(dir, "deno.json"),
      outDir: join(dir, ".denext"),
    });
    assert(css, "the app's stylesheet was found");
    const imports = JSON.parse(await Deno.readTextFile(css.configPath)).imports;
    assertEquals(imports.effect, undefined);
    assertStringIncludes(imports["@std/path"], "jsr:@std/path");
  });
});

Deno.test("layeredFrameworkImports: denext's graph decides, the app's packages are the app's", async () => {
  await withTree(
    { ...checkout(), "app/package.json": { dependencies: { ws: "^7" } } },
    async (root) => {
      const framework = {
        "denext": toFileUrl(join(root, "denext", "mod.ts")).href,
        "@std/path": "jsr:@std/path@^1.0.0",
        "ws": "npm:ws@^8",
        "effect": "npm:effect@^3.22.0",
        "jsqr": "npm:jsqr@1.4.0",
      };
      const fileRoot = toFileUrl(join(root, "denext") + "/").href;
      assertEquals(Object.keys(await layeredFrameworkImports(framework, { root: fileRoot })), [
        "denext",
        "@std/path",
        "ws",
      ]);
      // A process running the CLI needs the CLI's deps (the fake checkout's cli.ts imports effect).
      assertEquals(
        Object.keys(await layeredFrameworkImports(framework, { root: fileRoot, cli: true })),
        ["denext", "@std/path", "ws", "effect"],
      );
      // The app owns ws: left to the app.
      assertEquals(
        Object.keys(
          await layeredFrameworkImports(framework, { root: fileRoot, appDir: join(root, "app") }),
        ),
        ["denext", "@std/path"],
      );
      // A remote framework is not walked; only the app's packages are taken out.
      assertEquals(
        Object.keys(
          await layeredFrameworkImports(framework, {
            root: "https://jsr.io/@denext/denext/9.9.9/",
            appDir: join(root, "app"),
          }),
        ),
        ["denext", "@std/path", "effect", "jsqr"],
      );
    },
  );
});

Deno.test("migrate --check --denext-local-path: previews each import clash", async () => {
  await withTree({ ...checkout(), ...viteApp({ ws: "^7.5.0" }) }, async (root) => {
    const dir = join(root, "apps/web");
    const report = await checkMigration(dir, { denextLocalPath: join(root, "denext") });
    assertEquals(report.importClashes, [
      { name: "ws", app: "ws@^7.5.0 (package.json)", denext: "npm:ws@^8" },
    ]);
    const finding = report.review.find((f) => f.item === "local denext import: ws");
    assert(finding, JSON.stringify(report.review));
    assertStringIncludes(finding.reason, "denext's checkout maps npm:ws@^8");
    assertEquals(report.verdict, "review");
    await Deno.stat(join(dir, "deno.json")).then(
      () => assert(false, "--check writes nothing"),
      () => {},
    );
  });
});

Deno.test("denext doctor: an npm: import-map entry at another major than the app's own copy", async () => {
  await withTree({
    "package.json": { dependencies: { effect: "catalog:", zod: "^3.23.0", ws: "^8.0.0" } },
    "node_modules/effect/package.json": { name: "effect", version: "4.0.0-beta.1" },
    "deno.json": {
      imports: {
        effect: "npm:effect@^3.22.0", // installed 4.x: flagged
        zod: "npm:zod@^4.0.0", // not installed, package.json ^3: flagged
        ws: "npm:ws@^8.18.0", // agrees
        left: "npm:left-pad@^1.0.0", // the app has no copy: nothing to compare
      },
    },
  }, async (dir) => {
    assertEquals(
      (await ownVersionMismatches(dir, {
        effect: "npm:effect@^3.22.0",
        zod: "npm:zod@^4.0.0",
        ws: "npm:ws@^8.18.0",
        left: "npm:left-pad@^1.0.0",
      })).map((m) => [m.key, m.own, m.source]),
      [["effect", "4.0.0-beta.1", "node_modules"], ["zod", "^3.23.0", "package.json"]],
    );
    const check = await importVersionsCheck(dir);
    assert(check && !check.ok && !check.critical, JSON.stringify(check));
    assertStringIncludes(
      check.detail,
      "effect → npm:effect@^3.22.0, but node_modules has 4.0.0-beta.1",
    );
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { effect: "npm:effect@^4.0.0-beta.1" } }),
    );
    assert((await importVersionsCheck(dir))?.ok);
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ imports: {} }));
    assertEquals(await importVersionsCheck(dir), null);
  });
});

Deno.test("module re-exec config: denext's test-only `effect` never shadows the app's own", async () => {
  // The config the CLI re-execs a manual-node_modules build under, against this checkout.
  const framework = fromFileUrl(new URL("../deno.json", import.meta.url));
  await withTree({
    "package.json": { name: "app", dependencies: { effect: "4.0.0-beta.1" } },
    "deno.json": { nodeModulesDir: "manual", imports: {} },
  }, async (dir) => {
    const path = await writeMergedModuleConfig(
      join(dir, ".denext"),
      join(dir, "deno.json"),
      framework,
    );
    const imports = JSON.parse(await Deno.readTextFile(path)).imports;
    assertEquals(imports.effect, undefined, "the app's node_modules effect resolves, not denext's");
    assertEquals(imports.jsqr, undefined, "a dep only denext's tests import");
    assertStringIncludes(imports["@std/path"], "jsr:@std/path", "the CLI's own deps stay");
    assertStringIncludes(imports.sass, "npm:sass", "a build dep the CLI imports stays");
    assert(imports["denext"], "denext's own entries stay");
  });
});
