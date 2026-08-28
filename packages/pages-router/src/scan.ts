// Scan a Pages Router `pages/` tree into routes. File conventions differ from the
// App Router: a *file* is a route (not a `page.tsx` inside a folder), dynamic
// segments are bracketed filenames (`[slug].tsx`, `[...all].tsx`, `[[...opt]].tsx`),
// `index` maps to its directory, and `_`-prefixed files are special (not routes).

import { join } from "@std/path";
import { parsePattern, type Segment, specificity } from "@denext/denext/plugin-kit";

/** A discovered Pages Router route (page or API). */
export interface PageEntry {
  /** Display path, e.g. `/blog/[slug]` (`/` for the index). */
  routePath: string;
  /** Parsed URL pattern segments (for matching via `matchSegments`). */
  pattern: Segment[];
  /** Absolute path to the module. */
  filePath: string;
  /** True for `pages/api/**` handler modules. */
  isApi: boolean;
}

/** The special (non-route) files a Pages Router recognizes. */
export interface PagesSpecials {
  /** `pages/_app.*` — wraps every page. */
  app: string | null;
  /** `pages/_document.*` — customizes the HTML shell (SSR only). */
  document: string | null;
  /** `pages/_error.*` — renders runtime errors + fallback 404. */
  error: string | null;
  /** `pages/404.*` — custom 404 page. */
  notFound: string | null;
  /** `pages/500.*` — custom 500 page. */
  serverError: string | null;
}

/** The full result of scanning a `pages/` directory. */
export interface PagesScan extends PagesSpecials {
  /** Page routes, most-specific first. */
  pages: PageEntry[];
  /** API routes, most-specific first. */
  api: PageEntry[];
}

const ROUTE_EXT = /\.(tsx|ts|jsx|js|mjs)$/;
// Non-route special files at the pages root, by base name (sans extension).
const SPECIAL_BASENAMES = new Set(["_app", "_document", "_error"]);

/** Strip a supported route extension from a file name. */
function stripExt(name: string): string {
  return name.replace(ROUTE_EXT, "");
}

/** Most-specific first; ties broken by routePath for deterministic order. */
function bySpecificity(a: PageEntry, b: PageEntry): number {
  const d = specificity(b.pattern) - specificity(a.pattern);
  if (d !== 0) return d;
  return a.routePath < b.routePath ? -1 : a.routePath > b.routePath ? 1 : 0;
}

/**
 * Build a route from a `pages/`-relative module path (POSIX-style, no extension).
 * `index` maps to its directory; brackets become dynamic/catch-all segments.
 */
function toRoute(relNoExt: string, filePath: string, isApi: boolean): PageEntry {
  // Drop a trailing `index` (a directory's own route) and any `index` is only
  // meaningful as the last segment.
  const parts = relNoExt.split("/").filter((p) => p.length > 0);
  if (parts.length > 0 && parts[parts.length - 1] === "index") parts.pop();
  const patternStr = parts.join("/");
  const pattern = parsePattern(patternStr);
  const routePath = "/" + parts.map(segmentDisplay).join("/");
  return {
    routePath: routePath === "/" ? "/" : routePath.replace(/\/$/, ""),
    pattern,
    filePath,
    isApi,
  };
}

/** Display form of a single raw filename segment (mirrors patternToPath). */
function segmentDisplay(raw: string): string {
  return raw;
}

/**
 * Recursively scan `pagesDir` into a {@link PagesScan}. Missing directory → an
 * empty scan (no pages), so an app without a `pages/` tree is a no-op.
 *
 * @param pagesDir Absolute path to the `pages/` (or `src/pages/`) directory.
 */
export async function scanPagesDir(pagesDir: string): Promise<PagesScan> {
  const pages: PageEntry[] = [];
  const api: PageEntry[] = [];
  const specials: PagesSpecials = {
    app: null,
    document: null,
    error: null,
    notFound: null,
    serverError: null,
  };

  async function walk(dir: string, relBase: string): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch {
      return; // unreadable dir → skip
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(abs, relBase ? `${relBase}/${entry.name}` : entry.name);
        continue;
      }
      if (!entry.isFile || !ROUTE_EXT.test(entry.name)) continue;
      const base = stripExt(entry.name);
      const relNoExt = relBase ? `${relBase}/${base}` : base;
      const isApi = relBase === "api" || relBase.startsWith("api/");

      // Root-level special files.
      if (!relBase) {
        if (base === "_app") {
          specials.app = abs;
          continue;
        }
        if (base === "_document") {
          specials.document = abs;
          continue;
        }
        if (base === "_error") {
          specials.error = abs;
          continue;
        }
        if (base === "404") {
          specials.notFound = abs;
          continue;
        }
        if (base === "500") {
          specials.serverError = abs;
          continue;
        }
      }
      // Any other `_`-prefixed file is treated as non-routable (helper/colocated).
      if (base.startsWith("_") && SPECIAL_BASENAMES.has(base)) continue;

      const route = toRoute(relNoExt, abs, isApi);
      (isApi ? api : pages).push(route);
    }
  }

  await walk(pagesDir, "");
  pages.sort(bySpecificity);
  api.sort(bySpecificity);
  return { pages, api, ...specials };
}
