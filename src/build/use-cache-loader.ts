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
import { absolutizeSpecifiers, applyEdits, type Edit, parseModule, swcParse } from "./swc-ast.ts";
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

/**
 * A per-instance compiler that maps a module's `file:` URL to the URL that should
 * actually be imported — the original when its subtree contains no `"use cache"`,
 * or a written transformed copy otherwise. Post-order over the import graph, so a
 * parent's copy imports its children's (possibly transformed) effective URLs.
 */
class UseCacheCompiler {
  #memo = new Map<string, string>();
  #inProgress = new Set<string>();
  #ensured = false;
  #aliases: Promise<ImportAliases> | null = null;

  constructor(private opts: UseCacheLoaderOptions) {}

  async #ensureDir(): Promise<void> {
    if (this.#ensured) return;
    await Deno.mkdir(this.opts.cacheDir, { recursive: true });
    this.#ensured = true;
  }

  /** The effective import URL for `moduleUrl` (original, or a transformed copy). */
  async effectiveUrl(moduleUrl: string): Promise<string> {
    const cached = this.#memo.get(moduleUrl);
    if (cached) return cached;
    // Only transform project files; leave framework/std/npm and out-of-tree files
    // as-is. A cycle (in-progress) resolves to the original to break the recursion.
    if (!underRoot(moduleUrl, this.opts.projectDir) || this.#inProgress.has(moduleUrl)) {
      return moduleUrl;
    }
    this.#inProgress.add(moduleUrl);
    try {
      const result = await this.#compute(moduleUrl);
      this.#memo.set(moduleUrl, result);
      return result;
    } finally {
      this.#inProgress.delete(moduleUrl);
    }
  }

  /**
   * Resolve each local import of `source` (relative, or an import-map alias) to its effective
   * URL (post-order recursion), through the platform redirect first: `childMap` by the file the
   * import names, `bareMap` by an alias specifier the copy must rewrite.
   */
  async #children(source: string, moduleUrl: string): Promise<{
    childMap: Map<string, string>;
    bareMap: Map<string, string>;
    anyChildCopied: boolean;
  }> {
    const aliases = await (this.#aliases ??= readImportAliases(this.opts.projectDir));
    const imports = await localImports(source, moduleUrl, aliases, this.opts.redirects ?? {});
    const childMap = new Map<string, string>();
    const bareMap = new Map<string, string>();
    let anyChildCopied = false;
    for (const imp of imports) {
      const eff = await this.effectiveUrl(imp.target);
      childMap.set(imp.url, eff);
      const changed = eff !== imp.url;
      anyChildCopied ||= changed;
      if (rewritesBare(imp, changed)) bareMap.set(imp.spec, eff);
    }
    return { childMap, bareMap, anyChildCopied };
  }

  async #compute(moduleUrl: string): Promise<string> {
    let source: string;
    try {
      source = await Deno.readTextFile(fromFileUrl(moduleUrl));
    } catch {
      return moduleUrl; // unreadable → import the original
    }

    const { childMap, bareMap, anyChildCopied } = await this.#children(source, moduleUrl);

    // No directive here and no transformed child ⇒ this module is unchanged.
    const useCache = this.opts.useCache !== false && source.includes("use cache");
    if (!useCache && !anyChildCopied) return moduleUrl;

    const resolveSpecifier = (abs: string) => childMap.get(abs) ?? abs;
    const resolveBare = (spec: string) => bareMap.get(spec) ?? null;
    const { code, changed } = this.opts.useCache === false
      ? await rewriteLocalImports(source, moduleUrl, resolveSpecifier, resolveBare)
      : await transformUseCache(source, moduleUrl, {
        resolveSpecifier,
        resolveBare,
        alwaysRewriteImports: true,
      });
    if (!changed) return moduleUrl;

    await this.#ensureDir();
    const ext = extname(fromFileUrl(moduleUrl)) || ".ts";
    const outPath = join(this.opts.cacheDir, `uc_${hash(moduleUrl)}${ext}`);
    await Deno.writeTextFile(outPath, code);
    return toFileUrl(outPath).href;
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
