// Route manifest: scan an app directory into an ordered list of page and API
// routes, each with its parsed pattern and (for pages) the chain of layouts
// that wrap it.
//
// File conventions inside the app dir:
//   page.{tsx,ts,jsx,js}     -> a rendered page at that path
//   layout.{tsx,ts,jsx,js}   -> wraps this segment and everything beneath it
//   route.{ts,js}            -> an API endpoint (exports GET/POST/... handlers)
//   (group)/                 -> a route group: folder name omitted from the URL

import { join } from "@std/path";
import { parseSegment, type Segment, specificity } from "./segments.ts";

/** A rendered page route discovered by scanning the app directory. */
export interface PageRoute {
  /** Discriminant marking this as a page route. */
  kind: "page";
  /** Parsed URL pattern segments. */
  pattern: Segment[];
  /** Human-readable route path, e.g. "/blog/[slug]". */
  routePath: string;
  /** Absolute path to the page module. */
  filePath: string;
  /** Layout module paths from outermost (root) to innermost. */
  layoutChain: string[];
  /** Nearest loading.tsx (Suspense fallback) up the tree, or null. */
  loading: string | null;
  /** Nearest error.tsx (error boundary) up the tree, or null. */
  error: string | null;
  /** Nearest not-found.tsx up the tree, or null. */
  notFound: string | null;
  /** Nearest forbidden.tsx (403 UI) up the tree, or null. */
  forbidden: string | null;
  /** Nearest unauthorized.tsx (401 UI) up the tree, or null. */
  unauthorized: string | null;
  /** Template module paths (like layouts, but conceptually re-mounted), outer→inner. */
  templateChain: string[];
}

/** An API endpoint route discovered by scanning the app directory. */
export interface ApiRoute {
  /** Discriminant marking this as an API route. */
  kind: "api";
  /** Parsed URL pattern segments. */
  pattern: Segment[];
  /** Human-readable route path, e.g. "/api/users/[id]". */
  routePath: string;
  /** Absolute path to the route module. */
  filePath: string;
}

/** The complete set of routes and root-level boundaries for an app. */
export interface RouteManifest {
  /** All page routes, sorted most-specific first. */
  pages: PageRoute[];
  /** All API routes, sorted most-specific first. */
  api: ApiRoute[];
  /** Root layout path if present, else null. */
  rootLayout: string | null;
  /** Root not-found.tsx path if present, else null. */
  rootNotFound: string | null;
  /** Root global-error.tsx path (wraps the entire tree incl. root layout), or null. */
  rootGlobalError: string | null;
}

const PAGE_RE = /^page\.(tsx|ts|jsx|js)$/;
const LAYOUT_RE = /^layout\.(tsx|ts|jsx|js)$/;
const TEMPLATE_RE = /^template\.(tsx|ts|jsx|js)$/;
const ROUTE_RE = /^route\.(ts|js)$/;
const LOADING_RE = /^loading\.(tsx|ts|jsx|js)$/;
const ERROR_RE = /^error\.(tsx|ts|jsx|js)$/;
const NOT_FOUND_RE = /^not-found\.(tsx|ts|jsx|js)$/;
const FORBIDDEN_RE = /^forbidden\.(tsx|ts|jsx|js)$/;
const UNAUTHORIZED_RE = /^unauthorized\.(tsx|ts|jsx|js)$/;
const GLOBAL_ERROR_RE = /^global-error\.(tsx|ts|jsx|js)$/;

/** Is a directory name a route group like "(marketing)"? */
function isRouteGroup(name: string): boolean {
  return name.startsWith("(") && name.endsWith(")");
}

/** Scan `appDir` recursively and produce a sorted route manifest. */
export async function scanRoutes(appDir: string): Promise<RouteManifest> {
  const pages: PageRoute[] = [];
  const api: ApiRoute[] = [];

  /** Inheritable special files (nearest ancestor wins). */
  interface Boundaries {
    loading: string | null;
    error: string | null;
    notFound: string | null;
    forbidden: string | null;
    unauthorized: string | null;
  }

  async function walk(
    dir: string,
    segments: Segment[],
    layoutChain: string[],
    templateChain: string[],
    boundaries: Boundaries,
  ): Promise<void> {
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry);

    const fileHere = (re: RegExp) => {
      const found = entries.find((e) => e.isFile && re.test(e.name));
      return found ? join(dir, found.name) : null;
    };

    // Detect special files at this level before descending (override inherited).
    const layoutFile = entries.find((e) => e.isFile && LAYOUT_RE.test(e.name));
    const nextLayoutChain = layoutFile ? [...layoutChain, join(dir, layoutFile.name)] : layoutChain;
    const templateFile = entries.find((e) => e.isFile && TEMPLATE_RE.test(e.name));
    const nextTemplateChain = templateFile
      ? [...templateChain, join(dir, templateFile.name)]
      : templateChain;
    const nextBoundaries: Boundaries = {
      loading: fileHere(LOADING_RE) ?? boundaries.loading,
      error: fileHere(ERROR_RE) ?? boundaries.error,
      notFound: fileHere(NOT_FOUND_RE) ?? boundaries.notFound,
      forbidden: fileHere(FORBIDDEN_RE) ?? boundaries.forbidden,
      unauthorized: fileHere(UNAUTHORIZED_RE) ?? boundaries.unauthorized,
    };

    for (const entry of entries) {
      if (entry.isFile) {
        if (PAGE_RE.test(entry.name)) {
          pages.push({
            kind: "page",
            pattern: segments,
            routePath: patternToPath(segments),
            filePath: join(dir, entry.name),
            layoutChain: nextLayoutChain,
            templateChain: nextTemplateChain,
            loading: nextBoundaries.loading,
            error: nextBoundaries.error,
            notFound: nextBoundaries.notFound,
            forbidden: nextBoundaries.forbidden,
            unauthorized: nextBoundaries.unauthorized,
          });
        } else if (ROUTE_RE.test(entry.name)) {
          api.push({
            kind: "api",
            pattern: segments,
            routePath: patternToPath(segments),
            filePath: join(dir, entry.name),
          });
        }
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const childDir = join(dir, entry.name);
      if (isRouteGroup(entry.name)) {
        // Route group: keep the same URL segments.
        await walk(childDir, segments, nextLayoutChain, nextTemplateChain, nextBoundaries);
      } else {
        await walk(
          childDir,
          [...segments, parseSegment(entry.name)],
          nextLayoutChain,
          nextTemplateChain,
          nextBoundaries,
        );
      }
    }
  }

  await walk(appDir, [], [], [], {
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
  });

  // Most-specific routes first so the matcher can return on first hit.
  pages.sort((a, b) => specificity(b.pattern) - specificity(a.pattern));
  api.sort((a, b) => specificity(b.pattern) - specificity(a.pattern));

  const rootLayout = pages.find((p) => p.layoutChain.length > 0)?.layoutChain[0] ??
    null;

  // Root-level files applying to otherwise-unmatched routes / the whole tree.
  let rootNotFound: string | null = null;
  let rootGlobalError: string | null = null;
  try {
    for await (const entry of Deno.readDir(appDir)) {
      if (!entry.isFile) continue;
      if (!rootNotFound && NOT_FOUND_RE.test(entry.name)) {
        rootNotFound = join(appDir, entry.name);
      }
      if (!rootGlobalError && GLOBAL_ERROR_RE.test(entry.name)) {
        rootGlobalError = join(appDir, entry.name);
      }
    }
  } catch {
    // appDir unreadable — leave null.
  }

  return { pages, api, rootLayout, rootNotFound, rootGlobalError };
}

/** Render a segment list as a display path like "/blog/[slug]". */
export function patternToPath(segments: Segment[]): string {
  if (segments.length === 0) return "/";
  return "/" + segments.map(segmentToString).join("/");
}

function segmentToString(seg: Segment): string {
  switch (seg.kind) {
    case "static":
      return seg.value;
    case "dynamic":
      return `[${seg.value}]`;
    case "catchAll":
      return `[...${seg.value}]`;
    case "optionalCatchAll":
      return `[[...${seg.value}]]`;
  }
}
