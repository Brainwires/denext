// Build-time static generation (SSG) for the Pages Router: run
// `getStaticPaths`/`getStaticProps` for each static page and write pre-rendered
// `index.html` + `props.json` to `<outDir>/pages-static/<path>/`. At runtime the
// handler serves those files directly (and, for `revalidate` pages, through the
// PageCache for stale-while-revalidate ISR). Mirrors the App Router's
// `src/build/export.ts` param-expansion pattern.

import { join } from "@std/path";
import { matchSegments, type RouteParams, type Segment } from "@denext/denext/server";
import { type NextData, type PageComponent, renderPage } from "./render.ts";
import type { PageEntry, PagesScan } from "./scan.ts";

/** The `getStaticProps` result shape we consume. */
interface GspResult {
  props?: Record<string, unknown>;
  notFound?: boolean;
  redirect?: { destination: string; permanent?: boolean };
  /** ISR window in seconds — the page is regenerated at most once per interval. */
  revalidate?: number;
}

/** The `getStaticPaths` result shape we consume. */
interface GspPaths {
  paths: Array<string | { params: RouteParams }>;
  fallback: boolean | "blocking";
}

/** A page module's SSG-relevant exports. */
interface PageModule {
  default?: PageComponent;
  // deno-lint-ignore no-explicit-any
  getStaticProps?: (ctx: any) => Promise<GspResult> | GspResult;
  getStaticPaths?: () => Promise<GspPaths> | GspPaths;
}

/** Options for {@linkcode prerenderStaticPages}. */
export interface PrerenderOptions {
  scan: PagesScan;
  load: (filePath: string) => Promise<unknown>;
  /** Build output dir; files land under `<outDir>/pages-static/`. */
  outDir: string;
  /** routePath → client bundle URL path (without basePath), or null. */
  bundleUrlFor: (routePath: string) => string | null;
  /** routePath → CSS URL path (without basePath), or null. */
  cssUrlFor: (routePath: string) => string | null;
  lang?: string;
  basePath?: string;
}

/** Load a module's default export, or null. */
async function loadDefault(
  filePath: string | null,
  load: (f: string) => Promise<unknown>,
): Promise<PageComponent | null> {
  if (!filePath) return null;
  return ((await load(filePath)) as { default?: PageComponent }).default ?? null;
}

/** Fill a route pattern with params → a concrete pathname (mirror `export.ts`). */
function fillPath(pattern: Segment[], params: RouteParams): string {
  const parts: string[] = [];
  for (const seg of pattern) {
    if (seg.kind === "static") parts.push(seg.value);
    else {
      const v = params[seg.value];
      if (v != null && v !== "") parts.push(v); // catch-all values already contain "/"
    }
  }
  return "/" + parts.join("/");
}

/** A concrete instance of a route to prerender. */
interface Target {
  params: RouteParams;
  pathname: string;
}

/** Resolve which concrete paths to prerender for a page (null ⇒ cannot prerender). */
async function resolveTargets(entry: PageEntry, mod: PageModule): Promise<Target[] | null> {
  const isDynamic = entry.pattern.some((s) => s.kind !== "static");
  if (!isDynamic) return [{ params: {}, pathname: entry.routePath }];
  if (typeof mod.getStaticPaths !== "function") return null; // dynamic, not enumerable
  const gsp = await mod.getStaticPaths();
  const targets: Target[] = [];
  for (const p of gsp.paths) {
    if (typeof p === "string") {
      targets.push({ params: matchSegments(entry.pattern, p) ?? {}, pathname: p });
    } else {
      targets.push({ params: p.params, pathname: fillPath(entry.pattern, p.params) });
    }
  }
  return targets;
}

/**
 * Prerender every static page (one exporting `getStaticProps`) to disk. Returns
 * the pathnames written. Pages with `getServerSideProps`, or dynamic pages without
 * `getStaticPaths`, are skipped (rendered on demand at runtime).
 */
export async function prerenderStaticPages(
  opts: PrerenderOptions,
): Promise<{ prerendered: string[] }> {
  const base = opts.basePath?.replace(/\/$/, "") || "";
  const withBase = (p: string | null): string | null => (p && base ? base + p : p);
  const staticDir = join(opts.outDir, "pages-static");
  const App = await loadDefault(opts.scan.app, opts.load);
  const Document = await loadDefault(opts.scan.document, opts.load);
  const prerendered: string[] = [];

  for (const entry of opts.scan.pages) {
    const mod = (await opts.load(entry.filePath)) as PageModule;
    if (typeof mod.getStaticProps !== "function" || typeof mod.default !== "function") continue;
    const targets = await resolveTargets(entry, mod);
    if (!targets) continue;

    for (const { params, pathname } of targets) {
      const result = await mod.getStaticProps({ params, query: { ...params }, locale: undefined });
      if (result.notFound || result.redirect) continue; // resolved at runtime instead
      const pageProps = result.props ?? {};
      const rawBundle = opts.bundleUrlFor(entry.routePath);
      const rawCss = opts.cssUrlFor(entry.routePath);
      const css = withBase(rawCss);
      const nextData: NextData = {
        props: { pageProps },
        page: entry.routePath,
        query: { ...params },
        asPath: pathname,
        isServer: false,
        basePath: base || undefined,
      };
      const bodyHtml = await renderPage({
        Page: mod.default,
        pageProps,
        App,
        nextData,
        clientBundle: withBase(rawBundle),
        styles: css ? [css] : undefined,
        lang: opts.lang,
        Document,
      });

      const dir = join(staticDir, pathname === "/" ? "" : pathname);
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(join(dir, "index.html"), bodyHtml);
      // props.json doubles as the soft-nav data response (+ `revalidate` for ISR).
      await Deno.writeTextFile(
        join(dir, "props.json"),
        JSON.stringify({
          page: entry.routePath,
          entryUrl: rawBundle,
          pageProps,
          query: { ...params },
          asPath: pathname,
          isServer: false,
          revalidate: result.revalidate,
        }),
      );
      prerendered.push(pathname);
    }
  }
  return { prerendered };
}
