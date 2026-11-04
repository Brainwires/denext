// Split islands on isomorphic (non-Flight) routes, at build time.
//
// An isomorphic route ships its whole tree as one client bundle, and a `client:*` island in it
// defers its hydration (src/client/iso-island.ts). This pass also takes the island's code out of
// that bundle: in each app module only isomorphic routes reach, a directive element whose
// component is imported only for directive elements (`<Chart client:visible />`) is pointed at an
// `isoIslandChunk(() => import("./chart.tsx").then((m) => m.default))` stand-in and the static
// import is dropped, so the bundler moves the component's module (and what only it imports) into
// a chunk of its own, fetched when the island's strategy fires. The server keeps rendering the
// original modules (every client transform is client-only), so its output is unchanged.
//
// Left as written (the island then hydrates in place from the page bundle, as before): a
// component also used without a directive or imported beside a binding used elsewhere, a member
// tag, a name an inner scope re-binds, and every module a Flight route, `global-error` or
// `instrumentation-client` also reaches (a Flight route renders the original's directive
// itself, and those entries don't install the island runtime).

import { fromFileUrl, join, toFileUrl } from "@std/path";
import { routeNeedsHydration } from "./hydration.ts";
import { clientGraphModules, routeEntryFiles } from "./module-graph.ts";
import { type IslandRewrite, rewriteIslandElements, type SpaIslandResult } from "./spa-islands.ts";
import { writeTransformedModules } from "./swc-ast.ts";
import type { BuildContext } from "./build-pipeline/context.ts";

/** A module that may carry a directive (the graph crawls are skipped for an app with none). */
const MAYBE = /\bclient:(?:load|idle|visible|interaction|media|only)\b/;

/** Isomorphic routes: an `isoIslandChunk` stand-in per split component, its tag in place. */
const ISO_REWRITE: IslandRewrite = {
  splitOnly: true,
  members: false,
  runtime: `import { isoIslandChunk as __dnxIsoChunk } from "denext/iso-island";\n`,
  declare: (i, loader) => `const __DnxIso${i} = /* @__PURE__ */ __dnxIsoChunk(${loader});\n`,
  open: (i) => `__DnxIso${i}`,
  close: (i) => `__DnxIso${i}`,
};

/**
 * Rewrite a module's split-able `client:*` component elements for an isomorphic route (see the
 * module header).
 *
 * @param source The module source (TSX/JSX).
 * @param opts.moduleUrl The module's URL, when the output is written elsewhere (its relative
 *   specifiers are made absolute).
 * @returns The rewritten module and which imports were dropped.
 */
export function transformIsoIslands(
  source: string,
  opts: { moduleUrl?: string } = {},
): Promise<SpaIslandResult> {
  return rewriteIslandElements(source, opts, ISO_REWRITE);
}

/** The component sources that write a `client:*` directive. */
async function directiveSources(components: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const file of components) {
    if (MAYBE.test(await Deno.readTextFile(file).catch(() => ""))) out.push(file);
  }
  return out;
}

/**
 * The entry modules of the isomorphic routes whose tree hydrates (`iso`), and of every other
 * client bundle (`other`: the Flight routes, `global-error`, `instrumentation-client`).
 */
async function bundleEntries(
  ctx: Pick<BuildContext, "paths" | "manifest" | "flightRoutes">,
): Promise<{ iso: string[]; other: string[] }> {
  const iso: string[] = [];
  const other = [ctx.manifest.rootGlobalError, ctx.paths.instrumentationClientPath]
    .filter((f): f is string => !!f);
  for (const route of ctx.manifest.pages) {
    if (ctx.flightRoutes.has(route.routePath)) other.push(...routeEntryFiles(route));
    else if (await routeNeedsHydration(route)) iso.push(...routeEntryFiles(route));
  }
  return { iso, other };
}

/**
 * The component modules whose islands split: those with a directive that an isomorphic route's
 * client bundle reaches and no other bundle does. Empty when a crawl fails (nothing splits).
 */
async function splitModules(
  ctx: Pick<BuildContext, "paths" | "manifest" | "flightRoutes">,
  components: string[],
): Promise<string[]> {
  const candidates = await directiveSources(components);
  if (candidates.length === 0) return [];
  const { iso, other } = await bundleEntries(ctx);
  if (iso.length === 0) return [];
  const crawled = await Promise.all([
    clientGraphModules(iso, iso),
    clientGraphModules(other, other),
  ]).catch(() => null);
  if (!crawled) return [];
  const [reached, elsewhere] = crawled.map((paths) => new Set(paths));
  // The crawls name each module by its real path (macOS's `/var` is `/private/var`).
  const real = await Promise.all(candidates.map((f) => Deno.realPath(f).catch(() => f)));
  return candidates.filter((_, i) => reached.has(real[i]) && !elsewhere.has(real[i]));
}

/**
 * The isomorphic routes' split islands as a client transform: each module with an island to split
 * (see the module header) rewritten into `<outDir>/iso-islands`, over an earlier pass's output.
 *
 * @param ctx The project, its routes and which of them are Flight routes.
 * @param components The app's component sources.
 * @param prior `original module URL → transformed module URL` from the earlier passes.
 * @param outDir The build output directory.
 * @returns Each rewritten module's original URL → its rewrite's URL.
 */
export async function compileIsoIslandModules(
  ctx: Pick<BuildContext, "paths" | "manifest" | "flightRoutes">,
  components: string[],
  prior: Record<string, string>,
  outDir: string,
): Promise<Record<string, string>> {
  const files = await splitModules(ctx, components);
  if (files.length === 0) return {};
  return writeTransformedModules(
    files,
    join(outDir, "iso-islands"),
    (source, url) => transformIsoIslands(source, { moduleUrl: url }),
    (file) => {
      const earlier = prior[toFileUrl(file).href];
      return earlier ? fromFileUrl(earlier) : file;
    },
  );
}
