// Full import-graph boundary discovery.
//
// A `"use client"` leaf component imported by a server page is not a file
// convention, so the manifest scanner (which only stats convention basenames)
// never sees it. denext has no bundler transform, so to find every client/server
// module app-wide we crawl Deno's own module graph (`deno info --json`) from the
// route entry modules, then read each local module's directive prologue.
//
// The result is a `BoundaryManifest`: the single source of truth for both the
// build-time graph split (which modules the browser bundle may contain) and the
// runtime registration of client-component and server references.

import { fromFileUrl, join, relative, SEPARATOR, toFileUrl } from "@std/path";
import { type Directive, readDirective } from "./directives.ts";
import { denoExecutable, frameworkRoot } from "./bundle.ts";

/** A discovered boundary module: its file URL and (optionally) its export names. */
export interface BoundaryRef {
  /** The module's `file://` URL. */
  url: string;
  /** Exported symbol names, when resolved (empty if not extracted). */
  exports: string[];
}

/** The client/server module split discovered across an app's import graph. */
export interface BoundaryManifest {
  /** `"use client"` modules keyed by a stable client id (`c_<hash>`). */
  client: Map<string, BoundaryRef>;
  /** `"use server"` modules keyed by a stable module id (`<hash>`). */
  server: Map<string, BoundaryRef>;
}

/**
 * A stable, dependency-free short hash (FNV-1a, 32-bit) rendered in base-36.
 * Used to derive client/server ids from a module's app-relative path so ids are
 * deterministic across machines and runs.
 */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** The app-relative, forward-slashed path of a module (the id/hash basis). */
function relKey(appDir: string, fileUrl: string): string {
  return relative(appDir, fromFileUrl(fileUrl)).replaceAll("\\", "/");
}

/** Derive the stable client id (`c_<hash>`) for a `"use client"` module. */
export function clientIdFor(appDir: string, fileUrl: string): string {
  return "c_" + shortHash(relKey(appDir, fileUrl));
}

/** Derive the stable module id (`<hash>`) for a `"use server"` module. */
export function serverModuleIdFor(appDir: string, fileUrl: string): string {
  return shortHash(relKey(appDir, fileUrl));
}

/** Compose a server-reference id from a module id and an export name. */
export function serverRefId(moduleId: string, exportName: string): string {
  return `${moduleId}#${exportName}`;
}

/** Minimal shape of the `deno info --json` output we consume. */
interface DenoInfo {
  modules: Array<{ specifier: string; kind?: string; error?: string }>;
}

/** Options for {@linkcode crawlLocalModules}. */
export interface CrawlOptions {
  /** Predicate to drop a discovered path (e.g. framework internals). */
  exclude?: (filePath: string) => boolean;
}

/**
 * Crawl the transitive import graph of `entryFiles` and return the absolute
 * paths of every **local** (`file://`) module reached, excluding the entries'
 * own synthetic barrel. Remote (jsr:/npm:/https:) modules are ignored — the
 * boundary only concerns project source.
 *
 * @param entryFiles Absolute paths of the modules to crawl from.
 * @param opts Optional exclusion predicate.
 * @returns Absolute file paths of all local modules in the graph.
 */
export async function crawlLocalModules(
  entryFiles: string[],
  opts: CrawlOptions = {},
): Promise<string[]> {
  if (entryFiles.length === 0) return [];
  const tmpDir = await Deno.makeTempDir({ prefix: "denext_graph_" });
  const barrel = `${tmpDir}/barrel.ts`;
  const barrelUrl = toFileUrl(barrel).href;
  try {
    const body = entryFiles.map((f) => `import ${JSON.stringify(toFileUrl(f).href)};`).join("\n");
    await Deno.writeTextFile(barrel, body + "\n");

    const command = new Deno.Command(denoExecutable(), {
      // sloppy-imports so extensionless Next.js app imports resolve in the graph
      // crawl (permissive fallback; see runDenoBundle in bundle.ts).
      args: ["info", "--unstable-sloppy-imports", "--json", barrel],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await command.output();
    if (code !== 0) {
      throw new Error(`deno info failed (${code}):\n${new TextDecoder().decode(stderr)}`);
    }
    const info = JSON.parse(new TextDecoder().decode(stdout)) as DenoInfo;
    const out: string[] = [];
    for (const m of info.modules) {
      if (m.error) continue;
      if (!m.specifier.startsWith("file://")) continue;
      if (m.specifier === barrelUrl) continue;
      const filePath = fromFileUrl(m.specifier);
      if (opts.exclude?.(filePath)) continue;
      out.push(filePath);
    }
    return out;
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

/** Options for {@linkcode buildBoundaryManifest}. */
export interface BoundaryManifestOptions {
  /**
   * Resolve a module's exported symbol names. When omitted, refs carry an empty
   * `exports` array (discovery only). Phase B supplies one that imports the
   * module and lists its keys.
   */
  exportsOf?: (filePath: string) => string[] | Promise<string[]>;
}

/**
 * Default {@link BoundaryManifestOptions.exportsOf}: import a module and return
 * the names of its function exports (the ones that can be client components or
 * server references). Suitable for build-time boundary construction.
 *
 * @param filePath Absolute path to the module.
 */
export async function importFunctionExports(filePath: string): Promise<string[]> {
  try {
    const mod = await import(toFileUrl(filePath).href);
    return Object.keys(mod).filter((k) =>
      typeof (mod as Record<string, unknown>)[k] === "function"
    );
  } catch {
    // The module (or a dependency) throws at module-eval, so we can't read its exports
    // by executing it. This happens with npm packages whose CJS default-import interop
    // differs under Deno's native loader from the compat esbuild bundle — e.g.
    // `import styled from "styled-components"` yields the module NAMESPACE (named
    // exports), so a module-scope `styled.div` throws. Fall back to a STATIC read of the
    // module's own export names (no execution, no dependency resolution).
    return await staticExportNames(filePath);
  }
}

/**
 * Named exports of a module read **statically** from its source — no execution, no
 * dependency resolution — for the {@link importFunctionExports} fallback. A pragmatic
 * lexer (not a full parser): it strips comments/strings, then matches `export`
 * declarations, `export { … }` lists (incl. `as` aliases), and `export default`. This is
 * a superset of the runtime function exports, which is safe for boundary tagging. Always
 * includes `default` when a default export is present. Empty/parse-miss → `["default"]`
 * (route conventions always have one — the common boundary case).
 */
async function staticExportNames(filePath: string): Promise<string[]> {
  let src: string;
  try {
    src = await Deno.readTextFile(filePath);
  } catch {
    return ["default"];
  }
  // Strip line/block comments and string/template literals so their contents can't be
  // mistaken for `export` keywords.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
  const names = new Set<string>();
  if (/\bexport\s+default\b/.test(stripped)) names.add("default");
  // `export [async] function|class|const|let|var NAME`
  const declRe =
    /\bexport\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (let m; (m = declRe.exec(stripped)) !== null;) names.add(m[1]);
  // `export { a, b as c }` (including `export { … } from "…"`).
  const listRe = /\bexport\s*\{([^}]*)\}/g;
  for (let m; (m = listRe.exec(stripped)) !== null;) {
    for (const part of m[1].split(",")) {
      const seg = part.trim();
      if (!seg) continue;
      // `a as b` exports `b`; a bare `a` exports `a`. `default as X` exports `X`.
      const asMatch = seg.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/);
      const name = asMatch ? asMatch[1] : seg;
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names.size > 0 ? [...names] : ["default"];
}

/**
 * Whether `filePath` is a framework-internal source module under `fwSrc`. Matched
 * on a path-segment boundary (exact, or `fwSrc` + separator prefix) — NOT a bare
 * string prefix — so a sibling like `.../denext/src-app/` whose name merely starts
 * with "src" is not wrongly excluded from boundary discovery.
 */
export function isUnderFrameworkSrc(filePath: string, fwSrc: string): boolean {
  return filePath === fwSrc || filePath.startsWith(fwSrc + SEPARATOR);
}

/**
 * Build the {@linkcode BoundaryManifest} for an app by crawling the import graph
 * of its route entry modules and classifying each local module by its directive.
 *
 * @param appDir Absolute path of the app directory (the id/hash basis).
 * @param entryFiles Absolute paths of the route entry modules to crawl from.
 * @param opts Optional export resolver.
 */
export async function buildBoundaryManifest(
  appDir: string,
  entryFiles: string[],
  opts: BoundaryManifestOptions = {},
): Promise<BoundaryManifest> {
  const manifest: BoundaryManifest = { client: new Map(), server: new Map() };
  // Exclude the framework's own source: its modules are local file:// too (in a
  // source checkout / monorepo) but are never app boundary modules. Scope the
  // exclusion to the framework's `src/` subtree — NOT the whole repo root — so a
  // sibling app under the repo (e.g. `examples/*`) still has its own
  // `"use client"`/`"use server"` modules discovered. (Framework internals all
  // live under `src/`; the root `mod.ts`/`cli.ts` carry no directives. Real users
  // import the framework via `jsr:`, whose modules are already excluded as
  // non-`file://`, so this only affects source-checkout/monorepo apps.)
  let fwSrc = join(frameworkRoot(), "src");
  // Resolve symlinks so a symlinked checkout (the framework linked into a monorepo)
  // still matches the realpath'd module paths `deno info` reports. If the src tree
  // isn't on disk (a jsr install), keep the logical path — those modules are
  // non-file:// and already excluded upstream.
  try {
    fwSrc = await Deno.realPath(fwSrc);
  } catch { /* framework src not on disk */ }
  const locals = await crawlLocalModules(entryFiles, {
    exclude: (p) => isUnderFrameworkSrc(p, fwSrc),
  });

  await Promise.all(
    locals.map(async (filePath) => {
      const directive: Directive = await readDirective(filePath);
      if (!directive) return;
      const url = toFileUrl(filePath).href;
      const exports = opts.exportsOf ? await opts.exportsOf(filePath) : [];
      if (directive === "client") {
        manifest.client.set(clientIdFor(appDir, url), { url, exports });
      } else {
        manifest.server.set(serverModuleIdFor(appDir, url), { url, exports });
      }
    }),
  );

  return manifest;
}

/**
 * Determine which routes need the Flight boundary: a route qualifies when its
 * import graph (page + layouts + templates + slots) reaches any `"use client"`
 * module — even one that is not a file-convention module (the common
 * server-page-imports-a-client-island case).
 *
 * @param appDir The app directory.
 * @param routes The page routes to classify.
 * @returns The set of `routePath`s that must render via Flight.
 */
/** A route whose boundary-relevant entry modules we collect. */
export interface RouteEntrySource {
  filePath: string;
  layoutChain: string[];
  templateChain: string[];
  slots?: Record<string, { pages: Array<{ filePath: string }>; default: string | null }>;
  layoutSlots?: Array<
    Record<string, { pages: Array<{ filePath: string }>; default: string | null }> | undefined
  >;
}

/**
 * Every module that composes a route's server tree — the roots a boundary crawl
 * must start from: the page, its layout chain, its template chain, and every
 * parallel-route slot (page + `default`) at both the page's own level and each
 * layout's level. A `"use client"` island (or `"use server"` action) imported
 * ONLY by a layout/template/slot is reachable only through these; crawling from
 * the page file alone silently drops it (H1).
 *
 * @param r The route whose entry modules to collect.
 * @returns Absolute file paths of the route's boundary crawl roots.
 */
export function routeEntryFiles(r: RouteEntrySource): string[] {
  const entries = [r.filePath, ...r.layoutChain, ...r.templateChain];
  for (const map of [r.slots, ...(r.layoutSlots ?? [])]) {
    if (!map) continue;
    for (const slot of Object.values(map)) {
      if (slot.default) entries.push(slot.default);
      for (const sp of slot.pages) entries.push(sp.filePath);
    }
  }
  return entries;
}

export async function computeBoundaryRoutes(
  appDir: string,
  routes: Array<RouteEntrySource & { routePath: string }>,
): Promise<Set<string>> {
  const out = new Set<string>();
  await Promise.all(
    routes.map(async (r) => {
      const bm = await buildBoundaryManifest(appDir, routeEntryFiles(r));
      if (bm.client.size > 0) out.add(r.routePath);
    }),
  );
  return out;
}
