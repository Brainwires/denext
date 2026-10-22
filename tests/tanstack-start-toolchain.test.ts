// @denext/tanstack-start's toolchain loader (packages/tanstack-start/src/toolchain.ts): TanStack
// Start's compiler, sitemap builder and import-protection mocks are loaded from the APP's own
// node_modules, `@tanstack/start-plugin-core` resolved through its `@tanstack/react-start`, and its
// Babel helpers through the plugin core. The real Start packages are exercised by the
// installed-example suites (tests/tanstack-start-*.test.ts, ignored unless installed); here a
// node_modules tree of stand-ins for Start's own modules, laid out as npm installs them, proves the
// resolution and every call the plugin makes through them (router-utils' Babel helpers are the
// real ones, from the lock), and the refusal when the app has no Start.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  loadSitemapBuilder,
  loadStartMocks,
  loadStartToolchain,
} from "../packages/tanstack-start/src/toolchain.ts";

/** What the stand-ins were called with, in order. */
type Calls = [string, unknown][];
const g = globalThis as unknown as { __startCalls?: Calls };

/** Write `files` (relative path → text) under `root`. */
async function tree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await Deno.mkdir(join(root, rel, ".."), { recursive: true });
    await Deno.writeTextFile(join(root, rel), text);
  }
}

const pkg = (name: string, main = "index.js") =>
  JSON.stringify({ name, version: "0.0.0-test", type: "module", main });

/** A stand-in module: each export records its call and answers `result`. */
const record = (name: string, result: string) =>
  `export const ${name} = (...args) => { globalThis.__startCalls.push([${
    JSON.stringify(name)
  }, args]); return ${result}; };\n`;

const CORE = "node_modules/@tanstack/start-plugin-core";

/** An app whose node_modules hold stand-ins for Start's packages (hoisted, as npm lays them out). */
async function app(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "denext_start_toolchain_" });
  await tree(root, {
    "package.json": JSON.stringify({ dependencies: { "@tanstack/react-start": "*" } }),
    "node_modules/@tanstack/react-start/package.json": pkg("@tanstack/react-start"),
    [`${CORE}/package.json`]: pkg("@tanstack/start-plugin-core"),
    [`${CORE}/dist/esm/start-compiler/host.js`]: record("createStartCompiler", "{ host: true }") +
      record("matchesCodeFilters", "args[1].length === 1"),
    [`${CORE}/dist/esm/start-compiler/compiler.js`]: record(
      "detectKindsInCode",
      "new Set([args[1]])",
    ),
    [`${CORE}/dist/esm/start-compiler/config.js`]: record(
      "getTransformCodeFilterForEnv",
      "args[0] === 'client' ? [/c/] : [/s/, /t/]",
    ),
    [`${CORE}/dist/esm/start-compiler/server-fn-resolver-module.js`]: record(
      "generateServerFnResolverModule",
      "'resolver module'",
    ),
    [`${CORE}/dist/esm/build-sitemap.js`]: record("buildSitemap", "undefined"),
    [`${CORE}/dist/esm/import-protection/virtualModules.js`]:
      `export const MOCK_MODULE_ID = "tanstack-start-import-protection:mock";\n` +
      record("loadSilentMockModule", "{ code: 'silent' }"),
    [`${CORE}/dist/esm/import-protection/analysis.js`]:
      record("getMockExportNamesBySource", "new Map()") +
      record("getNamedExports", "['a', 'b']"),
    // @babel/core: its API is the default export (the CommonJS shape).
    "node_modules/@babel/core/package.json": pkg("@babel/core"),
    "node_modules/@babel/core/index.js": `${record("traverse", "undefined")}` +
      "export default { traverse };\n",
  });
  return root;
}

Deno.test("loadStartToolchain: Start's compiler from the app, driven as the plugin drives it", async () => {
  const root = await app();
  g.__startCalls = [];
  try {
    const t = await loadStartToolchain(root);
    const calls = g.__startCalls;
    // The code filters are read once per environment at load.
    assertEquals(calls.map(([n, a]) => [n, a]), [
      ["getTransformCodeFilterForEnv", ["client"]],
      ["getTransformCodeFilterForEnv", ["server"]],
    ]);
    calls.length = 0;
    const onServerFnsById = () => {};
    const compiler = t.createCompiler({
      env: "server",
      root,
      onServerFnsById,
      getKnownServerFns: () => ({}),
      loadModule: () => Promise.resolve(),
      resolveId: () => Promise.resolve(null),
    });
    assertEquals(compiler as unknown, { host: true });
    const [name, [opts]] = calls[0] as [string, [Record<string, unknown>]];
    assertEquals(name, "createStartCompiler");
    assertEquals(
      [opts.env, opts.envName, opts.mode, opts.framework, opts.providerEnvName, opts.root],
      ["server", "server", "build", "react", "server", root],
    );
    assert(opts.onServerFnsById === onServerFnsById);
    // The fast pre-scan gets that environment's filters; the kinds come from the compiler.
    assertEquals(t.mayNeedCompile("code", "client"), true); // one client filter
    assertEquals(t.mayNeedCompile("code", "server"), false); // two server filters
    assertEquals([...t.detectKinds("x", "client")], ["client"]);
    assertEquals(t.resolverModule({ a: {} as never }), "resolver module");
    const resolver = calls.find(([n]) => n === "generateServerFnResolverModule")!;
    assertEquals(resolver[1], [{
      serverFnsById: { a: {} },
      includeClientReferencedCheck: false,
      memoizeModules: true,
    }]);
    // Babel: the real @tanstack/router-utils (in the lock, as a dependency of
    // @tanstack/router-plugin) parses, finds references, eliminates dead code and prints; traverse
    // is @babel/core's (a stand-in here), handed the AST and the visitors as given.
    const ast = t.parse("const used = 1;\nconst unused = () => 2;\nconsole.log(used);\n", "a.ts");
    assertEquals(ast.type, "File");
    const visitors = { Identifier: () => {} };
    t.traverse(ast, visitors);
    const traversed = calls.at(-1)!;
    assertEquals(traversed[0], "traverse");
    assert((traversed[1] as unknown[])[0] === ast && (traversed[1] as unknown[])[1] === visitors);
    // Dead-code elimination drops what was referenced before an edit and no longer is: with the
    // `console.log(used)` statement gone, `used` goes too.
    const refs = t.referencedIdentifiers(ast);
    ast.program.body.pop();
    t.deadCodeElimination(ast, refs);
    const printed = t.print(ast, "a.ts");
    assertStringIncludes(printed, "const unused = () => 2;");
    assert(!printed.includes("used = 1"), printed);
  } finally {
    delete g.__startCalls;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadSitemapBuilder / loadStartMocks: Start's own modules, from the app", async () => {
  const root = await app();
  g.__startCalls = [];
  try {
    const build = await loadSitemapBuilder(root);
    await build({ startConfig: { pages: [] }, publicDir: "/out" });
    assertEquals(g.__startCalls[0], ["buildSitemap", [{
      startConfig: { pages: [] },
      publicDir: "/out",
    }]]);
    const mocks = await loadStartMocks(root);
    assertEquals(mocks.MOCK_MODULE_ID, "tanstack-start-import-protection:mock");
    assertEquals(mocks.loadSilentMockModule(), { code: "silent" });
    assertEquals(mocks.getNamedExports("export const a = 1", "a.ts"), ["a", "b"]);
    assert(mocks.getMockExportNamesBySource("") instanceof Map);
  } finally {
    delete g.__startCalls;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadStartToolchain: an app without @tanstack/react-start is told to install it", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext_start_none_" });
  try {
    await Deno.writeTextFile(join(root, "package.json"), "{}");
    for (const load of [loadStartToolchain, loadSitemapBuilder, loadStartMocks]) {
      const err = await assertRejects(() => load(root), Error);
      assertStringIncludes(err.message, "add @tanstack/react-start to the app's package.json");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
