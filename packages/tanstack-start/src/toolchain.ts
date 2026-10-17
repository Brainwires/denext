// TanStack Start's own build-time compiler, loaded from the APP's dependencies: the
// `createServerFn` / `createMiddleware` / `createIsomorphicFn` / `createServerOnlyFn` transform
// Start's Vite plugin runs (`@tanstack/start-plugin-core`), its server-function resolver module,
// and the Babel helpers it parses and prints with (`@tanstack/router-utils`, `@babel/core`).
// `@tanstack/start-plugin-core` is a dependency of `@tanstack/react-start`, so it is resolved
// from there; the plugin itself depends on no npm package. These run at build time only.

import { createRequire } from "node:module";
import { dirname, join, toFileUrl } from "@std/path";

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
 * Load TanStack Start's compiler from the app at `projectRoot`.
 *
 * @param projectRoot The app root (its `package.json` lists `@tanstack/react-start`).
 */
export async function loadStartToolchain(projectRoot: string): Promise<StartToolchain> {
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
  const core = (rel: string) => importFile(join(dirname(corePkg), "dist", "esm", rel));
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
