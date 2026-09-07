// From the RR route tree + the generated modules to denext's route manifest: every leaf (and
// every resource route) becomes a `PageRoute` / `ApiRoute` whose `filePath` is the generated
// wrapper, with the generated layouts as its `layoutChain` (the root layout first) and the
// generated `error.tsx` files as per-segment boundaries. RR's `:param` / `*` / `seg?` syntax
// maps onto denext's `[param]` / `[...splat]` / expanded variants.

import { parsePattern } from "@denext/denext/plugin-kit";
import type { PageRoute, RouteManifest, SegmentLevel } from "@denext/denext/server";
import { type GeneratedRoute, ROOT_ID } from "./generate.ts";
import { expandOptionalSegments, type RouteNode } from "./route-tree.ts";

/** An RR pattern (`teams/:id/*`) as a denext one (`teams/[id]/[...splat]`). */
function toDenextPattern(rr: string): string {
  return rr.split("/").filter((s) => s !== "").map((seg) => {
    if (seg === "*") return "[...splat]";
    if (seg.startsWith(":")) return `[${seg.slice(1)}]`;
    return seg;
  }).join("/");
}

/**
 * Push the app's routes into `manifest` (mutated in place, the synthesizer contract).
 *
 * @param manifest The core manifest being scanned.
 * @param nodes The RR route tree (flat, with layout chains).
 * @param generated What {@link generateRoutes} wrote, by route id.
 */
export function synthesizeRoutes(
  manifest: RouteManifest,
  nodes: RouteNode[],
  generated: Map<string, GeneratedRoute>,
): void {
  const root = generated.get(ROOT_ID);
  if (root?.wrapper && !manifest.rootLayout) manifest.rootLayout = root.wrapper;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const node of nodes) {
    const gen = generated.get(node.id);
    // A pure layout (children, no route of its own) rides along in the leaves' chains.
    if (!gen || (node.layout && gen.component)) continue;
    for (const rr of expandOptionalSegments(node.pattern)) {
      addRoute(manifest, node, gen, rr, byId, generated, root);
    }
  }
}

/** Add one route variant (a concrete pattern) to the manifest as a page and/or API route. */
function addRoute(
  manifest: RouteManifest,
  node: RouteNode,
  gen: GeneratedRoute,
  rr: string,
  byId: Map<string, RouteNode>,
  generated: Map<string, GeneratedRoute>,
  root: GeneratedRoute | undefined,
): void {
  const denextPattern = toDenextPattern(rr);
  const pattern = parsePattern(denextPattern);
  const routePath = "/" + denextPattern;
  if (gen.api && !gen.component) {
    manifest.api.push({ kind: "api", pattern, routePath, filePath: gen.api });
    return;
  }
  if (!gen.wrapper) return;
  manifest.pages.push(pageRoute(node, gen, pattern, routePath, byId, generated, root));
  if (gen.api) manifest.api.push({ kind: "api", pattern, routePath, filePath: gen.api });
}

function pageRoute(
  node: RouteNode,
  gen: GeneratedRoute,
  pattern: PageRoute["pattern"],
  routePath: string,
  byId: Map<string, RouteNode>,
  generated: Map<string, GeneratedRoute>,
  root: GeneratedRoute | undefined,
): PageRoute {
  const layoutChain: string[] = [];
  const layoutDepths: number[] = [];
  const levels: SegmentLevel[] = [];
  let error: string | null = null;
  if (root?.wrapper) {
    layoutChain.push(root.wrapper);
    layoutDepths.push(0);
    if (root.error) error = root.error;
    levels.push(level(0, root.wrapper, root.error ?? null));
  }
  for (const id of node.layoutIds) {
    const layout = byId.get(id);
    const g = generated.get(id);
    if (!layout || !g?.wrapper) continue;
    const depth = segmentCount(layout.pattern);
    layoutChain.push(g.wrapper);
    layoutDepths.push(depth);
    if (g.error) error = g.error;
    levels.push(level(depth, g.wrapper, g.error ?? null));
  }
  if (gen.error) {
    error = gen.error;
    levels.push(level(pattern.length, null, gen.error));
  }
  return {
    kind: "page",
    pattern,
    routePath,
    filePath: gen.wrapper!,
    layoutChain,
    layoutDepths,
    loading: null,
    error,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
    levels,
  };
}

function level(depth: number, layout: string | null, error: string | null): SegmentLevel {
  return {
    depth,
    layout,
    template: null,
    loading: null,
    error,
    notFound: null,
    forbidden: null,
    unauthorized: null,
  };
}

function segmentCount(rrPattern: string): number {
  return rrPattern.split("/").filter((s) => s !== "").length;
}
