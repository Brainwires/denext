// @denext/tanstack-start's options: the field-scoped check `tanstackStart()` runs on them (Start's
// own shapes for `router`, `importProtection`, `prerender` and `pages`; unknown keys refused with a
// suggestion), Start's object form of `router` mapped onto the plugin (an extensionless `entry`,
// `basepath` against the app's `basePath`, the generator's options), and Start's remaining
// `importProtection` keys: `maxTraceDepth` caps a violation's trace, `behavior: "mock"` is warned
// about (per `log`) while every violation still fails.

import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  checkBasepath,
  resolveRouter,
  validateOptions,
} from "../packages/tanstack-start/src/options.ts";
import {
  compileImportProtection,
  importProtectionViolations,
  type Metafile,
  mockNotice,
} from "../packages/tanstack-start/src/protect.ts";
import { generateRouteTree, generatorPaths } from "../packages/tanstack-start/src/route-tree.ts";
import { tanstackStart, type TanStackStartOptions } from "../packages/tanstack-start/mod.ts";
import type { PluginContext } from "../src/plugin/mod.ts";

const invalid = (options: unknown, message: string) =>
  assertThrows(() => validateOptions(options), Error, message);

Deno.test("tanstack-start options: Start's full shapes pass", () => {
  validateOptions(undefined);
  validateOptions({});
  validateOptions({
    srcDirectory: "app",
    router: "router.ts",
    generateRouteTree: true,
    maxBodyBytes: 2048,
    allowedOrigins: ["https://app.example.com"],
    importProtection: {
      enabled: true,
      behavior: { dev: "mock", build: "error" },
      mockAccess: "warn",
      onViolation: () => false,
      include: ["src/**"],
      exclude: [/legacy/],
      ignoreImporters: ["src/vendor/**"],
      client: { specifiers: [/^@prisma\//], files: ["**/*.secret.*"], excludeFiles: [] },
      server: { specifiers: ["jquery"], files: ["**/*.client.*"] },
      maxTraceDepth: 5,
      log: "always",
    },
    prerender: {
      enabled: true,
      concurrency: 4,
      filter: () => true,
      failOnError: false,
      autoStaticPathsDiscovery: true,
      maxRedirects: 0,
      crawlLinks: true,
      autoSubfolderIndex: false,
      retryCount: 2,
      retryDelay: 100,
      headers: { "x-prerender": "1" },
      onSuccess: () => {},
    },
    pages: [
      { path: "/" },
      { path: "/about", prerender: { outputPath: "/about.html" }, sitemap: {}, fromCrawl: false },
    ],
  });
  validateOptions({
    router: {
      entry: "app-router",
      basepath: "/docs",
      routesDirectory: "pages",
      generatedRouteTree: "tree.gen.ts",
      quoteStyle: "double",
      semicolons: true,
      addExtensions: ".tsx",
      routeFileIgnorePrefix: "~",
      plugins: [],
    },
  });
  validateOptions({ importProtection: { behavior: "mock" } });
});

Deno.test("tanstack-start options: unknown keys are refused, with the closest one suggested", () => {
  invalid(
    { importprotection: {} },
    "invalid tanstackStart() options: `importprotection` is not an option (did you mean " +
      "`importProtection`?)",
  );
  invalid({ zzz: 1 }, "`zzz` is not an option");
  invalid(
    { importProtection: { cleint: { files: [] } } },
    "`importProtection.cleint` is not an option (did you mean `client`?)",
  );
  invalid(
    { importProtection: { ignoreImporter: ["x"] } },
    "`importProtection.ignoreImporter` is not an option (did you mean `ignoreImporters`?)",
  );
  invalid(
    { importProtection: { server: { file: ["x"] } } },
    "`importProtection.server.file` is not an option (did you mean `files`?)",
  );
  invalid(
    { importProtection: { behavior: { serve: "mock" } } },
    "`importProtection.behavior.serve` is not an option",
  );
  invalid({ prerender: { crawlLink: true } }, "(did you mean `crawlLinks`?)");
  invalid({ pages: [{ path: "/", prerender: { outPath: "/x" } }] }, "`pages[0].prerender.outPath`");
  invalid({ router: { routesDir: "x" } }, "(did you mean `routesDirectory`?)");
});

Deno.test("tanstack-start options: a bad type names the field and what it must be", () => {
  const cases: Array<[unknown, string]> = [
    [[], "`tanstackStart() options` must be an object"],
    [{ srcDirectory: "" }, "`srcDirectory` must be a non-empty string"],
    [{ router: 1 }, "`router` must be an object"],
    [{ router: "" }, "`router` must be a non-empty string"],
    [{ generateRouteTree: "yes" }, "`generateRouteTree` must be a boolean"],
    [{ maxBodyBytes: 0 }, "`maxBodyBytes` must be a finite integer >= 1"],
    [{ maxBodyBytes: 1.5 }, "`maxBodyBytes` must be a finite integer >= 1"],
    [{ allowedOrigins: "https://a" }, "`allowedOrigins` must be an array"],
    [{ allowedOrigins: [1] }, "`allowedOrigins[0]` must be a non-empty string"],
    [{ importProtection: true }, "`importProtection` must be an object"],
    [{ importProtection: { enabled: 1 } }, "`importProtection.enabled` must be a boolean"],
    [
      { importProtection: { behavior: "warn" } },
      '`importProtection.behavior` must be "error", "mock" or { dev?, build? }',
    ],
    [
      { importProtection: { behavior: { dev: "off" } } },
      '`importProtection.behavior.dev` must be one of "error", "mock"',
    ],
    [
      { importProtection: { mockAccess: "loud" } },
      '`importProtection.mockAccess` must be one of "error", "warn", "off"',
    ],
    [
      { importProtection: { onViolation: "x" } },
      "`importProtection.onViolation` must be a function",
    ],
    [{ importProtection: { include: "src/**" } }, "`importProtection.include` must be an array"],
    [
      { importProtection: { client: { files: ["ok", 3] } } },
      "`importProtection.client.files[1]` must be a string (a glob) or a RegExp",
    ],
    [{ importProtection: { server: [] } }, "`importProtection.server` must be an object"],
    [
      { importProtection: { maxTraceDepth: -1 } },
      "`importProtection.maxTraceDepth` must be a finite integer >= 0",
    ],
    [{ importProtection: { log: "never" } }, '`importProtection.log` must be one of "once"'],
    [{ prerender: { concurrency: 0 } }, "`prerender.concurrency` must be a finite integer >= 1"],
    [{ prerender: { filter: "/x" } }, "`prerender.filter` must be a function"],
    [{ prerender: { headers: { a: 1 } } }, "`prerender.headers.a` must be a string"],
    [{ prerender: { headers: [] } }, "`prerender.headers` must be an object of strings"],
    [{ pages: {} }, "`pages` must be an array"],
    [{ pages: ["/"] }, "`pages[0]` must be an object"],
    [{ pages: [{ path: "about" }] }, '`pages[0].path` must be a path starting with "/"'],
    [{ pages: [{ path: "/", sitemap: 1 }] }, "`pages[0].sitemap` must be an object"],
    [{ router: { entry: "" } }, "`router.entry` must be a non-empty string"],
    [{ router: { semicolons: "no" } }, "`router.semicolons` must be a boolean"],
    [{ router: { quoteStyle: "back" } }, '`router.quoteStyle` must be one of "single", "double"'],
    [{ router: { plugins: {} } }, "`router.plugins` must be an array"],
    [{ router: { addExtensions: 1 } }, "`router.addExtensions` must be a non-empty string"],
  ];
  for (const [options, message] of cases) invalid(options, message);
});

Deno.test("tanstack-start options: the parts of Start's router the plugin cannot honour", () => {
  invalid({ router: { target: "solid" } }, "`router.target` is not an option: the plugin builds");
  invalid({ router: { autoCodeSplitting: true } }, "`router.autoCodeSplitting` is not an option");
  invalid(
    { router: { addExtensions: false } },
    "`router.addExtensions` cannot be false: Deno resolves",
  );
  // The factory checks them, so a bad config fails when denext.config.ts loads.
  assertThrows(
    () => tanstackStart({ prerender: { concurrency: -1 } }),
    Error,
    "invalid tanstackStart() options: `prerender.concurrency`",
  );
  assertThrows(
    () => tanstackStart({ importProtection: { client: { files: "x" } } } as never),
    Error,
    "`importProtection.client.files` must be an array",
  );
});

Deno.test("tanstack-start router: Start's object form maps onto the plugin", () => {
  assertEquals(resolveRouter(undefined), { entry: "router.tsx", generator: {} });
  assertEquals(resolveRouter("app.tsx"), { entry: "app.tsx", generator: {} });
  assertEquals(resolveRouter({}), { entry: "router", basepath: undefined, generator: {} });
  assertEquals(
    resolveRouter({ entry: "r", basepath: "/a", routesDirectory: "pages", semicolons: true }),
    { entry: "r", basepath: "/a", generator: { routesDirectory: "pages", semicolons: true } },
  );
  checkBasepath(undefined, "/docs");
  checkBasepath("/", undefined);
  checkBasepath("/docs/", "/docs");
  assertThrows(
    () => checkBasepath("/docs", ""),
    Error,
    'invalid tanstackStart() options: `router.basepath` is "/docs" but the app\'s basePath is ""',
  );
  // Start resolves the generator's paths under the source directory.
  const root = join("/", "p");
  assertEquals(generatorPaths(root, join(root, "src")), {
    routesDirectory: "./src/routes",
    generatedRouteTree: "./src/routeTree.gen.ts",
  });
  assertEquals(
    generatorPaths(root, join(root, "app"), {
      routesDirectory: "pages",
      generatedRouteTree: "gen/tree.ts",
    }),
    { routesDirectory: "./app/pages", generatedRouteTree: "./app/gen/tree.ts" },
  );
});

/** A plugin context recording the prepare steps' watch globs. */
function setupContext(dir: string, basePath?: string) {
  const watched: string[][] = [];
  const ctx = {
    projectRoot: dir,
    appDir: join(dir, "app"),
    config: basePath === undefined ? {} : { basePath },
    mode: "build",
    load: () => Promise.resolve({}),
    addRequestHandler: () => {},
    addBuildStep: () => {},
    addPrepareStep: (_step: unknown, opts?: { watch?: string[] }) =>
      watched.push(opts?.watch ?? []),
  } as unknown as PluginContext;
  return { ctx, watched };
}

Deno.test("tanstack-start router: an extensionless entry, the routes directory, the base path", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_tss_router_" });
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.writeTextFile(join(dir, "src", "app-router.ts"), "export function getRouter() {}\n");
    const options: TanStackStartOptions = {
      router: { entry: "app-router", routesDirectory: "pages" },
    };
    const { ctx, watched } = setupContext(dir);
    await tanstackStart(options).setup(ctx);
    // The generator's step watches the routes directory Start would read.
    assertEquals(watched, [["src/pages/**"]]);
    // No such module: not a Start app, nothing registered.
    const none = setupContext(dir);
    await tanstackStart({ router: { entry: "missing" } }).setup(none.ctx);
    assertEquals(none.watched, []);
    // A basepath the app does not serve under is refused at setup.
    await assertRejects(
      async () =>
        await tanstackStart({ router: { entry: "app-router", basepath: "/docs" } })
          .setup(setupContext(dir, "/blog").ctx),
      Error,
      '`router.basepath` is "/docs" but the app\'s basePath is "/blog"',
    );
    await tanstackStart({ router: { entry: "app-router", basepath: "/docs/" } })
      .setup(setupContext(dir, "/docs").ctx);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tanstack-start router: the generator's options reach the generator", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_tss_gen_" }));
  try {
    await Deno.writeTextFile(join(dir, "package.json"), "{}");
    const pkg = join(dir, "node_modules", "@tanstack", "router-generator");
    await Deno.mkdir(pkg, { recursive: true });
    await Deno.writeTextFile(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@tanstack/router-generator", main: "index.cjs" }),
    );
    // A stand-in generator: it hands back the config it was given.
    await Deno.writeTextFile(
      join(pkg, "index.cjs"),
      `exports.getConfig = (inline) => inline;
exports.inferFullPath = () => "/";
exports.Generator = class {
  constructor({ config }) { globalThis.__tssGeneratorConfig = config; }
  async run() {}
};
`,
    );
    const mine = { name: "app-plugin" };
    await generateRouteTree(dir, join(dir, "src"), {
      routesDirectory: "pages",
      quoteStyle: "double",
      disableLogging: false,
      addExtensions: ".tsx",
      plugins: [mine],
    });
    const config = (globalThis as Record<string, unknown>).__tssGeneratorConfig as Record<
      string,
      unknown
    >;
    assertEquals(config.routesDirectory, "./src/pages");
    assertEquals(config.generatedRouteTree, "./src/routeTree.gen.ts");
    assertEquals(config.quoteStyle, "double");
    assertEquals(config.disableLogging, false);
    assertEquals(config.addExtensions, ".tsx");
    assertEquals(config.target, "react");
    const plugins = config.plugins as Array<{ name: string }>;
    assertEquals(plugins.map((p) => p.name), ["app-plugin", "denext-route-info"]);
    // With no options: the plugin's defaults.
    await generateRouteTree(dir, join(dir, "src"));
    const defaults = (globalThis as Record<string, unknown>).__tssGeneratorConfig as Record<
      string,
      unknown
    >;
    assertEquals([defaults.addExtensions, defaults.disableLogging], [true, true]);
  } finally {
    delete (globalThis as Record<string, unknown>).__tssGeneratorConfig;
    await Deno.remove(dir, { recursive: true });
  }
});

/** A metafile whose modules all shipped, from an import list per module. */
function metafile(graph: Record<string, string[]>): Metafile {
  const inputs: Metafile["inputs"] = {};
  for (const [from, imports] of Object.entries(graph)) {
    inputs[from] = { imports: imports.map((path) => ({ path })) };
  }
  const shipped = Object.fromEntries(Object.keys(graph).map((p) => [p, { bytesInOutput: 10 }]));
  return { inputs, outputs: { "client.js": { inputs: shipped } } };
}

Deno.test("tanstack-start import protection: maxTraceDepth caps the trace (Start's buildTrace)", async () => {
  const P = join("/", "p");
  const meta = metafile({
    "src/router.tsx": ["src/a.ts"],
    "src/a.ts": ["src/b.ts"],
    "src/b.ts": ["src/c.ts"],
    "src/c.ts": ["src/db.server.ts"],
    "src/db.server.ts": [],
  });
  const trace = async (maxTraceDepth?: number) => {
    const rules = compileImportProtection({ maxTraceDepth }, P, join(P, "src"));
    const [v] = await importProtectionViolations(meta, P, rules, "client");
    return v.trace.map((s) => s.file.slice(P.length + 1).replace(/\\/g, "/"));
  };
  // Default 20: the whole chain from the entry.
  assertEquals(await trace(), ["src/router.tsx", "src/a.ts", "src/b.ts", "src/c.ts"]);
  assertEquals(await trace(3), ["src/router.tsx", "src/a.ts", "src/b.ts", "src/c.ts"]);
  // No entry within reach: the importer alone, as in Start.
  assertEquals(await trace(2), ["src/c.ts"]);
  assertEquals(await trace(0), ["src/c.ts"]);
});

Deno.test('tanstack-start import protection: behavior "mock" is warned about; log sets how often', () => {
  assertEquals(mockNotice(undefined), null);
  assertEquals(mockNotice({ behavior: "error" }), null);
  assertEquals(mockNotice({ behavior: { build: "error" } }), null);
  assertEquals(mockNotice({ behavior: "mock", enabled: false }), null);
  assertStringIncludes(
    mockNotice({ behavior: { dev: "mock" } })!,
    'importProtection.behavior "mock" is not applied: denext fails the build',
  );
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (msg: string) => warnings.push(msg);
  try {
    const root = join("/", "p");
    const once = compileImportProtection({ behavior: "mock" }, root, join(root, "src"));
    once.noticeBehavior();
    once.noticeBehavior();
    assertEquals(warnings.length, 1, 'log "once" (the default) warns once');
    const always = compileImportProtection(
      { behavior: "mock", log: "always" },
      root,
      join(root, "src"),
    );
    always.noticeBehavior();
    always.noticeBehavior();
    assertEquals(warnings.length, 3, 'log "always" warns on every build');
    compileImportProtection({ log: "always" }, root, join(root, "src")).noticeBehavior();
    assertEquals(warnings.length, 3, "no mock, no warning");
  } finally {
    console.warn = warn;
  }
});
