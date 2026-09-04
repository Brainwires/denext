// Production build, stage 1: app CSS + the client-module transforms (auto-memo compiler,
// qrl handler extraction, AsyncContext instrumentation), merged into the bundler import map.

import { compileAsyncContextModules } from "../async-context-transform.ts";
import { collectComponentSources, compileModules } from "../compiler.ts";
import { type AppCss, buildAppCss } from "../css.ts";
import { routeEntryFiles } from "../module-graph.ts";
import { compileQrlModules } from "../qrl-transform.ts";
import { tailwindPaths } from "../tailwind.ts";
import { type BuildContext, log } from "./context.ts";

/**
 * CSS assets for the whole app: the import map lets `deno bundle` resolve every `.css`
 * import to its shim; per-route extraction produces the linked stylesheet.
 */
export function buildCss(ctx: BuildContext): Promise<AppCss | null> {
  const { projectDir, paths, manifest } = ctx;
  return buildAppCss({
    projectDir,
    configPath: paths.configPath,
    outDir: paths.outDir,
    minify: true,
    // Every route's page/layout files are the app's import roots; crawling them finds
    // stylesheets in sibling workspace packages (outside `projectDir`) the walk misses.
    entryFiles: [...new Set(manifest.pages.flatMap(routeEntryFiles))],
    tailwind: tailwindPaths(projectDir, paths.config?.tailwind),
  });
}

type RewriteMap = Record<string, string> | undefined;

/** Memoized component-source scan (the compiler and the qrl extractor share it). */
function componentSourcesOnce(projectDir: string): () => Promise<string[]> {
  let scan: Promise<string[]> | null = null;
  return () => scan ??= collectComponentSources(projectDir);
}

/**
 * Guard the one clobber that silently drops a needed rewrite: async-context instruments
 * the ORIGINAL source, so if a module is ALSO auto-memo'd or qrl-split, only the
 * last-spread rewrite (async-context) reaches the bundle and the other is lost. The
 * qrl-over-auto-memo overlap is intentional precedence (qrl wins), so it is not warned.
 */
function warnClobbered(asyncContextMap: RewriteMap, compilerMap: RewriteMap, qrlMap: RewriteMap) {
  if (!asyncContextMap) return;
  const clobbered = Object.keys(asyncContextMap).filter(
    (url) => (compilerMap && url in compilerMap) || (qrlMap && url in qrlMap),
  );
  if (clobbered.length === 0) return;
  log(
    `WARNING: async-context instrumented ${clobbered.length} module(s) that auto-memo/qrl ` +
      `also rewrote; only the async-context rewrite reaches the client bundle: ` +
      clobbered.join(", "),
  );
}

/**
 * The client-only module rewrites, each keyed by original module URL. Server rendering
 * keeps the originals (every transform is behavior-neutral there), so SSR/hydration stay
 * aligned. Auto-memo (experimental, opt-in) and AsyncContext transition scoping
 * (experimental, opt-in) need their config flags; qrl auto-wrap self-filters to modules
 * that opt into resumability, so it always runs and is inert for every other app.
 * On overlap the later spread wins: qrl over auto-memo (intended), async-context over both.
 */
export async function clientTransforms(ctx: BuildContext): Promise<Record<string, string>> {
  const { projectDir, paths } = ctx;
  const outDir = paths.outDir;
  const sources = componentSourcesOnce(projectDir);
  let compilerMap: RewriteMap;
  if (paths.config?.experimental?.compiler) {
    log("auto-memo compiler: transforming components (experimental)");
    compilerMap = await compileModules(await sources(), { outDir });
  }
  const qrlMap = await compileQrlModules(await sources(), { outDir });
  const qrlCount = Object.keys(qrlMap).length;
  if (qrlCount > 0) log(`qrl: code-split ${qrlCount} resumable module(s)`);
  let asyncContextMap: RewriteMap;
  if (paths.config?.experimental?.asyncContext) {
    log("async-context: instrumenting awaits for transition scoping (experimental)");
    asyncContextMap = await compileAsyncContextModules(await sources(), { outDir });
  }
  warnClobbered(asyncContextMap, compilerMap, qrlMap);
  return { ...compilerMap, ...qrlMap, ...asyncContextMap };
}
