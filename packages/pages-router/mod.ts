/**
 * `@denext/pages-router` — a Next.js **Pages Router** for denext, shipped as a
 * {@linkcode https://jsr.io/@denext/denext | denext} plugin. Add it to your
 * `denext.config.ts` and a `pages/` tree renders alongside your `app/` routes:
 *
 * ```ts
 * // denext.config.ts
 * import { pagesRouter } from "@denext/pages-router";
 * export default { plugins: [pagesRouter()] };
 * ```
 *
 * ```tsx
 * // pages/blog/[slug].tsx
 * export async function getServerSideProps({ params }) {
 *   return { props: { slug: params.slug } };
 * }
 * export default function Post({ slug }) {
 *   return <article>Post: {slug}</article>;
 * }
 * ```
 *
 * The plugin claims requests the App Router didn't match, so App Router routes
 * always win. It supports `pages/`-file routing (incl. `[slug]`, `[...all]`,
 * `[[...opt]]`), `_app`/`_document`, `getServerSideProps`/`getStaticProps`/
 * `getStaticPaths`, `pages/api/*` handlers, and client hydration with `next/router`.
 *
 * @module
 */

import type { DenextPlugin, PluginContext } from "@denext/denext/server";

// Re-export the denext types referenced by this package's public API so the
// generated docs are self-contained: deno doc --lint requires every type used in a
// public signature (and their transitively-referenced members) to be exported from
// an entrypoint. Mirrors the same doc-completeness re-exports denext itself ships.
// Type-only; no runtime effect.
export type {
  ApiRoute,
  Component,
  CspSetting,
  DenextConfig,
  DenextPlugin,
  Directive,
  ExperimentalConfig,
  HeaderRule,
  HstsConfig,
  I18nConfig,
  ImagesConfig,
  Intercept,
  Key,
  LocalPattern,
  Messages,
  ModuleLoader,
  PageRoute,
  PluginBuildContext,
  PluginBuildStep,
  PluginContext,
  PluginMode,
  PluginRequestHandler,
  PluginTeardown,
  RedirectRule,
  RemotePattern,
  RewriteRule,
  RouteCsp,
  RouteManifest,
  RouteSynthesizer,
  Segment,
  SegmentKind,
  SlotRoutes,
  TailwindConfig,
  VNode,
  VNodeChild,
  VNodeChildren,
  VNodeType,
  VProps,
} from "@denext/denext/server";
export { FRAGMENT } from "@denext/denext/server";
import { PageCache } from "@denext/denext/server";
import { join, resolve } from "@std/path";
import { createPagesHandler } from "./src/handler.ts";
import { type PagesScan, scanPagesDir } from "./src/scan.ts";
import { type ClientBundler, createClientBundler, PAGES_PREFIX } from "./src/client-bundle.ts";
import { prerenderStaticPages } from "./src/ssg.ts";

/** Options for {@linkcode pagesRouter}. */
export interface PagesRouterOptions {
  /**
   * Absolute or project-relative path to the pages directory. Defaults to
   * auto-detecting `pages/` then `src/pages/` under the project root.
   */
  dir?: string;
}

/** Find the pages directory: an explicit `dir`, else `pages/` or `src/pages/`. */
async function resolvePagesDir(root: string, dir?: string): Promise<string | null> {
  const candidates = dir
    ? [dir.startsWith("/") ? dir : join(root, dir)]
    : [join(root, "pages"), join(root, "src", "pages")];
  for (const candidate of candidates) {
    try {
      const stat = await Deno.stat(candidate);
      if (stat.isDirectory) return candidate;
    } catch {
      // not here — try the next candidate
    }
  }
  return null;
}

/** Locate the project's deno config (needed to bundle client entries). */
async function resolveConfigPath(root: string): Promise<string | null> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const candidate = join(root, name);
    try {
      if ((await Deno.stat(candidate)).isFile) return candidate;
    } catch {
      // try the next name
    }
  }
  return null;
}

/**
 * Create the Pages Router plugin. Place it in your `denext.config.ts` `plugins`.
 *
 * @param options Optional overrides (e.g. a custom pages directory).
 */
export function pagesRouter(options: PagesRouterOptions = {}): DenextPlugin {
  return {
    name: "@denext/pages-router",
    async setup(ctx: PluginContext) {
      const pagesDir = await resolvePagesDir(ctx.projectRoot, options.dir);
      if (!pagesDir) return; // no pages/ tree — nothing to do

      // Scan once in prod/build/export; re-scan per request in dev so new/edited
      // page files are picked up without a restart.
      let cached: PagesScan | null = null;
      const getScan = async (): Promise<PagesScan> => {
        if (ctx.mode === "dev") return await scanPagesDir(pagesDir);
        return (cached ??= await scanPagesDir(pagesDir));
      };

      // Client hydration: bundle each route's browser entry via `deno bundle`.
      // dev bundles lazily in-process; prod reads what the build step pre-wrote
      // to `.denext/pages-client/` (falling back to an in-process bundle).
      const configPath = await resolveConfigPath(ctx.projectRoot);
      // Tailwind: mirror the CLI's `tailwindPaths` — resolve input/output against
      // the project root so `buildAppCss` can compile it before the CSS walk.
      const tw = ctx.config.tailwind;
      const tailwind = tw
        ? { input: resolve(ctx.projectRoot, tw.input), output: resolve(ctx.projectRoot, tw.output) }
        : undefined;
      let bundler: ClientBundler | undefined;
      if (configPath) {
        bundler = createClientBundler({
          getScan,
          configPath,
          projectRoot: ctx.projectRoot,
          dev: ctx.mode === "dev",
          tailwind,
          readDir: ctx.mode === "prod"
            ? join(ctx.projectRoot, ".denext", "pages-client")
            : undefined,
        });
      }

      const lang = ctx.config.i18n?.defaultLocale;
      const basePath = ctx.config.basePath;
      const handle = createPagesHandler({
        getScan,
        load: ctx.load,
        bundler,
        lang,
        basePath,
        // Prod: serve build-time prerendered SSG pages from disk, with ISR.
        staticDir: ctx.mode === "prod"
          ? join(ctx.projectRoot, ".denext", "pages-static")
          : undefined,
        pageCache: ctx.mode === "prod" ? new PageCache() : undefined,
      });

      ctx.addRequestHandler(handle);

      // Build step (seam 3): pre-bundle every route's client entry, then prerender
      // static (`getStaticProps`) pages to disk for `denext start` to serve.
      if (bundler) {
        ctx.addBuildStep(async ({ outDir }) => {
          const { entryByRoute, cssByRoute } = await bundler!.prebuild(outDir);
          const url = (map: Map<string, string>, rp: string): string | null => {
            const b = map.get(rp);
            return b ? PAGES_PREFIX + b : null;
          };
          await prerenderStaticPages({
            scan: await getScan(),
            load: ctx.load,
            outDir,
            bundleUrlFor: (rp) => url(entryByRoute, rp),
            cssUrlFor: (rp) => url(cssByRoute, rp),
            lang,
            basePath,
          });
        });
      }
    },
  };
}
