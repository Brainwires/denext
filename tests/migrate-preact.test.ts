// `denext migrate` for a Preact app: detection (Vite's @preact/preset-vite, preact-cli, WMR,
// esbuild), the SPA path with the shared Preact layer (import map + resolveAlias), preact-iso →
// denext/preact-iso, the routers kept on the aliases, and the `migrate --check` report (golden;
// `DENEXT_UPDATE_GOLDEN=1` rewrites it).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { migrateProject } from "../src/build/migrate.ts";
import { checkMigration } from "../src/build/migrate-check.ts";
import { preactTooling } from "../src/build/migrate-preact.ts";

type Tree = Record<string, string | Record<string, unknown>>;

const REPO = fromFileUrl(new URL("..", import.meta.url));
const GOLDEN = fromFileUrl(
  new URL("./fixtures/migrate-preact/preact-vite.check.json", import.meta.url),
);

async function withTree<T>(files: Tree, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_migrate_preact_" }));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const path = join(dir, rel);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(
        path,
        typeof body === "string" ? body : JSON.stringify(body, null, 2),
      );
    }
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** create-preact's Vite template with the router option, plus a few things that do not migrate. */
const PREACT_VITE: Tree = {
  "package.json": {
    private: true,
    type: "module",
    dependencies: {
      "preact": "^11.0.0",
      "preact-iso": "^2.12.2",
      "@preact/signals": "^2.9.0",
      "wouter-preact": "^3.7.1",
    },
    devDependencies: { "@preact/preset-vite": "^2.10.6", "vite": "^8.3.1" },
  },
  "vite.config.js": `import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
export default defineConfig({
  plugins: [preact({ prerender: { enabled: true, renderTarget: '#app' } })],
});
`,
  "index.html": `<!DOCTYPE html>
<html lang="en"><head><title>Vite + Preact</title></head>
<body><div id="app"></div><script type="module" src="/src/index.jsx"></script></body></html>
`,
  "src/index.jsx": `import { render } from 'preact';
import { LocationProvider, Router, Route } from 'preact-iso';
import { useErrorBoundary } from 'preact/hooks';
import { Home } from './pages/Home.jsx';
export function App() {
  useErrorBoundary();
  return <LocationProvider><Router><Route path="/" component={Home} /></Router></LocationProvider>;
}
render(<App />, document.getElementById('app'));
`,
  "src/pages/Home.jsx": `export function Home() { return <h1>Home</h1>; }\n`,
};

Deno.test("preactTooling: Vite preset, preact-cli, WMR, esbuild, and not a Preact app", async () => {
  await withTree(
    { "vite.config.js": `import preact from "@preact/preset-vite";\n` },
    async (dir) => {
      assertEquals(await preactTooling(dir, { preact: "11" }), "vite");
      assertEquals(await preactTooling(dir, { react: "19" }), null);
    },
  );
  await withTree({}, async (dir) => {
    assertEquals(await preactTooling(dir, { preact: "10", "preact-cli": "3" }), "preact-cli");
    assertEquals(await preactTooling(dir, { preact: "10", wmr: "3" }), "wmr");
    assertEquals(await preactTooling(dir, { preact: "10", esbuild: "0.25" }), null);
  });
  await withTree(
    { "tsconfig.json": `{ "compilerOptions": { "jsxImportSource": "preact" } }` },
    async (dir) => {
      assertEquals(await preactTooling(dir, { preact: "10", esbuild: "0.25" }), "esbuild");
    },
  );
});

Deno.test("migrate: a Preact + Vite + preact-iso app takes the SPA path with the Preact layer", async () => {
  await withTree(PREACT_VITE, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: REPO });
    assertEquals(r.kind, "preact");
    assertEquals(r.spa?.entry, "./src/index.jsx");
    assertEquals(r.aliased.sort(), ["@preact/signals", "preact", "preact-iso"]);
    assert(r.dropped.includes("@preact/preset-vite"));
    assertEquals(r.preact?.tooling, "vite");
    assertEquals(r.preact?.routers, ["preact-iso", "wouter-preact"]);
    const config = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assertStringIncludes(config, `mode: "spa"`);
    assertStringIncludes(config, `"preact": "denext/preact",`);
    assertStringIncludes(config, `"preact-iso": "denext/preact-iso",`);
    assertStringIncludes(config, `rootId: "app"`);
    const deno = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assertStringIncludes(deno.imports.preact, "src/compat/preact/mod.ts");
    assertStringIncludes(deno.imports["denext/preact"], "src/compat/preact/mod.ts");
    assertStringIncludes(deno.imports["preact-iso"], "src/compat/preact/iso.ts");
    assertStringIncludes(deno.imports["@preact/signals"], "src/compat/preact/signals.ts");
    assertStringIncludes(deno.imports["preact/debug"], "src/compat/empty.ts");
    assertEquals(deno.compilerOptions.jsxImportSource, "preact");
    assertStringIncludes(deno.imports["preact/jsx-runtime"], "src/compat/preact/jsx-runtime.ts");
  });
});

Deno.test("migrate: preact-cli and WMR configs are reported", async () => {
  await withTree({
    "package.json": {
      dependencies: { preact: "^10.0.0", "preact-router": "^4" },
      devDependencies: { "preact-cli": "^3" },
    },
    "preact.config.js": "export default () => {};\n",
    "src/index.js": `import { h } from "preact";\nexport default () => h("p", null, "x");\n`,
  }, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: REPO });
    assertEquals(r.preact?.tooling, "preact-cli");
    assert(r.preact?.wontMigrate.some((f) => f.item === "preact.config.js"));
    assert(r.preact?.review.some((f) => f.item === "preact-router"));
  });
  await withTree({
    "package.json": { dependencies: { preact: "^10.0.0" }, devDependencies: { wmr: "^3" } },
    "wmr.config.mjs": "export default {};\n",
    "public/index.html": `<div id="root"></div><script type="module" src="./index.js"></script>\n`,
    "public/index.js": `import { render } from "preact";\nrender(null, document.body);\n`,
  }, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: REPO, from: "preact" });
    assertEquals(r.preact?.tooling, "wmr");
    assert(r.preact?.review.some((f) => f.item === "wmr.config.mjs"));
  });
});

Deno.test("migrate --check: a Preact app — golden report", async () => {
  await withTree(PREACT_VITE, async (dir) => {
    const report = await checkMigration(dir, { denextLocalPath: REPO });
    assertEquals(report.source, "preact");
    const { target: _t, denext: _d, ...rest } = report as unknown as Record<string, unknown>;
    const actual = JSON.stringify(
      // The repo path as it is spelled inside JSON (a Windows path's backslashes escaped).
      JSON.parse(JSON.stringify(rest).replaceAll(JSON.stringify(REPO).slice(1, -1), "<repo>/")),
      null,
      2,
    ) + "\n";
    if (Deno.env.get("DENEXT_UPDATE_GOLDEN") === "1") {
      await Deno.mkdir(dirname(GOLDEN), { recursive: true });
      await Deno.writeTextFile(GOLDEN, actual);
    }
    assertEquals(actual, await Deno.readTextFile(GOLDEN));
  });
});
