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
import { join } from "@std/path";
import { createPagesHandler } from "./src/handler.ts";
import { type PagesScan, scanPagesDir } from "./src/scan.ts";

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

      const handle = createPagesHandler({
        getScan,
        load: ctx.load,
        lang: ctx.config.i18n?.defaultLocale,
        basePath: ctx.config.basePath,
      });

      ctx.addRequestHandler(handle);
    },
  };
}
