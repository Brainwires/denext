// `viteBuildPlugin` (denext/plugin-kit/vite-emitter): a Fresh 2 app's other Vite plugins, run at
// build in Rollup's hook order — `configResolved`, `buildStart`, `generateBundle`, `writeBundle`,
// `closeBundle` — with `this.emitFile` publishing assets; `apply: "serve"` plugins skipped,
// `enforce` ordering kept, and the hooks denext's esbuild build has no place for named in a
// warning. `denext migrate` moves such plugins to `vite.plugins.ts`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { flattenVitePlugins, viteBuildPlugin } from "../src/plugin/vite-emitter.ts";
import { migrateProject } from "../src/build/migrate.ts";

/** Run a plugin's build step against a stand-in build context; what it emitted, by file name. */
async function runBuild(plugin: ReturnType<typeof viteBuildPlugin>) {
  const steps: ((b: never) => Promise<void> | void)[] = [];
  plugin.setup({ addBuildStep: (step) => void steps.push(step as never) });
  const emitted: Record<string, string> = {};
  const build = {
    outDir: "/out",
    config: {},
    clientModules: ["/app/a.ts"],
    emitFile: (a: { fileName?: string; name?: string; source: string | Uint8Array }) => {
      emitted[a.fileName ?? a.name!] = String(a.source);
      return Promise.resolve(a.fileName ?? a.name);
    },
  };
  for (const step of steps) await step(build as never);
  return emitted;
}

Deno.test("viteBuildPlugin: build hooks in Rollup's order, enforce respected, serve-only skipped", async () => {
  const log: string[] = [];
  const hooks = (name: string) => ({
    name,
    configResolved(c: { command: string; isProduction: boolean }) {
      log.push(`${name}:configResolved:${c.command}:${c.isProduction}`);
    },
    buildStart() {
      log.push(`${name}:buildStart`);
    },
    generateBundle: {
      handler(
        this: { emitFile(f: unknown): string },
        _o: unknown,
        bundle: Record<string, { moduleIds: string[] }>,
      ) {
        log.push(`${name}:generateBundle:${Object.values(bundle)[0].moduleIds.join()}`);
        this.emitFile({ type: "asset", fileName: `${name}.txt`, source: name });
      },
    },
    writeBundle() {
      log.push(`${name}:writeBundle`);
    },
    closeBundle() {
      log.push(`${name}:closeBundle`);
    },
  });
  const warns: unknown[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  try {
    const emitted = await runBuild(viteBuildPlugin(() => [
      hooks("normal"),
      Promise.resolve({ ...hooks("post"), enforce: "post" }),
      [{ ...hooks("pre"), enforce: "pre", transform() {} }],
      { name: "dev-only", apply: "serve", buildStart: () => log.push("never") },
      false,
    ]));
    assertEquals(emitted, { "pre.txt": "pre", "normal.txt": "normal", "post.txt": "post" });
  } finally {
    console.warn = warn;
  }
  assertEquals(log, [
    "pre:configResolved:build:true",
    "normal:configResolved:build:true",
    "post:configResolved:build:true",
    "pre:buildStart",
    "normal:buildStart",
    "post:buildStart",
    "pre:generateBundle:/app/a.ts",
    "normal:generateBundle:/app/a.ts",
    "post:generateBundle:/app/a.ts",
    "pre:writeBundle",
    "normal:writeBundle",
    "post:writeBundle",
    "pre:closeBundle",
    "normal:closeBundle",
    "post:closeBundle",
  ]);
  assertEquals(warns.length, 1);
  assertStringIncludes(String(warns[0]), "Vite plugin pre: transform not run");
});

Deno.test("viteBuildPlugin: a module or config input, and a loader that fails is skipped with a warning", async () => {
  assertEquals(
    (await flattenVitePlugins({ default: { plugins: [[{ name: "a" }], null] } })).map((p) =>
      p.name
    ),
    [
      "a",
    ],
  );
  const warns: unknown[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a[0]);
  try {
    const emitted = await runBuild(viteBuildPlugin(() => Promise.reject(new Error("no vite"))));
    assertEquals(emitted, {});
  } finally {
    console.warn = warn;
  }
  assertStringIncludes(String(warns[0]), "could not be loaded");
});

const REPO = fromFileUrl(new URL("..", import.meta.url));

Deno.test("migrate: a Fresh 2 app's other Vite plugins move to vite.plugins.ts and run through viteBuildPlugin", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_vite_plugins_" }));
  try {
    const files: Record<string, string> = {
      "deno.json": JSON.stringify({
        imports: {
          fresh: "jsr:@fresh/core@^2.3.3",
          vite: "npm:vite@^7.1.3",
          "rollup-plugin-visualizer": "npm:rollup-plugin-visualizer@^5.12.0",
        },
      }),
      "vite.config.ts": `import { defineConfig } from "vite";
import { fresh } from "@fresh/plugin-vite";
import { visualizer } from "rollup-plugin-visualizer";
const filename = "stats.html";
export default defineConfig({ plugins: [fresh(), visualizer({ filename })] });
`,
      "routes/index.tsx": "export default function Home() { return <p>home</p>; }\n",
    };
    for (const [rel, body] of Object.entries(files)) {
      await Deno.mkdir(dirname(join(dir, rel)), { recursive: true });
      await Deno.writeTextFile(join(dir, rel), body);
    }
    const r = await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
    const mod = await Deno.readTextFile(join(dir, "vite.plugins.ts"));
    assertStringIncludes(mod, `import { visualizer } from "rollup-plugin-visualizer";`);
    assertStringIncludes(mod, "visualizer({ filename })");
    assert(!mod.includes("fresh") || !/import[^\n]*@fresh/.test(mod), mod);
    assert(!/from "vite"/.test(mod));
    const config = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assertStringIncludes(
      config,
      `import { viteBuildPlugin } from "denext/plugin-kit/vite-emitter";`,
    );
    assertStringIncludes(config, `plugins: [viteBuildPlugin(() => import("./vite.plugins.ts"))],`);
    const deno = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assertEquals(deno.imports["rollup-plugin-visualizer"], "npm:rollup-plugin-visualizer@^5.12.0");
    assert(deno.imports["denext/plugin-kit/vite-emitter"]);
    assertEquals(r.fresh!.wontMigrate.filter((w) => w.item.startsWith("vite.config")), []);
    assert(r.fresh!.review.some((w) => w.item === "vite.config.ts: visualizer()"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
