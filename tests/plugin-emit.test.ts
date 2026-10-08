// The plugin build-step emit seam (`PluginBuildContext.emitFile`, src/plugin/mod.ts): a build
// step publishes a generated file at the site root — Vite's `this.emitFile({ type: "asset" })`.
// Covered: the seam itself (where it writes, the paths it refuses, `clientModules`), and each
// pipeline that runs build steps — the SPA export and build (served by the SPA `denext start`),
// the App Router export and build (served by the App Router `denext start`) — putting the file
// where the site serves it (ahead of a same-named `public/` file).

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  applyPlugins,
  type DenextPlugin,
  listBuiltFiles,
  type PluginBuildContext,
  resetPlugins,
  runPluginBuildSteps,
} from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { staticExport } from "../src/build/export.ts";
import { build } from "../src/build/build.ts";
import { startSpaProdServer } from "../src/build/spa/prod-server.ts";
import { startProdServer } from "../src/build/prod-server.ts";

const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;

/** Register `plugin` the way a pipeline does (setup, under build mode). */
async function register(plugin: DenextPlugin, projectRoot = "/proj"): Promise<void> {
  await applyPlugins({
    projectRoot,
    appDir: join(projectRoot, "app"),
    config: { plugins: [plugin] } as unknown as DenextConfig,
    mode: "build",
    load: () => Promise.resolve({}),
  });
}

Deno.test("emitFile: writes under emitDir (nested dirs created), defaulting to <outDir>/emitted", async () => {
  resetPlugins();
  const tmp = await Deno.makeTempDir({ prefix: "denext_emit_unit_" });
  try {
    const seen: PluginBuildContext[] = [];
    await register({
      name: "emitter",
      setup(ctx) {
        ctx.addBuildStep(async (b) => {
          seen.push(b);
          await b.emitFile({ fileName: "licenses.json", source: '{"ok":true}' });
          await b.emitFile({ fileName: "meta/bytes.bin", source: new Uint8Array([1, 2, 3]) });
        });
      },
    });
    const base = {
      projectRoot: tmp,
      appDir: join(tmp, "app"),
      outDir: join(tmp, ".denext"),
      config: {},
    };
    await runPluginBuildSteps(base);
    assertEquals(
      await Deno.readTextFile(join(tmp, ".denext", "emitted", "licenses.json")),
      '{"ok":true}',
    );
    assertEquals(
      [...await Deno.readFile(join(tmp, ".denext", "emitted", "meta", "bytes.bin"))],
      [1, 2, 3],
    );
    await runPluginBuildSteps(base, { emitDir: join(tmp, "site"), clientModules: ["/a.ts"] });
    assertEquals(await Deno.readTextFile(join(tmp, "site", "licenses.json")), '{"ok":true}');
    assertEquals(seen[0].clientModules, undefined);
    assertEquals(seen[1].clientModules, ["/a.ts"]);
  } finally {
    resetPlugins();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("emitFile: refuses a path that could leave the site root", async () => {
  resetPlugins();
  const tmp = await Deno.makeTempDir({ prefix: "denext_emit_refuse_" });
  try {
    const bad = ["", "/etc/x", "../x", "a/../../x", "a/./b", "a//b", "a\\b", "C:/x", "a/"];
    const results: string[] = [];
    await register({
      name: "bad-emitter",
      setup(ctx) {
        ctx.addBuildStep(async (b) => {
          for (const fileName of bad) {
            await assertRejects(
              () => b.emitFile({ fileName, source: "x" }),
              Error,
              "emitFile refused",
            );
            results.push(fileName);
          }
        });
      },
    });
    await runPluginBuildSteps({ projectRoot: tmp, appDir: tmp, outDir: tmp, config: {} });
    assertEquals(results, bad);
    // Nothing escaped: the only entry in tmp is (at most) an empty `emitted/`.
    for await (const e of Deno.readDir(tmp)) assertEquals(e.name, "emitted");
  } finally {
    resetPlugins();
    await Deno.remove(tmp, { recursive: true });
  }
});

// Audit 3.4.0 N2: a build step may not replace what the build itself publishes — its output
// under `_denext/` (the client, Pages Router and font directories, the OTA manifest, the platform
// stamp, the desktop preload), the `spa.assetsDir` client directory and the HTML shell
// (`index.html`). The rest of `_denext/` is open: `@denext/htmx` publishes its runtime there.
Deno.test("emitFile: refuses the build's own output and the HTML shell, not the rest of _denext/", async () => {
  resetPlugins();
  const tmp = await Deno.makeTempDir({ prefix: "denext_emit_reserved_" });
  try {
    const reserved = [
      "index.html",
      "INDEX.HTML",
      "_denext/client/index.js",
      "_denext/client/x.js",
      "_denext/client",
      "_denext/ota.json",
      "_denext/platform.txt",
      "_denext/desktop-preload.js",
      "_denext/pages/about.js",
      "_denext/fonts/inter.woff2",
      "_DENEXT/client/x.js",
      "_Denext/OTA.json",
      "assets/index-ABCD1234.js",
      "Assets/x.css",
      "assets",
    ];
    const allowed = [
      "sub/index.html",
      "assets-extra/x.js",
      "denext/x.js",
      "licenses.json",
      "_denext/htmx/htmx.min.js",
      "_denext/client-extra/x.js",
      "_denext/ota.json.bak",
    ];
    const refused: string[] = [];
    await register({
      name: "reserved-emitter",
      setup(ctx) {
        ctx.addBuildStep(async (b) => {
          for (const fileName of reserved) {
            await assertRejects(
              () => b.emitFile({ fileName, source: "x" }),
              Error,
              "emitFile refused",
            );
            refused.push(fileName);
          }
          for (const fileName of allowed) await b.emitFile({ fileName, source: "ok" });
        });
      },
    });
    await runPluginBuildSteps({
      projectRoot: tmp,
      appDir: tmp,
      outDir: tmp,
      config: { spa: { entry: "src/main.tsx", assetsDir: "/assets/" } },
    }, { emitDir: join(tmp, "site") });
    assertEquals(refused, reserved);
    for (const fileName of allowed) {
      assertEquals(await Deno.readTextFile(join(tmp, "site", fileName)), "ok");
    }
  } finally {
    resetPlugins();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("emitFile: refuses a file the build already wrote (builtFiles), without case", async () => {
  resetPlugins();
  const tmp = await Deno.makeTempDir({ prefix: "denext_emit_built_" });
  try {
    const site = join(tmp, "site");
    await Deno.mkdir(join(site, "about"), { recursive: true });
    await Deno.writeTextFile(join(site, "about", "index.html"), "page");
    await Deno.writeTextFile(join(site, "Robots.txt"), "build");
    const builtFiles = await listBuiltFiles(site);
    assertEquals([...builtFiles].sort(), ["about/index.html", "robots.txt"]);
    assertEquals((await listBuiltFiles(join(tmp, "missing"))).size, 0);
    const refused: string[] = [];
    await register({
      name: "overwriter",
      setup(ctx) {
        ctx.addBuildStep(async (b) => {
          for (const fileName of ["about/index.html", "ABOUT/Index.html", "robots.txt"]) {
            await assertRejects(
              () => b.emitFile({ fileName, source: "plugin" }),
              Error,
              "the build already wrote that file",
            );
            refused.push(fileName);
          }
          await b.emitFile({ fileName: "about/extra.txt", source: "plugin" });
        });
      },
    });
    await runPluginBuildSteps(
      { projectRoot: tmp, appDir: tmp, outDir: tmp, config: {} },
      { emitDir: site, builtFiles },
    );
    assertEquals(refused.length, 3);
    assertEquals(await Deno.readTextFile(join(site, "about", "index.html")), "page");
    assertEquals(await Deno.readTextFile(join(site, "about", "extra.txt")), "plugin");
  } finally {
    resetPlugins();
    await Deno.remove(tmp, { recursive: true });
  }
});

/** The `denext.config.ts` plugin every pipeline test below declares. */
const EMITTER_PLUGIN = `{
  name: "test-emitter",
  setup(ctx) {
    ctx.addBuildStep(async (b) => {
      await b.emitFile({
        fileName: "third-party-licenses.json",
        source: JSON.stringify({ modules: b.clientModules?.length ?? null }),
      });
      await b.emitFile({ fileName: "robots.txt", source: "emitted" });
    });
  },
}`;

/** A throwaway project: `deno.json`, a `public/robots.txt`, and `extra` files. */
async function project(
  prefix: string,
  config: string,
  extra: Record<string, string>,
  jsx: "denext" | "react" = "denext",
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: jsx },
      imports: {
        "denext": abs("mod.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/server": abs("src/server/mod.ts"),
        "denext/client": abs("src/client/mod.ts"),
        "react": abs("src/compat/react.ts"),
        "react/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
      },
    }),
  );
  await Deno.writeTextFile(join(dir, "denext.config.ts"), config);
  await Deno.mkdir(join(dir, "public"));
  await Deno.writeTextFile(join(dir, "public", "robots.txt"), "public");
  for (const [rel, text] of Object.entries(extra)) {
    await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), text);
  }
  return dir;
}

/** A SPA project with the emitter plugin (esbuild path when `compat`). */
function spaProject(compat: boolean): Promise<string> {
  return project(
    "denext_emit_spa_",
    `export default { mode: "spa"${compat ? ", compatibilityMode: true" : ""}, ` +
      `plugins: [${EMITTER_PLUGIN}], spa: { entry: "./src/main.ts" } };\n`,
    { "src/main.ts": `console.log("spa");\n` },
    compat ? "react" : "denext",
  );
}

/** Fetch `path` from a server listening on an ephemeral port, then shut it down. */
async function fetchFrom(
  start: (signal: AbortSignal, onListen: (i: { port: number }) => void) => Promise<Deno.HttpServer>,
  paths: string[],
): Promise<string[]> {
  const ac = new AbortController();
  let port = 0;
  const server = await start(ac.signal, (i) => port = i.port);
  try {
    const out: string[] = [];
    for (const p of paths) out.push(await (await fetch(`http://127.0.0.1:${port}${p}`)).text());
    return out;
  } finally {
    ac.abort();
    await server.finished;
  }
}

for (const compat of [false, true]) {
  Deno.test({
    name: `emitFile, SPA ${compat ? "esbuild" : "native"} path: export root + build/start serve it`,
    sanitizeResources: false,
    sanitizeOps: false,
  }, async () => {
    resetPlugins();
    const dir = await spaProject(compat);
    try {
      await staticExport(dir);
      const licenses = JSON.parse(
        await Deno.readTextFile(join(dir, "out", "third-party-licenses.json")),
      );
      // The esbuild path knows the bundle's modules; the native `deno bundle` path does not.
      if (compat) assert(licenses.modules > 0, `clientModules: ${licenses.modules}`);
      else assertEquals(licenses.modules, null);
      // Emitted after public/: the emitted file wins a name clash.
      assertEquals(await Deno.readTextFile(join(dir, "out", "robots.txt")), "emitted");

      resetPlugins();
      await build(dir);
      assert(
        (await Deno.stat(join(dir, ".denext", "emitted", "third-party-licenses.json"))).isFile,
      );
      const [served, robots] = await fetchFrom(
        (signal, onListen) =>
          startSpaProdServer({ projectDir: dir, port: 0, hostname: "127.0.0.1", signal, onListen }),
        ["/third-party-licenses.json", "/robots.txt"],
      );
      assertEquals(JSON.parse(served), licenses);
      // As in the export, the emitted file wins the name clash with `public/`.
      assertEquals(robots, "emitted");
    } finally {
      resetPlugins();
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test({
  name: "emitFile, App Router: export root + build/start serve it (ahead of public/)",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  resetPlugins();
  const dir = await project(
    "denext_emit_app_",
    `export default { plugins: [${EMITTER_PLUGIN}] };\n`,
    { "app/page.tsx": `export default function Page() { return <h1>home</h1>; }\n` },
  );
  try {
    await staticExport(dir);
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(dir, "out", "third-party-licenses.json"))),
      { modules: null },
    );
    assertEquals(await Deno.readTextFile(join(dir, "out", "robots.txt")), "emitted");

    resetPlugins();
    await build(dir);
    const [served, robots] = await fetchFrom(
      (signal, onListen) =>
        startProdServer({ projectDir: dir, port: 0, hostname: "127.0.0.1", signal, onListen }),
      ["/third-party-licenses.json", "/robots.txt"],
    );
    assertEquals(JSON.parse(served), { modules: null });
    assertEquals(robots, "emitted");
  } finally {
    resetPlugins();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "emitFile, App Router export: a build step cannot overwrite a page the export rendered",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  resetPlugins();
  const overwriter = `{
  name: "overwriter",
  setup(ctx) {
    ctx.addBuildStep(async (b) => {
      try {
        await b.emitFile({ fileName: "about/index.html", source: "plugin" });
      } catch (err) {
        await b.emitFile({ fileName: "refused.txt", source: String(err) });
      }
    });
  },
}`;
  const dir = await project(
    "denext_emit_overwrite_",
    `export default { plugins: [${overwriter}] };\n`,
    {
      "app/page.tsx": `export default function Page() { return <h1>home</h1>; }\n`,
      "app/about/page.tsx": `export default function About() { return <h1>about page</h1>; }\n`,
    },
  );
  try {
    await staticExport(dir);
    const page = await Deno.readTextFile(join(dir, "out", "about", "index.html"));
    assert(page.includes("about page"), "the rendered page survives");
    assert(
      (await Deno.readTextFile(join(dir, "out", "refused.txt"))).includes(
        "the build already wrote that file",
      ),
    );
  } finally {
    resetPlugins();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("viteEmitterPlugin: a Vite generateBundle emitter publishes through emitFile", async () => {
  resetPlugins();
  const tmp = await Deno.makeTempDir({ prefix: "denext_vite_emitter_" });
  try {
    // The shape of T3 Code's `thirdPartyLicensesPlugin`: reads the bundled module ids from
    // `bundle`, emits one asset. Its dev-only `configureServer` is ignored.
    const licenses = {
      name: "licenses",
      configureServer() {
        throw new Error("never called at build");
      },
      generateBundle(
        this: { emitFile(f: { type: string; fileName: string; source: string }): string },
        _options: unknown,
        bundle: Record<string, { type: string; modules: Record<string, unknown> }>,
      ) {
        const ids = Object.values(bundle).flatMap((o) =>
          o.type === "chunk" ? Object.keys(o.modules) : []
        );
        const ref = this.emitFile({
          type: "asset",
          fileName: "third-party-licenses.json",
          source: JSON.stringify(ids),
        });
        assertEquals(ref, "third-party-licenses.json");
      },
    };
    const serveOnly = {
      name: "serve-only",
      apply: "serve",
      generateBundle() {
        throw new Error("a serve plugin never runs at build");
      },
    };
    const objectHook = {
      name: "object-hook",
      apply: (_c: unknown, env: { command: string }) => env.command === "build",
      generateBundle: {
        handler(this: { emitFile(f: unknown): string }) {
          this.emitFile({
            type: "asset",
            fileName: "nested/stamp.txt",
            source: new TextEncoder().encode("v1"),
          });
        },
      },
    };
    const { viteEmitterPlugin } = await import("../src/plugin/kit.ts");
    for (const p of [licenses, serveOnly, objectHook]) {
      await register(viteEmitterPlugin(p as Parameters<typeof viteEmitterPlugin>[0]), tmp);
    }
    await runPluginBuildSteps(
      { projectRoot: tmp, appDir: tmp, outDir: tmp, config: {} },
      {
        emitDir: join(tmp, "site"),
        clientModules: ["/app/src/main.tsx", "/app/node_modules/x/index.js"],
      },
    );
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(tmp, "site", "third-party-licenses.json"))),
      ["/app/src/main.tsx", "/app/node_modules/x/index.js"],
    );
    assertEquals(await Deno.readTextFile(join(tmp, "site", "nested", "stamp.txt")), "v1");
  } finally {
    resetPlugins();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("viteEmitterPlugin: a chunk emit or a nameless asset fails the build with a clear error", async () => {
  const { viteEmitterPlugin } = await import("../src/plugin/kit.ts");
  for (
    const [file, message] of [
      [{ type: "chunk", id: "./x.ts" }, 'emitted a "chunk"'],
      [{ type: "asset", name: "logo.png", source: "x" }, "without a fileName"],
    ] as const
  ) {
    resetPlugins();
    await register(viteEmitterPlugin({
      name: "bad",
      generateBundle() {
        (this as unknown as { emitFile(f: unknown): string }).emitFile(file);
      },
    }));
    await assertRejects(
      () =>
        runPluginBuildSteps({ projectRoot: "/p", appDir: "/p/app", outDir: "/p/.d", config: {} }),
      Error,
      message,
    );
  }
  resetPlugins();
});

Deno.test("viteEmitterPlugin: the synthetic entry chunk sits where the client is (spa.assetsDir)", async () => {
  const { viteEmitterPlugin } = await import("../src/plugin/kit.ts");
  for (
    const [spa, expected] of [
      [undefined, "_denext/client/index.js"],
      [{ entry: "./src/main.tsx", assetsDir: "assets" }, "assets/index.js"],
      [{ entry: "./src/main.tsx", assetsDir: "static/js" }, "static/js/index.js"],
    ] as const
  ) {
    resetPlugins();
    let seen: string[] = [];
    await register(viteEmitterPlugin({
      name: "entry-name",
      generateBundle(_o: unknown, bundle: unknown) {
        seen = Object.keys(bundle as Record<string, unknown>);
      },
    }));
    await runPluginBuildSteps({
      projectRoot: "/p",
      appDir: "/p/app",
      outDir: "/p/.d",
      config: (spa ? { mode: "spa", spa } : {}) as DenextConfig,
    });
    assertEquals(seen, [expected]);
  }
  resetPlugins();
});
