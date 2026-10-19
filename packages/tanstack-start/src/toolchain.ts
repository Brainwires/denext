// TanStack Start's own build-time compiler, loaded from the APP's dependencies: the
// `createServerFn` / `createMiddleware` / `createIsomorphicFn` / `createServerOnlyFn` transform
// Start's Vite plugin runs (`@tanstack/start-plugin-core`), its server-function resolver module,
// and the Babel helpers it parses and prints with (`@tanstack/router-utils`, `@babel/core`).
// `@tanstack/start-plugin-core` is a dependency of `@tanstack/react-start`, so it is resolved
// from there; the plugin itself depends on no npm package. These run at build time only. The
// same package's sitemap builder (`denext export`) and import-protection mocks (a `"mock"`
// behavior) are loaded from it on demand.

import { createRequire } from "node:module";
import { dirname, join, toFileUrl } from "@std/path";
import type { SitemapOptions, StartPage } from "./prerender.ts";

/** The environment a module is compiled for. */
export type StartEnv = "client" | "server";

/** One server function the compiler found (`ServerFn` in TanStack's types). */
export interface ServerFnInfo {
  functionName: string;
  functionId: string;
  filename: string;
  extractedFilename: string;
  isClientReferenced?: boolean;
}

/** The slice of TanStack's `StartCompiler` the plugin drives. */
export interface StartCompilerLike {
  compile(opts: {
    code: string;
    id: string;
    detectedKinds?: Set<string>;
  }): Promise<{ code: string } | null>;
  ingestModule(opts: { code: string; id: string }): unknown;
}

/** Options for {@link StartToolchain.createCompiler}. */
export interface CompilerOptions {
  env: StartEnv;
  root: string;
  onServerFnsById: (fns: Record<string, ServerFnInfo>) => void;
  getKnownServerFns: () => Record<string, ServerFnInfo>;
  loadModule: (id: string) => Promise<void>;
  resolveId: (source: string, importer?: string) => Promise<string | null>;
}

/** A Babel AST node, as far as the plugin looks at one. */
// deno-lint-ignore no-explicit-any
type Node = any;

/** TanStack Start's compiler and helpers, loaded from the app. */
export interface StartToolchain {
  /** A `StartCompiler` for one environment (production ids: a hash of file + name). */
  createCompiler(opts: CompilerOptions): StartCompilerLike;
  /** Whether `code` may hold anything the compiler rewrites for `env` (a fast pre-scan). */
  mayNeedCompile(code: string, env: StartEnv): boolean;
  /** The kinds the compiler should look for in `code`. */
  detectKinds(code: string, env: StartEnv): Set<string>;
  /** The `#tanstack-start-server-fn-resolver` module for these server functions. */
  resolverModule(fns: Record<string, ServerFnInfo>): string;
  /** Babel: parse, traverse, eliminate dead code, print. */
  parse(code: string, filename: string): Node;
  traverse(ast: Node, visitors: Record<string, (path: Node) => void>): void;
  referencedIdentifiers(ast: Node): unknown;
  deadCodeElimination(ast: Node, refs: unknown): void;
  print(ast: Node, filename: string): string;
}

/** Resolve `specifier` from `fromFile` with Node's algorithm, through symlinks. */
function resolveFrom(fromFile: string, specifier: string): string {
  return Deno.realPathSync(createRequire(fromFile).resolve(specifier));
}

const importFile = (path: string) => import(toFileUrl(path).href);

/**
 * The app's `@tanstack/start-plugin-core` (a dependency of its `@tanstack/react-start`): its
 * `package.json`, and an importer of its built modules (`dist/esm/<rel>`).
 */
function startCore(projectRoot: string) {
  let startPkg: string;
  try {
    startPkg = resolveFrom(join(projectRoot, "package.json"), "@tanstack/react-start/package.json");
  } catch {
    throw new Error(
      "@denext/tanstack-start: add @tanstack/react-start to the app's package.json " +
        "(dependencies) and install it — the plugin runs TanStack Start's own runtime and compiler",
    );
  }
  const corePkg = resolveFrom(startPkg, "@tanstack/start-plugin-core/package.json");
  return {
    corePkg,
    core: (rel: string) => importFile(join(dirname(corePkg), "dist", "esm", rel)),
  };
}

/** What Start's `buildSitemap` reads: the `sitemap` option and the pages its prerender met. */
export interface SitemapInput {
  startConfig: { sitemap?: SitemapOptions; pages: StartPage[] };
  /** The directory the files are written to (the export's root). */
  publicDir: string;
}

/** Start's `buildSitemap`: writes `sitemap.xml` (at `sitemap.outputPath`) and `pages.json`. */
export type SitemapBuilder = (input: SitemapInput) => void | Promise<void>;

/**
 * Start's own `buildSitemap` (`@tanstack/start-plugin-core`'s `build-sitemap`), from the app at
 * `projectRoot`.
 *
 * @param projectRoot The app root (its `package.json` lists `@tanstack/react-start`).
 */
export async function loadSitemapBuilder(projectRoot: string): Promise<SitemapBuilder> {
  const mod = await startCore(projectRoot).core("build-sitemap.js");
  return mod.buildSitemap as SitemapBuilder;
}

/** What Start's import-protection mocks are made of (its `virtualModules` and `analysis`). */
export interface StartMocks {
  /** The id prefixes and the silent mock's id (`tanstack-start-import-protection:…`). */
  MOCK_MODULE_ID: string;
  MOCK_EDGE_PREFIX: string;
  MOCK_RUNTIME_PREFIX: string;
  /** A build mock's id prefix (a build's mock-edge runtime: Start's silent mock). */
  MOCK_BUILD_PREFIX: string;
  /** The runtime mock's id for a violation (diagnostics in the browser, per `mockAccess`). */
  mockRuntimeModuleIdFromViolation(
    info: { env: string; importer: string; specifier: string; trace: unknown[] },
    mode: "error" | "warn" | "off",
    root: string,
  ): string;
  /** A mock-edge module's id: the named exports the importer expects, over a runtime mock. */
  makeMockEdgeModuleId(exports: string[], runtimeId: string): string;
  loadSilentMockModule(): { code: string };
  loadMockEdgeModule(payload: string): { code: string };
  loadMockRuntimeModule(payload: string): { code: string };
  /** The module a denied file becomes in a build: its named exports over a mock of its own. */
  generateSelfContainedMockModule(exports: string[]): { code: string };
  /** The module a denied file becomes in dev: its named exports, over a runtime mock. */
  generateDevSelfDenialModule(exports: string[], runtimeId: string): { code: string };
  /** The names each import source is used by in `code` (named imports, member accesses). */
  getMockExportNamesBySource(code: string): Map<string, string[]>;
  /** A module's named exports. */
  getNamedExports(code: string, filename: string): string[];
}

/**
 * Start's own import-protection mocks (`@tanstack/start-plugin-core`'s `import-protection`
 * modules), from the app at `projectRoot`.
 *
 * @param projectRoot The app root (its `package.json` lists `@tanstack/react-start`).
 */
export async function loadStartMocks(projectRoot: string): Promise<StartMocks> {
  const { core } = startCore(projectRoot);
  const [modules, analysis] = await Promise.all([
    core("import-protection/virtualModules.js"),
    core("import-protection/analysis.js"),
  ]);
  return {
    ...modules,
    getMockExportNamesBySource: analysis.getMockExportNamesBySource,
    getNamedExports: analysis.getNamedExports,
  } as StartMocks;
}

/**
 * Load TanStack Start's compiler from the app at `projectRoot`.
 *
 * @param projectRoot The app root (its `package.json` lists `@tanstack/react-start`).
 */
export async function loadStartToolchain(projectRoot: string): Promise<StartToolchain> {
  const { corePkg, core } = startCore(projectRoot);
  const [host, compiler, config, resolver] = await Promise.all([
    core("start-compiler/host.js"),
    core("start-compiler/compiler.js"),
    core("start-compiler/config.js"),
    core("start-compiler/server-fn-resolver-module.js"),
  ]);
  const utils = await importFile(resolveFrom(corePkg, "@tanstack/router-utils"));
  const babelMod = await importFile(resolveFrom(corePkg, "@babel/core"));
  const babel = babelMod.default ?? babelMod;
  const filters = {
    client: config.getTransformCodeFilterForEnv("client") as RegExp[],
    server: config.getTransformCodeFilterForEnv("server") as RegExp[],
  };
  return {
    createCompiler: (opts) =>
      host.createStartCompiler({
        ...opts,
        envName: opts.env,
        mode: "build",
        framework: "react",
        providerEnvName: "server",
      }),
    mayNeedCompile: (code, env) => host.matchesCodeFilters(code, filters[env]),
    detectKinds: (code, env) => compiler.detectKindsInCode(code, env),
    resolverModule: (fns) =>
      resolver.generateServerFnResolverModule({
        serverFnsById: fns,
        includeClientReferencedCheck: false,
        memoizeModules: true,
      }),
    parse: (code, filename) => utils.parseAst({ code, filename }),
    traverse: (ast, visitors) => babel.traverse(ast, visitors),
    referencedIdentifiers: (ast) => utils.findReferencedIdentifiers(ast),
    deadCodeElimination: (ast, refs) => utils.deadCodeElimination(ast, refs),
    print: (ast, filename) => utils.generateFromAst(ast, { filename }).code,
  };
}
