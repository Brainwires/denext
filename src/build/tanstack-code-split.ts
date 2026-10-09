// TanStack Router `autoCodeSplitting` on denext's esbuild SPA path (`spa.tanstackRouter`).
//
// Under Vite, `@tanstack/router-plugin` rewrites each file route so its `component` (and
// loader, error/pending/not-found components) is imported lazily from a virtual
// `route.tsx?tsr-split=component` module that holds just that code — the bundler then gives each
// one its own chunk, keeping every route's UI out of the startup graph. The package's own
// esbuild adapter does not do this: it never runs the route generator (which supplies the route
// map the splitter consults) nor initializes the splitter's config outside Vite/webpack/rspack,
// so under esbuild nothing is split. This module hosts the package's **Vite** plugins instead
// (the same compiler a Vite build runs): `configResolved` generates the route tree and
// initializes the splitter, and their `transform` hooks run from an esbuild `onLoad`, with the
// `?tsr-split` / `?tsr-shared` virtual modules resolved to their file plus that query as an
// esbuild `suffix` (so each is its own module). `@tanstack/router-plugin` is a build-time npm tool
// (loaded only when the option is on); nothing of it reaches the browser.

import type * as esbuild from "esbuild";
import { extname, SEPARATOR } from "@std/path";
import type { SpaTanstackRouterConfig } from "../server/config.ts";
import { inNodeModules } from "./path-segments.ts";
import type { SourceTransform } from "./spa-compiler-plugin.ts";
import { generatedRouteTreePath, keepCommittedRouteTree } from "./tanstack-route-tree.ts";

/** A Vite hook filter pattern, as the TanStack plugins declare them. */
type FilterPattern = string | RegExp | readonly (string | RegExp)[];

/** The slice of a Vite plugin this host drives. */
interface VitePluginLike {
  name?: string;
  configResolved?: (this: unknown, config: unknown) => unknown;
  transform?: {
    filter?: {
      id?: FilterPattern | { include?: FilterPattern; exclude?: FilterPattern };
      code?: FilterPattern | { include?: FilterPattern; exclude?: FilterPattern };
    };
    handler: (
      this: unknown,
      code: string,
      id: string,
    ) => unknown;
  };
}

/** A query naming a TanStack virtual module (`?tsr-split=component`, `?tsr-shared=1`). */
const VIRTUAL_QUERY = /\?tsr-(?:split|shared)=/;

/** The modules the splitter may rewrite (its own `include` is this). */
const SCRIPT = /\.(?:m|c)?(?:j|t)sx?$/;

/** Whether one pattern matches: a RegExp tests, a string is a substring (TanStack's are ids). */
function matchOne(pattern: string | RegExp, value: string): boolean {
  if (typeof pattern === "string") return value.includes(pattern);
  pattern.lastIndex = 0;
  return pattern.test(value);
}

/** Whether any of `patterns` matches `value`. */
function matchAny(patterns: FilterPattern, value: string): boolean {
  return (Array.isArray(patterns) ? patterns : [patterns as string | RegExp])
    .some((p: string | RegExp) => matchOne(p, value));
}

/** Whether a hook filter (`{ include, exclude }`, or bare patterns = include) admits `value`. */
export function filterAdmits(
  filter: FilterPattern | { include?: FilterPattern; exclude?: FilterPattern } | undefined,
  value: string,
): boolean {
  if (filter === undefined) return true;
  if (typeof filter === "string" || filter instanceof RegExp || Array.isArray(filter)) {
    return matchAny(filter as FilterPattern, value);
  }
  const { include, exclude } = filter as { include?: FilterPattern; exclude?: FilterPattern };
  if (exclude !== undefined && matchAny(exclude, value)) return false;
  return include === undefined || matchAny(include, value);
}

/** The code a transform hook returned, or null when it left the module alone. */
function transformedCode(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (
    result && typeof result === "object" && typeof (result as { code?: unknown }).code === "string"
  ) {
    return (result as { code: string }).code;
  }
  return null;
}

/** The esbuild loader for a module path by its extension. */
function loaderFor(path: string): esbuild.Loader {
  const ext = extname(path).replace(/^\.[mc]?/, "");
  return ext === "ts" ? "ts" : ext === "js" ? "jsx" : ext === "jsx" ? "jsx" : "tsx";
}

/** Run the plugins' transform hooks over `code` in order, each fed the previous output. */
async function runTransforms(
  plugins: readonly VitePluginLike[],
  code: string,
  id: string,
): Promise<string | null> {
  let out = code;
  let changed = false;
  for (const plugin of plugins) {
    const hook = plugin.transform;
    if (!hook) continue;
    if (!filterAdmits(hook.filter?.id, id) || !filterAdmits(hook.filter?.code, out)) continue;
    const next = transformedCode(await hook.handler.call({}, out, id));
    if (next !== null) {
      out = next;
      changed = true;
    }
  }
  return changed ? out : null;
}

/** Whether `path` is the project's own source (not a dependency, not outside the project). */
function isAppSource(path: string, roots: readonly string[]): boolean {
  return !inNodeModules(path) &&
    roots.some((root) => path.startsWith(root.endsWith(SEPARATOR) ? root : root + SEPARATOR));
}

/** `dir` with symlinks resolved (esbuild reports modules by real path), or `dir` itself. */
function realDir(dir: string): string {
  try {
    return Deno.realPathSync(dir);
  } catch {
    return dir;
  }
}

/** `path`'s text, or null when it cannot be read (the next loader then reports it). */
async function readSource(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

/**
 * The `onLoad` answer for one module: a TanStack virtual module (`?tsr-split=…`) always, a route
 * file the splitter rewrote, and null (the next `onLoad` loads it; denext's own source
 * transforms run there) for anything else.
 */
async function loadRouteModule(
  plugins: readonly VitePluginLike[],
  args: esbuild.OnLoadArgs,
  roots: readonly string[],
  after: SourceTransform | undefined,
): Promise<esbuild.OnLoadResult | null> {
  const virtual = isVirtual(args);
  if (!virtual && !isAppSource(args.path, roots)) return null;
  const source = await readSource(args.path);
  if (source === null) return null;
  const split = await runTransforms(plugins, source, virtual ? args.path + args.suffix : args.path);
  if (split === null && !virtual) return null;
  return {
    contents: await withAfter(after, split ?? source, args.path),
    loader: loaderFor(args.path),
  };
}

/** Whether the module is a TanStack virtual module (its suffix is `?tsr-split=…` / `?tsr-shared=…`). */
function isVirtual(args: esbuild.OnLoadArgs): boolean {
  return VIRTUAL_QUERY.test(args.suffix ?? "");
}

/** `code` after the `after` transforms (unchanged when there are none or they changed nothing). */
async function withAfter(
  after: SourceTransform | undefined,
  code: string,
  path: string,
): Promise<string> {
  if (!after) return code;
  return (await after(code, path)) ?? code;
}

/**
 * Create the TanStack Router plugins (`@tanstack/router-plugin/vite`) for this project and run
 * their `configResolved` as a Vite production build would: the route generator writes the route
 * tree and records which file is which route, and the code-splitter reads its settings. A tree
 * regenerated with the same routes is restored to the committed bytes (see
 * {@link keepCommittedRouteTree}).
 *
 * @param projectDir Absolute project root (where `tsr.config.json` is read from).
 * @param options `spa.tanstackRouter` (its paths are relative to the project root).
 */
async function loadTanstackRouterPlugins(
  projectDir: string,
  options: SpaTanstackRouterConfig,
): Promise<VitePluginLike[]> {
  const { tanstackRouter } = await import("@tanstack/router-plugin/vite");
  const settings: Record<string, unknown> = {
    target: "react",
    disableLogging: true,
    autoCodeSplitting: true,
  };
  if (options.routesDirectory) settings.routesDirectory = options.routesDirectory;
  if (options.generatedRouteTree) settings.generatedRouteTree = options.generatedRouteTree;
  const plugins = [tanstackRouter(settings)].flat(Infinity) as VitePluginLike[];
  // The generator keys its route map by path under `root`; esbuild names modules by their real
  // path, so the root is the real one (a project reached through a symlink, macOS's /var → /private/var).
  const config = { command: "build", root: realDir(projectDir), plugins };
  // The generator (re)writes the project's route tree; a tree it regenerates with the same routes
  // is put back exactly as the app's own generator committed it (tanstack-route-tree.ts).
  const tree = await generatedRouteTreePath(config.root, settings);
  const committed = await readSource(tree);
  for (const plugin of plugins) await plugin.configResolved?.call({}, config);
  await keepCommittedRouteTree(tree, committed);
  return plugins;
}

/**
 * The esbuild plugin applying TanStack Router's `autoCodeSplitting` to the app's route files.
 * Place it ahead of denext's other `onLoad` plugins: a module it rewrites is answered here, so
 * `after` (the enabled SPA source transforms, see `spaSourceTransform`) is applied to its output.
 *
 * @param projectDir Absolute project root.
 * @param options `spa.tanstackRouter`.
 * @param after The SPA source transforms to apply to a module this plugin answers, if any.
 */
export function tanstackCodeSplitPlugin(
  projectDir: string,
  options: SpaTanstackRouterConfig,
  after?: SourceTransform,
): esbuild.Plugin {
  return {
    name: "denext-tanstack-code-split",
    async setup(build) {
      const plugins = await loadTanstackRouterPlugins(projectDir, options);
      const roots = [projectDir, realDir(projectDir)];
      // `/abs/route.tsx?tsr-split=component` → the file, with the query kept as its suffix.
      build.onResolve({ filter: VIRTUAL_QUERY }, (args) => {
        const at = args.path.indexOf("?");
        const file = args.path.slice(0, at);
        if (!file.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(file)) return null;
        return { path: file, suffix: args.path.slice(at) };
      });
      build.onLoad({ filter: SCRIPT }, (args) => loadRouteModule(plugins, args, roots, after));
    },
  };
}
