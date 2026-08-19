/**
 * Bare `next` specifier barrel — the top-level `import … from "next"` surface.
 *
 * App Router code imports a small set of things from bare `next` (as opposed to
 * `next/navigation`, `next/headers`, …): almost always the metadata/config
 * *types* used to annotate `export const metadata`/`generateMetadata` and
 * `next.config`. These are type-only, so a consumer's `import { Metadata } from
 * "next"` is elided at transpile; this module exists so the specifier resolves.
 *
 * The per-area runtime APIs live in their own submodules (`next/navigation`,
 * `next/server`, …); this barrel deliberately does not re-export them.
 */

export type { Metadata, Viewport } from "../../server/types.ts";

/**
 * File-convention route metadata (`app/sitemap.ts`, `robots.ts`, `manifest.ts`).
 * Permissive shapes — enough to type the exported values without pulling in the
 * full Next type graph. Next's public API is the dotted type
 * `MetadataRoute.Sitemap`/`.Robots`/`.Manifest`, so a namespace mirrors it exactly.
 */
// deno-lint-ignore no-namespace
export namespace MetadataRoute {
  /** The value shape returned by an `app/sitemap.ts` default export. */
  export type Sitemap = Array<{
    url: string;
    lastModified?: string | Date;
    changeFrequency?:
      | "always"
      | "hourly"
      | "daily"
      | "weekly"
      | "monthly"
      | "yearly"
      | "never";
    priority?: number;
    alternates?: { languages?: Record<string, string> };
  }>;
  /** The value shape returned by an `app/robots.ts` default export. */
  export type Robots = {
    rules:
      | { userAgent?: string | string[]; allow?: string | string[]; disallow?: string | string[] }
      | Array<
        { userAgent?: string | string[]; allow?: string | string[]; disallow?: string | string[] }
      >;
    sitemap?: string | string[];
    host?: string;
  };
  /** The value shape returned by an `app/manifest.ts` default export. */
  export type Manifest = Record<string, unknown>;
}

/** `next.config` shape — permissive; denext reads its own `denext.config`. */
export type NextConfig = Record<string, unknown>;
