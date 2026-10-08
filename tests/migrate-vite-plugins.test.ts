// `denext migrate` (Vite SPA) carrying build plugins over (src/build/migrate-vite-plugins.ts):
// TanStack Router's `autoCodeSplitting` → `spa.tanstackRouter`, and a Vite plugin that emits
// files from `generateBundle` → `viteEmitterPlugin(<the same call>)` in `denext.config.ts` —
// proven end to end (the migrated app exports the emitted file). Emitters migrate cannot carry
// (other build hooks, vite.config values in the call, inline plugins) are reported for review,
// by the migration and by `denext migrate --check`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { migrateProject } from "../src/build/migrate.ts";
import { checkMigration } from "../src/build/migrate-check.ts";
import {
  balancedCall,
  tanstackRouterFacts,
  viteAssetsDir,
} from "../src/build/migrate-vite-plugins.ts";
import { staticExport } from "../src/build/export.ts";
import { resetPlugins } from "../src/plugin/mod.ts";

const REPO = fromFileUrl(new URL("../", import.meta.url));

/** A minimal Vite React SPA with `viteConfig` and any `extra` files. */
async function viteApp(viteConfig: string, extra: Record<string, string> = {}): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_migrate_viteplugins_" });
  await Deno.writeTextFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", dependencies: { react: "^19", "react-dom": "^19" } }),
  );
  await Deno.writeTextFile(join(dir, "vite.config.ts"), viteConfig);
  await Deno.writeTextFile(
    join(dir, "index.html"),
    `<!doctype html><html><head><title>app</title></head><body>` +
      `<div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`,
  );
  await Deno.mkdir(join(dir, "src"));
  await Deno.writeTextFile(
    join(dir, "src", "main.tsx"),
    `import { createRoot } from "react-dom/client";\n` +
      `createRoot(document.getElementById("root")!).render(<p>hi</p>);\n`,
  );
  for (const [rel, text] of Object.entries(extra)) {
    await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), text);
  }
  return dir;
}

/** A Vite plugin module that only emits a file (the shape of T3 Code's licences plugin). */
const LICENSES_MODULE = `import type { Plugin } from "vite";
export function licensesPlugin(options: { fileName: string; configFile: URL }): Plugin {
  return {
    name: "licenses",
    configureServer() {},
    generateBundle(_options, bundle) {
      this.emitFile({
        type: "asset",
        fileName: options.fileName,
        source: JSON.stringify({ config: options.configFile.pathname.endsWith("licenses.config.json") }),
      });
    },
  } as Plugin;
}
`;

Deno.test("tanstackRouterFacts: autoCodeSplitting (and literal paths) from the plugin call", () => {
  assertEquals(
    tanstackRouterFacts(
      `plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true, ` +
        `routesDirectory: "./src/pages", generatedRouteTree: './src/tree.gen.ts' }), react()]`,
    ),
    {
      autoCodeSplitting: true,
      routesDirectory: "./src/pages",
      generatedRouteTree: "./src/tree.gen.ts",
    },
  );
  assertEquals(tanstackRouterFacts(`TanStackRouterVite({ autoCodeSplitting: true })`), {
    autoCodeSplitting: true,
  });
  assertEquals(tanstackRouterFacts(`tanstackRouter({ autoCodeSplitting: false })`), undefined);
  assertEquals(tanstackRouterFacts(`tanstackRouter()`), undefined);
  // A comment mentioning it is not the call's argument.
  assertEquals(tanstackRouterFacts(`// autoCodeSplitting: true\ntanstackRouter({})`), undefined);
});

Deno.test("balancedCall: strings and comments do not unbalance the call", () => {
  const text = `f({ a: ")", b: '(', c: \`)\` /* ) */ }, g(1)) // )\nrest`;
  assertEquals(balancedCall(text, 1), `({ a: ")", b: '(', c: \`)\` /* ) */ }, g(1))`);
  assertEquals(balancedCall("f((", 1), null);
});

Deno.test("migrate SPA: TanStack Router autoCodeSplitting → spa.tanstackRouter", async () => {
  const dir = await viteApp(
    `import { tanstackRouter } from "@tanstack/router-plugin/vite";\n` +
      `export default { plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true })] };\n`,
  );
  try {
    const r = await migrateProject(dir, {});
    const config = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assertStringIncludes(config, "tanstackRouter: { autoCodeSplitting: true },");
    assertEquals(r.spa?.tanstackRouter, { autoCodeSplitting: true });
    const loaded = (await import(`file://${join(dir, "denext.config.ts")}`)).default;
    assertEquals(loaded.spa.tanstackRouter, { autoCodeSplitting: true });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("viteAssetsDir: build.assetsDir from the vite.config, else Vite's default", () => {
  assertEquals(viteAssetsDir(`export default { build: { assetsDir: "static/js" } };`), "static/js");
  assertEquals(viteAssetsDir(`build: {\n  outDir: "dist",\n  assetsDir: 'res',\n}`), "res");
  assertEquals(viteAssetsDir(`export default { plugins: [] };`), "assets");
  // A comment mentioning it, or a value migrate cannot read, keeps the default.
  assertEquals(viteAssetsDir(`// assetsDir: "nope"\nexport default {};`), "assets");
  assertEquals(viteAssetsDir(`build: { assetsDir: dir }`), "assets");
  // Vite's "" (assets at the root) has no denext equivalent: the default is kept.
  assertEquals(viteAssetsDir(`build: { assetsDir: "" }`), "assets");
});

for (
  const [label, build, expected] of [
    ["Vite's default", "", "assets"],
    ["the vite.config's build.assetsDir", `, build: { assetsDir: "static" }`, "static"],
  ] as const
) {
  Deno.test(`migrate SPA: spa.assetsDir is ${label}`, async () => {
    const dir = await viteApp(`export default { plugins: []${build} };\n`);
    try {
      await migrateProject(dir, {});
      const config = await Deno.readTextFile(join(dir, "denext.config.ts"));
      assertStringIncludes(config, `assetsDir: ${JSON.stringify(expected)},`);
      const loaded = (await import(`file://${join(dir, "denext.config.ts")}`)).default;
      assertEquals(loaded.spa.assetsDir, expected);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("migrate SPA: no autoCodeSplitting → no spa.tanstackRouter", async () => {
  const dir = await viteApp(
    `import { tanstackRouter } from "@tanstack/router-plugin/vite";\n` +
      `export default { plugins: [tanstackRouter({ target: "react" })] };\n`,
  );
  try {
    await migrateProject(dir, {});
    assert(!(await Deno.readTextFile(join(dir, "denext.config.ts"))).includes("tanstackRouter"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name:
    "migrate SPA: a file-emitting Vite plugin is wired through viteEmitterPlugin and still emits",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  resetPlugins();
  const dir = await viteApp(
    `import react from "@vitejs/plugin-react";\n` +
      `import { licensesPlugin } from "./scripts/licenses";\n` +
      `export default {\n  plugins: [\n    licensesPlugin({\n      fileName: "third-party-licenses.json",\n` +
      `      configFile: new URL("./licenses.config.json", import.meta.url),\n    }),\n    react(),\n  ],\n};\n`,
    { "scripts/licenses.ts": LICENSES_MODULE },
  );
  try {
    const r = await migrateProject(dir, { denextLocalPath: REPO });
    assertEquals(r.spa?.viteEmitters?.map((e) => e.name), ["licensesPlugin"]);
    assertEquals(r.spa?.viteEmitterReview, []);
    const config = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assertStringIncludes(config, `import { viteEmitterPlugin } from "denext/plugin-kit";`);
    assertStringIncludes(config, `import { licensesPlugin } from "./scripts/licenses.ts";`);
    assertStringIncludes(config, "viteEmitterPlugin(licensesPlugin({");
    const denoJson = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assert(denoJson.imports["denext/plugin-kit"], "denext/plugin-kit is mapped");
    // The migrated app exports the file the Vite plugin emits.
    await staticExport(dir);
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(dir, "out", "third-party-licenses.json"))),
      { config: true },
    );
  } finally {
    resetPlugins();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate SPA: emitters migrate cannot carry are reported for review (and by --check)", async () => {
  const transformModule = LICENSES_MODULE.replace(
    "configureServer() {},",
    "transform(code) { return code; },",
  );
  const dir = await viteApp(
    `import { licensesPlugin } from "./scripts/licenses";\n` +
      `import { stampPlugin } from "./scripts/stamp";\n` +
      `const out = "stamp.txt";\n` +
      `export default { plugins: [\n` +
      `  licensesPlugin({ fileName: "x.json", configFile: new URL("./c.json", import.meta.url) }),\n` +
      `  stampPlugin(out),\n` +
      `  { name: "inline", generateBundle() { this.emitFile({ type: "asset", fileName: "a", source: "" }); } },\n` +
      `] };\n`,
    {
      "scripts/licenses.ts": transformModule,
      "scripts/stamp.ts": `export const stampPlugin = (f: string) => ({ name: "stamp", ` +
        `generateBundle() { (this as any).emitFile({ type: "asset", fileName: f, source: "1" }); } });\n`,
    },
  );
  try {
    const check = await checkMigration(dir, {});
    const items = check.review.map((f) => f.item);
    assert(items.includes("vite.config.ts: licensesPlugin()"), items.join("\n"));
    assert(items.includes("vite.config.ts: stampPlugin()"), items.join("\n"));
    assert(items.includes("vite.config.ts: an inline plugin's generateBundle"), items.join("\n"));
    const byItem = new Map(check.review.map((f) => [f.item, f.reason]));
    assertStringIncludes(byItem.get("vite.config.ts: licensesPlugin()")!, "`transform` hook");
    assertStringIncludes(byItem.get("vite.config.ts: stampPlugin()")!, "(out)");
    const r = await migrateProject(dir, {});
    assertEquals(r.spa?.viteEmitters, []);
    assert(!(await Deno.readTextFile(join(dir, "denext.config.ts"))).includes("viteEmitterPlugin"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Audit 3.4.0: a template literal's `${…}` is code, not string content. An emitter called with
// `\`${dir}/stamp.txt\`` reads a vite.config value, so it is reported, not carried over into a
// denext.config.ts where `dir` does not exist. A template with no expression is still carried.
Deno.test("migrate SPA: a vite.config value read inside a template literal keeps the emitter for review", async () => {
  const STAMP = `export const stampPlugin = (f: string) => ({ name: "stamp", ` +
    `generateBundle() { (this as any).emitFile({ type: "asset", fileName: f, source: "1" }); } });\n`;
  const dir = await viteApp(
    `import { stampPlugin, stampPlugin as plainPlugin, stampPlugin as nestedPlugin } ` +
      `from "./scripts/stamp";\n` +
      'const dir = "meta";\n' +
      "export default { plugins: [stampPlugin(`${dir}/stamp.txt`), plainPlugin(`plain.txt`), " +
      'nestedPlugin(`a${`${"x" + dir}`}b`)] };\n',
    { "scripts/stamp.ts": STAMP },
  );
  try {
    const r = await migrateProject(dir, {});
    assertEquals(r.spa?.viteEmitters?.map((e) => e.call), ["plainPlugin(`plain.txt`)"]);
    const reasons = (r.spa?.viteEmitterReview ?? []).map((f) => f.reason);
    assertEquals(reasons.length, 2, reasons.join("\n"));
    for (const reason of reasons) assertStringIncludes(reason, "(dir)");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
