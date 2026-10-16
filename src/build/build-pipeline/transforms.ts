// Production build, stage 1: app CSS + the client-module transforms (auto-memo compiler,
// qrl handler extraction, AsyncContext instrumentation, feature folds), merged into the bundler
// import map. `denext export` runs the same transforms (../export-pipeline/assets.ts).

import { extname, join, SEPARATOR } from "@std/path";
import { asyncContextEnabled, featureFlags, reactCompilerEnabled } from "../../server/config.ts";
import { prodMinify } from "../minify.ts";
import { compileAsyncContextModules } from "../async-context-transform.ts";
import { compileFeatureModules } from "../feature-transform.ts";
import { collectComponentSources, compileModules } from "../compiler.ts";
import { type AppCss, buildAppCss } from "../css.ts";
import { routeNeedsHydration } from "../hydration.ts";
import { clientGraphModules, routeEntryFiles } from "../module-graph.ts";
import { stylesheetImportMap } from "../platform-imports.ts";
import type { Platform } from "../platform-extensions.ts";
import { compileQrlModules } from "../qrl-transform.ts";
import { tailwindPaths } from "../tailwind.ts";
import { type BuildContext, log } from "./context.ts";

/**
 * CSS assets for the whole app: the import map lets `deno bundle` resolve every `.css`
 * import to its shim; per-route extraction produces the linked stylesheet.
 */
export async function buildCss(ctx: BuildContext): Promise<AppCss | null> {
  const { projectDir, paths, manifest } = ctx;
  return await buildAppCss({
    projectDir,
    configPath: paths.configPath,
    outDir: paths.outDir,
    minify: prodMinify(),
    // Every route's page/layout files are the app's import roots; crawling them finds
    // stylesheets in sibling workspace packages (outside `projectDir`) the walk misses.
    entryFiles: [...new Set(manifest.pages.flatMap(routeEntryFiles))],
    tailwind: tailwindPaths(projectDir, paths.config?.tailwind),
    // A next-compat app's esbuild bundles probe the `.web` files, so its stylesheet crawl
    // resolves them through their redirects (the native path's crawls already do).
    graph: ctx.compat
      ? await stylesheetImportMap(
        projectDir,
        paths.config,
        "web",
        join(paths.outDir, "platform-imports", "css-web"),
      )
      : undefined,
  });
}

type RewriteMap = Record<string, string> | undefined;

/** Memoized component-source scan (the compiler and the qrl extractor share it). */
function componentSourcesOnce(projectDir: string): () => Promise<string[]> {
  let scan: Promise<string[]> | null = null;
  return () => scan ??= collectComponentSources(projectDir);
}

/** The plain-script extensions the client passes cover beyond `.tsx` / `.jsx`. */
const SCRIPT_EXTS = new Set([".ts", ".mts", ".js", ".mjs"]);

/**
 * The modules the AsyncContext pass instruments and the `feature()` fold rewrites: every
 * component source, plus each plain `.ts` / `.js` / `.mts` / `.mjs` module of the project a
 * client bundle can contain ({@linkcode clientGraphModules}) — a hook or store that awaits
 * inside `startTransition`, or calls `feature("KEY")`, was missed when only `.tsx` / `.jsx`
 * were scanned. A module only the server tree reaches (a Flight page's data module, a
 * `"use server"` module and what it imports) is left alone. When the graph cannot be crawled,
 * the component sources alone.
 */
async function clientModuleSources(
  ctx: Pick<BuildContext, "projectDir" | "paths" | "manifest" | "flightRoutes">,
  components: string[],
): Promise<string[]> {
  const { manifest, paths } = ctx;
  const extra = [manifest.rootGlobalError, paths.instrumentationClientPath]
    .filter((f): f is string => !!f);
  const entries = [...new Set([...manifest.pages.flatMap(routeEntryFiles), ...extra])];
  const wholeTree = [...extra];
  for (const route of manifest.pages) {
    if (ctx.flightRoutes.has(route.routePath)) continue;
    if (await routeNeedsHydration(route)) wholeTree.push(...routeEntryFiles(route));
  }
  const reached = await clientGraphModules(entries, [...new Set(wholeTree)]).catch(() => []);
  const root = await Deno.realPath(ctx.projectDir).catch(() => ctx.projectDir);
  const inProject = (p: string) =>
    p.startsWith(root + SEPARATOR) &&
    !/[/\\](node_modules|\.denext|\.git)[/\\]/.test(p.slice(root.length));
  // The crawl names modules by their real path; the bundler's redirects are keyed by the
  // project's own spelling (a temp dir under macOS's `/var` is `/private/var`).
  const scripts = reached.filter((p) => SCRIPT_EXTS.has(extname(p)) && inProject(p))
    .map((p) => join(ctx.projectDir, p.slice(root.length)));
  return [...new Set([...components, ...scripts])].sort();
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
 * aligned. Auto-memo (opt-in) and AsyncContext transition scoping (opt-in) need their
 * config flags; qrl auto-wrap self-filters to modules
 * that opt into resumability, so it always runs and is inert for every other app.
 * On overlap the later spread wins: qrl over auto-memo (intended), async-context over both.
 *
 * `denext build` and `denext export` both call this, and every native client bundle either of
 * them makes resolves through the result (./routes.ts, ../export-pipeline/context.ts).
 *
 * @param ctx The project and its config.
 * @param outDir Where the transformed modules are written (default: the build's output dir).
 * @param platform The build target `platform` (denext/platform) folds to (default `web`).
 * @returns Each transformed module's file URL → its transformed file's URL.
 */
export async function clientTransforms(
  ctx: Pick<BuildContext, "projectDir" | "paths" | "manifest" | "flightRoutes">,
  outDir: string = ctx.paths.outDir,
  platform: Platform = "web",
): Promise<Record<string, string>> {
  const { projectDir, paths } = ctx;
  const sources = componentSourcesOnce(projectDir);
  // The client-graph crawl is shared by the AsyncContext pass and the feature fold.
  let clientSources: Promise<string[]> | null = null;
  const clientModules = () =>
    clientSources ??= sources().then((components) => clientModuleSources(ctx, components));
  let compilerMap: RewriteMap;
  if (reactCompilerEnabled(paths.config)) {
    log("auto-memo compiler: transforming components");
    compilerMap = await compileModules(await sources(), { outDir });
  }
  const qrlMap = await compileQrlModules(await sources(), { outDir });
  const qrlCount = Object.keys(qrlMap).length;
  if (qrlCount > 0) log(`qrl: code-split ${qrlCount} resumable module(s)`);
  let asyncContextMap: RewriteMap;
  if (asyncContextEnabled(paths.config)) {
    log("async-context: instrumenting awaits for transition scoping");
    asyncContextMap = await compileAsyncContextModules(await clientModules(), { outDir });
  }
  warnClobbered(asyncContextMap, compilerMap, qrlMap);
  const merged = { ...compilerMap, ...qrlMap, ...asyncContextMap };
  // The build-constant fold runs LAST, over each module's already-transformed source (so it
  // never clobbers auto-memo/qrl/async-context), replacing `feature("KEY")` with the configured
  // literal and `platform` (denext/platform) with the target, so `deno bundle`
  // dead-code-eliminates the untaken branches.
  const featureMap = await compileFeatureModules(await clientModules(), merged, {
    outDir,
    features: featureFlags(paths.config),
    platform,
  });
  const folded = Object.keys(featureMap).length;
  if (folded > 0) log(`build constants: folded feature() / platform in ${folded} module(s)`);
  Object.assign(merged, featureMap);
  return merged;
}
