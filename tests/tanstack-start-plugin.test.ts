// @denext/tanstack-start: the request handler (the client bundle under /_tss/, denext's
// same-origin rule on a mutating server-function call, the body cap, everything else handed to
// Start's own handler), the generated entries, the esbuild side of a Start build (Start's virtual
// modules, TanStack's compiler over the app's and Start's own modules, the provider split), the
// server-function scan, Start's build-time constants, the server bundle's extra plugins and
// defines, and a project without a Start router left alone. The browser half is
// tests/e2e/tanstack-start.e2e.test.ts.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
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
  SPLIT_SUFFIX,
  startBuildPlugin,
  stripServerRouteOptions,
  virtualModuleSource,
} from "../packages/tanstack-start/src/compile.ts";
import { coversServerFns, scanServerFns } from "../packages/tanstack-start/src/server-fns.ts";
import {
  loadStartToolchain,
  type ServerFnInfo,
  type StartToolchain,
} from "../packages/tanstack-start/src/toolchain.ts";
import { generateRouteTree } from "../packages/tanstack-start/src/route-tree.ts";
import { tanstackStart } from "../packages/tanstack-start/mod.ts";
import { startDefines } from "../packages/tanstack-start/src/bundles.ts";
import { buildNextCompatModules } from "../src/build/next-compat-build.ts";
import { loadBundleRef } from "../src/build/next-compat-loader.ts";
import { stopNextCompat } from "../src/build/next-compat.ts";
import { defaultLoader } from "../src/server/mod.ts";
import type { PluginContext } from "../src/plugin/mod.ts";

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
});
