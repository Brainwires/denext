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
//   is compiled again as the function's provider (`<file>?tss-serverfn-split`). denext's own
//   transforms (`"use cache"`, the `platform` fold) run on what it produced.
// - **A `"use server"` module** in the browser build: its server functions stay RPC stubs and
//   the rest of its source never ships (./use-server.ts), through denext's server-module stub.
// - **The bundles' guard** once each is built: Start's import protection on both sides (server
//   code the browser would get, browser code the server would run) and denext's server-only scan
//   in the browser (./protect.ts) fail the build. With Start's `"mock"` behavior (`denext dev`'s
//   default, as in Start) a violation is a warning instead, and the denied module Start's mock
//   (./mock.ts): its dev mocks in `denext dev`, its build mocks in a build. The browser
//   build's import graph is kept for the export's prerender (which routes reach a server
//   function).

import { dirname, extname } from "@std/path";
import {
  type BundleGraph,
  bundleGraph,
  compileImportProtection,
  DENIED_NS,
  deniedFilePattern,
  formatGuardError,
  formatViolation,
  type ImportProtection,
  type ImportProtectionViolation,
  importProtectionViolations,
  type Metafile,
  newResolveRecord,
  recordImport,
  resolveFilter,
  serverOnlyLeaks,
} from "./protect.ts";
import {
  loadStartMocks,
  type ServerFnInfo,
  type StartCompilerLike,
  type StartEnv,
  type StartMocks,
  type StartToolchain,
} from "./toolchain.ts";
import {
  type ImportTrail,
  importTrail,
  MOCK_ID,
  MOCK_NS,
  mockEdgeId,
  mockModuleSource,
  selfDenialSource,
} from "./mock.ts";
import { browserServerModule } from "./use-server.ts";

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
  /**
   * Start's import protection, as the app configures it. Default: Start's own rules, importers
   * under the router module's directory checked.
   */
  protection?: ImportProtection;
  /** Start's mock modules (default: loaded from the app when a `"mock"` needs them). */
  mocks?: () => Promise<StartMocks>;
}

/** A minimal esbuild plugin shape (the plugin-kit build takes them as `unknown[]`). */
interface EsbuildPluginBuild {
  onResolve(
    opts: { filter: RegExp; namespace?: string },
    cb: (
      args: {
        path: string;
        importer: string;
        resolveDir: string;
        namespace: string;
        kind?: string;
        pluginData?: unknown;
      },
    ) => unknown,
  ): void;
  onLoad(
    opts: { filter: RegExp; namespace?: string },
    cb: (args: { path: string; suffix?: string }) => unknown,
  ): void;
  resolve(
    path: string,
    opts: { importer?: string; resolveDir?: string; kind?: string; pluginData?: unknown },
  ): Promise<
    { path: string; namespace: string; external: boolean; errors: unknown[]; suffix?: string }
  >;
  initialOptions?: { metafile?: boolean; absWorkingDir?: string };
  onEnd?(cb: (result: { errors: unknown[]; metafile?: Metafile }) => unknown): void;
}

/** One environment's build: the esbuild plugin, and the client's `"use server"` modules. */
export interface StartBuild {
  /** The esbuild plugin (an `esbuild.Plugin`). */
  plugin: unknown;
  /**
   * The browser source of an app `"use server"` module that declares server functions, or
   * `null` (no server function in it, or not the client build): denext's
   * `serverModuleSource` hook.
   */
  serverModuleSource(path: string): Promise<string | null>;
  /**
   * The browser build's import graph and the app modules it compiled into server-function RPC
   * stubs, once a client build has run (`null` before, and for the server build).
   */
  clientGraph(): ClientGraph | null;
}

/** What a browser build reached: its import graph, and its server-function modules. */
export interface ClientGraph {
  graph: BundleGraph;
  /** The app modules the browser gets as RPC stubs (they call a server function). */
  serverFnModules: Set<string>;
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
  return startBuild(opts).plugin;
}

/**
 * One environment of a Start build: its esbuild plugin and, for the browser, the source of the
 * app's `"use server"` modules.
 *
 * @param opts The environment, TanStack's toolchain and the app's entry modules.
 */
export function startBuild(opts: StartBuildOptions): StartBuild {
  const tc = opts.toolchain;
  let compiler: StartCompilerLike | undefined;
  // What the browser build compiled, by real path (the server-only scan reads these) and by the
  // path the build used (the export's prerender reads its RPC stubs).
  const emitted = new Map<string, string>();
  const emittedAt = new Map<string, string>();
  const record = async (path: string, code: string) => {
    if (opts.env !== "client") return;
    emitted.set(await Deno.realPath(path).catch(() => path), code);
    emittedAt.set(path, code);
  };
  const protection = opts.protection ??
    compileImportProtection(undefined, opts.projectRoot, dirname(opts.routerFile));
  // A `"mock"`: what each module compiled to (a mock-edge module reads its importer's names), and
  // Start's mock modules, loaded once.
  const compiled = new Map<string, string>();
  let mocksLoaded: Promise<StartMocks> | undefined;
  const mocking: Mocking | null = protection.behavior === "mock"
    ? {
      mocks: () => (mocksLoaded ??= (opts.mocks ?? (() => loadStartMocks(opts.projectRoot)))()),
      code: async (path) => compiled.get(path) ?? await Deno.readTextFile(path),
    }
    : null;
  let graph: ClientGraph | null = null;
  const plugin = {
    name: `@denext/tanstack-start:${opts.env}`,
    setup(build: EsbuildPluginBuild) {
      compiler = tc.createCompiler({
        env: opts.env,
        root: opts.projectRoot,
        onServerFnsById: (fns) => opts.onServerFns?.(fns),
        getKnownServerFns: () => opts.knownServerFns,
        loadModule: async (id) => {
          const file = id.split("?")[0];
          const code = await Deno.readTextFile(file).catch(() => null);
          if (code !== null) compiler!.ingestModule({ code, id });
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

      build.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: "file" }, async (args) => {
        const out = (mocking && await selfDenial(args.path, opts.env, protection, mocking)) ??
          await transformModule(args.path, args.suffix === SPLIT_SUFFIX, compiler!, opts);
        if (out) {
          await record(args.path, out.contents);
          if (mocking) compiled.set(args.path, out.contents);
        }
        return out;
      });
      guardBundle(build, { env: opts.env, protection, emitted, mocking }, (meta, cwd) => {
        if (opts.env !== "client") return;
        const serverFnModules = new Set<string>();
        for (const [path, code] of emittedAt) {
          if (code.includes("createClientRpc(")) serverFnModules.add(path);
        }
        graph = { graph: bundleGraph(meta, cwd), serverFnModules };
      });
    },
  };
  return {
    plugin,
    async serverModuleSource(path) {
      if (opts.env !== "client" || !compiler) return null;
      const source = await Deno.readTextFile(path);
      if (!tc.mayNeedCompile(source, "client")) return null;
      const stripped = stripServerRouteOptions(source, path, tc) ?? source;
      const compiled = await compileModule(stripped, path, false, compiler, opts);
      if (compiled === stripped) return null; // no server function: denext refuses the module
      const code = browserServerModule(compiled, path, tc);
      await record(path, code);
      return code;
    },
    clientGraph: () => graph,
  };
}

/** A `"mock"` build's mock modules and its modules' code (read by a mock-edge module). */
interface Mocking {
  mocks(): Promise<StartMocks>;
  code(path: string): Promise<string>;
  /** The imports seen so far, when a runtime mock's message lists a trace (dev, the browser). */
  trail?: ImportTrail;
}

/** The `pluginData` of a resolve the import trail makes (every hook of the plugin skips it). */
const TRAIL_PROBE = { denextTssTrailProbe: true };

/** Whether a resolve is the import trail's own. */
const isTrailProbe = (pluginData: unknown) =>
  (pluginData as typeof TRAIL_PROBE | undefined)?.denextTssTrailProbe === true;

/**
 * With a `"mock"` behavior, a file the environment's `files` rules deny is loaded as Start's
 * self-denial module (its named exports over a mock) instead of itself; `null` otherwise.
 */
async function selfDenial(
  path: string,
  env: StartEnv,
  protection: ImportProtection,
  mocking: Mocking,
): Promise<{ contents: string; loader: string; resolveDir: string } | null> {
  if (deniedFilePattern(protection, env, path) === undefined) return null;
  const source = await Deno.readTextFile(path);
  const contents = selfDenialSource(await mocking.mocks(), protection, {
    env,
    file: path,
    source,
    trace: await mocking.trail?.trace(path),
  });
  return { contents, loader: "js", resolveDir: dirname(path) };
}

/** What a bundle's guard checks. */
interface GuardOptions {
  env: StartEnv;
  protection: ImportProtection;
  /** What the browser build compiled (the server-only scan reads it). */
  emitted: Map<string, string>;
  /** A `"mock"`: denied imports resolve to Start's mocks and violations warn. */
  mocking: Mocking | null;
}

/**
 * Fail a build on what crossed sides: Start's import protection over the bundle's metafile (both
 * sides) and, in the browser, denext's server-only scan, each compiled module read as compiled.
 * With a `"mock"` behavior a violation is a warning instead, and the import a mock.
 * `onGraph` receives the metafile of a build that passed.
 */
function guardBundle(
  build: EsbuildPluginBuild,
  { env, protection, emitted, mocking }: GuardOptions,
  onGraph: (meta: Metafile, cwd: string) => void,
): void {
  if (!build.initialOptions || !build.onEnd) return;
  build.initialOptions.metafile = true;
  const cwd = build.initialOptions.absWorkingDir ?? Deno.cwd();
  // Start's markers and the environment's denied specifiers, as the app's modules import them:
  // recorded, and a denied one an empty module (CommonJS, so a named import still binds) until
  // the end decides whether the import survived.
  let record = newResolveRecord();
  if (mocking) mocking.trail = trailOf(build, { env, protection, cwd });
  build.onResolve({ filter: resolveFilter(protection, env) }, async (args) => {
    if (args.namespace !== "file") return undefined;
    // The trail's probe of a denied import: not an import of the build's (nothing to record).
    if (isTrailProbe(args.pluginData)) return { path: args.path, external: true };
    const denied = record.denied.length;
    const action = recordImport(protection, env, record, args.path, args.importer);
    if (action !== "mock") return undefined;
    // A denied specifier in a "mock": Start's mock-edge module (a marker stays empty).
    if (mocking && record.denied.length > denied) {
      const id = mockEdgeId(await mocking.mocks(), protection, {
        env,
        importer: args.importer,
        importerCode: await mocking.code(args.importer),
        specifier: args.path,
        trace: await mocking.trail?.trace(args.importer),
      });
      record.denied[denied].module = `${MOCK_NS}:${id}`;
      return { path: id, namespace: MOCK_NS };
    }
    return { path: args.path, namespace: DENIED_NS };
  });
  if (mocking) {
    build.onResolve({ filter: MOCK_ID }, (args) => ({ path: args.path, namespace: MOCK_NS }));
    build.onLoad({ filter: /.*/, namespace: MOCK_NS }, async (args) => ({
      contents: mockModuleSource(await mocking.mocks(), args.path),
      loader: "js",
      resolveDir: cwd,
    }));
  }
  build.onLoad({ filter: /.*/, namespace: DENIED_NS }, () => ({
    contents: "module.exports = {};",
    loader: "js",
    resolveDir: cwd,
  }));
  build.onEnd(async (result) => {
    const seen = record;
    record = newResolveRecord();
    if (result.errors.length > 0 || !result.metafile) return;
    const violations = await importProtectionViolations(
      result.metafile,
      cwd,
      protection,
      env,
      seen,
    );
    let leaks: Awaited<ReturnType<typeof serverOnlyLeaks>> = [];
    if (env === "client") {
      const read = async (path: string) =>
        emitted.get(await Deno.realPath(path).catch(() => path)) ?? await Deno.readTextFile(path);
      // Start's server-only marker is denext's marker too: reported once, by Start's rule.
      const marked = new Set(violations.filter((v) => v.type === "marker").map((v) => v.importer));
      leaks = (await serverOnlyLeaks(result.metafile, cwd, read))
        .filter((leak) => !marked.has(leak.module));
    }
    if (mocking) warnMocked(violations, protection, cwd);
    const message = formatGuardError(mocking ? [] : violations, leaks, cwd);
    if (message) throw new Error(message);
    onGraph(result.metafile, cwd);
  });
}

/**
 * A dev browser build's import trail (a runtime mock's message lists its trace), or `undefined`
 * where Start's runtime mock is the silent one (a build, the server, `mockAccess: "off"`). It
 * notes each app module's imports as esbuild resolves them, and resolves them again, marked as
 * its probe, only when a violation asks for a trace.
 */
function trailOf(
  build: EsbuildPluginBuild,
  { env, protection, cwd }: { env: StartEnv; protection: ImportProtection; cwd: string },
): ImportTrail | undefined {
  if (protection.command === "build" || env !== "client" || protection.mockAccess === "off") {
    return undefined;
  }
  const trail = importTrail(
    async ({ importer, specifier, resolveDir, kind }) => {
      const r = await build.resolve(specifier, {
        importer,
        resolveDir,
        kind,
        pluginData: TRAIL_PROBE,
      });
      return r.errors.length > 0 || r.external || r.namespace !== "file" ? null : r.path;
    },
    cwd,
    protection.maxTraceDepth,
  );
  build.onResolve({ filter: /.*/, namespace: "file" }, (args) => {
    if (!isTrailProbe(args.pluginData) && args.importer) {
      trail.note({
        importer: args.importer,
        specifier: args.path,
        resolveDir: args.resolveDir,
        kind: args.kind ?? "import-statement",
      });
    }
    return undefined;
  });
  return trail;
}

/**
 * Warn about each mocked violation in Start's words, once per process (`log: "once"`) or on every
 * build (`log: "always"`), as Start does.
 */
function warnMocked(
  violations: ImportProtectionViolation[],
  protection: ImportProtection,
  cwd: string,
): void {
  for (const v of violations) {
    if (
      protection.reportsMocked(`${v.type}|${v.envType}|${v.importer}|${v.resolved ?? v.specifier}`)
    ) {
      console.warn(formatViolation(v, cwd));
    }
  }
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
