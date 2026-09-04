// Unbundled dev: the generated client entries — per-route, app-wide Flight, and SPA.

import { toFileUrl } from "@std/path";
import type { PageRoute } from "../../router/manifest.ts";
import { generateFlightEntry, generateRouteEntry, routeSourceFiles } from "../bundle.ts";
import type { BoundaryManifest } from "../module-graph.ts";
import { ensureClientDeps } from "./deps.ts";
import { ENTRY_PATH, norm, type UnbundledState } from "./state.ts";
import { transformGeneratedEntry } from "./transform.ts";

/** The client entry URL for a route (points the shell's module <script> here). */
export function entryUrlFor(route: PageRoute): string {
  return `${ENTRY_PATH}?p=${encodeURIComponent(route.routePath)}`;
}

/** The SPA client entry URL (no `?p=` — SPA has a single entry, not routes). */
export function spaEntryUrl(): string {
  return ENTRY_PATH;
}

/**
 * Whether a route's client entry can be served unbundled. Every module the entry
 * imports (page, layouts, templates, loading/error boundaries, slots) must be
 * transformable by esbuild's built-in loaders — JS/TS/JSX/TSX. A route with an
 * `.mdx`/`.md` entry module (which needs the full MDX pipeline) keeps the bundled
 * path; the caller falls back for it and the whole surface stays correct.
 */
export function supportsRoute(route: PageRoute): boolean {
  return routeSourceFiles(route).every((f) => /\.(tsx|ts|jsx|js|mjs|cjs)$/.test(f));
}

/**
 * Serve a route's generated client entry (page/layouts/templates/boundaries),
 * transformed through {@linkcode transformGeneratedEntry}. Its imported modules become
 * `@fs` dev URLs served unbundled with per-module footers.
 */
export function serveEntry(st: UnbundledState, route: PageRoute): Promise<string> {
  return transformGeneratedEntry(
    st,
    generateRouteEntry(route, true, true),
    `entry:${route.routePath}`,
  );
}

/**
 * Serve the app-wide FLIGHT client entry unbundled: each `"use client"` island is
 * imported by its `@fs` dev URL (served on its own with a per-module footer), so an
 * island edit hot-swaps that single module in place. The flight `registry` (clientId
 * -> fn, for Flight parsing) and Live/resumability wiring are unchanged; only the
 * island modules move off the bundled entry. `ensureClientDeps` first — the entry
 * imports `denext/client` and `denext/live`. All islands share the `entry:flight`
 * importer key; since each island self-accepts, an edit propagates to itself (an
 * in-place update), never to the entry (a reload).
 */
export async function serveFlightEntry(
  st: UnbundledState,
  boundary: BoundaryManifest,
): Promise<string> {
  await ensureClientDeps(st);
  return transformGeneratedEntry(st, generateFlightEntry(boundary, true, true), "entry:flight");
}

/**
 * Serve the SPA's generated client entry: enable per-module Fast Refresh, then import
 * the app's single entry (`main.tsx`) by its `@fs` URL. The app's whole module graph is
 * then served unbundled, so any component edit hot-swaps that one module in place. Its
 * `denext`/`react`/npm imports resolve through the specifier rewrite like any route.
 */
export async function serveSpaEntry(st: UnbundledState): Promise<string> {
  await ensureClientDeps(st);
  const abs = norm(st.opts.spaEntry!);
  const src = `// denext generated SPA entry (dev, unbundled) — do not edit.\n` +
    `import { enablePerModuleRefresh } from "denext/client-runtime";\nimport { installDevtools } from "denext/devtools";\n` +
    `enablePerModuleRefresh();\ninstallDevtools();\n` +
    `await import(${JSON.stringify(toFileUrl(abs).href)});\n`;
  return transformGeneratedEntry(st, src, "entry:spa");
}
