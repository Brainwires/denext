// Unbundled dev: the generated client entries — per-route, app-wide Flight, and SPA.

import { toFileUrl } from "@std/path";
import type { PageRoute } from "../../router/manifest.ts";
import { generateFlightEntry, generateRouteEntry, routeSourceFiles } from "../bundle.ts";
import { scanDirective } from "../directives.ts";
import { routeNeedsHydration } from "../hydration.ts";
import { type BoundaryManifest, crawlLocalModules, isFrameworkSource } from "../module-graph.ts";
import { findServerOnlyLeaks, formatServerOnlyLeaks } from "../server-only-scan.ts";
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
export async function serveEntry(st: UnbundledState, route: PageRoute): Promise<string> {
  await assertNoDevServerOnlyLeaks(st, route);
  return await transformGeneratedEntry(
    st,
    generateRouteEntry(route, {
      dev: true,
      perModule: true,
      instrumentationClient: st.opts.instrumentationClient,
      classRuntime: "eager",
      usesActivity: true,
      usesViewTransition: true,
    }),
    `entry:${route.routePath}`,
  );
}

/**
 * Refuse to serve a route entry whose module graph would ship server-only code.
 *
 * The bundled paths catch this from the bundle's source map (`assertNoServerOnlyLeaks`), but the
 * unbundled loop never bundles: the browser imports the route's modules one by one, so every
 * local module the route reaches is shipped as written. The graph is the truth here — nothing is
 * tree-shaken — except a `"use server"` module, which the transform replaces with an action stub
 * and is therefore never shipped. A hit throws the same message `denext build` prints, which the
 * entry handler turns into a console error the page shows instead of hydrating.
 *
 * Only a route that `denext build` would hydrate is checked: dev links an entry for every
 * non-Flight route, but a page with no interactivity is a static route in the build — it ships
 * no JavaScript there, so a `lib/db.ts` it imports is no leak, and dev must not say otherwise.
 *
 * @param st The unbundled dev state (for the project directory).
 * @param route The route whose entry is about to be served.
 * @throws When the route would ship a server-only module.
 */
export async function assertNoDevServerOnlyLeaks(
  st: UnbundledState,
  route: PageRoute,
): Promise<void> {
  const files = routeSourceFiles(route);
  if (files.length === 0 || !(await routeNeedsHydration(route))) return;
  const modules = await crawlLocalModules(files, { exclude: isFrameworkSource });
  const shipped: string[] = [];
  for (const m of modules) {
    let src: string;
    try {
      src = await Deno.readTextFile(m);
    } catch {
      continue;
    }
    // Realpath'd like the bundle's sources: the leak scan compares against the realpath'd
    // project dir, and a temp dir or a symlinked checkout spells the two differently.
    if (scanDirective(src) !== "server") shipped.push(await Deno.realPath(m).catch(() => m));
  }
  const leaks = await findServerOnlyLeaks(shipped, st.opts.projectDir);
  if (leaks.length === 0) return;
  const byModule = new Map(
    leaks.map((leak) => [leak.module, { leak, entries: [`the route of ${route.routePath}`] }]),
  );
  throw new Error(formatServerOnlyLeaks(byModule, st.opts.projectDir));
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
  return transformGeneratedEntry(
    st,
    generateFlightEntry(
      boundary,
      true,
      true,
      true,
      st.opts.instrumentationClient ?? null,
      "eager",
      true,
      true,
    ),
    "entry:flight",
  );
}

/**
 * Serve the SPA's generated client entry: mark the page as dev, enable per-module Fast
 * Refresh, mount the DevTools panel, then import the app's single entry (`main.tsx`) by
 * its `@fs` URL. The app's whole module graph is then served unbundled, so any component
 * edit hot-swaps that one module in place. Its `denext`/`react`/npm imports resolve
 * through the specifier rewrite like any route.
 */
export async function serveSpaEntry(st: UnbundledState): Promise<string> {
  await ensureClientDeps(st);
  const abs = norm(st.opts.spaEntry!);
  // `__denextDev` FIRST: `installDevtools()` no-ops unless the flag is set, and the SPA
  // shell's dev script (which sets it for the App Router) runs after this module.
  const src = `// denext generated SPA entry (dev, unbundled) — do not edit.\n` +
    `globalThis.__denextDev = true;\n` +
    `import { enablePerModuleRefresh } from "denext/client-runtime";\n` +
    `import { installDevtools } from "denext/devtools";\n` +
    `enablePerModuleRefresh();\ninstallDevtools();\n` +
    `await import(${JSON.stringify(toFileUrl(abs).href)});\n`;
  return transformGeneratedEntry(st, src, "entry:spa");
}
