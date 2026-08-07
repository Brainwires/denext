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
import {
  type Segment,
  parseSegment,
  specificity,
} from "./segments.ts";

export interface PageRoute {
  kind: "page";
  /** Parsed URL pattern segments. */
  pattern: Segment[];
  /** Human-readable route path, e.g. "/blog/[slug]". */
  routePath: string;
  /** Absolute path to the page module. */
  filePath: string;
  /** Layout module paths from outermost (root) to innermost. */
  layoutChain: string[];
}

export interface ApiRoute {
  kind: "api";
  pattern: Segment[];
  routePath: string;
  filePath: string;
}

export interface RouteManifest {
  pages: PageRoute[];
  api: ApiRoute[];
  /** Root layout path if present, else null. */
  rootLayout: string | null;
}

const PAGE_RE = /^page\.(tsx|ts|jsx|js)$/;
const LAYOUT_RE = /^layout\.(tsx|ts|jsx|js)$/;
const ROUTE_RE = /^route\.(ts|js)$/;

/** Is a directory name a route group like "(marketing)"? */
function isRouteGroup(name: string): boolean {
  return name.startsWith("(") && name.endsWith(")");
}

/** Scan `appDir` recursively and produce a sorted route manifest. */
export async function scanRoutes(appDir: string): Promise<RouteManifest> {
  const pages: PageRoute[] = [];
  const api: ApiRoute[] = [];

  async function walk(
    dir: string,
    segments: Segment[],
    layoutChain: string[],
  ): Promise<void> {
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry);

    // Detect a layout at this level before descending.
    const layoutFile = entries.find((e) => e.isFile && LAYOUT_RE.test(e.name));
    const nextLayoutChain = layoutFile
      ? [...layoutChain, join(dir, layoutFile.name)]
      : layoutChain;

    for (const entry of entries) {
      if (entry.isFile) {
        if (PAGE_RE.test(entry.name)) {
          pages.push({
            kind: "page",
            pattern: segments,
            routePath: patternToPath(segments),
            filePath: join(dir, entry.name),
            layoutChain: nextLayoutChain,
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
        await walk(childDir, segments, nextLayoutChain);
      } else {
        await walk(childDir, [...segments, parseSegment(entry.name)], nextLayoutChain);
      }
    }
  }

  await walk(appDir, [], []);

  // Most-specific routes first so the matcher can return on first hit.
  pages.sort((a, b) => specificity(b.pattern) - specificity(a.pattern));
  api.sort((a, b) => specificity(b.pattern) - specificity(a.pattern));

  const rootLayout = pages.find((p) => p.layoutChain.length > 0)?.layoutChain[0] ??
    null;

  return { pages, api, rootLayout };
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
