// Build-time static generation (SSG) for the Pages Router: run
// `getStaticPaths`/`getStaticProps` for each static page and write pre-rendered
// `index.html` + `props.json` to `<outDir>/pages-static/<path>/`. At runtime the
// handler serves those files directly (and, for `revalidate` pages, through the
// PageCache for stale-while-revalidate ISR). Mirrors the App Router's
// `src/build/export.ts` param-expansion pattern.

import { join, resolve, SEPARATOR } from "@std/path";
import { matchSegments, type Segment } from "@denext/denext/plugin-kit";
import type { I18nConfig } from "@denext/denext/server";
import { type NextData, type PageComponent, renderPage } from "./render.ts";
import type { PageEntry, PagesScan } from "./scan.ts";

/**
 * Params from `getStaticPaths` — a catch-all segment's value is an **array** in the
 * Next.js convention (`{ params: { slug: ["a", "b"] } }`), so values may be
 * `string` or `string[]`.
 */
type SsgParams = Record<string, string | string[]>;

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
  paths: Array<string | { params: SsgParams }>;
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
  /**
   * i18n config. Prerendered pages are written for the **default locale** (its real
   * value is threaded into `getStaticProps`' `context.locale` and the `__NEXT_DATA__`
   * payload); non-default locales render live at runtime (see the handler), so they
   * aren't prewritten.
   */
  i18n?: I18nConfig;
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
function fillPath(pattern: Segment[], params: SsgParams): string {
  const parts: string[] = [];
  for (const seg of pattern) {
    if (seg.kind === "static") {
      parts.push(seg.value);
      continue;
    }
    const v = params[seg.value];
    if (v == null) continue;
    // Catch-all → one segment per array element. Values are kept **raw** (not
    // percent-encoded) so the written directory matches the runtime `url.pathname`
    // for ordinary slugs; a value with URL-special chars simply isn't prerendered
    // (it renders on demand) rather than being written to a non-matching dir.
    if (Array.isArray(v)) { for (const s of v) parts.push(String(s)); }
    else if (v !== "") parts.push(String(v));
  }
  return "/" + parts.join("/");
}

/** Reject pathnames that could write outside `pages-static/` (developer footgun). */
function isSafePathname(pathname: string): boolean {
  if (!pathname.startsWith("/")) return false;
  if (pathname.includes("\0") || pathname.includes("\\")) return false;
  return !pathname.split("/").includes("..");
}

/** A concrete instance of a route to prerender. */
interface Target {
  params: SsgParams;
  pathname: string;
}

/** Resolve which concrete paths to prerender for a page (null ⇒ cannot prerender). */
async function resolveTargets(entry: PageEntry, mod: PageModule): Promise<Target[] | null> {
  const isDynamic = entry.pattern.some((s) => s.kind !== "static");
  if (!isDynamic) return [{ params: {}, pathname: entry.routePath }];
  if (typeof mod.getStaticPaths !== "function") return null; // dynamic, not enumerable
  let gsp: GspPaths;
  try {
    gsp = await mod.getStaticPaths();
  } catch (err) {
    throw new Error(`getStaticPaths failed for "${entry.routePath}": ${errMsg(err)}`, {
      cause: err,
    });
  }
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

/** Extract an error message for build-time diagnostics. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
      if (!isSafePathname(pathname)) {
        throw new Error(
          `getStaticPaths for "${entry.routePath}" produced an unsafe path "${pathname}"`,
        );
      }
      const locale = opts.i18n?.defaultLocale;
      let result: GspResult;
      try {
        result = await mod.getStaticProps!({
          params,
          query: { ...params },
          locale,
          locales: opts.i18n?.locales,
          defaultLocale: opts.i18n?.defaultLocale,
        });
      } catch (err) {
        throw new Error(
          `getStaticProps failed for "${entry.routePath}" (${pathname}): ${errMsg(err)}`,
          { cause: err },
        );
      }
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
        locale,
        locales: opts.i18n?.locales,
        defaultLocale: opts.i18n?.defaultLocale,
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
      // Defense-in-depth: never write outside pages-static/, even if the checks above
      // are bypassed by an unusual segment.
      const rootDir = resolve(staticDir);
      const resolvedDir = resolve(dir);
      if (resolvedDir !== rootDir && !resolvedDir.startsWith(rootDir + SEPARATOR)) {
        throw new Error(`SSG target "${pathname}" escapes the output dir`);
      }
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(join(dir, "index.html"), bodyHtml);
      // props.json doubles as the soft-nav data response (+ `revalidate` for ISR).
      await Deno.writeTextFile(
        join(dir, "props.json"),
        JSON.stringify({
          page: entry.routePath,
          entryUrl: rawBundle,
          cssUrl: rawCss,
          pageProps,
          query: { ...params },
          asPath: pathname,
          isServer: false,
          revalidate: result.revalidate,
          locale,
          locales: opts.i18n?.locales,
          defaultLocale: opts.i18n?.defaultLocale,
        }),
      );
      prerendered.push(pathname);
    }
  }
  return { prerendered };
}
