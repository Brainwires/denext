// Static site export (SSG): pre-render every page — including dynamic routes
// enumerated by `generateStaticParams` — to static HTML plus client bundles, in
// a directory any static host can serve.

import { copy, ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { scanRoutes } from "../router/manifest.ts";
import type { PageRoute } from "../router/manifest.ts";
import { renderPage } from "../server/render-page.ts";
import { renderDocument } from "../server/document.ts";
import { defaultLoader } from "../server/mod.ts";
import { createRequestContext, runWithContext } from "../server/request-context.ts";
import type { ModuleLoader, PageModule } from "../server/types.ts";
import type { RouteParams } from "../router/segments.ts";
import { bundleRoute } from "./bundle.ts";
import { resolveProject, routeId } from "./paths.ts";

export interface StaticExportResult {
  /** Absolute path of the output directory. */
  outDir: string;
  /** Number of HTML pages written. */
  pages: number;
  /** Route paths skipped (dynamic without generateStaticParams). */
  skipped: string[];
}

export interface StaticExportOptions {
  /** Output directory name (relative to the project); defaults to "out". */
  outDir?: string;
}

/** Pre-render a denext app to a static, host-anywhere directory. */
export async function staticExport(
  projectDir: string,
  options: StaticExportOptions = {},
): Promise<StaticExportResult> {
  const paths = await resolveProject(projectDir);
  const manifest = await scanRoutes(paths.appDir);
  const outDir = join(projectDir, options.outDir ?? "out");
  const clientOut = join(outDir, "_denext", "client");
  await ensureDir(clientOut);
  const load = defaultLoader;

  // 1. Client bundles (minified), one per route.
  for (const route of manifest.pages) {
    const js = await bundleRoute(route, {
      configPath: paths.configPath,
      minify: true,
    });
    await Deno.writeTextFile(
      join(clientOut, `${routeId(route.routePath)}.js`),
      js,
    );
  }
  const clientEntryFor = (route: PageRoute): string =>
    `/_denext/client/${routeId(route.routePath)}.js`;

  // 2. Render every page (× each static param set).
  let pages = 0;
  const skipped: string[] = [];
  for (const route of manifest.pages) {
    const paramSets = await paramSetsFor(route, load);
    if (paramSets === null) {
      skipped.push(route.routePath);
      console.warn(
        `  skip ${route.routePath} — dynamic route without generateStaticParams`,
      );
      continue;
    }
    for (const params of paramSets) {
      const pathname = fillPath(route, params);
      const html = await renderStatic(route, params, pathname, clientEntryFor, load);
      const file = pageFilePath(outDir, pathname);
      await ensureDir(dirname(file));
      await Deno.writeTextFile(file, html);
      console.log(`  ${pathname} -> ${file.slice(outDir.length + 1)}`);
      pages++;
    }
  }

  // 3. Copy public assets.
  await copyPublic(paths.publicDir, outDir);

  return { outDir, pages, skipped };
}

/** Render one page to a full HTML document string. */
function renderStatic(
  route: PageRoute,
  params: RouteParams,
  pathname: string,
  clientEntryFor: (route: PageRoute) => string,
  load: ModuleLoader,
): Promise<string> {
  const request = new Request(`http://localhost${pathname}`);
  const ctx = createRequestContext(request);
  return runWithContext(ctx, async () => {
    const { html, metadata } = await renderPage({ route, params }, request, load);
    return renderDocument({
      bodyHtml: html,
      metadata,
      clientEntry: clientEntryFor(route),
      hydration: { params, searchParams: "", pathname },
    });
  });
}

/** Resolve the param sets to render for a route, or null to skip it. */
async function paramSetsFor(
  route: PageRoute,
  load: ModuleLoader,
): Promise<RouteParams[] | null> {
  const isDynamic = route.pattern.some((s) => s.kind !== "static");
  if (!isDynamic) return [{}];
  const mod = (await load(route.filePath)) as PageModule;
  if (typeof mod.generateStaticParams !== "function") return null;
  const sets = await mod.generateStaticParams();
  return sets.map((s) => ({ ...s }));
}

/** Fill a route pattern with params to produce a concrete pathname. */
function fillPath(route: PageRoute, params: RouteParams): string {
  const parts: string[] = [];
  for (const seg of route.pattern) {
    if (seg.kind === "static") parts.push(seg.value);
    else if (params[seg.value]) parts.push(params[seg.value]); // dynamic / catch-all
  }
  return "/" + parts.join("/");
}

/** Map a pathname to its output HTML file (clean-URL directories). */
function pageFilePath(outDir: string, pathname: string): string {
  if (pathname === "/") return join(outDir, "index.html");
  return join(outDir, pathname, "index.html");
}

/** Copy the public directory's contents into the output directory. */
async function copyPublic(publicDir: string, outDir: string): Promise<void> {
  try {
    for await (const entry of Deno.readDir(publicDir)) {
      await copy(join(publicDir, entry.name), join(outDir, entry.name), {
        overwrite: true,
      });
    }
  } catch {
    // No public/ directory — nothing to copy.
  }
}
