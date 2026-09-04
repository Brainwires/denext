// Static export, stage 2: render every page (× each static param set × each locale) to
// its HTML file, then copy `public/`.

import { copy, ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import type { PageRoute } from "../../router/manifest.ts";
import { fillPattern, type RouteParams } from "../../router/segments.ts";
import { isNotFound } from "../../runtime/error-boundary.ts";
import { publicEnv } from "../../runtime/public-env.ts";
import { augmentMetadataConventions } from "../../server/augment-metadata.ts";
import { renderDocument } from "../../server/document.ts";
import { peelLocale } from "../../server/i18n.ts";
import { renderPage } from "../../server/render-page.ts";
import { createRequestContext, runWithContext } from "../../server/request-context.ts";
import { readSegmentConfig } from "../../server/segment-config.ts";
import type { PageModule } from "../../server/types.ts";
import { clientEntryFor, type ExportContext, styleHrefsFor } from "./context.ts";

/** Render one page to a full HTML document string. */
function renderStatic(
  ctx: ExportContext,
  route: PageRoute,
  params: RouteParams,
  pathname: string,
): Promise<string> {
  const { manifest, i18n } = ctx;
  const request = new Request(`http://localhost${pathname}`);
  const rctx = createRequestContext(request);
  return runWithContext(rctx, async () => {
    const flight = ctx.flightRoutes.has(route.routePath);
    const rendered = await renderPage({ route, params }, request, ctx.load, { flight });
    // Apply the same file-convention / hreflang augmentation the served path does.
    // Absolute URLs resolve against the page's metadataBase (there is no request Host in
    // a static export); with no metadataBase, og:image stays relative and
    // hreflang/canonical are skipped (they require an absolute URL).
    const base = rendered.metadata.metadataBase;
    augmentMetadataConventions(rendered.metadata, {
      manifest,
      route,
      i18n,
      localeInfo: i18n ? peelLocale(pathname, i18n) : null,
      absolutize: (path) => {
        if (!base) return null;
        try {
          return new URL(path, base).href;
        } catch {
          return null;
        }
      },
    });
    return renderDocument({
      bodyHtml: rendered.html,
      metadata: rendered.metadata,
      viewport: rendered.viewport,
      clientEntry: clientEntryFor(ctx, route),
      styles: styleHrefsFor(ctx, route),
      hydration: { params, searchParams: "", pathname },
      flight: rendered.flight,
      islands: rendered.islands,
      signalState: rendered.signalState,
      publicEnv: publicEnv(),
    });
  });
}

/** Resolve the param sets to render for a route, or null to skip it. */
async function paramSetsFor(ctx: ExportContext, route: PageRoute): Promise<RouteParams[] | null> {
  const isDynamic = route.pattern.some((s) => s.kind !== "static");
  if (!isDynamic) return [{}];
  const mod = (await ctx.load(route.filePath)) as PageModule;
  if (typeof mod.generateStaticParams !== "function") return null;
  const sets = await mod.generateStaticParams();
  return sets.map((s) => ({ ...s }));
}

/** Map a pathname to its output HTML file (clean-URL directories). */
function pageFilePath(outDir: string, pathname: string): string {
  if (pathname === "/") return join(outDir, "index.html");
  return join(outDir, pathname, "index.html");
}

/** Record a skipped route/pathname with its reason. */
function skip(ctx: ExportContext, what: string, reason: string): void {
  ctx.skipped.push(what);
  console.warn(`  skip ${what} — ${reason}`);
}

/**
 * Render one page variant to its file. A route (or param) that renders to `notFound()`
 * with no not-found boundary is statically a 404 — its file is skipped (the host serves
 * its own 404) rather than aborting the whole export, mirroring the dynamic-without-params
 * skip. Real errors and redirect()s still bubble.
 */
async function writePage(
  ctx: ExportContext,
  route: PageRoute,
  params: RouteParams,
  pathname: string,
): Promise<void> {
  let html: string;
  try {
    html = await renderStatic(ctx, route, params, pathname);
  } catch (err) {
    if (isNotFound(err)) return skip(ctx, pathname, "renders notFound()");
    throw err;
  }
  const file = pageFilePath(ctx.outDir, pathname);
  await ensureDir(dirname(file));
  await Deno.writeTextFile(file, html);
  console.log(`  ${pathname} -> ${file.slice(ctx.outDir.length + 1)}`);
  ctx.pages++;
}

/**
 * Render a route for one param set. With i18n, emit one variant per locale: the default
 * locale unprefixed, others under /<locale>/… . Without i18n, a single unprefixed page.
 */
async function renderParamSet(ctx: ExportContext, route: PageRoute, params: RouteParams) {
  const { i18n } = ctx;
  const basePath = fillPattern(route.pattern, params);
  for (const loc of i18n ? i18n.locales : [null]) {
    const isDefault = !i18n || loc === i18n.defaultLocale;
    const pathname = isDefault ? basePath : `/${loc}${basePath === "/" ? "" : basePath}`;
    const localeParams = i18n ? { ...params, locale: loc! } : params;
    await writePage(ctx, route, localeParams, pathname);
  }
}

/** Render every page (× each static param set). */
export async function renderAllPages(ctx: ExportContext): Promise<void> {
  for (const route of ctx.manifest.pages) {
    const mod = (await ctx.load(route.filePath)) as PageModule;
    // force-dynamic routes render per request; they can't be pre-rendered.
    if (readSegmentConfig(mod).dynamic === "force-dynamic") {
      skip(ctx, route.routePath, 'export const dynamic = "force-dynamic"');
      continue;
    }
    const paramSets = await paramSetsFor(ctx, route);
    if (paramSets === null) {
      skip(ctx, route.routePath, "dynamic route without generateStaticParams");
      continue;
    }
    for (const params of paramSets) await renderParamSet(ctx, route, params);
  }
}

/** Copy the public directory's contents into the output directory. */
export async function copyPublic(publicDir: string, outDir: string): Promise<void> {
  try {
    for await (const entry of Deno.readDir(publicDir)) {
      await copy(join(publicDir, entry.name), join(outDir, entry.name), { overwrite: true });
    }
  } catch {
    // No public/ directory — nothing to copy.
  }
}
