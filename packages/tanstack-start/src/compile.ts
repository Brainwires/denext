// The esbuild side of a Start build, one plugin per environment, ahead of denext's own:
//
// - **Start's virtual modules.** `#tanstack-router-entry` (the app's router factory),
//   `#tanstack-start-entry` (`src/start.ts`'s `startInstance`, when there is one),
//   `#tanstack-start-plugin-adapters`, and on the server `#tanstack-start-server-fn-resolver`
//   (server-function id → its module) and `tanstack-start-manifest:v` (the client entry the root
//   route's `<Scripts />` loads).
// - **TanStack's own compiler** over the app's modules: in the browser a `createServerFn`
//   handler becomes an RPC stub (`createClientRpc(id)`) and its validator and server-only code
//   are dropped, as are `createMiddleware().server()`, `createServerOnlyFn` bodies and a route's
//   `server` / `headers` / `ssr` options (so a server route's handlers and their imports never
//   reach the client); on the server a caller gets `createSsrRpc(id)`, and the module behind it
//   is compiled again as the function's provider (`<file>?tss-serverfn-split`).

import { dirname, extname } from "@std/path";
import type { ServerFnInfo, StartCompilerLike, StartEnv, StartToolchain } from "./toolchain.ts";

/** The query naming a server-function provider module (Start's `TSS_SERVERFN_SPLIT_PARAM`). */
export const SPLIT_SUFFIX = "?tss-serverfn-split";

/** A route's options Start deletes from the client build (its router plugin's `deleteNodes`). */
const SERVER_ONLY_ROUTE_OPTIONS = new Set(["server", "headers", "ssr"]);

/** Route factories whose options object the client build prunes. */
const CURRIED_FACTORIES = new Set(["createFileRoute", "createRootRouteWithContext"]);
const DIRECT_FACTORIES = new Set(["createRootRoute", "createRoute"]);

/** What a build's plugin needs to know about the app. */
export interface StartBuildOptions {
  env: StartEnv;
  toolchain: StartToolchain;
  projectRoot: string;
  /** The router module (`src/router.tsx`). */
  routerFile: string;
  /** `src/start.ts`, when the app has one. */
  startFile: string | null;
  /** The router manifest `<Scripts />` reads (server only). */
  manifest?: unknown;
  /** The server functions the resolver module maps (server only). */
  knownServerFns: Record<string, ServerFnInfo>;
  /** Called with every server function the compiler meets. */
  onServerFns?: (fns: Record<string, ServerFnInfo>) => void;
}

/** A minimal esbuild plugin shape (the plugin-kit build takes them as `unknown[]`). */
interface EsbuildPluginBuild {
  onResolve(
    opts: { filter: RegExp; namespace?: string },
    cb: (
      args: { path: string; importer: string; resolveDir: string; namespace: string },
    ) => unknown,
  ): void;
  onLoad(
    opts: { filter: RegExp; namespace?: string },
    cb: (args: { path: string; suffix?: string }) => unknown,
  ): void;
  resolve(
    path: string,
    opts: { importer?: string; resolveDir?: string; kind?: string },
  ): Promise<
    { path: string; namespace: string; external: boolean; errors: unknown[]; suffix?: string }
  >;
}

const VIRTUAL_NS = "denext-tss";
const VIRTUAL_IDS =
  /^(#tanstack-router-entry|#tanstack-start-entry|#tanstack-start-plugin-adapters|#tanstack-start-server-fn-resolver|tanstack-start-manifest:v)$/;

/** A virtual module's esbuild path: `#tanstack-router-entry` → `tanstack-router-entry`. */
const virtualName = (id: string) => id.replace(/^#/, "").replace(/:v$/, "");
const VIRTUAL_BY_NAME = new Map(
  [
    "#tanstack-router-entry",
    "#tanstack-start-entry",
    "#tanstack-start-plugin-adapters",
    "#tanstack-start-server-fn-resolver",
    "tanstack-start-manifest:v",
  ].map((id) => [virtualName(id), id]),
);

/** A module importing one of Start's packages (where its compiler-handled factories live). */
const START_IMPORT = /["']@tanstack\/(?:react-start|start-)[\w/-]*["']/;

/** Whether a path is inside a package. */
const inNodeModules = (path: string) => /[\\/]node_modules[\\/]/.test(path);

/** The esbuild loader for a module path. */
function loaderOf(path: string): string {
  const ext = extname(path).slice(1);
  return ext === "mjs" || ext === "cjs" ? "js" : ext;
}

/** A path as a module specifier (forward slashes). */
const spec = (path: string) => JSON.stringify(path.replace(/\\/g, "/"));

/** The source of one of Start's virtual modules. */
export function virtualModuleSource(id: string, opts: StartBuildOptions): string {
  switch (id) {
    case "#tanstack-router-entry":
      return `import * as app from ${spec(opts.routerFile)};
const exported = { ...app };
export const getRouter = exported.getRouter ?? exported.createRouter;
if (typeof getRouter !== "function") {
  throw new Error("@denext/tanstack-start: the router module exports no getRouter()");
}
`;
    case "#tanstack-start-entry":
      return opts.startFile
        ? `export { startInstance } from ${spec(opts.startFile)};\n`
        : `export const startInstance = undefined;\n`;
    case "#tanstack-start-plugin-adapters":
      return `export const hasPluginAdapters = false;\nexport const pluginSerializationAdapters = [];\n`;
    case "#tanstack-start-server-fn-resolver":
      return opts.toolchain.resolverModule(opts.knownServerFns);
    default: // tanstack-start-manifest:v
      return `export const tsrStartManifest = () => (${JSON.stringify(opts.manifest ?? {})});\n`;
  }
}

/**
 * Drop a route's server-only options (`server`, `headers`, `ssr`) from `createFileRoute(…)({…})`,
 * `createRootRoute({…})` and friends, then the imports only they used. `null` when the module
 * declares none.
 */
export function stripServerRouteOptions(
  code: string,
  filename: string,
  tc: StartToolchain,
): string | null {
  if (!/\b(?:server|headers|ssr)\s*:/.test(code) || !/\bcreate\w*Route\w*\s*\(/.test(code)) {
    return null;
  }
  const ast = tc.parse(code, filename);
  const refs = tc.referencedIdentifiers(ast);
  let changed = false;
  tc.traverse(ast, {
    CallExpression(path) {
      const { callee, arguments: args } = path.node;
      const factory = callee.type === "CallExpression" && callee.callee.type === "Identifier"
        ? CURRIED_FACTORIES.has(callee.callee.name)
        : callee.type === "Identifier" && DIRECT_FACTORIES.has(callee.name);
      const options = args[0];
      if (!factory || options?.type !== "ObjectExpression") return;
      const kept = options.properties.filter((
        p: { type: string; key?: unknown; computed?: boolean },
      ) =>
        !((p.type === "ObjectProperty" || p.type === "ObjectMethod") && !p.computed &&
          SERVER_ONLY_ROUTE_OPTIONS.has(keyName(p.key)))
      );
      if (kept.length === options.properties.length) return;
      options.properties = kept;
      changed = true;
    },
  });
  if (!changed) return null;
  tc.deadCodeElimination(ast, refs);
  return tc.print(ast, filename);
}

function keyName(key: unknown): string {
  const k = key as { type?: string; name?: string; value?: unknown };
  if (k?.type === "Identifier") return k.name ?? "";
  if (k?.type === "StringLiteral") return String(k.value);
  return "";
}

/**
 * The esbuild plugin for one environment of a Start build (an `esbuild.Plugin`).
 *
 * @param opts The environment, TanStack's toolchain and the app's entry modules.
 */
export function startBuildPlugin(opts: StartBuildOptions): unknown {
  const tc = opts.toolchain;
  return {
    name: `@denext/tanstack-start:${opts.env}`,
    setup(build: EsbuildPluginBuild) {
      const compiler = tc.createCompiler({
        env: opts.env,
        root: opts.projectRoot,
        onServerFnsById: (fns) => opts.onServerFns?.(fns),
        getKnownServerFns: () => opts.knownServerFns,
        loadModule: async (id) => {
          const file = id.split("?")[0];
          const code = await Deno.readTextFile(file).catch(() => null);
          if (code !== null) compiler.ingestModule({ code, id });
        },
        resolveId: async (source, importer) => {
          const from = importer?.split("?")[0];
          const r = await build.resolve(source, {
            importer: from,
            resolveDir: from ? dirname(from) : opts.projectRoot,
            kind: "import-statement",
          });
          if (r.errors.length > 0 || r.external || r.namespace !== "file") return null;
          return r.path;
        },
      });

      build.onResolve({ filter: VIRTUAL_IDS }, (args) => {
        if (args.path === "#tanstack-start-server-fn-resolver" && opts.env !== "server") {
          return null;
        }
        // A path free of `#` and `:` — esbuild names a chunk split off a virtual module after it,
        // and `#` in a chunk's file URL would be read as a fragment.
        return { path: virtualName(args.path), namespace: VIRTUAL_NS };
      });
      // The virtual modules import the app's modules by absolute path.
      build.onResolve(
        { filter: /^(?:\/|[A-Za-z]:[\\/])/, namespace: VIRTUAL_NS },
        (args) => args.path.endsWith(SPLIT_SUFFIX) ? null : { path: args.path },
      );
      build.onLoad({ filter: /.*/, namespace: VIRTUAL_NS }, (args) => ({
        contents: virtualModuleSource(VIRTUAL_BY_NAME.get(args.path) ?? args.path, opts),
        loader: "ts",
        resolveDir: opts.projectRoot,
      }));
      // A provider module: the file itself, compiled again as the functions' server half.
      build.onResolve({ filter: /\?tss-serverfn-split$/ }, (args) => ({
        path: args.path.slice(0, -SPLIT_SUFFIX.length),
        suffix: SPLIT_SUFFIX,
      }));

      build.onLoad(
        { filter: /\.[cm]?[jt]sx?$/, namespace: "file" },
        (args) => transformModule(args.path, args.suffix === SPLIT_SUFFIX, compiler, opts),
      );
    },
  };
}

/**
 * One module through the plugin: an app module (or a package that builds on Start) the compiler
 * rewrites, and in the browser a route's server-only options dropped. `undefined` leaves the
 * module to denext's own loaders.
 */
async function transformModule(
  path: string,
  provider: boolean,
  compiler: StartCompilerLike,
  opts: StartBuildOptions,
): Promise<{ contents: string; loader: string; resolveDir: string } | undefined> {
  const source = await Deno.readTextFile(path);
  const pkg = inNodeModules(path);
  if (pkg && !buildsOnStart(source, opts)) return undefined;
  const stripped = opts.env === "client" && !pkg
    ? stripServerRouteOptions(source, path, opts.toolchain) ?? source
    : source;
  const code = await compileModule(stripped, path, provider, compiler, opts);
  if (code === source && !provider) return undefined;
  return { contents: code, loader: loaderOf(path), resolveDir: dirname(path) };
}

/**
 * Whether a package module is compiled: only one that builds on Start (Start's own client core
 * wraps its server-only helpers in `createServerOnlyFn`, which the browser build must drop).
 */
function buildsOnStart(source: string, opts: StartBuildOptions): boolean {
  return START_IMPORT.test(source) && opts.toolchain.mayNeedCompile(source, opts.env);
}

/** `code` through TanStack's compiler when it holds anything to rewrite (always for a provider). */
async function compileModule(
  code: string,
  path: string,
  provider: boolean,
  compiler: StartCompilerLike,
  opts: StartBuildOptions,
): Promise<string> {
  if (!provider && !opts.toolchain.mayNeedCompile(code, opts.env)) return code;
  // The real path: ids hash it relative to the (real) root, as the scan does.
  const file = await Deno.realPath(path);
  const compiled = await compiler.compile({
    code,
    id: provider ? file + SPLIT_SUFFIX : file,
    detectedKinds: opts.toolchain.detectKinds(code, opts.env),
  });
  return compiled?.code ?? code;
}
