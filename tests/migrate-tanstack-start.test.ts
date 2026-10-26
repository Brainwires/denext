// `denext migrate` on a TanStack Start app: detected from `@tanstack/react-start` plus Start's
// Vite plugin (or a Vinxi-era app.config), wired to the `@denext/tanstack-start` plugin with the
// Start options its config passed carried into `tanstackStart({ … })`, sources untouched.
// The real-world run (TanStack's start-basic example, built and served) is the migration bed
// tests/migration-bed/tanstack-start-basic.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { migrateProject } from "../packages/migrate/src/migrate.ts";
import { checkMigration } from "../packages/migrate/src/migrate-check.ts";
import {
  isTanstackStartApp,
  readTanstackStartOptions,
} from "../packages/migrate/src/migrate-tanstack-start.ts";
import { migrateCommand } from "../src/cli/commands/migrate.ts";
import { capture, makeCtx } from "./_cli-coverage-helpers.ts";

const REPO = Deno.cwd();

const VITE_CONFIG = `import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { defineConfig } from 'vite'
import viteReact from '@vitejs/plugin-react'
import { routes } from './routes.config'

const port = 3000

export default defineConfig({
  server: { port },
  plugins: [
    // tanstackStart({ srcDirectory: 'commented-out' }),
    tanstackStart({
      srcDirectory: 'src',
      prerender: {
        enabled: true,
        filter: ({ path }) => path !== '/boom',
      },
      pages: routes,
      tsr: { quoteStyle: 'double' },
      spa: { enabled: false },
      sitemap: { host: 'https://start.example' },
    }),
    viteReact(),
  ],
})
`;

/** Write `files` (relative path → contents; objects are JSON) under a fresh temp dir. */
async function app(files: Record<string, unknown>): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_migrate_tss_" }));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

/** A Start app with Start's layout and `vite.config.ts`. */
function startApp(viteConfig = VITE_CONFIG): Record<string, unknown> {
  return {
    "package.json": {
      name: "start-app",
      type: "module",
      dependencies: {
        "@tanstack/react-router": "^1.170.44",
        "@tanstack/react-start": "^1.169.2",
        react: "^19.0.0",
        "react-dom": "^19.0.0",
      },
      devDependencies: { vite: "^8.0.0", "@vitejs/plugin-react": "^6.0.0" },
    },
    "vite.config.ts": viteConfig,
    "tsconfig.json": { compilerOptions: { paths: { "~/*": ["./src/*"] } } },
    "src/router.tsx": "export function getRouter() {}\n",
    "src/routes/__root.tsx": "export const Route = {};\n",
    "src/routes/index.tsx": "export const Route = {};\n",
  };
}

Deno.test("isTanstackStartApp: Start's package plus its Vite plugin or a Vinxi-era app.config", async () => {
  const dir = await app(startApp());
  try {
    const deps = { "@tanstack/react-start": "^1" };
    assert(await isTanstackStartApp(dir, deps));
    assert(!(await isTanstackStartApp(dir, {})), "no Start package, no Start app");
    await Deno.writeTextFile(join(dir, "vite.config.ts"), "// tanstackStart()\nexport default {}");
    assert(!(await isTanstackStartApp(dir, deps)), "a commented-out call does not count");
    await Deno.writeTextFile(join(dir, "app.config.ts"), "export default defineConfig({})");
    assert(await isTanstackStartApp(dir, deps), "a Vinxi-era app.config");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readTanstackStartOptions: literal plugin options carry, the rest are reported", async () => {
  const dir = await app(startApp());
  try {
    const info = await readTanstackStartOptions(dir);
    assertEquals(info.file, "vite.config.ts");
    assertEquals(info.legacy, false);
    assertEquals(info.carried.map((o) => o.key), ["srcDirectory", "prerender", "spa", "sitemap"]);
    assertEquals(info.carried[0].source, "srcDirectory: 'src'");
    assertStringIncludes(info.carried[1].source, "filter: ({ path }) => path !== '/boom'");
    assertEquals(info.dropped.map((d) => d.key), ["pages", "tsr"]);
    assertStringIncludes(info.dropped[0].note, "reads routes from vite.config.ts");
    assertStringIncludes(info.dropped[1].note, "tsr.config.json");
    assertEquals(info.notes, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readTanstackStartOptions: shorthand, spread and code-built options are not carried", async () => {
  const shorthand = await app(startApp(
    `import { tanstackStart } from '@tanstack/react-start/plugin/vite'\n` +
      `const router = { entry: 'app.tsx' }\nconst base = {}\n` +
      `export default { plugins: [tanstackStart({ router, ...base, "srcDirectory": "app" })] }\n`,
  ));
  const built = await app(startApp(
    `import { tanstackStart } from '@tanstack/react-start/plugin/vite'\n` +
      `export default { plugins: [tanstackStart(startOptions())] }\n`,
  ));
  const bare = await app(startApp(
    `import { tanstackStart } from '@tanstack/react-start/plugin/vite'\n` +
      `export default { plugins: [tanstackStart()] }\n`,
  ));
  try {
    const s = await readTanstackStartOptions(shorthand);
    assertEquals(s.carried, [{ key: "srcDirectory", source: '"srcDirectory": "app"' }]);
    assertEquals(s.dropped.map((d) => d.key), ["router"]);
    assertStringIncludes(s.notes[0], "`...base` is not a plain option");
    const b = await readTanstackStartOptions(built);
    assertEquals(b.carried, []);
    assertStringIncludes(b.notes[0], "built in code (startOptions())");
    assertEquals(await readTanstackStartOptions(bare), {
      file: "vite.config.ts",
      legacy: false,
      carried: [],
      dropped: [],
      notes: [],
    });
  } finally {
    for (const d of [shorthand, built, bare]) await Deno.remove(d, { recursive: true });
  }
});

Deno.test("readTanstackStartOptions: a Vinxi-era app.config carries tsr.appDirectory, with a note", async () => {
  const files = startApp();
  delete files["vite.config.ts"];
  const dir = await app({
    ...files,
    "app.config.ts": `import { defineConfig } from '@tanstack/react-start/config'\n` +
      `export default defineConfig({ tsr: { appDirectory: 'app' }, server: { preset: 'node' } })\n`,
  });
  const none = await app({ "package.json": { name: "x" } });
  try {
    const info = await readTanstackStartOptions(dir);
    assertEquals(info.file, "app.config.ts");
    assertEquals(info.legacy, true);
    assertEquals(info.carried, [{ key: "srcDirectory", source: 'srcDirectory: "app"' }]);
    assertEquals(info.dropped.map((d) => d.key), ["server"]);
    assertStringIncludes(info.notes[0], "Vinxi-era Start config");
    assertEquals((await readTanstackStartOptions(none)).file, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(none, { recursive: true });
  }
});

Deno.test("migrate: a TanStack Start app is wired to the @denext/tanstack-start plugin", async () => {
  const dir = await app(startApp());
  try {
    const router = await Deno.readTextFile(join(dir, "src/router.tsx"));
    const r = await migrateProject(dir, { denextLocalPath: REPO });
    assertEquals(r.kind, "tanstack-start");
    assertEquals(r.tanstackStart?.carried.map((o) => o.key), [
      "srcDirectory",
      "prerender",
      "spa",
      "sitemap",
    ]);
    assertEquals(r.pagesConfigWritten, true);
    assertEquals(r.denoJsonExists, false);
    assert(r.dropped.includes("vite") && r.dropped.includes("@vitejs/plugin-react"));
    assertEquals(await Deno.readTextFile(join(dir, "src/router.tsx")), router, "sources untouched");

    const config = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assertStringIncludes(config, 'import { tanstackStart } from "@denext/tanstack-start";');
    assertStringIncludes(config, "compatibilityMode: true,");
    assertStringIncludes(
      config,
      "    tanstackStart({\n      srcDirectory: 'src',\n      prerender: {\n" +
        "        enabled: true,\n        filter: ({ path }) => path !== '/boom',\n      },\n" +
        "      spa: { enabled: false },\n      sitemap: { host: 'https://start.example' },\n" +
        "    }),\n",
    );
    assertStringIncludes(config, "Options carried from vite.config.ts.");

    const deno = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assertEquals(deno.nodeModulesDir, "manual", "TanStack loads from the app's node_modules");
    assert(deno.unstable.includes("sloppy-imports"));
    assertEquals(deno.fmt.exclude, ["src/routeTree.gen.ts"]);
    const imports = deno.imports as Record<string, string>;
    assert(imports["@denext/tanstack-start"].endsWith("/packages/tanstack-start/mod.ts"));
    // Local-path mode: the plugin's own bare imports resolve to this checkout.
    assert(imports["@denext/denext/plugin-kit"].endsWith("/src/plugin/kit.ts"));
    assert(imports["@denext/denext/server"].endsWith("/src/server/mod.ts"));
    assert(imports["@denext/denext/build/next-compat"].startsWith("file://"));
    assertEquals(imports["@std/path"], "jsr:@std/path@^1.0.0");
    assert(imports.react.startsWith("file://"), "React is denext's");
    assertEquals(imports["~/"], "./src/");
    assert(!("@tanstack/react-start" in imports), "npm packages come from node_modules, unpinned");
    const gitignore = await Deno.readTextFile(join(dir, ".gitignore"));
    assertStringIncludes(gitignore, ".denext/");

    // A re-run rewrites its own files the same way.
    await migrateProject(dir, { denextLocalPath: REPO });
    assertEquals(await Deno.readTextFile(join(dir, "denext.config.ts")), config);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate: the published path maps @denext/tanstack-start from the catalog", async () => {
  const dir = await app(startApp());
  try {
    await migrateProject(dir);
    const imports = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))).imports;
    assert(imports["@denext/tanstack-start"].startsWith("jsr:@denext/tanstack-start@"));
    assert(!("@denext/denext/plugin-kit" in imports), "a JSR package resolves its own imports");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate --check: a TanStack Start app is named, with the options left behind", async () => {
  const dir = await app(startApp());
  try {
    const report = await checkMigration(dir);
    assertEquals(report.source, "tanstack-start");
    assertEquals(report.verdict, "review");
    assert(report.changes.some((c) => c.path === "denext.config.ts" && c.action === "create"));
    assertEquals(report.review.map((f) => f.item), [
      "vite.config.ts: pages",
      "vite.config.ts: tsr",
    ]);
    // Nothing was written.
    assert(!(await exists(join(dir, "deno.json"))));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate: --from tanstack-start, a hand-authored config, and --enable-capacitor", async () => {
  const dir = await app({
    ...startApp(),
    "denext.config.ts": "export default {};\n",
  });
  try {
    const report = await checkMigration(dir, { from: "tanstack-start" });
    const kept = report.wontMigrate.find((f) => f.item === "denext.config.ts");
    assertStringIncludes(kept!.reason, 'tanstackStart() from "@denext/tanstack-start"');
    const r = await migrateProject(dir, { capacitor: true });
    assertEquals(r.pagesConfigExists, true);
    assertEquals(await Deno.readTextFile(join(dir, "denext.config.ts")), "export default {};\n");
    assertStringIncludes(r.capacitorSkipped!, "a TanStack Start app");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate CLI: the TanStack Start section of the report", async () => {
  const dir = await app(startApp());
  const kept = await app({ ...startApp(), "denext.config.ts": "export default {};\n" });
  try {
    for (const target of [dir, kept]) {
      const cap = capture();
      try {
        await migrateCommand.run(makeCtx({
          positionals: [target],
          flags: { "denext-local-path": REPO },
        }));
      } finally {
        cap.restore();
      }
      const out = cap.logs.join("\n");
      assertStringIncludes(
        out,
        "TanStack Start detected — wired the @denext/tanstack-start plugin",
      );
      assertStringIncludes(out, "vite.config.ts: tsr not carried — the route generator reads");
      if (target === dir) {
        assertStringIncludes(out, "(from vite.config.ts: srcDirectory, prerender, spa, sitemap).");
      } else {
        assertStringIncludes(out, "denext.config.ts already exists — add `tanstackStart()`");
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(kept, { recursive: true });
  }
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
