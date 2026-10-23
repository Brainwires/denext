// @denext/tanstack-start: the request handler (the client bundle under /_tss/, denext's
// same-origin rule on a mutating server-function call, the body cap, everything else handed to
// Start's own handler), the generated entries, the esbuild side of a Start build (Start's virtual
// modules, TanStack's compiler over the app's and Start's own modules, the provider split),
// denext's `"use cache"` transform after it, the client bundle's guard (Start's import protection,
// denext's server-only scan), the browser half of a `"use server"` module, the server-function
// scan, Start's build-time constants, the server bundle's extra plugins and defines, the server
// bundle prebuilt by `denext build` and loaded by `denext start`, and a project without a Start
// router left alone. The browser half is tests/e2e/tanstack-start.e2e.test.ts.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { fromFileUrl, join, resolve } from "@std/path";
import {
  CLIENT_ENTRY,
  createHandler,
  type HandlerOptions,
  routerManifest,
} from "../packages/tanstack-start/src/handler.ts";
import {
  clientBootSource,
  clientEntrySource,
  serverEntrySource,
} from "../packages/tanstack-start/src/entries.ts";
import {
  type ClientGraph,
  SPLIT_SUFFIX,
  startBuild,
  startBuildPlugin,
  stripServerRouteOptions,
  virtualModuleSource,
} from "../packages/tanstack-start/src/compile.ts";
import {
  compileImportProtection,
  deniedModulePath,
  formatGuardError,
  formatViolation,
  type ImportProtectionOptions,
  type ImportProtectionViolation,
  importProtectionViolations,
  type Metafile,
  newResolveRecord,
  recordImport,
  resolveFilter,
  serverOnlyLeaks,
} from "../packages/tanstack-start/src/protect.ts";
import { coversServerFns, scanServerFns } from "../packages/tanstack-start/src/server-fns.ts";
import {
  loadStartToolchain,
  type ServerFnInfo,
  type StartToolchain,
} from "../packages/tanstack-start/src/toolchain.ts";
import { generateRouteTree } from "../packages/tanstack-start/src/route-tree.ts";
import { tanstackStart } from "../packages/tanstack-start/mod.ts";
import {
  buildStep,
  createBundles,
  SERVER_RECORD,
  type StartApp,
  type StartBundles,
  startDefines,
  startShell,
} from "../packages/tanstack-start/src/bundles.ts";
import {
  formatRefusals,
  prerenderPages,
  routeFor,
  type RouteInfo,
  staticPaths,
} from "../packages/tanstack-start/src/prerender.ts";
import {
  buildNextCompatClientEntries,
  buildNextCompatModules,
} from "../src/build/next-compat-build.ts";
import { loadBundleRef } from "../src/build/next-compat-loader.ts";
import { stopNextCompat } from "../src/build/next-compat.ts";
import { defaultLoader } from "../src/server/mod.ts";
import type { PluginBuildContext, PluginContext } from "../src/plugin/mod.ts";
import { watchTests } from "./helpers/watchdog.ts";

// Builds in this process: a stalled one fails its test instead of holding the CI job.
watchTests();

// deno-lint-ignore no-explicit-any
type Any = any;

const ORIGIN = "http://app.test";

async function handlerWithClient(over: Partial<HandlerOptions> = {}) {
  const dir = await Deno.makeTempDir({ prefix: "denext_tss_client_" });
  await Deno.writeTextFile(join(dir, CLIENT_ENTRY), "console.log('entry')");
  await Deno.writeTextFile(join(dir, "chunk-ABC.js"), "export const x = 1;");
  const seen: Array<{ method: string; url: string; body: string }> = [];
  const handle = createHandler({
    basePath: "",
    client: () => Promise.resolve(dir),
    origin: {},
    maxBodyBytes: 64,
    isStaticFile: (path) => Promise.resolve(path === "/robots.txt"),
    loadServerEntry: () =>
      Promise.resolve({
        fetch: async (request: Request) => {
          seen.push({ method: request.method, url: request.url, body: await request.text() });
          return new Response("<!DOCTYPE html><html></html>");
        },
      }),
    ...over,
  });
  return { dir, handle, seen };
}

const post = (path: string, origin: string | null, body = "{}") =>
  new Request(ORIGIN + path, {
    method: "POST",
    headers: { host: "app.test", ...(origin ? { origin } : {}) },
    body,
  });

Deno.test("tanstack-start handler: requests go to Start's handler; the bundle is served", async () => {
  const { dir, handle, seen } = await handlerWithClient();
  try {
    const page = await handle(new Request(ORIGIN + "/posts/1"));
    assertEquals(await page!.text(), "<!DOCTYPE html><html></html>");
    assertEquals(seen, [{ method: "GET", url: ORIGIN + "/posts/1", body: "" }]);
    const entry = await handle(new Request(ORIGIN + "/_tss/client.js"));
    assertEquals(await entry!.text(), "console.log('entry')");
    assertEquals(entry!.headers.get("cache-control"), "no-cache");
    const chunk = await handle(new Request(ORIGIN + "/_tss/chunk-ABC.js"));
    assertStringIncludes(chunk!.headers.get("cache-control")!, "immutable");
    assertEquals((await handle(new Request(ORIGIN + "/_tss/..%2Fdeno.json")))!.status, 404);
    assertEquals((await handle(new Request(ORIGIN + "/_tss/nope.js")))!.status, 404);
    assertEquals(await handle(new Request(ORIGIN + "/robots.txt")), null, "public/ files");
    assertEquals(await handle(new Request(ORIGIN + "/_denext/x.js")), null, "denext's own");
    // A path with an extension that is no public file is Start's (a server route, its 404).
    await handle(new Request(ORIGIN + "/sitemap.xml"));
    assertEquals(seen.at(-1)?.url, ORIGIN + "/sitemap.xml");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tanstack-start handler: the assets the bundles emit are served from assets/", async () => {
  const { dir, handle, seen } = await handlerWithClient();
  try {
    await Deno.mkdir(join(dir, "assets"));
    await Deno.writeTextFile(join(dir, "assets", "app-ABCDEFGH.css"), "body{color:red}");
    await Deno.writeTextFile(join(dir, "assets", "logo-ABCDEFGH.svg"), "<svg/>");
    await Deno.writeTextFile(join(dir, "assets", "data-ABCDEFGH.bin"), "x");
    const css = await handle(new Request(ORIGIN + "/_tss/assets/app-ABCDEFGH.css"));
    assertEquals(await css!.text(), "body{color:red}");
    assertEquals(css!.headers.get("content-type"), "text/css; charset=utf-8");
    assertStringIncludes(css!.headers.get("cache-control")!, "immutable");
    const svg = await handle(new Request(ORIGIN + "/_tss/assets/logo-ABCDEFGH.svg"));
    assertEquals(svg!.headers.get("content-type"), "image/svg+xml");
    await svg!.body?.cancel();
    const bin = await handle(new Request(ORIGIN + "/_tss/assets/data-ABCDEFGH.bin"));
    assertEquals(bin!.headers.get("content-type"), "application/octet-stream");
    await bin!.body?.cancel();
    for (
      const path of ["assets/nope.css", "assets/a/b.css", "assets/..%2F..%2Fdeno.json", "x.css"]
    ) {
      assertEquals((await handle(new Request(ORIGIN + "/_tss/" + path)))!.status, 404, path);
    }
    assertEquals(seen, [], "client files never reach Start's handler");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tanstack-start handler: a cross-origin server function POST is refused before Start", async () => {
  const { dir, handle, seen } = await handlerWithClient();
  try {
    const evil = await handle(post("/_serverFn/abc", "https://evil.example"));
    assertEquals(evil!.status, 403);
    const none = await handle(post("/_serverFn/abc", null));
    assertEquals(none!.status, 403, "no Origin / Referer is refused too");
    assertEquals(seen, [], "Start never saw them");
    const own = await handle(post("/_serverFn/abc", ORIGIN, '{"a":1}'));
    assertEquals(own!.status, 200);
    assertEquals(seen, [{ method: "POST", url: ORIGIN + "/_serverFn/abc", body: '{"a":1}' }]);
    // A GET server function call and a server route's POST are not server-function mutations.
    await handle(new Request(ORIGIN + "/_serverFn/abc?payload=x"));
    await handle(post("/api/hook", "https://partner.example"));
    assertEquals(seen.map((s) => s.url).slice(1), [
      ORIGIN + "/_serverFn/abc?payload=x",
      ORIGIN + "/api/hook",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tanstack-start handler: request bodies are capped", async () => {
  const { dir, handle, seen } = await handlerWithClient();
  try {
    const big = "x".repeat(65);
    assertEquals((await handle(post("/_serverFn/abc", ORIGIN, big)))!.status, 413);
    assertEquals((await handle(post("/api/upload", null, big)))!.status, 413);
    assertEquals(seen, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tanstack-start handler: under basePath, and the manifest names the entry", async () => {
  const { dir, handle, seen } = await handlerWithClient({ basePath: "/app" });
  try {
    assertEquals((await handle(new Request(ORIGIN + "/app/_tss/client.js")))!.status, 200);
    assertEquals((await handle(post("/app/_serverFn/abc", "https://evil.example")))!.status, 403);
    await handle(new Request(ORIGIN + "/app/about"));
    assertEquals(seen.map((s) => s.url), [ORIGIN + "/app/about"]);
    assertEquals(routerManifest("/app/_tss/client.js"), {
      routes: {
        __root__: {
          scripts: [{ attrs: { type: "module", src: "/app/_tss/client.js", async: true } }],
        },
      },
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tanstack-start entries: Start's handler on the server, StartClient in the browser", () => {
  const server = serverEntrySource(null);
  assertStringIncludes(server, `from "@tanstack/react-start/server"`);
  assertStringIncludes(server, "createStartHandler(\n  defaultStreamHandler,\n)");
  const custom = serverEntrySource("/p/src/server.ts");
  assertStringIncludes(custom, `import entry from "/p/src/server.ts"`);
  assertStringIncludes(custom, "entry.fetch(request)");
  const boot = clientBootSource(null);
  assertStringIncludes(boot, `import { StartClient } from "@tanstack/react-start/client"`);
  assertStringIncludes(boot, "hydrateRoot(document, createElement(StartClient))");
  assertStringIncludes(clientBootSource("/p/src/client.tsx"), `import "/p/src/client.tsx";`);
  assertEquals(
    clientEntrySource("/p/.denext/tanstack-start/client-boot.ts"),
    `import "/p/.denext/tanstack-start/client-boot.ts";\n`,
  );
});

Deno.test("tanstack-start: Start's build-time constants follow basePath", () => {
  assertEquals(startDefines("")["process.env.TSS_SERVER_FN_BASE"], '"/_serverFn/"');
  assertEquals(startDefines("")["process.env.TSS_ROUTER_BASEPATH"], '"/"');
  const based = startDefines("/app");
  assertEquals(based["process.env.TSS_SERVER_FN_BASE"], '"/app/_serverFn/"');
  assertEquals(based["process.env.TSS_ROUTER_BASEPATH"], '"/app"');
  assertEquals(based["process.env.TSS_DEV_SERVER"], '"false"');
});

/** A stand-in for TanStack's toolchain that records what the plugin asks of it. */
function fakeToolchain() {
  const compiled: Array<{ env: string; id: string }> = [];
  const tc: StartToolchain = {
    createCompiler: (opts) => ({
      compile: ({ id, code }) => {
        compiled.push({ env: opts.env, id });
        const name = /export const (\w+) = createServerFn/.exec(code)?.[1];
        if (name) {
          opts.onServerFnsById({
            [`id-${name}`]: {
              functionName: `${name}_handler`,
              functionId: `id-${name}`,
              filename: id,
              extractedFilename: id + SPLIT_SUFFIX,
            },
          });
        }
        return Promise.resolve({ code: `/* ${opts.env} */ ${code}` });
      },
      ingestModule: () => undefined,
    }),
    mayNeedCompile: (code) => /createServerFn|createServerOnlyFn/.test(code),
    detectKinds: () => new Set(["ServerFn"]),
    resolverModule: (fns) => `export const ids = ${JSON.stringify(Object.keys(fns))};`,
    parse: () => ({}),
    traverse: () => {},
    referencedIdentifiers: () => null,
    deadCodeElimination: () => {},
    print: () => "",
  };
  return { tc, compiled };
}

/** Capture an esbuild plugin's hooks without running esbuild. */
function hooksOf(plugin: unknown) {
  const resolves: Array<{ filter: RegExp; namespace?: string; cb: (a: Any) => Any }> = [];
  const loads: Array<{ filter: RegExp; namespace?: string; cb: (a: Any) => Any }> = [];
  (plugin as { setup(b: unknown): void }).setup({
    onResolve: (o: Any, cb: Any) => resolves.push({ ...o, cb }),
    onLoad: (o: Any, cb: Any) => loads.push({ ...o, cb }),
    resolve: () => Promise.resolve({ path: "", namespace: "file", external: false, errors: [] }),
  });
  const resolve = async (path: string, namespace = "file") => {
    for (const r of resolves) {
      if (r.namespace !== undefined && r.namespace !== namespace) continue;
      if (!r.filter.test(path)) continue;
      const out = await r.cb({ path, importer: "", resolveDir: "", namespace });
      if (out) return out;
    }
    return null;
  };
  const load = async (path: string, namespace = "file", suffix?: string) => {
    for (const l of loads) {
      if ((l.namespace ?? "file") !== namespace || !l.filter.test(path)) continue;
      const out = await l.cb({ path, suffix });
      if (out !== undefined) return out;
    }
    return undefined;
  };
  return { resolve, load };
}

Deno.test("tanstack-start build: Start's virtual modules", async () => {
  const { tc } = fakeToolchain();
  const opts = {
    toolchain: tc,
    projectRoot: "/p",
    routerFile: "/p/src/router.tsx",
    startFile: null,
    manifest: routerManifest("/_tss/client.js"),
    knownServerFns: { "id-a": {} as ServerFnInfo },
  };
  const server = hooksOf(startBuildPlugin({ ...opts, env: "server" }));
  const entry = await server.resolve("#tanstack-router-entry");
  // `#` would end a chunk's file URL: the virtual path has none.
  assertEquals(entry, { path: "tanstack-router-entry", namespace: "denext-tss" });
  const router = await server.load(entry.path, "denext-tss");
  assertStringIncludes(router.contents, `import * as app from "/p/src/router.tsx"`);
  assertStringIncludes(router.contents, "exported.getRouter ?? exported.createRouter");
  const resolver = await server.resolve("#tanstack-start-server-fn-resolver");
  assertEquals(
    (await server.load(resolver.path, "denext-tss")).contents,
    `export const ids = ["id-a"];`,
  );
  const manifest = await server.resolve("tanstack-start-manifest:v");
  assertStringIncludes(
    (await server.load(manifest.path, "denext-tss")).contents,
    "/_tss/client.js",
  );
  // The virtual modules import the app's modules by absolute path.
  assertEquals(await server.resolve("/p/src/router.tsx", "denext-tss"), {
    path: "/p/src/router.tsx",
  });
  assertEquals(await server.resolve("/p/src/fns.ts" + SPLIT_SUFFIX), {
    path: "/p/src/fns.ts",
    suffix: SPLIT_SUFFIX,
  });

  const client = hooksOf(startBuildPlugin({ ...opts, env: "client" }));
  assertEquals(await client.resolve("#tanstack-start-server-fn-resolver"), null, "server only");
  assertStringIncludes(
    virtualModuleSource("#tanstack-start-entry", { ...opts, env: "client" }),
    "export const startInstance = undefined",
  );
  assertStringIncludes(
    virtualModuleSource("#tanstack-start-entry", {
      ...opts,
      env: "client",
      startFile: "/p/src/start.ts",
    }),
    `export { startInstance } from "/p/src/start.ts"`,
  );
});

Deno.test("tanstack-start build: a route module without server-only options is not parsed", () => {
  const { tc } = fakeToolchain();
  let parsed = 0;
  const counting = { ...tc, parse: () => (parsed++, {}) };
  const plain = `export const Route = createFileRoute("/a")({ component: A });`;
  assertEquals(stripServerRouteOptions(plain, "/p/a.tsx", counting), null);
  assertEquals(stripServerRouteOptions("export const server = 1;", "/p/b.ts", counting), null);
  assertEquals(parsed, 0, "the cheap pre-check rules both out");
});

Deno.test("tanstack-start build: TanStack's compiler runs over the app and Start's own modules", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_tss_build_" }));
  try {
    const fns = join(dir, "fns.ts");
    await Deno.writeTextFile(fns, `export const a = createServerFn().handler(() => 1);\n`);
    const plain = join(dir, "plain.ts");
    await Deno.writeTextFile(plain, `export const b = 2;\n`);
    const pkgDir = join(dir, "node_modules", "@tanstack", "start-client-core");
    await Deno.mkdir(pkgDir, { recursive: true });
    const startPkg = join(pkgDir, "only.js");
    await Deno.writeTextFile(
      startPkg,
      `import { createServerOnlyFn } from "@tanstack/start-fn-stubs";\n` +
        `export const s = createServerOnlyFn(() => 1);\n`,
    );
    const otherPkg = join(dir, "node_modules", "lib", "x.js");
    await Deno.mkdir(join(otherPkg, ".."), { recursive: true });
    await Deno.writeTextFile(otherPkg, `export const createServerFn = 1;\n`);

    const { tc, compiled } = fakeToolchain();
    const plugin = startBuildPlugin({
      env: "server",
      toolchain: tc,
      projectRoot: dir,
      routerFile: join(dir, "router.tsx"),
      startFile: null,
      knownServerFns: {},
    });
    const { load } = hooksOf(plugin);
    assertStringIncludes((await load(fns)).contents, "/* server */");
    assertStringIncludes((await load(fns, "file", SPLIT_SUFFIX)).contents, "/* server */");
    assertEquals(await load(plain), undefined, "nothing to compile: denext's loaders keep it");
    assertStringIncludes((await load(startPkg)).contents, "/* server */", "Start's own package");
    assertEquals(await load(otherPkg), undefined, "a package that does not build on Start");
    assertEquals(compiled, [
      { env: "server", id: fns },
      { env: "server", id: fns + SPLIT_SUFFIX },
      { env: "server", id: startPkg },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tanstack-start server functions: the scan finds them before the build", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_tss_scan_" }));
  try {
    await Deno.mkdir(join(dir, "src", "fns"), { recursive: true });
    await Deno.mkdir(join(dir, "src", "node_modules"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "src", "fns", "notes.ts"),
      `export const list = createServerFn().handler(() => []);\n`,
    );
    await Deno.writeTextFile(join(dir, "src", "plain.tsx"), `export const x = 1;\n`);
    await Deno.writeTextFile(
      join(dir, "src", "node_modules", "skip.ts"),
      `export const no = createServerFn().handler(() => 0);\n`,
    );
    const { tc, compiled } = fakeToolchain();
    const found = await scanServerFns(tc, dir, join(dir, "src"));
    assertEquals(Object.keys(found), ["id-list"]);
    assertEquals(compiled, [{ env: "server", id: join(dir, "src", "fns", "notes.ts") }]);
    assert(coversServerFns(found, { "id-list": found["id-list"] }));
    assert(!coversServerFns(found, { "id-other": found["id-list"] }), "a missed one rebuilds");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "tanstack-start server bundle: extra plugins and defines reach the build",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_tss_bundle_" }));
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ imports: {} }));
    const entry = join(dir, "entry.ts");
    await Deno.writeTextFile(
      entry,
      `import { greeting } from "#virtual-greeting";\n` +
        `export const out = greeting + " " + process.env.TSS_SERVER_FN_BASE;\n`,
    );
    const moduleMap = await buildNextCompatModules({
      projectDir: dir,
      configPath: join(dir, "deno.json"),
      outDir: join(dir, ".denext"),
      modules: [entry],
      define: startDefines(""),
      extraPlugins: [{
        name: "virtual-greeting",
        setup(build: Any) {
          build.onResolve({ filter: /^#virtual-greeting$/ }, () => ({ path: "g", namespace: "v" }));
          build.onLoad({ filter: /.*/, namespace: "v" }, () => ({
            contents: `export const greeting = "hello";`,
            loader: "js",
          }));
        },
      }],
    });
    const mod = await loadBundleRef(defaultLoader, moduleMap.get(entry)!) as { out: string };
    assertEquals(mod.out, "hello /_serverFn/");
  } finally {
    await stopNextCompat().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("tanstack-start: a project without a Start router registers nothing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_tss_none_" });
  const added: string[] = [];
  const ctx = {
    projectRoot: dir,
    appDir: join(dir, "app"),
    config: {},
    mode: "build",
    load: () => Promise.resolve({}),
    addRequestHandler: () => added.push("handler"),
    addBuildStep: () => added.push("build"),
    addPrepareStep: () => added.push("prepare"),
  } as unknown as PluginContext;
  try {
    await tanstackStart().setup(ctx);
    assertEquals(added, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tanstack-start: in dev an edit under src/ rebuilds the bundles", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_tss_dev_" });
  const watched: string[][] = [];
  const ctx = {
    projectRoot: dir,
    appDir: join(dir, "app"),
    config: {},
    mode: "dev",
    load: () => Promise.resolve({}),
    addRequestHandler: () => {},
    addBuildStep: () => {},
    addPrepareStep: (_step: unknown, opts?: { watch?: string[] }) =>
      watched.push(opts?.watch ?? []),
  } as unknown as PluginContext;
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(join(dir, "src", "router.tsx"), "export function getRouter() {}\n");
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await tanstackStart({ generateRouteTree: false }).setup(ctx);
    assertEquals(watched, [["src/**"]]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tanstack-start: TanStack's packages come from the app's own dependencies", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_tss_tree_" });
  try {
    await Deno.writeTextFile(join(dir, "package.json"), "{}");
    // Nothing installed in the app: guided errors, no npm fetch.
    const tree = await assertRejects(() => generateRouteTree(dir, join(dir, "src")));
    assertStringIncludes((tree as Error).message, "@tanstack/router-generator");
    assertStringIncludes((tree as Error).message, "generateRouteTree: false");
    const start = await assertRejects(() => loadStartToolchain(dir));
    assertStringIncludes((start as Error).message, "add @tanstack/react-start");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tanstack-start route tree: the generator's routes come back, parents linked", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_tss_routes_" }));
  try {
    await Deno.writeTextFile(join(dir, "package.json"), "{}");
    // A stand-in generator: its plugin hook gets the route nodes TanStack's would (`/` paths).
    const pkg = join(dir, "node_modules", "@tanstack", "router-generator");
    await Deno.mkdir(pkg, { recursive: true });
    await Deno.writeTextFile(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@tanstack/router-generator", main: "index.cjs" }),
    );
    const routes = `${dir.replace(/\\/g, "/")}/src/routes`;
    await Deno.writeTextFile(
      join(pkg, "index.cjs"),
      `const root = { fullPath: "${routes}/__root.tsx" };
const posts = { fullPath: "${routes}/posts/route.tsx", routePath: "/posts",
  createFileRouteProps: new Set(["component"]) };
const post = { fullPath: "${routes}/posts/$id.tsx", routePath: "/posts/$id", parent: posts,
  createFileRouteProps: new Set(["component", "loader"]) };
const layout = { fullPath: "${routes}/_auth.tsx", routePath: "/_auth", isNonPath: true };
exports.getConfig = (inline) => inline;
exports.inferFullPath = (node) => node.routePath.replace(/\\/_[^/]+/g, "") || "/";
exports.Generator = class {
  constructor({ config }) { this.config = config; }
  async run() {
    for (const p of this.config.plugins) {
      p.onRouteTreeChanged({ rootRouteNode: root, routeNodes: [root, posts, post, layout] });
    }
  }
};
`,
    );
    const infos = await generateRouteTree(dir, join(dir, "src"));
    assertEquals(
      infos.map((r) => [r.id, r.path, r.layout, r.options, r.parent?.id]),
      [
        ["__root__", "/", true, [], undefined],
        ["/posts", "/posts", false, ["component"], "__root__"],
        ["/posts/$id", "/posts/$id", false, ["component", "loader"], "/posts"],
        ["/_auth", "/", true, [], "__root__"],
      ],
    );
    // Module paths in the platform's form, as the bundles' import graph has them.
    assertEquals(infos[2].file, join(dir, "src", "routes", "posts", "$id.tsx"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: 'tanstack-start server bundle: a module Start\'s compiler rewrote still gets "use cache"',
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_tss_cache_" }));
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ imports: {} }));
    const fns = join(dir, "fns.ts");
    await Deno.writeTextFile(
      fns,
      `async function stamp() { "use cache"; return crypto.randomUUID(); }\n` +
        `export const getStamp = createServerFn().handler(() => stamp());\n`,
    );
    // Start's compiler (faked) rewrites the module; its output carries a marker.
    const compiled: string[] = [];
    const { tc } = fakeToolchain();
    const toolchain: StartToolchain = {
      ...tc,
      createCompiler: () => ({
        compile: (
          { code, id },
        ) => (compiled.push(id),
          Promise.resolve({ code: code + `export const compiledBy = "START_COMPILER";\n` })),
        ingestModule: () => undefined,
      }),
    };
    const moduleMap = await buildNextCompatModules({
      projectDir: dir,
      configPath: join(dir, "deno.json"),
      outDir: join(dir, ".denext"),
      modules: [fns],
      useCache: true,
      extraPlugins: [startBuildPlugin({
        env: "server",
        toolchain,
        projectRoot: dir,
        routerFile: join(dir, "router.tsx"),
        startFile: null,
        knownServerFns: {},
      })],
    });
    assertEquals(compiled, [fns], "Start's compiler answered the module");
    const bundle = await Deno.readTextFile(moduleMap.get(fns)!.split("#")[0]);
    assertStringIncludes(bundle, "START_COMPILER", "its output is what was bundled");
    assertStringIncludes(bundle, "__useCache", "and denext's transform ran on it");
  } finally {
    await stopNextCompat().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

/** A metafile for the guard: `inputs` from an import list per module, all shipped. */
function metafile(graph: Record<string, Array<string | [string, string]>>): Metafile {
  const inputs: Metafile["inputs"] = {};
  for (const [from, imports] of Object.entries(graph)) {
    inputs[from] = {
      imports: imports.map((i) =>
        typeof i === "string" ? { path: i } : { path: i[0], original: i[1] }
      ),
    };
  }
  const shipped = Object.fromEntries(Object.keys(graph).map((p) => [p, { bytesInOutput: 10 }]));
  return { inputs, outputs: { "client.js": { entryPoint: ".denext/entry.tsx", inputs: shipped } } };
}

// An absolute root on every OS (`C:\p` on Windows): the guard resolves the metafile's paths
// against it, as it does the build's own.
const P = resolve("/p");
/** `rel` under {@link P}, as the guard names it. */
const p = (rel: string) => join(P, rel);
/** A guard path back to its `/`-separated path under {@link P}. */
const rel = (path: string) => path.slice(P.length + 1).replaceAll("\\", "/");
const startRules = (options?: ImportProtectionOptions) =>
  compileImportProtection(options, P, p("src"));

/** A resolve record, as a build fills it. */
function recorded(
  protection: ReturnType<typeof startRules>,
  env: "client" | "server",
  imports: Array<[string, string]>,
) {
  const record = newResolveRecord();
  const actions = imports.map(([spec, importer]) =>
    recordImport(protection, env, record, spec, importer)
  );
  return { record, actions };
}

Deno.test("tanstack-start import protection: Start's browser rules, in its words", async () => {
  const meta = metafile({
    ".denext/entry.tsx": ["src/router.tsx"],
    "src/router.tsx": [["src/routes/a.tsx", "./routes/a.tsx"], "node_modules/pkg/index.js"],
    "src/routes/a.tsx": [
      ["src/db.server.ts", "../db.server.ts"],
      ["src/marked.ts", "../marked.ts"],
      [deniedModulePath("@tanstack/react-start/server"), "@tanstack/react-start/server"],
    ],
    "src/db.server.ts": [],
    "src/marked.ts": [],
    [deniedModulePath("@tanstack/react-start/server")]: [],
    // A package may import what an app module may not.
    "node_modules/pkg/index.js": ["node_modules/pkg/x.server.js"],
    "node_modules/pkg/x.server.js": [],
  });
  const rules = startRules();
  const { record, actions } = recorded(rules, "client", [
    ["@tanstack/react-start/server-only", p("src/marked.ts")],
    ["@tanstack/react-start/server", p("src/routes/a.tsx")],
    ["@tanstack/react-start/server", p("node_modules/x/y.js")],
    ["@tanstack/react-start", p("src/a.ts")],
  ]);
  // Start's server entry and its marker are an empty module in the browser; the rest resolves.
  assertEquals(actions, ["mock", "mock", "pass", "pass"]);
  const found = await importProtectionViolations(meta, P, rules, "client", record);
  assertEquals(found.map((v) => [v.type, v.importer, v.specifier, v.trace.map((s) => s.file)]), [
    ["specifier", p("src/routes/a.tsx"), "@tanstack/react-start/server", [
      p("src/router.tsx"),
      p("src/routes/a.tsx"),
    ]],
    ["file", p("src/routes/a.tsx"), "../db.server.ts", [
      p("src/router.tsx"),
      p("src/routes/a.tsx"),
    ]],
    ["marker", p("src/marked.ts"), "@tanstack/react-start/server-only", [
      p("src/router.tsx"),
      p("src/routes/a.tsx"),
      p("src/marked.ts"),
    ]],
  ]);
  const message = formatViolation(found[1], P);
  assertStringIncludes(message, "[import-protection] Import denied in client environment");
  assertStringIncludes(message, "  Denied by file pattern: **/*.server.*");
  assertStringIncludes(message, "  Importer: src/routes/a.tsx\n");
  assertStringIncludes(message, '  Import: "../db.server.ts"\n  Resolved: src/db.server.ts');
  assertStringIncludes(
    message,
    '    1. src/router.tsx (entry) (import "./routes/a.tsx")\n    2. src/routes/a.tsx\n',
  );
  assertStringIncludes(message, "Use createServerFn().handler(() => ...)");
  assertStringIncludes(
    formatViolation(found[0], P),
    "  Denied by specifier pattern: @tanstack/react-start/server",
  );
  assertStringIncludes(
    formatViolation(found[2], P),
    "  Denied by marker: module is restricted to the opposite environment",
  );
  assertEquals(formatGuardError([], [], P), null);
});

Deno.test("tanstack-start import protection: tree-shaken imports do not count", async () => {
  const meta = metafile({
    "src/router.tsx": ["src/routes/a.tsx"],
    "src/routes/a.tsx": ["src/db.server.ts", [deniedModulePath("x-secret"), "x-secret"]],
    "src/db.server.ts": [],
    [deniedModulePath("x-secret")]: [],
  });
  // The import's module (and the denied specifier's stand-in) were dropped from the output.
  meta.outputs["client.js"].inputs["src/db.server.ts"].bytesInOutput = 0;
  meta.outputs["client.js"].inputs[deniedModulePath("x-secret")].bytesInOutput = 0;
  const rules = startRules({ client: { specifiers: ["x-secret"] } });
  const { record } = recorded(rules, "client", [["x-secret", p("src/routes/a.tsx")]]);
  assertEquals(await importProtectionViolations(meta, P, rules, "client", record), []);
});

Deno.test("tanstack-start import protection: the server build refuses *.client.* and the client-only marker", async () => {
  const meta = metafile({
    "src/router.tsx": ["src/routes/a.tsx"],
    "src/routes/a.tsx": [
      ["src/widget.client.tsx", "../widget.client.tsx"],
      "src/browser.ts",
      "src/db.server.ts",
    ],
    "src/widget.client.tsx": [],
    "src/browser.ts": [],
    "src/db.server.ts": [],
  });
  const rules = startRules();
  const { record, actions } = recorded(rules, "server", [
    ["@tanstack/react-start/client-only", p("src/browser.ts")],
    ["@tanstack/react-start/server-only", p("src/db.server.ts")],
  ]);
  assertEquals(actions, ["pass", "pass"], "both markers resolve on the server");
  const found = await importProtectionViolations(meta, P, rules, "server", record);
  assertEquals(found.map((v) => [v.type, v.importer, v.resolved]), [
    ["file", p("src/routes/a.tsx"), p("src/widget.client.tsx")],
    ["marker", p("src/browser.ts"), undefined],
  ]);
  const message = formatViolation(found[0], P);
  assertStringIncludes(message, "[import-protection] Import denied in server environment");
  assertStringIncludes(message, "  Denied by file pattern: **/*.client.*");
  assertStringIncludes(message, "Use createClientOnlyFn(() => ...)");
  // The browser's rules leave *.client.* alone; the server's leave *.server.* alone.
  assertEquals(
    (await importProtectionViolations(meta, P, rules, "client")).map((v) => v.resolved),
    [p("src/db.server.ts")],
  );
  // One module may not carry both markers.
  const both = newResolveRecord();
  recordImport(rules, "server", both, "@tanstack/react-start/client-only", p("src/x.ts"));
  assertThrows(
    () => recordImport(rules, "server", both, "@tanstack/react-start/server-only", p("src/x.ts")),
    Error,
    'File "src/x.ts" has both server-only and client-only markers',
  );
});

Deno.test("tanstack-start import protection: the app's importProtection rules", async () => {
  const meta = metafile({
    "src/router.tsx": ["src/routes/a.tsx", "lib/shared.ts"],
    "src/routes/a.tsx": [
      ["src/db.server.ts", "../db.server.ts"],
      ["src/secret/keys.ts", "../secret/keys.ts"],
      ["src/legacy.client.ts", "../legacy.client.ts"],
      [deniedModulePath("@prisma/client"), "@prisma/client"],
    ],
    "lib/shared.ts": [["src/db.server.ts", "../src/db.server.ts"]],
    "src/db.server.ts": [],
    "src/secret/keys.ts": [],
    "src/legacy.client.ts": [],
    [deniedModulePath("@prisma/client")]: [],
  });
  const files = (found: ImportProtectionViolation[]) =>
    found.map((v) => `${v.type}:${rel(v.importer)}>${v.resolved ? rel(v.resolved) : v.specifier}`);
  // client.specifiers add to Start's; client.files replace its *.server.* rule.
  const client = startRules({
    client: { specifiers: [/^@prisma\//], files: ["src/secret/**"] },
  });
  assertEquals(resolveFilter(client, "client").source, ".*", "a RegExp rule sees every import");
  const { record } = recorded(client, "client", [
    ["@prisma/client", p("src/routes/a.tsx")],
    ["@tanstack/react-start/server", p("src/routes/a.tsx")],
  ]);
  assertEquals(record.denied.map((d) => d.specifier), [
    "@prisma/client",
    "@tanstack/react-start/server",
  ]);
  assertEquals(files(await importProtectionViolations(meta, P, client, "client", record)), [
    "specifier:src/routes/a.tsx>@prisma/client",
    "file:src/routes/a.tsx>src/secret/keys.ts",
  ]);
  // By default only importers under the source directory are checked; `include` widens it.
  const wide = startRules({ include: ["**"] });
  assertEquals(files(await importProtectionViolations(meta, P, wide, "client")), [
    "file:src/routes/a.tsx>src/db.server.ts",
    "file:lib/shared.ts>src/db.server.ts",
  ]);
  // `exclude` / `ignoreImporters` skip importers; `excludeFiles` exempts files.
  for (
    const options of [
      { exclude: ["src/routes/**"] },
      { ignoreImporters: [/routes\/a/] },
      { client: { excludeFiles: ["**/db.server.ts"] } },
      { enabled: false },
    ] as ImportProtectionOptions[]
  ) {
    assertEquals(
      await importProtectionViolations(meta, P, startRules(options), "client"),
      [],
      JSON.stringify(options),
    );
  }
  // server.files replaces Start's *.client.* rule; server.specifiers apply on the server.
  const server = startRules({ server: { files: ["**/legacy.*"], specifiers: ["@prisma/client"] } });
  assertEquals(resolveFilter(server, "server").test("@prisma/client"), true);
  assertEquals(resolveFilter(startRules(), "server").test("@prisma/client"), false);
  const serverRecord = recorded(server, "server", [["@prisma/client", p("src/routes/a.tsx")]]);
  assertEquals(serverRecord.actions, ["mock"]);
  assertEquals(
    files(await importProtectionViolations(meta, P, server, "server", serverRecord.record)),
    ["specifier:src/routes/a.tsx>@prisma/client", "file:src/routes/a.tsx>src/legacy.client.ts"],
  );
  // onViolation: false waives one (and the hook sees Start's violation shape).
  const seen: string[] = [];
  const waived = startRules({
    onViolation: (v) => {
      seen.push(`${v.envType}:${v.type}:${v.behavior}`);
      return v.resolved?.endsWith("db.server.ts") ? false : undefined;
    },
  });
  assertEquals(await importProtectionViolations(meta, P, waived, "client"), []);
  assertEquals(seen, ["client:file:error"]);
});

Deno.test("tanstack-start client guard: denext's server-only scan reads modules as compiled", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_tss_leak_" }));
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "src", "fn.ts"),
      `export const f = () => Deno.env.get("K");\n`,
    );
    await Deno.writeTextFile(join(dir, "src", "fs.ts"), `import "node:fs";\nexport const g = 1;\n`);
    const meta = metafile({ "src/fn.ts": [], "src/fs.ts": [] });
    const disk = await serverOnlyLeaks(meta, dir, (p) => Deno.readTextFile(p));
    assertEquals(disk.map((l) => [l.module, l.rule]), [
      [join(dir, "src", "fn.ts"), "uses the Deno global"],
      [join(dir, "src", "fs.ts"), "imports a node: built-in"],
    ]);
    // Compiled for the browser (the handler that read Deno.env is an RPC stub now): no leak.
    const compiled = await serverOnlyLeaks(
      meta,
      dir,
      (p) =>
        p.endsWith("fn.ts") ? Promise.resolve("export const f = rpc();") : Deno.readTextFile(p),
    );
    assertEquals(compiled.map((l) => l.module), [join(dir, "src", "fs.ts")]);
    // A module tree-shaking dropped is not shipped.
    meta.outputs["client.js"].inputs["src/fs.ts"].bytesInOutput = 0;
    assertEquals((await serverOnlyLeaks(meta, dir, (p) => Deno.readTextFile(p))).length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "tanstack-start client bundle: the build fails on server code the browser would get",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_tss_guard_" }));
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ imports: {} }));
    await Deno.mkdir(join(dir, "src"));
    const file = (name: string, code: string) => Deno.writeTextFile(join(dir, "src", name), code);
    await file("db.server.ts", `export const db = () => "DB_SECRET";\n`);
    await file(
      "fns.ts",
      `export const read = createServerFn().handler(() => Deno.env.get("K"));\n`,
    );
    await file("ok.ts", `import { read } from "./fns.ts";\nexport const run = () => read();\n`);
    // A server function whose handler alone uses a *.server.* module: the compiler drops the
    // handler from the browser build, and with it the only use of the module.
    await file("store.server.ts", `export const load = () => "STORE_SERVER_BODY";\n`);
    await file(
      "store.ts",
      `import { load } from "./store.server.ts";\n` +
        `export const read = createServerFn().handler(() => "HANDLER_BODY:" + load());\n`,
    );
    await file(
      "uses-store.ts",
      `import { read } from "./store.ts";\nexport const run = () => read();\n`,
    );
    await file("bad.ts", `import { db } from "./db.server.ts";\nexport const run = () => db();\n`);
    // The fake compiler turns a server function into an RPC stub in the browser.
    const { tc } = fakeToolchain();
    const toolchain: StartToolchain = {
      ...tc,
      createCompiler: () => ({
        compile: ({ code }) =>
          Promise.resolve({ code: code.replace(/\.handler\(.*\)\);/, ".handler(rpc());") }),
        ingestModule: () => undefined,
      }),
    };
    const build = (route: string) => {
      const start = startBuild({
        env: "client",
        toolchain,
        projectRoot: dir,
        routerFile: join(dir, "router.tsx"),
        startFile: null,
        knownServerFns: {},
      });
      return buildNextCompatClientEntries({
        projectDir: dir,
        configPath: join(dir, "deno.json"),
        outDir: join(dir, ".denext"),
        clientDir: join(dir, ".denext", "client"),
        entries: [{
          id: "client",
          source: `import { run } from ${JSON.stringify(join(dir, "src", route))};\nrun();\n`,
        }],
        extraPlugins: [start.plugin],
        serverModuleSource: (path) => start.serverModuleSource(path),
      });
    };
    // The server function's Deno.env read is gone from the browser build: it ships.
    await build("ok.ts");
    const js = await Deno.readTextFile(join(dir, ".denext", "client", "client.js"));
    assert(!js.includes("Deno.env"), "the compiled module shipped, not the source");
    // The emitted browser bundle has neither the *.server.* module nor the handler's body.
    await build("uses-store.ts");
    const shipped = await clientBundleText(join(dir, ".denext", "client"));
    assertStringIncludes(shipped, "rpc()", "the server function is an RPC stub");
    for (const body of ["STORE_SERVER_BODY", "HANDLER_BODY"]) {
      assert(!shipped.includes(body), `the client bundle ships ${body}`);
    }
    const err = await assertRejects(() => build("bad.ts"));
    assertStringIncludes(String(err), "[import-protection] Import denied in client environment");
    assertStringIncludes(String(err), "Denied by file pattern: **/*.server.*");
    assertStringIncludes(String(err), '  Importer: src/bad.ts\n  Import: "./db.server.ts"');
  } finally {
    await stopNextCompat().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name:
    'tanstack-start client bundle: an inline "use server" function in a route module never ships',
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_tss_inline_" }));
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ imports: {} }));
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "src", "route.ts"),
      `export const read = createServerFn().handler(() => "FN_SECRET");\n` +
        `export async function act() {\n  "use server";\n  return "INLINE_SECRET";\n}\n` +
        `export const run = () => [read(), act()];\n`,
    );
    // Start's compiler answers the module (an RPC stub for the server function); denext's
    // transforms chained after it see the compiled module.
    let compiled = (code: string) => code;
    const { tc } = fakeToolchain();
    const toolchain: StartToolchain = {
      ...tc,
      createCompiler: () => ({
        compile: ({ code }) =>
          Promise.resolve({
            code: compiled(code.replace(/\.handler\(.*\)\);/, ".handler(rpc());")),
          }),
        ingestModule: () => undefined,
      }),
    };
    const start = startBuild({
      env: "client",
      toolchain,
      projectRoot: dir,
      routerFile: join(dir, "router.tsx"),
      startFile: null,
      knownServerFns: {},
    });
    const build = () =>
      buildNextCompatClientEntries({
        projectDir: dir,
        configPath: join(dir, "deno.json"),
        outDir: join(dir, ".denext"),
        clientDir: join(dir, ".denext", "client"),
        entries: [{
          id: "client",
          source: `import { run } from ${JSON.stringify(join(dir, "src", "route.ts"))};\nrun();\n`,
        }],
        extraPlugins: [start.plugin],
        serverModuleSource: (path) => start.serverModuleSource(path),
      });
    const refused = async (where: string) => {
      const err = await assertRejects(build);
      assertStringIncludes(
        String(err),
        'It is not allowed to define inline "use server" annotated Server Actions',
      );
      assertStringIncludes(String(err), where);
    };
    // As written in the source.
    await refused("route.ts:2:8");
    // Only in what Start's compiler emits (the source has none): denext's chained check sees it.
    await Deno.writeTextFile(
      join(dir, "src", "route.ts"),
      `export const read = createServerFn().handler(() => "FN_SECRET");\n` +
        `export const run = () => [read()];\n`,
    );
    compiled = (code) =>
      code + `export async function act() {\n  "use server";\n  return "INLINE_SECRET";\n}\n`;
    await refused("route.ts:3:8");
    const client = join(dir, ".denext", "client");
    const written = await Array.fromAsync(Deno.readDir(client)).catch(() => []);
    for (const e of written) {
      const js = await Deno.readTextFile(join(client, e.name)).catch(() => "");
      assert(!js.includes("INLINE_SECRET"), `${e.name} ships no action body`);
    }
  } finally {
    await stopNextCompat().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name: "tanstack-start server bundle: the build fails on browser code the server would run",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_tss_sguard_" }));
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ imports: {} }));
    await Deno.mkdir(join(dir, "src"));
    const file = (name: string, code: string) => Deno.writeTextFile(join(dir, "src", name), code);
    await file("widget.client.ts", `export const track = () => "WIDGET";\n`);
    await file(
      "browser.ts",
      `import "@tanstack/react-start/client-only";\nexport const run = () => "BROWSER";\n`,
    );
    // createClientOnlyFn's body (and the import only it used) is gone on the server.
    await file(
      "safe.ts",
      `import { track } from "./widget.client.ts";\n` +
        `export const run = createClientOnlyFn(() => track());\n`,
    );
    await file(
      "bad.ts",
      `import { track } from "./widget.client.ts";\nexport const run = track;\n`,
    );
    await file("marked.ts", `import { run } from "./browser.ts";\nexport { run };\n`);
    // An empty marker module, where the app's install would have Start's.
    const marker = join(dir, "node_modules", "@tanstack", "react-start");
    await Deno.mkdir(marker, { recursive: true });
    await Deno.writeTextFile(
      join(marker, "package.json"),
      JSON.stringify({
        name: "@tanstack/react-start",
        exports: { "./client-only": "./client-only.js" },
      }),
    );
    await Deno.writeTextFile(join(marker, "client-only.js"), "");
    const { tc } = fakeToolchain();
    const toolchain: StartToolchain = {
      ...tc,
      mayNeedCompile: (code) => code.includes("createClientOnlyFn"),
      createCompiler: () => ({
        compile: ({ code }) =>
          Promise.resolve({
            code: code.replace(/^import .*\n/, "").replace(
              /createClientOnlyFn\(.*\)/,
              "() => { throw new Error('client only'); }",
            ),
          }),
        ingestModule: () => undefined,
      }),
    };
    const build = (module: string, protection?: ImportProtectionOptions) =>
      buildNextCompatModules({
        projectDir: dir,
        configPath: join(dir, "deno.json"),
        outDir: join(dir, ".denext"),
        modules: [join(dir, "src", module)],
        resolveAllNodeModules: true,
        extraPlugins: [startBuildPlugin({
          env: "server",
          toolchain,
          projectRoot: dir,
          routerFile: join(dir, "src", "router.tsx"),
          startFile: null,
          knownServerFns: {},
          protection: protection &&
            compileImportProtection(protection, dir, join(dir, "src")),
        })],
      });
    // The emitted server bundle has no *.client.* module body: only createClientOnlyFn used it.
    const safe = await build("safe.ts");
    const serverJs = await Deno.readTextFile(
      safe.get(join(dir, "src", "safe.ts"))!.split("#")[0],
    );
    assertStringIncludes(serverJs, "client only", "createClientOnlyFn's server stub");
    assert(!serverJs.includes("WIDGET"), "the server bundle ships the .client module's body");
    const err = await assertRejects(() => build("bad.ts"));
    assertStringIncludes(String(err), "[import-protection] Import denied in server environment");
    assertStringIncludes(String(err), "Denied by file pattern: **/*.client.*");
    assertStringIncludes(String(err), '  Importer: src/bad.ts\n  Import: "./widget.client.ts"');
    const marked = await assertRejects(() => build("marked.ts"));
    assertStringIncludes(String(marked), "Denied by marker");
    assertStringIncludes(String(marked), "  Importer: src/browser.ts");
    // The app's rules: `server.files` replaces Start's, and `enabled: false` turns it off.
    await build("bad.ts", { server: { files: ["**/*.secret.*"] } });
    await build("marked.ts", { enabled: false });
  } finally {
    await stopNextCompat().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

/** Every `.js` file a client build wrote, concatenated. */
async function clientBundleText(dir: string): Promise<string> {
  let js = "";
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".js")) {
      js += await Deno.readTextFile(join(dir, entry.name));
    }
  }
  return js;
}

/** A Start app's layout under `dir`, as the plugin records it. */
function startApp(dir: string): StartApp {
  const outDir = join(dir, ".denext", "tanstack-start");
  return {
    projectRoot: dir,
    root: dir,
    src: join(dir, "src"),
    routerFile: join(dir, "src", "router.tsx"),
    startFile: null,
    serverEntry: join(outDir, "server-entry.ts"),
    boot: join(outDir, "client-boot.ts"),
    outDir,
    clientDir: join(outDir, "client"),
    configPath: join(dir, "deno.json"),
    basePath: "",
  };
}

Deno.test("tanstack-start: `denext start` loads the server bundle `denext build` recorded", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_tss_prod_" }));
  try {
    const app = startApp(dir);
    await Deno.mkdir(app.outDir, { recursive: true });
    await Deno.writeTextFile(
      join(app.outDir, SERVER_RECORD),
      JSON.stringify({ bundle: "server/app.js", key: "m0" }),
    );
    const loaded: string[] = [];
    const entry = { fetch: () => Promise.resolve(new Response("from the build")) };
    const ctx = (mode: string) =>
      ({
        projectRoot: dir,
        config: {},
        mode,
        load: (path: string) => (loaded.push(path), Promise.resolve({ m0: entry })),
      }) as unknown as PluginContext;
    // Nothing is installed here: building would fail, so this proves nothing was built.
    const served = await createBundles(ctx("prod"), app).loadServerEntry();
    assertEquals(await (await served.fetch(new Request("http://x/"))).text(), "from the build");
    assertEquals(loaded, [join(app.outDir, "server", "app.js")]);
    // dev builds its own; so does `start` when no build recorded one.
    await assertRejects(() => createBundles(ctx("dev"), app).loadServerEntry(), Error, "install");
    await Deno.remove(join(app.outDir, SERVER_RECORD));
    await assertRejects(() => createBundles(ctx("prod"), app).loadServerEntry(), Error, "install");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Stand-in bundles that record what a build step asks of them. */
function fakeBundles(over: Partial<StartBundles> = {}) {
  const calls: string[] = [];
  const bundles: StartBundles = {
    loadServerEntry: () => Promise.reject(new Error("not at build")),
    client: () => Promise.reject(new Error("not at build")),
    bundle: () => (calls.push("client"), Promise.resolve()),
    clientGraph: () => null,
    prebuildServer: () => (calls.push("server"), Promise.resolve()),
    forgetServerBuild: () => (calls.push("forget"), Promise.resolve()),
    reset: () => {},
    serverFunctions: () => Promise.resolve({}),
    ...over,
  };
  return { bundles, calls };
}

/** Run `fn` with console.warn / console.log captured. */
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const { warn, log } = console;
  let out = "";
  console.warn = console.log = (...args: unknown[]) => (out += args.join(" ") + "\n");
  try {
    return { value: await fn(), out };
  } finally {
    Object.assign(console, { warn, log });
  }
}

Deno.test("tanstack-start: `denext build` builds the client, then the server bundle", async () => {
  const { bundles, calls } = fakeBundles();
  await buildStep("build", bundles);
  assertEquals(calls, ["forget", "client", "server"], "a stale record never outlives a build");
  calls.length = 0;
  // An export with prerender off builds neither.
  const plan = {
    options: { enabled: false },
    pages: [],
    routes: () => null,
    projectRoot: "/p",
    basePath: "",
  };
  const { out } = await captured(() => buildStep("export", bundles, {} as never, plan));
  assertEquals(calls, []);
  assertStringIncludes(out, "prerender is off");
});

Deno.test("tanstack-start: `denext export` ships the client bundle and prerenders the pages", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_tss_export_" }));
  try {
    const clientDir = join(dir, "client");
    await Deno.mkdir(clientDir);
    await Deno.writeTextFile(join(clientDir, CLIENT_ENTRY), "boot()");
    await Deno.writeTextFile(join(clientDir, "chunk-A.js"), "chunk()");
    // A stale page from a previous export is gone.
    await Deno.mkdir(join(dir, "out", "pages-static", "old"), { recursive: true });
    await Deno.writeTextFile(join(dir, "out", "pages-static", "old", "index.html"), "stale");
    const emitted: string[] = [];
    const { bundles } = fakeBundles({
      client: () => Promise.resolve(clientDir),
      loadServerEntry: () =>
        Promise.resolve({
          fetch: (req: Request) => {
            const path = new URL(req.url).pathname;
            return Promise.resolve(
              new Response(`<a href="/about">a</a>${path}`, {
                headers: { "content-type": "text/html" },
              }),
            );
          },
        }),
    });
    const build = {
      outDir: join(dir, "out"),
      emitFile: ({ fileName }: { fileName: string }) => (emitted.push(fileName), Promise.resolve()),
    } as unknown as PluginBuildContext;
    const { out } = await captured(() =>
      buildStep("export", bundles, build, {
        options: {},
        pages: [],
        routes: () => null,
        projectRoot: dir,
        basePath: "",
      })
    );
    assertEquals(emitted.sort(), ["_tss/chunk-A.js", "_tss/client.js"]);
    const page = (p: string) => Deno.readTextFile(join(dir, "out", "pages-static", p));
    assertEquals(await page("index.html"), '<a href="/about">a</a>/');
    assertEquals(await page("about/index.html"), '<a href="/about">a</a>/about', "crawled");
    await assertRejects(() => page("old/index.html"));
    assertStringIncludes(out, "prerendered 2 page(s)");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A route tree like the example's. */
function exampleRoutes(dir: string): RouteInfo[] {
  const root: RouteInfo = {
    id: "__root__",
    path: "/",
    file: join(dir, "src/routes/__root.tsx"),
    layout: true,
    options: ["component"],
  };
  const route = (id: string, file: string, options: string[], parent = root): RouteInfo => ({
    id,
    path: id.replace(/\/_[^/]+/g, "") || "/",
    file: join(dir, "src/routes", file),
    layout: /\/_[^/]+$/.test(id),
    options,
    parent,
  });
  const posts = route("/posts", "posts/route.tsx", ["component"]);
  return [
    root,
    route("/", "index.tsx", ["component", "loader"]),
    route("/about", "about.tsx", ["component"]),
    route("/notes", "notes.tsx", ["component", "loader"]),
    route("/api/hello", "api/hello.ts", ["server"]),
    posts,
    route("/posts/", "posts/index.tsx", ["component", "loader"], posts),
    route("/posts/$postId", "posts/$postId.tsx", ["component", "loader"], posts),
    route("/docs/$slug", "docs/$slug.tsx", ["component"]),
    route("/_auth", "_auth.tsx", ["component"]),
  ];
}

/** A client graph in which `notes.tsx` reaches a server function. */
function exampleClientGraph(dir: string): ClientGraph {
  const routes = join(dir, "src/routes");
  return {
    graph: {
      imports: new Map([
        [join(routes, "notes.tsx"), [{ to: join(dir, "src/functions/notes.ts"), specifier: "x" }]],
        [join(routes, "about.tsx"), [{ to: join(dir, "node_modules/x/rpc.js"), specifier: "x" }]],
      ]),
      importers: new Map(),
      kept: new Set(),
    },
    serverFnModules: new Set([
      join(dir, "src/functions/notes.ts"),
      join(dir, "node_modules/x/rpc.js"),
    ]),
  };
}

Deno.test("tanstack-start prerender: Start's pages, discovery and crawl; server routes refused", async () => {
  const dir = "/app";
  const routes = exampleRoutes(dir);
  assertEquals(staticPaths(routes), ["/", "/about", "/notes", "/posts", "/posts/"]);
  assertEquals(routeFor(routes, "/posts/1")?.id, "/posts/$postId");
  assertEquals(routeFor(routes, "/posts")?.id, "/posts/", "the index route renders /posts");
  assertEquals(routeFor(routes, "/nope"), undefined);
  const requested: string[] = [];
  const files = new Map<string, string>();
  const links: Record<string, string> = {
    "/": '<a href="/posts">p</a><a href="/notes">n</a><a href="https://x.dev/">x</a>',
    "/posts": '<a href="/posts/1">1</a><a href="./x">rel</a>',
  };
  const result = await prerenderPages({
    options: { concurrency: 2 },
    pages: [],
    routes,
    client: exampleClientGraph(dir),
    projectRoot: dir,
    basePath: "",
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      requested.push(path);
      if (path === "/x") return Promise.resolve(new Response(null, { status: 404 }));
      return Promise.resolve(
        new Response(`${links[path] ?? ""}${path}`, { headers: { "content-type": "text/html" } }),
      );
    },
    write: (file, html) => (files.set(file, html), Promise.resolve()),
  }).catch((err) => err);
  // `./x` is a crawled page that 404s: Start's failOnError fails the export.
  assertStringIncludes(String(result), "Failed to fetch /x: 404");
  // Without it: every static page, the crawled dynamic one; the server routes refused.
  files.clear();
  const ok = await prerenderPages({
    options: { filter: (page) => page.path !== "/x" },
    pages: [],
    routes,
    client: exampleClientGraph(dir),
    projectRoot: dir,
    basePath: "",
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      return Promise.resolve(
        new Response(`${links[path] ?? ""}${path}`, { headers: { "content-type": "text/html" } }),
      );
    },
    write: (file, html) => (files.set(file, html), Promise.resolve()),
  });
  assertEquals([...files.keys()].sort(), [
    "about/index.html",
    "index.html",
    "posts/1/index.html",
    "posts/index.html",
  ]);
  assertEquals(ok.refused.map((r) => [r.path, r.reason.split(":")[0]]), [
    ["/api/hello", "a server route (server.handlers)"],
    ["/docs/$slug", "a dynamic route no prerendered page links to"],
    ["/notes", "calls a server function (createServerFn)"],
  ]);
  assert(!requested.includes("/notes"), "a page that needs a server is never rendered");
  const report = formatRefusals(ok.refused, dir)!;
  assertStringIncludes(report, "3 route(s) need a server and are not in the export");
  assertStringIncludes(report, "    /notes  (src/routes/notes.tsx) — calls a server function");
  assertEquals(formatRefusals([], dir), null);
});

Deno.test("tanstack-start prerender: page options, redirects and the base path", async () => {
  const files = new Map<string, string>();
  const seenHeaders: string[] = [];
  const succeeded: string[] = [];
  const result = await prerenderPages({
    options: { autoSubfolderIndex: false, crawlLinks: false, headers: { "x-a": "1" } },
    pages: [
      { path: "/old" },
      { path: "/feed", prerender: { outputPath: "/feed.xml" } },
      { path: "/skip", prerender: { enabled: false } },
      { path: "/hi", prerender: { onSuccess: ({ page }) => void succeeded.push(page.path) } },
    ],
    routes: null,
    client: null,
    projectRoot: "/app",
    basePath: "/base",
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      seenHeaders.push(req.headers.get("x-a") ?? "");
      if (path === "/base/old") {
        return Promise.resolve(
          new Response(null, { status: 307, headers: { location: "/base/new" } }),
        );
      }
      const type = path.endsWith("feed") ? "application/xml" : "text/html";
      return Promise.resolve(new Response(path, { headers: { "content-type": type } }));
    },
    write: (file, html) => (files.set(file, html), Promise.resolve()),
  });
  assertEquals(Object.fromEntries(files), {
    "old.html": "/base/new",
    "feed.xml": "/base/feed",
    "hi.html": "/base/hi",
  });
  assertEquals(result.written.sort(), ["/feed", "/hi", "/old"]);
  assertEquals(result.refused, []);
  assertEquals(succeeded, ["/hi"]);
  assert(seenHeaders.every((h) => h === "1"), "the prerender headers ride every request");
  // retryCount retries a failed page; with failOnError off a page that keeps failing is skipped.
  let flaky = 0;
  const retried = new Map<string, string>();
  const lenient = await prerenderPages({
    options: { failOnError: false, retryCount: 1, retryDelay: 0, crawlLinks: false },
    pages: [{ path: "/flaky" }, { path: "/gone" }],
    routes: null,
    client: null,
    projectRoot: "/app",
    basePath: "",
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      const fail = path === "/gone" || (path === "/flaky" && flaky++ === 0);
      return Promise.resolve(
        new Response(path, { status: fail ? 500 : 200, headers: { "content-type": "text/html" } }),
      );
    },
    write: (file, html) => (retried.set(file, html), Promise.resolve()),
  });
  assertEquals(Object.fromEntries(retried), { "flaky/index.html": "/flaky" });
  assertEquals(lenient.written, ["/flaky"]);
  // A path outside the app is refused before any request.
  await assertRejects(
    () =>
      prerenderPages({
        options: {},
        pages: [{ path: "https://evil.example/" }],
        routes: null,
        client: null,
        projectRoot: "/app",
        basePath: "",
        fetch: () => Promise.reject(new Error("no request")),
        write: () => Promise.resolve(),
      }),
    Error,
    "prerender page path must be relative",
  );
});

Deno.test("tanstack-start: the export's server bundle is Start's prerendering build", () => {
  assertEquals(startDefines("")["process.env.TSS_PRERENDERING"], '"false"');
  assertEquals(startDefines("", true)["process.env.TSS_PRERENDERING"], '"true"');
});

Deno.test("tanstack-start: spa renders every dev page as the shell (Start's serve-mode TSS_SHELL)", () => {
  assertEquals(startDefines("")["process.env.TSS_SHELL"], '"false"');
  assertEquals(startDefines("", false, true)["process.env.TSS_SHELL"], '"true"');
  // Start defines TSS_SHELL from `spa.enabled` (default true) in serve mode only.
  assertEquals(startShell("dev", {}), true);
  assertEquals(startShell("dev", { enabled: true, maskPath: "/app" }), true);
  assertEquals(startShell("dev", { enabled: false }), false);
  assertEquals(startShell("dev", undefined), false);
  for (const mode of ["build", "prod", "export"] as const) {
    assertEquals(
      startShell(mode, {}),
      false,
      `${mode} renders each page (the shell is prerendered)`,
    );
  }
});

// TanStack's real compiler, from the example app's install (`deno install` in
// examples/tanstack-start; the e2e does it). Skipped when the example is not installed.
const EXAMPLE = fromFileUrl(new URL("../examples/tanstack-start", import.meta.url));
const installed = await Deno.stat(join(EXAMPLE, "node_modules", "@tanstack", "react-start"))
  .then(() => true, () => false);

Deno.test({
  name: "tanstack-start compiler (installed example): the browser build drops server-only code",
  ignore: !installed,
}, async () => {
  const probe = fromFileUrl(
    new URL("./fixtures/tanstack-start/compiler-probe.ts", import.meta.url),
  );
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", join(EXAMPLE, "deno.json"), probe, EXAMPLE],
    cwd: EXAMPLE,
  }).output();
  const err = new TextDecoder().decode(out.stderr);
  assert(out.success, err);
  const r = JSON.parse(new TextDecoder().decode(out.stdout)) as Record<string, Any>;
  // A server route's handlers (and the imports only they used) never reach the browser.
  assert(!r.stripped.includes("handlers"), r.stripped);
  assert(!r.stripped.includes("db.server"), "the server-only import went with them");
  assert(!r.stripped.includes("x-a"), r.stripped);
  assertStringIncludes(r.stripped, "component");
  assertEquals(r.untouched, null);
  // A server function is an RPC stub in the browser, its body and imports gone.
  assertStringIncludes(r.client, "createClientRpc(");
  assert(!r.client.includes("secret.server"), r.client);
  assertStringIncludes(r.ssr, "createSsrRpc(");
  assertEquals(r.ids.length, 1);
  assertStringIncludes(r.client, r.ids[0], "both sides name the function by the same id");
  assertStringIncludes(r.resolver, "/p/src/fns.ts" + SPLIT_SUFFIX);
  // On the server a createClientOnlyFn body is replaced and its client-only import dropped, so
  // the server build's import protection never sees it.
  assertStringIncludes(r.clientOnlyOnServer, "export const report");
  assert(!r.clientOnlyOnServer.includes("analytics.client"), r.clientOnlyOnServer);
  // A "use server" module's browser half: its server functions stay RPC stubs, every other
  // export throws, and nothing else of it ships.
  const useServer = r.useServer as string;
  assertEquals((useServer.match(/createClientRpc\(/g) ?? []).length, 2, useServer);
  assertStringIncludes(useServer, "export const getStamp = createServerFn(");
  assertStringIncludes(useServer, "export { hidden as renamed }");
  assertStringIncludes(useServer, 'const plainAction = __denextUseServerExport("plainAction")');
  assertStringIncludes(useServer, 'export default __denextUseServerExport("default")');
  for (
    const leak of ["SECRET", "readFileSync", "node:fs", "setup.server", "SIDE_EFFECT", "effect"]
  ) {
    assert(!useServer.includes(leak), `${leak} shipped:\n${useServer}`);
  }
  assert(!/^\s*["']use server["']/.test(useServer), "the directive is gone");
});
