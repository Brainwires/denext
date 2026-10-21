// `denext build --compile` embeds the module graph of what the binary runs: src/standalone/mod.ts
// plus the app (whose plugins import the plugin kit). That graph must reach the production server
// only — not the CLI's build pipeline, whose npm tooling (prettier, babel, sass, zod, the TanStack
// router plugin, `@mdx-js/mdx`, …) and wasm (swc, lightningcss) once made a hello app's binary
// 214 MB. These checks walk the graph `deno compile` walks (`deno info --json`, code imports only)
// and fail when a build module comes back. tests/integration/compile-app.test.ts checks a real
// binary's embedded files.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { BUILD_ONLY_MODULES, buildOnlyStubs } from "../src/build/compile-app.ts";
import * as stub from "../src/build/build-only-stub.ts";
import { requireStartupCompile, resolveFlightBoundary } from "../src/build/prod-server/manifest.ts";
import { prodLoader } from "../src/build/prod-server/app.ts";
import { startAppProdServer } from "../src/build/prod-server/start.ts";
import { resolveProject } from "../src/build/paths.ts";
import type { BuildInfo } from "../src/build/prod-server/manifest.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { removeTempDir } from "./helpers/temp.ts";

const FW = new URL("../", import.meta.url);

/**
 * The most local source (and wasm) the standalone entry may reach, in bytes: about 9.7 MB, of
 * which 4.4 MB is the image packages' wasm (`ImageResponse`'s og, the optimizer's photon). Before
 * the split it reached 34 MB, and 47 MB of npm build tooling besides.
 */
const STANDALONE_SOURCE_CEILING = 11_000_000;

/** Framework modules that are build tooling: none may be in a compiled app's graph. */
const BUILD_MODULES = [
  /\/src\/build\/bundle\.ts$/,
  /\/src\/build\/css\.ts$/,
  /\/src\/build\/next-compat\.ts$/,
  /\/src\/build\/next-compat-build\.ts$/,
  /\/src\/build\/spa\.ts$/,
  /\/src\/build\/module-graph\.ts$/,
  /\/src\/build\/use-cache-loader\.ts$/,
  /\/src\/build\/swc-ast\.ts$/,
  /\/src\/build\/esbuild\//,
  /\/src\/build\/react-native\.ts$/,
  /\/packages\/(swc|lightningcss)\//,
];

interface InfoModule {
  specifier: string;
  size?: number;
  dependencies?: { code?: { specifier?: string } }[];
}

/** `deno info --json` of `root`. */
interface DenoInfo {
  roots: string[];
  modules: InfoModule[];
  redirects?: Record<string, string>;
}

/** Run `deno info --json` on `root` (with `config`, when given). */
async function denoInfo(root: string, config?: string): Promise<DenoInfo> {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", ...(config ? ["--config", config] : []), root],
    cwd: fromFileUrl(FW),
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
  return JSON.parse(new TextDecoder().decode(stdout));
}

/** Add to `reached` every module `info`'s roots reach through code imports. */
function walkCode(info: DenoInfo, reached: Map<string, InfoModule>): void {
  const bySpec = new Map(info.modules.map((m) => [m.specifier, m]));
  const resolve = (s: string) => info.redirects?.[s] ?? s;
  const queue = info.roots.map(resolve);
  while (queue.length > 0) {
    const spec = queue.shift()!;
    if (reached.has(spec)) continue;
    const mod = bySpec.get(spec) ?? { specifier: spec };
    reached.set(spec, mod);
    const deps = (mod.dependencies ?? []).map((d) => d.code?.specifier).filter((s) => s);
    queue.push(...deps.map((s) => resolve(s!)));
  }
}

/** The modules `deno compile` would embed for `roots`: code imports only, as it walks them. */
async function codeGraph(roots: string[], config?: string): Promise<InfoModule[]> {
  const reached = new Map<string, InfoModule>();
  for (const root of roots) walkCode(await denoInfo(root, config), reached);
  return [...reached.values()];
}

/** The build modules and npm packages among `mods`. */
function buildOnly(mods: InfoModule[]): string[] {
  return mods.map((m) => m.specifier).filter((s) =>
    s.startsWith("npm:") || BUILD_MODULES.some((re) => re.test(s))
  );
}

Deno.test("a compiled app's entry reaches the production server, not the build pipeline", async () => {
  const mods = await codeGraph([new URL("src/standalone/mod.ts", FW).href]);
  assertEquals(buildOnly(mods), []);
  const local = mods.filter((m) => m.specifier.startsWith("file:"));
  const bytes = local.reduce((n, m) => n + (m.size ?? 0), 0);
  assert(
    bytes < STANDALONE_SOURCE_CEILING,
    `the standalone entry reaches ${bytes} bytes of source in ${local.length} modules`,
  );
});

Deno.test("with the compile's stubs, the plugin kit reaches no build tooling", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_compile_slim_" });
  try {
    const config = join(dir, "deno.json");
    // The framework's import map with its local targets made absolute, plus the stubs.
    const fwConfig = JSON.parse(await Deno.readTextFile(new URL("deno.json", FW))) as {
      imports: Record<string, string>;
    };
    const imports = Object.fromEntries(
      Object.entries(fwConfig.imports).map((
        [k, v],
      ) => [k, v.startsWith(".") ? new URL(v, FW).href : v]),
    );
    await Deno.writeTextFile(
      config,
      JSON.stringify({ imports: { ...imports, ...buildOnlyStubs() } }),
    );
    const roots = ["src/plugin/kit.ts", ...BUILD_ONLY_MODULES].map((p) => new URL(p, FW).href);
    assertEquals(buildOnly(await codeGraph(roots, config)), []);
    // Without them, it does: the stubs are what keep it out.
    assert(buildOnly(await codeGraph([new URL("src/plugin/kit.ts", FW).href])).length > 0);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("buildOnlyStubs maps every build-only module to the stub, by the framework's URLs", () => {
  const stubs = buildOnlyStubs();
  const target = new URL("src/build/build-only-stub.ts", FW).href;
  assertEquals(
    Object.keys(stubs).sort(),
    BUILD_ONLY_MODULES.map((m) => new URL(m, FW).href).sort(),
  );
  for (const value of Object.values(stubs)) assertEquals(value, target);
});

Deno.test("the stub has every run-time export of each module it stands in for", async () => {
  const names = new Set(Object.keys(stub));
  for (const path of BUILD_ONLY_MODULES) {
    const real = await import(new URL(path, FW).href);
    for (const name of Object.keys(real)) assert(names.has(name), `${path}: ${name} missing`);
  }
});

Deno.test("the stub's build functions refuse with the reason; the run-time ones are real", async () => {
  const err = assertThrows(() => stub.bundleRoutes([]));
  assertStringIncludes(String(err), "bundleRoutes is denext build tooling");
  assertStringIncludes(String(err), "denext build --compile");
  assertThrows(() => stub.analyzeModule("x"), Error, "remixCodegen.analyzeModule");
  const codegen = await import("../src/build/remix-codegen.ts");
  assertEquals(stub.SERVER_EXPORTS, codegen.SERVER_EXPORTS);
  assertEquals(stub.GEN_HEADER, codegen.GEN_HEADER);
  const loader = await import("../src/build/next-compat-loader.ts");
  assertEquals(stub.createNextCompatServerLoader, loader.createNextCompatServerLoader);
  const scan = await import("../src/build/server-only-scan.ts");
  assertEquals(stub.findServerOnlyLeaks, scan.findServerOnlyLeaks);
});

/** A project with `app/page.tsx` (a page) and no build. */
async function project(): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_compile_slim_" }));
  await Deno.mkdir(join(dir, "app"));
  await Deno.writeTextFile(join(dir, "app", "page.tsx"), "export default () => null;\n");
  return dir;
}

const NO_BUILD: BuildInfo = {
  staticRoutes: new Set(),
  nextCompat: false,
  compatModuleMap: new Map(),
  publicEnvKeys: undefined,
};

Deno.test("requireStartupCompile: a server without one refuses a build that lacks the record", () => {
  const compile = {
    boundaryRoutes: () => Promise.resolve(new Set<string>()),
    boundaryManifest: () => Promise.resolve({ client: new Map(), server: new Map() }),
    loader: () => Promise.resolve(() => Promise.resolve({})),
  };
  assertEquals(requireStartupCompile(compile, "x"), compile);
  const err = assertThrows(() => requireStartupCompile(undefined, "server copies"));
  assertStringIncludes(String(err), "records no server copies");
  assertStringIncludes(String(err), "denext build --compile");
});

Deno.test("prodLoader / resolveFlightBoundary: no startup compiler, no record → a clear refusal", async () => {
  const dir = await project();
  try {
    const paths = await resolveProject(dir);
    await assertRejects(() => prodLoader(paths, NO_BUILD), Error, "records no server copies");
    const manifest = {
      pages: [{ routePath: "/", filePath: join(dir, "app", "page.tsx"), layoutChain: [] }],
    } as unknown as RouteManifest;
    const load = () => Promise.resolve({});
    await assertRejects(
      () => resolveFlightBoundary(paths, manifest, NO_BUILD, load),
      Error,
      "records no client boundary",
    );
    // No pages (a Pages Router app's empty `app/`): nothing to crawl, nothing to refuse.
    const none = await resolveFlightBoundary(
      paths,
      { pages: [] } as unknown as RouteManifest,
      NO_BUILD,
      load,
    );
    assertEquals(none.flightRoutes.size, 0);
    assertEquals(none.boundary.client.size + none.boundary.server.size, 0);
    // A Pages Router app (no `app/`) records no copies: its pages load as they are.
    await Deno.remove(join(dir, "app"), { recursive: true });
    assertEquals(typeof await prodLoader(await resolveProject(dir), NO_BUILD), "function");
    // Recorded copies need no compiler.
    const recorded: BuildInfo = {
      ...NO_BUILD,
      serverCopies: { root: toFileUrl(dir).href, redirects: {}, copies: {}, relocatable: true },
    };
    assertEquals(typeof await prodLoader(paths, recorded), "function");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("startAppProdServer refuses a SPA (its server is the SPA one)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_compile_slim_" });
  try {
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      'export default { mode: "spa", spa: { entry: "./main.tsx" } };\n',
    );
    await Deno.writeTextFile(join(dir, "main.tsx"), "export {};\n");
    await assertRejects(
      () => startAppProdServer({ projectDir: dir, port: 0 }),
      Error,
      "A SPA has no App Router server",
    );
  } finally {
    await removeTempDir(dir);
  }
});
