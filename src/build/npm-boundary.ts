/**
 * The `"use client"` / `"use server"` modules INSIDE npm packages that an app's server code
 * reaches — the boundaries `deno info` cannot see (it reports an npm dependency as one
 * `npm:` package, not its files).
 *
 * A Next library routinely marks its own components: `@clerk/nextjs` exports `ClerkProvider`,
 * `Show` and `SignInButton` from `"use client"` files, and its provider calls a `"use server"`
 * action. A Server Component importing them straight from the package (the way Next apps
 * do) must render them as client islands — hydrated, with their actions callable — exactly as
 * a local `"use client"` file is. Next's bundler finds these boundaries by walking the
 * package's files; this module does the same with one esbuild pass in metafile mode (no
 * output written), walking only `node_modules`:
 *
 * - the entries are the app's LOCAL modules (the `deno info` crawl already resolved the app's
 *   own graph, import map included); a local import is left external here;
 * - a bare import from a local module, or any import inside a package, is resolved the way the
 *   next-compat SERVER bundle resolves it (denext's node_modules resolver, SSR conditions),
 *   except the React family, `next/*` and `denext*`, which the compat build aliases to denext
 *   and so are never walked;
 * - from each local module, the walk stops at the first `"use client"` file on a path (that
 *   file is the island; what it imports is client code), and records every `"use server"`
 *   file anywhere below — including under an island, which is where a client component's
 *   action import lives.
 *
 * Build-time only (esbuild); the production server reads the boundary from the build
 * manifest instead.
 *
 * @module
 */

import * as esbuild from "esbuild";
import { dirname, resolve } from "@std/path";
import { readDirective } from "./directives.ts";
import { resolveNodeFrom, SSR_CONDITIONS } from "./next-compat.ts";
import { inNodeModules } from "./path-segments.ts";
import type { NpmBoundaryFound } from "./module-graph.ts";

/** The npm boundary modules one local module reaches (absolute file paths). */
type NpmBoundaryModules = NpmBoundaryFound;

/** Specifiers the compat build aliases to denext: never walked. */
const ALIASED = /^(?:react|react-dom|react-is|scheduler|next|denext)(?:\/|$)/;
/** Specifiers that are not files on disk (remote / registry / data). */
const REMOTE = /^(?:jsr:|https?:|data:|node:|bun:)/;
/** Assets a server module may import: loaded as empty modules (nothing to walk). */
const ASSET =
  /\.(?:css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|wasm|mp4|webm|mp3|wav|ogg|txt|md|mdx|html)$/i;
/** Extensions esbuild can walk as code. */
const CODE = /\.(?:[cm]?[jt]sx?)$/i;

/** `npm:@scope/pkg@^1/sub` → `@scope/pkg/sub` (the import map's npm specifiers). */
export function npmSpecifierToBare(spec: string): string {
  const rest = spec.slice("npm:".length).replace(/^\//, "");
  const scoped = rest.startsWith("@");
  const parts = rest.split("/");
  const nameParts = scoped ? parts.slice(0, 2) : parts.slice(0, 1);
  const last = nameParts.length - 1;
  const at = nameParts[last].indexOf("@");
  if (at > 0) nameParts[last] = nameParts[last].slice(0, at);
  return [...nameParts, ...parts.slice(nameParts.length)].join("/");
}

/** An import the walk does not follow. */
const SKIP = (path: string): esbuild.OnResolveResult => ({ path, external: true });

/** Whether `spec` is relative, absolute or a file URL (a path, not a package). */
function isPathSpecifier(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("file:");
}

/**
 * Where `spec` (from `importer`) leads inside `node_modules`, or null when it leads outside.
 * A package specifier resolves exactly as the SSR bundle resolves it (denext's node_modules
 * resolver with the SSR conditions: `require` before `import`, so often a package's CJS build):
 * the walk must reach the very files the server bundle renders, or the islands it records would
 * be other module instances. Anything else (a package's relative or `#imports` specifier)
 * resolves the way esbuild does.
 */
async function resolveInPackages(
  build: esbuild.PluginBuild,
  spec: string,
  args: esbuild.OnResolveArgs,
): Promise<string | null> {
  if (!isPathSpecifier(spec) && !spec.startsWith("#") && args.importer) {
    const viaNode = await resolveNodeFrom(dirname(args.importer), spec, SSR_CONDITIONS);
    if (viaNode) return inNodeModules(viaNode) ? viaNode : null;
  }
  const res = await build.resolve(spec, {
    kind: args.kind,
    resolveDir: args.resolveDir,
    importer: args.importer,
    pluginData: { denextInner: true },
  });
  return res.errors.length === 0 && res.path && inNodeModules(res.path) ? res.path : null;
}

/** The esbuild plugin that confines the walk to `node_modules`. */
function walkPlugin(): esbuild.Plugin {
  return {
    name: "denext-npm-boundary-walk",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === "entry-point" || args.pluginData?.denextInner) return undefined;
        if (ALIASED.test(args.path) || REMOTE.test(args.path)) return SKIP(args.path);
        const spec = args.path.startsWith("npm:") ? npmSpecifierToBare(args.path) : args.path;
        // A local module's relative / absolute imports are the deno info crawl's (its own entry).
        if (!inNodeModules(args.importer) && isPathSpecifier(spec)) return SKIP(args.path);
        const path = await resolveInPackages(build, spec, args);
        return path ? { path } : SKIP(args.path);
      });
      build.onLoad({ filter: ASSET }, () => ({ contents: "", loader: "js" }));
    },
  };
}

/** The metafile import graph as absolute path → absolute paths it imports. */
function importGraph(meta: esbuild.Metafile, root: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const [key, input] of Object.entries(meta.inputs)) {
    if (key.includes(":")) continue; // a plugin namespace, not a file
    const edges: string[] = [];
    for (const imp of input.imports) {
      if (imp.external || imp.path.includes(":")) continue;
      edges.push(resolve(root, imp.path));
    }
    graph.set(resolve(root, key), edges);
  }
  return graph;
}

/** The directive of `path`, memoized for the walk. */
function directiveOf(
  memo: Map<string, Promise<"client" | "server" | null>>,
  path: string,
): Promise<"client" | "server" | null> {
  let d = memo.get(path);
  if (!d) {
    d = readDirective(path).then((v) => v === "client" || v === "server" ? v : null);
    memo.set(path, d);
  }
  return d;
}

/**
 * Walk `node_modules` from one local module: islands (the first `"use client"` file on each
 * path) and action modules (every `"use server"` file, under islands too).
 */
async function walkFrom(
  local: string,
  localIsClient: boolean,
  graph: Map<string, string[]>,
  memo: Map<string, Promise<"client" | "server" | null>>,
): Promise<NpmBoundaryModules> {
  const client = new Set<string>();
  const server = new Set<string>();
  const seen = new Set<string>();
  const queue: Array<[string, boolean]> = (graph.get(local) ?? [])
    .filter(inNodeModules)
    .map((p) => [p, localIsClient]);
  while (queue.length > 0) {
    const [path, inClient] = queue.shift()!;
    const key = `${inClient ? "c" : "s"}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const directive = await directiveOf(memo, path);
    if (directive === "server") {
      server.add(path);
      continue;
    }
    const nowClient = inClient || directive === "client";
    if (directive === "client" && !inClient) client.add(path);
    for (const next of graph.get(path) ?? []) queue.push([next, nowClient]);
  }
  return { client: [...client], server: [...server] };
}

/**
 * The npm boundary modules each of `localFiles` reaches (see the module docs). Files with
 * nothing to report map to empty lists. Never throws: a graph esbuild cannot build (a broken
 * import) answers empty lists, leaving the app's own boundaries as they were.
 *
 * @param localFiles Absolute paths of the app's local modules (the `deno info` crawl).
 * @returns Local module path → the npm islands and action modules it reaches.
 */
export async function npmBoundaryByImporter(
  localFiles: readonly string[],
): Promise<Map<string, NpmBoundaryModules>> {
  const out = new Map<string, NpmBoundaryModules>();
  const entries = localFiles.filter((f) => CODE.test(f) && !inNodeModules(f));
  for (const f of localFiles) out.set(f, { client: [], server: [] });
  if (entries.length === 0) return out;
  const root = Deno.cwd();
  let meta: esbuild.Metafile;
  try {
    const result = await esbuild.build({
      entryPoints: entries,
      bundle: true,
      write: false,
      metafile: true,
      outdir: "/denext-npm-boundary",
      format: "esm",
      platform: "node",
      jsx: "automatic",
      jsxImportSource: "react",
      logLevel: "silent",
      absWorkingDir: root,
      plugins: [walkPlugin()],
    });
    meta = result.metafile!;
  } catch {
    return out;
  }
  const graph = importGraph(meta, root);
  const memo = new Map<string, Promise<"client" | "server" | null>>();
  await Promise.all(entries.map(async (local) => {
    const isClient = (await readDirective(local)) === "client";
    out.set(local, await walkFrom(local, isClient, graph, memo));
  }));
  return out;
}
