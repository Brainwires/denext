// A React Router v7 route config → the flat route table denext needs: each node gets its RR
// id (the app-relative, extension-less file path unless the entry set `id`), its full URL
// pattern (parent paths joined), and the chain of layout nodes above it. Optional segments
// (`foo?`) expand into their concrete variants, since denext routes are concrete patterns.
//
// Kept free of denext imports so it can be unit-tested (and reasoned about) on its own; the
// plugin maps `RouteNode`s onto denext `PageRoute`s.

import type { RouteConfigEntry } from "../routes.ts";

/** One resolved route of the config tree. */
export interface RouteNode {
  /** The RR route id (`routes/home`, or the entry's own `id`). */
  id: string;
  /** The parent node's id, or `root`. */
  parentId: string;
  /** The route module, app-relative (`routes/home.tsx`). */
  file: string;
  /** The full URL pattern from the root, RR syntax (`teams/:id/edit`, `docs/*`); `""` for the root index. */
  pattern: string;
  /** An index route (renders at its parent's URL). */
  index: boolean;
  /** This node wraps children (a layout, pathless or not). */
  layout: boolean;
  /** The ids of the layout nodes above this one, outermost first (`root` excluded). */
  layoutIds: string[];
  /** Nested entries (present on a layout). */
  children: RouteNode[];
}

/** The RR id of a route file: app-relative, extension-less (`routes/home.tsx` → `routes/home`). */
export function routeIdOf(file: string): string {
  return file.replace(/^\.?\/+/, "").replace(/\.[jt]sx?$/, "");
}

/**
 * Flatten a route config into nodes with full patterns and layout chains. Throws on a
 * duplicate id (two entries for the same file need an explicit `id`).
 */
export function buildRouteTree(entries: RouteConfigEntry[]): RouteNode[] {
  const nodes: RouteNode[] = [];
  const seen = new Set<string>();
  const visit = (
    entry: RouteConfigEntry,
    parentId: string,
    parentPattern: string,
    layoutIds: string[],
  ): RouteNode => {
    const id = entry.id ?? routeIdOf(entry.file);
    if (seen.has(id)) {
      throw new Error(
        `react-router: duplicate route id "${id}" — give one of the entries for ${entry.file} an explicit \`id\``,
      );
    }
    seen.add(id);
    const pattern = entry.path ? joinPattern(parentPattern, entry.path) : parentPattern;
    const node: RouteNode = {
      id,
      parentId,
      file: entry.file,
      pattern,
      index: entry.index === true,
      layout: (entry.children?.length ?? 0) > 0,
      layoutIds,
      children: [],
    };
    nodes.push(node);
    for (const child of entry.children ?? []) {
      node.children.push(visit(child, id, pattern, [...layoutIds, id]));
    }
    return node;
  };
  for (const entry of entries) visit(entry, "root", "", []);
  return nodes;
}

function joinPattern(parent: string, path: string): string {
  const p = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!parent) return p;
  return p ? `${parent}/${p}` : parent;
}

/**
 * The concrete patterns an RR pattern with optional segments (`docs/:lang?/intro`) stands
 * for — every combination of each optional segment present or absent, most-specific first.
 * A pattern without `?` segments is returned as-is.
 */
export function expandOptionalSegments(pattern: string): string[] {
  const segments = pattern.split("/").filter((s) => s !== "");
  const optional = segments.map((s) => s.endsWith("?") && s !== "?");
  if (!optional.some(Boolean)) return [pattern];
  const out: string[] = [];
  const total = optional.filter(Boolean).length;
  // Bitmask over the optional segments: 1 = present. Iterate from all-present downward so
  // the most specific variant comes first.
  for (let mask = (1 << total) - 1; mask >= 0; mask--) {
    let bit = 0;
    const parts: string[] = [];
    segments.forEach((s, i) => {
      if (!optional[i]) return parts.push(s);
      const present = (mask >> (total - 1 - bit)) & 1;
      bit++;
      if (present) parts.push(s.slice(0, -1));
    });
    out.push(parts.join("/"));
  }
  return out;
}
