// Crash reporting: `denext mobile add sentry` (its packages and privacy rows), the
// `initCrashReporting` helper in denext/mobile (release = the OTA UI version), and hidden source
// maps on `denext export --sourcemaps hidden` (DENEXT_SOURCEMAPS=hidden): maps are built, moved
// out of the export into .denext/sourcemaps beside a copy of their JS, and never referenced by
// what ships.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { walk } from "@std/fs";
import { join, relative } from "@std/path";
import { planMobileCapabilities } from "../src/build/mobile-capabilities.ts";
import {
  hiddenSourceMapsEnabled,
  SOURCEMAPS_ENV,
  stashHiddenSourceMaps,
} from "../src/build/hidden-sourcemaps.ts";
import { writeBundleOutput } from "../src/build/bundle.ts";
import { staticExport } from "../src/build/export.ts";
import {
  initCrashReporting,
  resetCrashReportingForTesting,
} from "../src/mobile/crash-reporting.ts";

const VERSION = "a".repeat(64);
/** A manifest `isOtaManifest` accepts. */
const MANIFEST = {
  version: VERSION,
  files: [{ path: "index.html", sha256: "b".repeat(64), size: 1 }],
};

async function write(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), content);
  }
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of walk(dir, { includeDirs: false })) {
    out.push(relative(dir, e.path).replaceAll("\\", "/"));
  }
  return out.sort();
}

/** Run `fn` with DENEXT_SOURCEMAPS set to `value` (restored after). */
async function withEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = Deno.env.get(SOURCEMAPS_ENV);
  if (value === undefined) Deno.env.delete(SOURCEMAPS_ENV);
  else Deno.env.set(SOURCEMAPS_ENV, value);
  try {
    return await fn();
  } finally {
    if (prior === undefined) Deno.env.delete(SOURCEMAPS_ENV);
    else Deno.env.set(SOURCEMAPS_ENV, prior);
  }
}

Deno.test("mobile add sentry: @sentry/capacitor with its exact sibling SDK, and diagnostics rows", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_sentry_" });
  try {
    await write(dir, {
      "capacitor.config.json": JSON.stringify({ appId: "dev.example", webDir: "out" }),
      "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
      "node_modules/@capacitor/core/package.json": JSON.stringify({ version: "8.5.2" }),
      ".git/HEAD": "ref: refs/heads/main\n",
    });
    const plan = await planMobileCapabilities({ capabilities: ["sentry"], cwd: dir });
    assertEquals(plan.install?.args, [
      "install",
      "--ignore-scripts",
      "@sentry/capacitor@4.4.0",
      "@sentry/browser@10.69.0",
    ]);
    assertEquals(plan.privacy, [
      "collected CrashData",
      "collected PerformanceData",
      "collected OtherDiagnosticData",
    ]);
    assert(plan.manual.some((m) => m.includes("--sourcemaps hidden")));
    assert(plan.manual.some((m) => m.includes("Swift Package Manager")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Stub `location` and `fetch` so `_denext/ota.json` answers with `body`. */
async function withPage<T>(body: unknown, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const priorFetch = globalThis.fetch;
  const hadLocation = "location" in g;
  const priorLocation = g.location;
  const fetched: string[] = [];
  Object.defineProperty(g, "location", {
    value: { href: "capacitor://localhost/index.html" },
    configurable: true,
    writable: true,
  });
  globalThis.fetch = ((url: URL) => {
    fetched.push(String(url));
    return Promise.resolve(Response.json(body));
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = priorFetch;
    if (hadLocation) g.location = priorLocation;
    else delete g.location;
    resetCrashReportingForTesting();
  }
}

// First: the page version, once read, is kept for the page's lifetime (as otaBooted() keeps it).
Deno.test("initCrashReporting: an explicit release and dist win; no manifest means no release", async () => {
  await withPage({ not: "a manifest" }, async () => {
    const seen: Record<string, unknown>[] = [];
    const sdk = () => Promise.resolve({ init: (o: Record<string, unknown>) => void seen.push(o) });
    const sibling = () => Promise.resolve({ init: () => {} });
    assertEquals(await initCrashReporting({ dsn: "d", sdk, sibling }), { release: undefined });
    assertEquals(seen[0], { dsn: "d" });
    resetCrashReportingForTesting();
    await initCrashReporting({ dsn: "d", sdk, sibling, release: "app@1.2.3", dist: "42" });
    assertEquals(seen[1], { dsn: "d", release: "app@1.2.3", dist: "42" });
  });
});

Deno.test("initCrashReporting: the OTA UI version is the release; sibling init is passed; once only", async () => {
  await withPage(MANIFEST, async () => {
    const calls: Array<{ options: Record<string, unknown>; sibling: unknown }> = [];
    const siblingInit = () => {};
    let loads = 0;
    const opts = {
      dsn: "https://public@o0.ingest.sentry.io/0",
      sdk: () => {
        loads++;
        return Promise.resolve({
          init: (options: Record<string, unknown>, sibling?: unknown) =>
            calls.push({ options, sibling }),
        });
      },
      sibling: () => Promise.resolve({ init: siblingInit }),
      environment: "production",
      options: { tracesSampleRate: 0.1, dsn: "overridden" },
    };
    const first = await initCrashReporting(opts);
    assertEquals(first, { release: VERSION });
    assertEquals(calls, [{
      options: {
        tracesSampleRate: 0.1,
        dsn: "https://public@o0.ingest.sentry.io/0",
        release: VERSION,
        environment: "production",
      },
      sibling: siblingInit,
    }]);
    assertEquals(await initCrashReporting(opts), first);
    assertEquals(loads, 1);
  });
});

Deno.test("initCrashReporting: a failed SDK load rejects, and the next call tries again", async () => {
  await withPage(MANIFEST, async () => {
    const sibling = () => Promise.resolve({ init: () => {} });
    await assertRejects(
      () =>
        initCrashReporting({ dsn: "d", sdk: () => Promise.reject(new Error("offline")), sibling }),
      Error,
      "offline",
    );
    const ok = await initCrashReporting({
      dsn: "d",
      sdk: () => Promise.resolve({ init: () => {} }),
      sibling,
    });
    assertEquals(ok.release, VERSION);
  });
});

Deno.test("hiddenSourceMapsEnabled follows DENEXT_SOURCEMAPS=hidden only", async () => {
  await withEnv("hidden", () => Promise.resolve(assert(hiddenSourceMapsEnabled())));
  await withEnv("inline", () => Promise.resolve(assert(!hiddenSourceMapsEnabled())));
  await withEnv(undefined, () => Promise.resolve(assert(!hiddenSourceMapsEnabled())));
});

Deno.test("stashHiddenSourceMaps moves maps out beside a copy of their JS; drops links and .map.gz", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext_stash_" });
  const web = join(root, "out");
  const stash = join(root, ".denext", "sourcemaps");
  try {
    await write(root, {
      "out/index.html": "<!doctype html>",
      "out/_denext/client/index.js": "console.log(1);\n",
      "out/_denext/client/index.js.map": '{"version":3}',
      "out/_denext/client/index.js.map.gz": "gz",
      "out/_denext/client/chunk-A.js": "x();\n//# sourceMappingURL=chunk-A.js.map\n",
      "out/_denext/client/chunk-A.js.gz": "gz",
      "out/_denext/client/chunk-A.js.map": '{"version":3}',
      ".denext/sourcemaps/stale.js.map": "{}",
    });
    assertEquals(await stashHiddenSourceMaps(web, stash), 2);
    assertEquals(await filesUnder(web), [
      "_denext/client/chunk-A.js",
      "_denext/client/index.js",
      "index.html",
    ]);
    assertEquals(await filesUnder(stash), [
      "_denext/client/chunk-A.js",
      "_denext/client/chunk-A.js.map",
      "_denext/client/index.js",
      "_denext/client/index.js.map",
    ]);
    assertEquals(await Deno.readTextFile(join(web, "_denext/client/chunk-A.js")), "x();\n");
    assertEquals(await Deno.readTextFile(join(stash, "_denext/client/chunk-A.js")), "x();\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("writeBundleOutput writes hidden maps, renaming the entry's with the entry", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeBundleOutput(dir, {
      entry: "entry.js",
      files: new Map([["entry.js", "a"], ["chunk-X.js", "b"]]),
      maps: new Map([
        ["entry.js.map", JSON.stringify({ version: 3, file: "entry.js" })],
        ["chunk-X.js.map", JSON.stringify({ version: 3, file: "chunk-X.js" })],
      ]),
    }, "index.js");
    assertEquals(await filesUnder(dir), [
      "chunk-X.js",
      "chunk-X.js.map",
      "index.js",
      "index.js.map",
    ]);
    assertEquals(JSON.parse(await Deno.readTextFile(join(dir, "index.js.map"))).file, "index.js");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;

Deno.test({
  name: "denext export with hidden source maps: SPA export ships none, .denext/sourcemaps has them",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_hidden_maps_" });
    try {
      await write(dir, {
        "deno.json": JSON.stringify({
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
          imports: {
            "denext": abs("mod.ts"),
            "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
            "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
            "denext/server": abs("src/server/mod.ts"),
            "denext/client": abs("src/client/mod.ts"),
          },
        }),
        "denext.config.ts":
          `export default { mode: "spa", spa: { entry: "./src/main.ts", ota: true, precompress: false } };\n`,
        "src/main.ts": `const { msg } = await import("./lazy.ts");\nconsole.log(msg);\n`,
        "src/lazy.ts": `export const msg = "lazy";\n`,
      });
      const { outDir } = await withEnv("hidden", () => staticExport(dir));
      const shipped = await filesUnder(outDir);
      assertEquals(shipped.filter((f) => f.endsWith(".map")), []);
      for (const f of shipped.filter((f) => f.endsWith(".js"))) {
        assert(!(await Deno.readTextFile(join(outDir, f))).includes("sourceMappingURL"), f);
      }
      const manifest = JSON.parse(await Deno.readTextFile(join(outDir, "_denext/ota.json")));
      assert(manifest.files.every((f: { path: string }) => !f.path.endsWith(".map")));
      const stash = join(dir, ".denext", "sourcemaps");
      const maps = (await filesUnder(stash)).filter((f) => f.endsWith(".map"));
      assert(maps.includes("_denext/client/index.js.map"), maps.join());
      for (const map of maps) {
        const js = map.slice(0, -".map".length);
        assertEquals(
          await Deno.readTextFile(join(stash, js)),
          await Deno.readTextFile(join(outDir, js)),
          js,
        );
      }
      const entryMap = JSON.parse(
        await Deno.readTextFile(join(stash, "_denext/client/index.js.map")),
      );
      assertEquals(entryMap.file, "index.js");
      assert(entryMap.sources.some((s: string) => s.includes("main.ts")), entryMap.sources.join());
      // Without the switch, no maps anywhere.
      await Deno.remove(stash, { recursive: true });
      const plain = await withEnv(undefined, () => staticExport(dir));
      assertEquals((await filesUnder(plain.outDir)).filter((f) => f.endsWith(".map")), []);
      assertEquals(await Deno.stat(stash).then(() => true, () => false), false);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "hidden source maps on the esbuild (compat) SPA path too",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_hidden_maps_compat_" });
    try {
      await write(dir, {
        "deno.json": JSON.stringify({
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
          imports: {
            "denext": abs("mod.ts"),
            "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
            "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
            "denext/server": abs("src/server/mod.ts"),
            "denext/client": abs("src/client/mod.ts"),
          },
        }),
        "denext.config.ts":
          `export default { mode: "spa", compatibilityMode: true, spa: { entry: "./src/main.ts", ota: true, precompress: false } };\n`,
        "src/main.ts": `const { msg } = await import("./lazy.ts");\nconsole.log(msg);\n`,
        "src/lazy.ts": `export const msg = "lazy";\n`,
      });
      const { outDir } = await withEnv("hidden", () => staticExport(dir));
      const shipped = await filesUnder(outDir);
      assertEquals(shipped.filter((f) => f.endsWith(".map")), []);
      for (const f of shipped.filter((f) => f.endsWith(".js"))) {
        assert(!(await Deno.readTextFile(join(outDir, f))).includes("sourceMappingURL"), f);
      }
      const manifest = JSON.parse(await Deno.readTextFile(join(outDir, "_denext/ota.json")));
      assert(manifest.files.every((f: { path: string }) => !f.path.endsWith(".map")));
      const stash = join(dir, ".denext", "sourcemaps");
      const maps = (await filesUnder(stash)).filter((f) => f.endsWith(".map"));
      assert(maps.includes("_denext/client/index.js.map"), maps.join());
      for (const map of maps) {
        const js = map.slice(0, -".map".length);
        assertEquals(
          await Deno.readTextFile(join(stash, js)),
          await Deno.readTextFile(join(outDir, js)),
          js,
        );
      }
      const entryMap = JSON.parse(
        await Deno.readTextFile(join(stash, "_denext/client/index.js.map")),
      );
      assert(entryMap.sources.some((s: string) => s.includes("main.ts")), entryMap.sources.join());
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
