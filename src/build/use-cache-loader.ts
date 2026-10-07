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
// Copies are written under a caller-provided cache dir and memoized per loader instance. In dev
// (`dev`, a {@linkcode DevCopies}) a module edited since the server started is copied too, with
// every module that imports it, and each copy is named by its subtree's content: Deno never evicts
// a module, so an edit must reach the render under a new URL, while an unchanged module keeps its
// URL — and its instance — from one generation to the next.

import { djb2 } from "../runtime/djb2.ts";
import { extname, fromFileUrl, join, resolve, toFileUrl } from "@std/path";
import type { ModuleLoader } from "../server/types.ts";
import {
  absolutizeSpecifiers,
  applyEdits,
  type Edit,
  literalSpecifiers,
  parseModule,
  pinImportMeta,
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
   * Directory the transformed copies are written to. In dev ({@link dev}) one directory per
   * target serves every generation: a copy's name carries its content.
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
  /**
   * Dev: the session's edited modules and written copies. An edited module (and every module
   * that imports one) loads as a copy named by its subtree's content, written once per process.
   */
  dev?: DevCopies;
}

/** A module file the compiler can copy (a stylesheet or JSON import is not one). */
const SCRIPT_EXT = /\.(?:[cm]?[jt]sx?)$/;

/**
 * One dev session's edits and server copies, shared by every generation's compiler and target.
 *
 * Deno caches a module by URL for the life of the process, and a page's relative imports resolve
 * without the cache-busting query its route entry is loaded with, so an edited module the page
 * imports would keep rendering its first version. Every file the watcher reports is recorded here;
 * the compiler then loads it, and each module on the way to it, as a copy whose name hashes the
 * content beneath it. A copy is written once, and each module keeps its two newest (the previous
 * one may still be loading in a request that started before the edit).
 */
export class DevCopies {
  #edited = new Set<string>();
  #written = new Map<string, Promise<void>>();
  #byModule = new Map<string, string[]>();
  #spell: (url: string) => string;

  /** @param projectDir The project root, as the loaders spell module URLs. */
  constructor(projectDir: string) {
    this.#spell = projectSpelling(projectDir);
  }

  /** Record edited files (absolute paths, as the watcher reports them). */
  markEdited(paths: Iterable<string>): void {
    for (const p of paths) {
      const url = this.#spell(toUrl(p));
      if (SCRIPT_EXT.test(new URL(url).pathname)) this.#edited.add(url);
    }
  }

  /** Whether any module was edited this session. */
  get anyEdited(): boolean {
    return this.#edited.size > 0;
  }

  /** Whether `url`'s file was edited this session. */
  isEdited(url: string): boolean {
    return this.#edited.has(url);
  }

  /**
   * Write `copy` (the copy of `moduleUrl` in `dir`) once per process through `write`, and drop
   * the module's copies older than its previous one.
   */
  write(dir: string, moduleUrl: string, copy: string, write: () => Promise<void>): Promise<void> {
    let done = this.#written.get(copy);
    if (done) return done;
    done = write();
    this.#written.set(copy, done);
    done.catch(() => this.#written.delete(copy));
    const key = `${dir}\0${moduleUrl}`;
    const kept = this.#byModule.get(key) ?? [];
    kept.push(copy);
    this.#byModule.set(key, kept);
    while (kept.length > 2) {
      const old = kept.shift()!;
      this.#written.delete(old);
      Deno.remove(old).catch(() => {});
    }
    return done;
  }

  /** How many copies the session holds (a test seam for the bound). */
  get size(): number {
    return this.#written.size;
  }
}

/** Deterministic short hash (djb2 → base36) for a module URL. */
const hash = djb2;

/** A 64-bit content hash: djb2 over the text forwards, then backwards. */
function contentHash(text: string): string {
  let h = 5381;
  for (let i = text.length - 1; i >= 0; i--) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return djb2(text) + "_" + h.toString(36);
}

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
 * Parse `source` and return its import/export specifiers — static, and each `import()` written
 * as a literal ({@linkcode literalSpecifiers}) — that name local files: relative ones, and bare
 * ones the project's import map aliases to a file (`@/components/Button.tsx`), each resolved by
 * {@linkcode resolvePlatformImport} (the platform variant applied). Packages (`npm:`, `jsr:`,
 * `@std/…`) are skipped. Returns `[]` on a parse error (the module is then treated as a leaf).
 */
async function localImports(
  source: string,
  moduleUrl: string,
  aliases: ImportAliases,
  redirects: Readonly<Record<string, string>>,
): Promise<LocalImport[]> {
  const parsed = await parseModule(source);
  if (!parsed) return [];
  const out: LocalImport[] = [];
  for (const { value: spec } of literalSpecifiers(parsed.body)) {
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
  /** The parsed nodes, once read (dev naming walks them synchronously). */
  #settled = new Map<string, ModuleNode>();
  /** Dev: each copied module's content stamp. */
  #stamps = new Map<string, string>();
  #needs = new Map<string, boolean>();
  #written = new Map<string, Promise<void>>();
  /** Per decided module: settles once every copy its graph needs is written. */
  #ready = new Map<string, Promise<void>>();
  #dir: Promise<void> | null = null;
  #aliases: Promise<ImportAliases> | null = null;

  constructor(private opts: UseCacheLoaderOptions) {}

  /** Whether `url` is a project module the compiler may copy. */
  #own(url: string): boolean {
    return underRoot(url, this.opts.projectDir);
  }

  /**
   * The copy's file URL for `moduleUrl` (named by its URL, so known before it is written; in dev
   * also by its subtree's content, decided by then).
   */
  #copyUrl(moduleUrl: string): string {
    const ext = extname(fromFileUrl(moduleUrl)) || ".ts";
    const stamp = this.opts.dev ? `_${this.#stamp(moduleUrl)}` : "";
    return toFileUrl(join(this.opts.cacheDir, `uc_${hash(moduleUrl)}${stamp}${ext}`)).href;
  }

  /**
   * A copied module's content stamp: a hash over every copied module it reaches (itself
   * included), each by its URL, source and resolved imports. The modules it reaches without a
   * copy load as themselves and are unedited. A cycle's members reach the same set, so each
   * names the others' copies consistently.
   */
  #stamp(moduleUrl: string): string {
    let stamp = this.#stamps.get(moduleUrl);
    if (stamp !== undefined) return stamp;
    const parts: string[] = [];
    const seen = new Set([moduleUrl]);
    for (const url of seen) {
      const node = this.#settled.get(url);
      if (!node || !this.#needs.get(url)) continue;
      parts.push(`${url}\0${contentHash(node.source ?? "")}\0${node.imports.map((i) => i.target)}`);
      for (const imp of node.imports) seen.add(imp.target);
    }
    stamp = contentHash(parts.sort().join("\n"));
    this.#stamps.set(moduleUrl, stamp);
    return stamp;
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
      batch.forEach((u, i) => {
        graph.set(u, nodes[i]);
        this.#settled.set(u, nodes[i]);
      });
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
      const direct = n.useCache || n.imports.some((i) => i.target !== i.url) ||
        !!this.opts.dev?.isEdited(u);
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
    // The copy lives in the cache dir; its `import.meta` keeps naming the module it stands in for,
    // and a non-literal `import()` resolves a relative specifier against that module too.
    const copy = fromFileUrl(this.#copyUrl(moduleUrl));
    const text = await pinImportMeta(code, moduleUrl, { dynamicImports: true });
    const dev = this.opts.dev;
    if (!dev) return await Deno.writeTextFile(copy, text);
    // Another generation may be loading the same copy: write it whole, then move it in place.
    await dev.write(this.opts.cacheDir, moduleUrl, copy, async () => {
      const tmp = `${copy}.${crypto.randomUUID()}.tmp`;
      await Deno.writeTextFile(tmp, text);
      await Deno.rename(tmp, copy);
    });
  }

  /** The effective import URL for `moduleUrl` (original, or a transformed copy). */
  async effectiveUrl(moduleUrl: string): Promise<string> {
    // Only transform project files; leave framework/std/npm and out-of-tree files as-is.
    if (!this.#own(moduleUrl) || this.#needs.get(moduleUrl) === false) return moduleUrl;
    const ready = this.#ready.get(moduleUrl);
    if (ready) {
      await ready;
      return this.#effective(moduleUrl);
    }
    const graph = await this.#reach(moduleUrl);
    this.#decide(graph);
    // Every copy the module's graph imports exists before it loads.
    const copied = [...graph].filter(([u]) => this.#needs.get(u));
    const written = Promise.all(copied.map(([u, n]) => this.#write(u, n))).then(() => {});
    for (const u of graph.keys()) if (!this.#ready.has(u)) this.#ready.set(u, written);
    await written;
    return this.#effective(moduleUrl);
  }
}

/**
 * Compile the server copies of every module in `files` ahead of time (`denext build`, so
 * `denext start` writes nothing and walks nothing): the copies are written under
 * `opts.cacheDir`, and the result maps each module that loads a copy (file URL) to it.
 *
 * @param opts As for {@linkcode createUseCacheLoader}.
 * @param files The project's source modules (absolute paths).
 * @returns Module file URL → its copy's file URL, for the modules that have one.
 */
export async function compileServerCopies(
  opts: UseCacheLoaderOptions,
  files: readonly string[],
): Promise<Record<string, string>> {
  const compiler = new UseCacheCompiler(opts);
  const out: Record<string, string> = {};
  for (const file of files) {
    const url = toUrl(file);
    const eff = await compiler.effectiveUrl(url).catch(() => url);
    if (eff !== url) out[url] = eff;
  }
  return out;
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
  return createUseCacheLoaders([base], opts)[0];
}

/**
 * {@linkcode createUseCacheLoader} over several base loaders that share ONE compiler (one walk,
 * one set of copies): the dev server renders through a cache-busting base and tags the Flight
 * boundary through a query-less one, and both must load the same copies.
 *
 * @param bases The underlying loaders.
 * @param opts Project root and the (generation-scoped) copy cache dir.
 * @returns One wrapping loader per base, in order.
 */
export function createUseCacheLoaders(
  bases: readonly ModuleLoader[],
  opts: UseCacheLoaderOptions,
): ModuleLoader[] {
  const compiler = new UseCacheCompiler(opts);
  const canonical = projectSpelling(opts.projectDir);
  return bases.map((base) => async (filePath: string): Promise<unknown> => {
    const url = canonical(toUrl(filePath));
    let eff: string;
    try {
      // A module loaded by its plain path (a boundary ref being tagged) loads its variant too.
      eff = await compiler.effectiveUrl(opts.redirects?.[url] ?? url);
    } catch {
      eff = url; // any transform failure → load the original (never break loading)
    }
    return base(eff);
  });
}

/**
 * A module URL spelled through the project root: a crawl names modules by their real path (a
 * boundary ref under macOS's `/private/var` for a project in `/var`), while redirects and copies
 * are keyed by the root as given.
 */
function projectSpelling(projectDir: string): (url: string) => string {
  const root = toFileUrl(resolve(projectDir)).href + "/";
  let real: string | null = null;
  try {
    real = toFileUrl(Deno.realPathSync(projectDir)).href + "/";
  } catch { /* no project dir on disk: nothing to respell */ }
  return (url) =>
    real && real !== root && url.startsWith(real) ? root + url.slice(real.length) : url;
}

/**
 * A loader over copies {@linkcode compileServerCopies} wrote at build time (`denext start`):
 * each module loads its target's variant, through its copy when it has one, with no walk, no
 * compile and no write.
 *
 * @param base The underlying loader.
 * @param opts The project root, the target's redirects and the copies (file URL → copy URL).
 */
export function createPrecompiledLoader(
  base: ModuleLoader,
  opts: {
    projectDir: string;
    redirects: Readonly<Record<string, string>>;
    copies: Readonly<Record<string, string>>;
  },
): ModuleLoader {
  const canonical = projectSpelling(opts.projectDir);
  return (filePath: string): Promise<unknown> => {
    const url = canonical(toUrl(filePath));
    const target = opts.redirects[url] ?? url;
    return base(opts.copies[target] ?? target);
  };
}
