// Unbundled dev, React Native mode (`reactNative` in the config): the per-module loop for an
// Expo / React Native app, so an edit to one of the app's modules hot-swaps it in place with
// its hook state kept (Fast Refresh), as in the App Router and the other SPA paths.
//
// React Native mode's resolution (react-native → react-native-web and its overlay, the
// `expo-*` shims, expo-router's route context and navigators, the list adapters, the worklets
// transform, the community aliases) lives in esbuild plugins that must see a package's whole
// graph. So the split is Vite's:
//
//   - The APP's own modules are served one by one (`@fs`), with `.web.*` probed first, `.js`
//     parsed as JSX, the build's `define`s, a static `require("…")` turned into an import, and
//     the worklets transform applied — each one re-transformed alone on an edit.
//   - Every PACKAGE import (and every non-code asset the app imports) is served from ONE
//     dependency bundle (`@npm`) built through `bundleNextCompatModules` with React Native
//     mode's plugins, exactly as `denext build` resolves them. Each specifier gets a small entry
//     that re-exports the names the app imports from it (CommonJS packages included) plus a
//     `__denextCjs` view for `require`. React, `denext/*` and `next/*` stay external — the
//     prebuilt runtime under `@dep` — so the page has one denext instance; so do the app's
//     own modules a package reaches (expo-router's route context imports every route), which
//     resolve to their `@fs` URLs.
//
// The dependency bundle is rebuilt when the app first imports a new specifier or name (the
// page then reloads: a module linking against the old bundle fails, and the client reloads),
// when a dependency manifest changes, and when an expo-router route is added or removed.
//
// @module

import { basename, dirname, join, resolve, SEPARATOR } from "@std/path";
import { ensureDir } from "@std/fs";
import type * as esbuild from "esbuild";
import { EXPO_RN_BRIDGE } from "../expo-shims.ts";
import { expoRouterRoot, expoRouterRouteFiles } from "../expo-router.ts";
import { bundleNextCompatModules } from "../next-compat.ts";
import { transformWorklets, WORKLETS_GATE } from "../reanimated.ts";
import {
  applyEdits,
  type Edit,
  endOf,
  type Node,
  parseModule,
  startOf,
  walkAst,
} from "../swc-ast.ts";
import type { ParsedModule } from "../swc-ast.ts";
import { CODE_FILE, firstPartyProbe, libraryDepUrl, runtimeDepUrl } from "./resolve.ts";
import {
  addImporter,
  crawlModuleGraph,
  depSlug,
  fsUrlPath,
  norm,
  NPM_PREFIX,
  type UnbundledState,
  versionOf,
} from "./state.ts";
import { inNodeModules } from "../path-segments.ts";

/**
 * The importer key the dependency bundle's edges to app modules are recorded under. It starts
 * with `entry:`, so an edit that propagates to it (a non-component module a package imports)
 * is a full reload: the bundle bakes the module's URL in.
 */
const NPM_IMPORTER = "entry:npm";

/** The named export every dependency entry carries: what `require(spec)` returns. */
const CJS_VIEW = "__denextCjs";

/** A name valid after `export { x as … }` (an IdentifierName: reserved words allowed). */
const EXPORT_NAME = /^[A-Za-z_$][\w$]*$/;

/**
 * Seed the specifiers every React Native app's page needs from the dependency bundle, so the
 * first build covers them: `react-native` itself and the `denext/expo/*` shims' bridge to
 * react-native-web (the prebuilt runtime imports it bare; see {@linkcode rewriteRuntimeBridges}).
 *
 * @param st The unbundled dev state.
 */
export function seedReactNativeSpecs(st: UnbundledState): void {
  st.npmSpecs.add("react-native");
  st.npmSpecs.add(EXPO_RN_BRIDGE);
  st.npmNames.set(EXPO_RN_BRIDGE, new Set(["*"]));
}

/**
 * The prebuilt runtime file `code` with its bare bridge import (`denext-expo-react-native`,
 * resolved by React Native mode to react-native-web) pointed at the dependency bundle's entry
 * for it — a browser cannot resolve a bare specifier.
 *
 * @param code A prebuilt runtime file's source.
 * @returns The source, bridge imports rewritten.
 */
export function rewriteRuntimeBridges(code: string): string {
  const bare = JSON.stringify(EXPO_RN_BRIDGE);
  if (!code.includes(bare)) return code;
  return code.replaceAll(bare, JSON.stringify(`${NPM_PREFIX}${depSlug(EXPO_RN_BRIDGE)}.js`));
}

/**
 * The names a module imports (or re-exports) from each specifier: `default`, each named
 * binding, and `*` for a namespace import or `export *`. Type-only imports are skipped; a
 * side-effect import records the specifier with no names.
 *
 * @param parsed The parsed module.
 * @returns Specifier → names.
 */
export function importedNames(parsed: ParsedModule): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (spec: string, name?: string) => {
    let set = out.get(spec);
    if (!set) out.set(spec, set = new Set());
    if (name) set.add(name);
  };
  for (const item of parsed.body) {
    const spec: string | undefined = item.source?.value;
    if (typeof spec !== "string" || item.typeOnly) continue;
    if (item.type === "ExportAllDeclaration") add(spec, "*");
    else if (item.type === "ImportDeclaration" || item.type === "ExportNamedDeclaration") {
      add(spec);
      for (const s of item.specifiers ?? []) add(spec, specifierName(s));
    }
  }
  return out;
}

/** The imported name of one import / re-export specifier, or undefined for a type-only one. */
function specifierName(s: Node): string | undefined {
  if (s.isTypeOnly) return undefined;
  switch (s.type) {
    case "ImportDefaultSpecifier":
      return "default";
    case "ImportNamespaceSpecifier":
    case "ExportNamespaceSpecifier":
      return "*";
    case "ImportSpecifier":
      return (s.imported ?? s.local)?.value;
    case "ExportSpecifier":
      return s.orig?.value;
    case "ExportDefaultSpecifier":
      return "default";
  }
  return undefined;
}

/** A `require("literal")` call: the callee is the bare identifier, one string argument. */
function requireSpecifier(n: Node): string | null {
  if (n.type !== "CallExpression" || n.callee?.type !== "Identifier") return null;
  if (n.callee.value !== "require" || n.arguments?.length !== 1) return null;
  const arg = n.arguments[0];
  if (arg.spread || arg.expression?.type !== "StringLiteral") return null;
  return arg.expression.value;
}

/**
 * `source` with each static `require("…")` call replaced by a hoisted import of the same
 * specifier — a browser module cannot `require`, and React Native code loads images (and
 * sometimes modules) that way. The call evaluates to what a bundle's `require` gives: a
 * package's CommonJS exports (or an ES module's namespace), an asset's URL, or an app
 * module's namespace. The imports and the helper go at the END, so every line keeps its
 * number. Returns `source` unchanged when it has no such call.
 *
 * @param source The module source.
 * @param parsed The parsed `source`.
 * @returns The rewritten source.
 */
export function hoistRequires(source: string, parsed: ParsedModule): string {
  const edits: Edit[] = [];
  const bindings = new Map<string, string>();
  for (const item of parsed.body) {
    walkAst(item, (n) => {
      const spec = requireSpecifier(n);
      if (spec === null) return;
      let local = bindings.get(spec);
      if (!local) bindings.set(spec, local = `__denext_require_${bindings.size}`);
      edits.push({
        start: startOf(parsed.ctx, n),
        end: endOf(parsed.ctx, n),
        text: `__denextRequire(${local})`,
      });
    });
  }
  if (edits.length === 0) return source;
  const imports = [...bindings].map(([spec, local]) =>
    `import * as ${local} from ${JSON.stringify(spec)};`
  );
  return applyEdits(parsed.ctx.bytes, edits) +
    `\n\n/* denext dev: require() → import */\n${imports.join("\n")}\n` +
    `function __denextRequire(m) { return m && ${
      JSON.stringify(CJS_VIEW)
    } in m ? m.${CJS_VIEW} : m; }\n`;
}

/**
 * React Native mode's source preparation for one app module, ahead of the refresh footer: the
 * worklets transform (reanimated / gesture-handler code, as the build applies it) and the
 * `require` hoist.
 *
 * @param abs The module's absolute path.
 * @param source Its source.
 * @returns The prepared source.
 */
export async function prepareReactNativeSource(abs: string, source: string): Promise<string> {
  let out = source;
  if (WORKLETS_GATE.test(out)) {
    try {
      const result = await transformWorklets(out, abs, { diagnostics: false, helper: "import" });
      if (result.changed) out = result.code;
    } catch { /* best-effort — the module is served as written */ }
  }
  if (!out.includes("require")) return out;
  const parsed = await parseModule(out);
  return parsed ? hoistRequires(out, parsed) : out;
}

/**
 * The dependency-bundle entry for `spec`: its default and each name in `names` re-exported, a
 * `__denextCjs` view (what `require(spec)` returns in a build) and, for a namespace import,
 * `export *`. A bundled target is taken through `require` — esbuild's interop then gives either
 * module format, so a CommonJS package's names are exported too; an `external` one (a
 * `denext/*` shim, served from the runtime) through `import *`, which a browser module can do.
 *
 * @param spec The specifier (a package subpath, or an app asset's absolute path).
 * @param names The names the app imports from it.
 * @param external Whether `spec` resolves outside the dependency bundle.
 * @returns The entry module source.
 */
export function dependencyEntrySource(
  spec: string,
  names: ReadonlySet<string>,
  external = false,
): string {
  const s = JSON.stringify(spec);
  const lines = external
    ? [
      `import * as __m from ${s};`,
      `export var ${CJS_VIEW} = __m;`,
      `export default __m.default;`,
    ]
    : [
      `var __m = require(${s});`,
      `export var ${CJS_VIEW} = __m;`,
      `export default __m && __m.__esModule ? __m.default : __m;`,
    ];
  let i = 0;
  for (const name of [...names].sort()) {
    if (name === "*" || name === "default" || name === CJS_VIEW || !EXPORT_NAME.test(name)) {
      continue;
    }
    const local = `__e${i++}`;
    lines.push(`var ${local} = __m[${JSON.stringify(name)}];`, `export { ${local} as ${name} };`);
  }
  if (names.has("*")) lines.push(`export * from ${s};`);
  return lines.join("\n") + "\n";
}

/**
 * esbuild plugin (dependency bundle): loads each specifier's entry file, generated once the
 * build can say whether the specifier resolves inside the bundle or to an external runtime
 * module ({@linkcode dependencyEntrySource}). The entries stay `file` modules outside
 * node_modules, so React Native mode's resolvers treat their imports as the app's own.
 */
function dependencyEntriesPlugin(
  entries: ReadonlyMap<string, { spec: string; names: ReadonlySet<string> }>,
): esbuild.Plugin {
  return {
    name: "denext-dev-rn-entries",
    setup(build) {
      build.onLoad({ filter: /\.js$/, namespace: "file" }, async (args) => {
        const entry = entries.get(args.path);
        if (!entry) return null;
        const resolveDir = dirname(args.path);
        const target = await build.resolve(entry.spec, {
          kind: "require-call",
          importer: args.path,
          namespace: "file",
          resolveDir,
        });
        const external = target.errors.length === 0 && target.external === true;
        return {
          contents: dependencyEntrySource(entry.spec, entry.names, external),
          loader: "js",
          resolveDir,
        };
      });
    },
  };
}

/** The specifiers + names the dependency bundle must cover, as one comparable string. */
export function dependencySignature(st: UnbundledState): string {
  return JSON.stringify(
    [...st.npmSpecs].sort().map((spec) => [spec, [...(st.npmNames.get(spec) ?? [])].sort()]),
  );
}

/**
 * Transform every app module reachable from the SPA entry and from expo-router's routes (which
 * only the dependency bundle's route context imports), so each one's specifiers and names are
 * recorded before the dependency bundle is built. Cached transforms make a re-crawl cheap.
 *
 * @param st The unbundled dev state.
 * @param transformModule Transforms one app module (returns its first-party deps).
 */
export async function crawlReactNativeGraph(
  st: UnbundledState,
  transformModule: (abs: string) => Promise<{ deps: Array<{ abs: string }> }>,
): Promise<void> {
  const roots = [
    ...(st.opts.spaEntry ? [st.opts.spaEntry] : []),
    ...await expoRouterRouteFiles(st.opts.projectDir),
  ];
  await crawlModuleGraph(roots.map(norm).filter((abs) => CODE_FILE.test(abs)), transformModule);
}

/** Whether `abs` is one of the app's own code modules (served per module, never bundled). */
function isAppModule(st: UnbundledState, abs: string): boolean {
  const { projectDir, outDir } = st.opts;
  return CODE_FILE.test(abs) && !inNodeModules(abs) &&
    abs.startsWith(norm(projectDir) + SEPARATOR) && !abs.startsWith(norm(outDir) + SEPARATOR);
}

/**
 * esbuild plugin (dependency bundle): an app module a package reaches — expo-router's route
 * context imports every route by absolute path — resolves to its `@fs` URL, external, so the
 * page holds ONE instance of it (the one the per-module loop hot-swaps).
 */
function appModuleExternalPlugin(st: UnbundledState): esbuild.Plugin {
  const probe = firstPartyProbe(st);
  return {
    name: "denext-dev-rn-app-modules",
    setup(build) {
      build.onResolve({ filter: /^(?:\.\.?(?:\/|$)|\/)/ }, (args) => {
        if (inNodeModules(args.importer)) return null;
        const base = args.path.startsWith("/") ? args.path : resolve(args.resolveDir, args.path);
        const hit = probe(base);
        if (!hit) return null;
        const abs = norm(hit);
        if (!isAppModule(st, abs)) return null;
        addImporter(st, abs, NPM_IMPORTER);
        return externalModule(`${fsUrlPath(abs)}?v=${versionOf(st, abs)}`, args.kind);
      });
    },
  };
}

/**
 * esbuild plugin (dependency bundle): React, `next/*` and `denext/*` resolve to the prebuilt
 * runtime's `@dep` URLs, external — the single denext instance the app's modules share. Runs
 * after React Native mode's plugins, which may claim one of these first.
 */
function runtimeExternalPlugin(): esbuild.Plugin {
  return {
    name: "denext-dev-rn-runtime-external",
    setup(build) {
      build.onResolve({ filter: /^(?:react|react-dom|react-is|next|denext)(?:\/|$)/ }, (args) => {
        const url = libraryDepUrl(args.path, args.importer) ?? runtimeDepUrl(args.path);
        return url ? externalModule(url, args.kind) : null;
      });
      // The facade's own imports: the external module itself.
      build.onResolve({ filter: /.*/, namespace: REQUIRE_NAMESPACE }, (args) => ({
        path: args.path,
        external: true,
      }));
      build.onLoad({ filter: /.*/, namespace: REQUIRE_NAMESPACE }, (args) => ({
        contents: requireFacadeSource(args.path),
        loader: "js",
      }));
    },
  };
}

/** The namespace of the facades that let a CommonJS module `require` an external module. */
const REQUIRE_NAMESPACE = "denext-dev-rn-require";

/**
 * The resolution of an import of the external module at `url`: external for an ES import; for
 * a `require()` — a CommonJS package's `require("react")`, which a browser cannot run against a
 * URL — a facade module inside the bundle that imports it statically
 * ({@linkcode requireFacadeSource}).
 */
function externalModule(url: string, kind: esbuild.ImportKind): esbuild.OnResolveResult {
  return kind === "require-call" || kind === "require-resolve"
    ? { path: url, namespace: REQUIRE_NAMESPACE }
    : { path: url, external: true };
}

/**
 * The facade a `require(url)` gets: an ES module re-exporting the external module, so the
 * bundle imports it statically (hoisted, loaded before any package code runs) and esbuild's
 * interop hands the CommonJS caller its exports (`default` included).
 *
 * @param url The external module's URL.
 * @returns The facade's source.
 */
function requireFacadeSource(url: string): string {
  const s = JSON.stringify(url);
  return `import * as __ns from ${s};\nexport * from ${s};\nexport default __ns.default;\n`;
}

/**
 * Build the dependency bundle for every specifier the app has imported so far (into
 * `st.npmDir`, served under `@npm`). The runtime (`@dep`) must already be prebuilt.
 *
 * @param st The unbundled dev state (React Native mode).
 */
export async function buildReactNativeDeps(st: UnbundledState): Promise<void> {
  const rn = st.opts.reactNative!;
  const entriesDir = join(st.npmDir, ".entries");
  await ensureDir(entriesDir);
  const entryPoints: Record<string, string> = {};
  const entries = new Map<string, { spec: string; names: ReadonlySet<string> }>();
  for (const spec of st.npmSpecs) {
    const slug = depSlug(spec);
    // A placeholder on disk (esbuild needs the entry to exist); the plugin generates its source.
    const written = join(entriesDir, `${slug}.js`);
    await Deno.writeTextFile(written, "");
    // esbuild names a module by its real path; key the entry the same way.
    const file = await Deno.realPath(written);
    entryPoints[slug] = file;
    entries.set(file, { spec, names: st.npmNames.get(spec) ?? new Set() });
  }
  await bundleNextCompatModules({
    entryPoints,
    runtimeDir: st.runtimeDir,
    outdir: st.npmDir,
    configPath: st.opts.configPath,
    platform: "browser",
    classComponents: st.opts.classComponents ?? true,
    absWorkingDir: st.opts.projectDir,
    define: { ...st.opts.define, ...rn.define },
    // Assets the app or a package imports: files next to the bundle, at their served URL.
    assets: { publicPath: NPM_PREFIX },
    resolveAllNodeModules: rn.resolveAllNodeModules ?? true,
    // Every bare specifier resolves from node_modules or the runtime; the deno-loader's
    // workspace discovery fails on an npm-only graph.
    denoLoader: false,
    extraPlugins: [
      dependencyEntriesPlugin(entries),
      appModuleExternalPlugin(st),
      ...rn.plugins,
      runtimeExternalPlugin(),
    ],
    platformExtensions: rn.platformExtensions,
    jsxInJs: true,
  });
}

/** Files whose change means the installed packages (so the dependency bundle) may differ. */
const DEPENDENCY_MANIFESTS = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

/** Whether `path` exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A local path with `/` separators (Windows `\` included), for prefix comparisons. */
function slashed(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * Whether a batch of changed paths invalidates the dependency bundle (the caller then reloads
 * the page, which rebuilds it): a dependency manifest changed, or an expo-router route was
 * added or removed (the route context the bundle generated lists the routes). An edit to an
 * existing route is an ordinary module edit.
 *
 * @param st The unbundled dev state.
 * @param changed The changed paths.
 */
export async function reactNativeDepsInvalidated(
  st: UnbundledState,
  changed: string[],
): Promise<boolean> {
  if (!st.opts.reactNative) return false;
  let invalid = changed.some((p) => DEPENDENCY_MANIFESTS.has(basename(p)));
  if (!invalid) {
    const root = await expoRouterRoot(st.opts.projectDir);
    // Compared `/`-separated: a watcher path and a realpath may disagree on Windows separators.
    const routes = root ? slashed(norm(root)) + "/" : null;
    for (const raw of changed) {
      const abs = norm(raw);
      if (!routes || !slashed(abs).startsWith(routes) || !/\.[jt]sx?$/.test(abs)) continue;
      if (!st.known.has(abs) || !(await exists(abs))) invalid = true;
    }
  }
  if (invalid) st.npmBuiltSig = null;
  return invalid;
}
