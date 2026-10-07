// Server-side module loader for the `"use cache"` directive (Cache Components).
//
// The `use cache` transform (`use-cache-transform.ts`) rewrites cached functions
// into `__useCache(...)` wrappers, but the transform only matters on the *server*
// (the cached data functions and components run there). denext renders by loading
// user modules through a `ModuleLoader` (native dynamic `import`), with no bundler
// in the loop — so to make `use cache` take effect this wraps that loader.
//
// The wrapper transforms each loaded module AND, transitively, every local module
// it imports (post-order), rewriting each import specifier to point at the
// transformed copy of its target. That transitivity is the whole point: the common
// case is a directive-free page importing a cached fetcher from `lib/data.ts` — an
// entry-only redirect would load the *original* helper and silently miss the
// cache. A module whose subtree contains no `use cache` is left untouched (its
// effective URL is the original), so the pass only materializes copies where
// caching actually occurs.
//
// Copies are written under a caller-provided cache dir (generation-scoped in dev,
// so edits are picked up on reload) and memoized per loader instance.

import { djb2 } from "../runtime/djb2.ts";
import { extname, fromFileUrl, join, resolve, toFileUrl } from "@std/path";
import type { ModuleLoader } from "../server/types.ts";
import {
  absolutizeSpecifiers,
  applyEdits,
  type Edit,
  parseModule,
  pinImportMeta,
  swcParse,
} from "./swc-ast.ts";
import { transformUseCache } from "./use-cache-transform.ts";
import {
  type ImportAliases,
  readImportAliases,
  resolvePlatformImport,
} from "./platform-extensions.ts";

/** Options for {@link createUseCacheLoader}. */
export interface UseCacheLoaderOptions {
  /** Absolute project root; only files beneath it are transformed. */
  projectDir: string;
  /**
   * Directory the transformed copies are written to. The caller scopes this by
   * build generation in dev (e.g. `.../server-cache/<gen>`) so a reload picks up
   * fresh copies rather than a natively-cached stale module.
   */
  cacheDir: string;
  /**
   * Import redirects keyed by resolved file URL (the target's platform files, from
   * `platformRedirects`): an import whose URL is a key loads its value instead, and every module
   * on the way to one is copied with the import rewritten.
   */
  redirects?: Readonly<Record<string, string>>;
  /**
   * Compile `"use cache"` directives (default true). `false` copies modules only to apply
   * {@link redirects} (Cache Components off), leaving every directive as written.
   */
  useCache?: boolean;
}

/** Deterministic short hash (djb2 → base36) for a module URL. */
const hash = djb2;

/** Normalize a file path or `file:` URL to a `file:` URL string. */
function toUrl(filePath: string): string {
  return filePath.startsWith("file:") ? filePath : toFileUrl(filePath).href;
}

/** True if `fileUrl` is a `file:` URL located under `rootDir`. */
function underRoot(fileUrl: string, rootDir: string): boolean {
  if (!fileUrl.startsWith("file:")) return false;
  const rootUrl = toFileUrl(/[\\/]$/.test(rootDir) ? rootDir : rootDir + "/").href; // or `\`
  return fileUrl.startsWith(rootUrl);
}

/** One local import of a module: as written, the file it names, and the module to load. */
interface LocalImport {
  readonly spec: string;
  readonly url: string;
  readonly target: string;
}

/**
 * Parse `source` and return its import/export specifiers that name local files: relative ones,
 * and bare ones the project's import map aliases to a file (`@/components/Button.tsx`), each
 * resolved by {@linkcode resolvePlatformImport} (the platform variant applied). Packages
 * (`npm:`, `jsr:`, `@std/…`) are skipped. Returns `[]` on a parse error (the module is then
 * treated as a leaf).
 */
async function localImports(
  source: string,
  moduleUrl: string,
  aliases: ImportAliases,
  redirects: Readonly<Record<string, string>>,
): Promise<LocalImport[]> {
  let ast;
  try {
    const parse = await swcParse();
    ast = await parse("0;\n" + source);
  } catch {
    return [];
  }
  const out: LocalImport[] = [];
  for (const item of ast.body ?? []) {
    const spec = item?.source?.value;
    if (typeof spec !== "string") continue;
    const hit = resolvePlatformImport(spec, moduleUrl, aliases, redirects);
    if (hit) out.push({ spec, ...hit });
  }
  return out;
}

/**
 * Whether a copy rewrites `imp`'s alias specifier: it names its file outright (the copy no longer
 * relies on the import map), but an extensionless alias is left to the import map unless it must
 * reach another file. A relative specifier is the absolutizing pass's.
 */
function rewritesBare(imp: LocalImport, changed: boolean): boolean {
  if (imp.spec.startsWith("./") || imp.spec.startsWith("../")) return false;
  return changed || extname(new URL(imp.url).pathname) !== "";
}

/**
 * Only absolutize `source`'s relative specifiers (mapped through `resolve`) and replace the
 * bare ones `bare` names, for a copy that compiles nothing else.
 */
async function rewriteLocalImports(
  source: string,
  moduleUrl: string,
  resolve: (absUrl: string) => string,
  bare: (spec: string) => string | null,
): Promise<{ code: string; changed: boolean }> {
  const parsed = await parseModule(source);
  if (!parsed) return { code: source, changed: false };
  const edits: Edit[] = [];
  if (!absolutizeSpecifiers(parsed.ctx, parsed.body, moduleUrl, edits, resolve, bare)) {
    return { code: source, changed: false };
  }
  return { code: applyEdits(parsed.ctx.bytes, edits), changed: true };
}

/** One project module as the compiler sees it: its source, local imports and directive. */
interface ModuleNode {
  /** Its source, or null when it is unreadable (then it loads as itself). */
  readonly source: string | null;
  readonly imports: readonly LocalImport[];
  /** Whether it has a `"use cache"` directive to compile. */
  readonly useCache: boolean;
}

/**
 * A per-instance compiler that maps a module's `file:` URL to the URL that should
 * actually be imported — the original when its subtree contains no `"use cache"` and reaches
 * no platform redirect, or a written transformed copy otherwise.
 *
 * Three steps, each memoized per URL, so concurrent loads (a production server warming every
 * route with `Promise.all`, overlapping dev requests) share the work and never take another
 * load's half-finished state for an answer: parse each reachable module once; decide which
 * modules need a copy, a fixpoint over the whole reached graph, so an import cycle is copied
 * whole (rather than one member loading its original, and with it the plain files); then write
 * each copy, its imports pointing at the copies of the modules that have one. A copy's name is a
 * hash of its module's URL, so a parent knows its child's copy before that is written.
 */
class UseCacheCompiler {
  #nodes = new Map<string, Promise<ModuleNode>>();
  #needs = new Map<string, boolean>();
  #written = new Map<string, Promise<void>>();
  #dir: Promise<void> | null = null;
  #aliases: Promise<ImportAliases> | null = null;

  constructor(private opts: UseCacheLoaderOptions) {}

  /** Whether `url` is a project module the compiler may copy. */
  #own(url: string): boolean {
    return underRoot(url, this.opts.projectDir);
  }

  /** The copy's file URL for `moduleUrl` (named by its URL, so known before it is written). */
  #copyUrl(moduleUrl: string): string {
    const ext = extname(fromFileUrl(moduleUrl)) || ".ts";
    return toFileUrl(join(this.opts.cacheDir, `uc_${hash(moduleUrl)}${ext}`)).href;
  }

  /** `moduleUrl`'s source and local imports, read and parsed once. */
  #node(moduleUrl: string): Promise<ModuleNode> {
    let node = this.#nodes.get(moduleUrl);
    if (!node) {
      node = this.#readNode(moduleUrl);
      this.#nodes.set(moduleUrl, node);
    }
    return node;
  }

  async #readNode(moduleUrl: string): Promise<ModuleNode> {
    let source: string;
    try {
      source = await Deno.readTextFile(fromFileUrl(moduleUrl));
    } catch {
      return { source: null, imports: [], useCache: false }; // unreadable → the original
    }
    const aliases = await (this.#aliases ??= readImportAliases(this.opts.projectDir));
    const imports = await localImports(source, moduleUrl, aliases, this.opts.redirects ?? {});
    const useCache = this.opts.useCache !== false && source.includes("use cache");
    return { source, imports, useCache };
  }

  /** Every project module reachable from `entry` (itself included), parsed. */
  async #reach(entry: string): Promise<Map<string, ModuleNode>> {
    const graph = new Map<string, ModuleNode>();
    let frontier = [entry];
    while (frontier.length > 0) {
      const batch = [...new Set(frontier)].filter((u) => !graph.has(u));
      const nodes = await Promise.all(batch.map((u) => this.#node(u)));
      frontier = [];
      batch.forEach((u, i) => graph.set(u, nodes[i]));
      for (const node of nodes) {
        for (const imp of node.imports) {
          if (this.#own(imp.target) && !graph.has(imp.target)) frontier.push(imp.target);
        }
      }
    }
    return graph;
  }

  /**
   * Decide which of `graph`'s modules need a copy: one with a directive or a redirected import,
   * and every module that imports one (a fixpoint, so a cycle settles). Synchronous, and `graph`
   * holds each module's whole subtree, so every decision is final.
   */
  #decide(graph: Map<string, ModuleNode>): void {
    const open = [...graph].filter(([u]) => !this.#needs.has(u));
    for (const [u, n] of open) {
      const direct = n.useCache || n.imports.some((i) => i.target !== i.url);
      this.#needs.set(u, n.source !== null && direct);
    }
    for (let grew = true; grew;) {
      grew = false;
      for (const [u, n] of open) {
        if (this.#needs.get(u) || n.source === null) continue;
        if (n.imports.some((i) => this.#needs.get(i.target))) {
          this.#needs.set(u, true);
          grew = true;
        }
      }
    }
  }

  /** The URL an import of `target` loads: its copy when it has one. */
  #effective(target: string): string {
    return this.#needs.get(target) ? this.#copyUrl(target) : target;
  }

  /** Write `moduleUrl`'s copy, once. */
  #write(moduleUrl: string, node: ModuleNode): Promise<void> {
    let done = this.#written.get(moduleUrl);
    if (!done) {
      done = this.#writeCopy(moduleUrl, node.source!, node.imports);
      this.#written.set(moduleUrl, done);
    }
    return done;
  }

  async #writeCopy(
    moduleUrl: string,
    source: string,
    imports: readonly LocalImport[],
  ): Promise<void> {
    const childMap = new Map<string, string>();
    const bareMap = new Map<string, string>();
    for (const imp of imports) {
      const eff = this.#effective(imp.target);
      childMap.set(imp.url, eff);
      if (rewritesBare(imp, eff !== imp.url)) bareMap.set(imp.spec, eff);
    }
    const resolveSpecifier = (abs: string) => childMap.get(abs) ?? abs;
    const resolveBare = (spec: string) => bareMap.get(spec) ?? null;
    const { code } = this.opts.useCache === false
      ? await rewriteLocalImports(source, moduleUrl, resolveSpecifier, resolveBare)
      : await transformUseCache(source, moduleUrl, {
        resolveSpecifier,
        resolveBare,
        alwaysRewriteImports: true,
      });
    await (this.#dir ??= Deno.mkdir(this.opts.cacheDir, { recursive: true }));
    // The copy lives in the cache dir; its `import.meta` keeps naming the module it stands in for.
    const copy = fromFileUrl(this.#copyUrl(moduleUrl));
    await Deno.writeTextFile(copy, await pinImportMeta(code, moduleUrl));
  }

  /** The effective import URL for `moduleUrl` (original, or a transformed copy). */
  async effectiveUrl(moduleUrl: string): Promise<string> {
    // Only transform project files; leave framework/std/npm and out-of-tree files as-is.
    if (!this.#own(moduleUrl) || this.#needs.get(moduleUrl) === false) return moduleUrl;
    const graph = await this.#reach(moduleUrl);
    this.#decide(graph);
    // Every copy the module's graph imports exists before it loads.
    const copied = [...graph].filter(([u]) => this.#needs.get(u));
    await Promise.all(copied.map(([u, n]) => this.#write(u, n)));
    return this.#effective(moduleUrl);
  }
}

/**
 * Wrap a base {@link ModuleLoader} so loaded modules (and their transitive local
 * imports) have their `"use cache"` directives compiled into cross-request caching
 * on the server. A module with no caching anywhere in its subtree is loaded
 * unchanged through `base`.
 *
 * @param base The underlying loader (dev cache-busting / `defaultLoader`).
 * @param opts Project root and the (generation-scoped) copy cache dir.
 * @returns A loader that transparently redirects to transformed copies.
 */
export function createUseCacheLoader(
  base: ModuleLoader,
  opts: UseCacheLoaderOptions,
): ModuleLoader {
  const compiler = new UseCacheCompiler(opts);
  // A crawl names modules by their real path (a boundary ref under macOS's `/private/var` for a
  // project in `/var`): spell those through the project root, as its redirects and copies are.
  const root = toFileUrl(resolve(opts.projectDir)).href + "/";
  let real: string | null = null;
  try {
    real = toFileUrl(Deno.realPathSync(opts.projectDir)).href + "/";
  } catch { /* no project dir on disk: nothing to respell */ }
  const canonical = (url: string) =>
    real && real !== root && url.startsWith(real) ? root + url.slice(real.length) : url;
  return async (filePath: string): Promise<unknown> => {
    const url = canonical(toUrl(filePath));
    let eff: string;
    try {
      // A module loaded by its plain path (a boundary ref being tagged) loads its variant too.
      eff = await compiler.effectiveUrl(opts.redirects?.[url] ?? url);
    } catch {
      eff = url; // any transform failure → load the original (never break loading)
    }
    return base(eff);
  };
}
