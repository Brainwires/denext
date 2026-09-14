// The "execute + inspect" half of the denext MCP tools: render a route or component
// server-side (no browser) and map everything that renders at a path.
//
// `renderRoute` is the flagship "try it" — an agent can render a page in-process and see the
// real HTML or the real error, closing the edit→render→fix loop without a browser or a live
// server. It reuses `denext/testing`'s browser-free app client (the JS-disabled surface).
// `renderComponent` renders a single component with props via the testing renderer.
// `routeMap` reports the full render tree at a path (layouts, boundaries, client/server
// split) from the route manifest — cheap context an agent would otherwise open many files for.
// It is `routeMapData()` (the structured map, also served to the DevTools Routes tab by the
// dev server) piped through `formatRouteMap()` (the text an MCP client reads).
//
// These run in-process, so they resolve against the project's own `deno.json` — which is the
// config the MCP server picks up when launched from the project directory (the normal case).

import { isAbsolute, relative, resolve, toFileUrl } from "@std/path";
import { resolveProject } from "../build/paths.ts";
import { scanRoutes } from "../router/manifest.ts";
import type { PageRoute, RouteManifest } from "../router/manifest.ts";
import type { RouteParams } from "../router/segments.ts";
import type { Directive } from "../build/directives.ts";
import { matchApi, matchPage, type PageMatch } from "../router/match.ts";
import { createTestApp, createTestClient } from "../testing/mod.ts";
import { render } from "../testing/render.ts";
import { h } from "../jsx/jsx-runtime.ts";

/** Truncate rendered HTML so a tool result stays a reasonable size. */
function clampHtml(html: string, max = 8000): string {
  return html.length > max
    ? `${html.slice(0, max)}\n… [truncated, ${html.length} bytes total]`
    : html;
}

/**
 * Render a route server-side (no browser) and return its status + HTML.
 *
 * @param dir The project directory.
 * @param path The route path to render (e.g. `/blog/hello`).
 * @returns A text report: status line, any redirect, and the rendered HTML (truncated).
 */
export async function renderRoute(dir: string, path: string): Promise<string> {
  const client = createTestClient(await createTestApp(dir));
  const res = await client.get(path);
  const redirect = res.location ? `\n→ redirect: ${res.location}` : "";
  const note = res.status >= 500
    ? "\n(500 — the route threw while rendering. Run `denext dev` and use denext_dev_logs for " +
      "the error message + codeframe.)"
    : res.status === 404
    ? "\n(404 — no route matched this path. Try denext_list_routes.)"
    : "";
  return `${path} → ${res.status}${redirect}${note}\n\n${clampHtml(res.text)}`;
}

/**
 * Render a single component with props via the browser-free test renderer.
 *
 * @param dir The project directory (props/imports resolve relative to it).
 * @param componentPath The component module path (relative to `dir`).
 * @param props Props passed to the component.
 * @returns The component's rendered inner HTML.
 */
export async function renderComponent(
  dir: string,
  componentPath: string,
  props: Record<string, unknown>,
): Promise<string> {
  // Contain the path INSIDE the project — `componentPath` is untrusted tool input, and
  // `import()` executes the target's top-level code, so a `../`/absolute path must not
  // escape the project tree (mirrors dev-server's resolveInProjectFile).
  const root = resolve(dir);
  const abs = resolve(root, componentPath);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`component path escapes the project: ${componentPath}`);
  }
  // Cache-bust the import so an edit between calls (long-lived MCP process) is reflected.
  const mod = await import(`${toFileUrl(abs).href}?t=${Date.now()}`);
  const Component = mod.default ?? Object.values(mod).find((v) => typeof v === "function");
  if (typeof Component !== "function") {
    throw new Error(`no component export found in ${componentPath}`);
  }
  // deno-lint-ignore no-explicit-any
  const screen = await render(h(Component as any, props ?? {}));
  return clampHtml(screen.html());
}

/** Which side of the server/client boundary a module renders on. */
export type RouteBoundary = "server" | "client";

/** One module in a page's render tree, with the boundary its directive puts it on. */
export interface RouteMapModule {
  /** The module path, relative to the app directory. */
  file: string;
  /** `"client"` when the module declares `"use client"`, else `"server"`. */
  boundary: RouteBoundary;
}

/** The special files that wrap a page, each relative to the app directory. */
export interface RouteMapBoundaries {
  /** Nearest `loading.tsx` (the Suspense fallback). */
  loading?: string;
  /** Nearest `error.tsx` (the error boundary). */
  error?: string;
  /** Nearest `not-found.tsx`. */
  notFound?: string;
  /** Nearest `forbidden.tsx` (403 UI). */
  forbidden?: string;
  /** Nearest `unauthorized.tsx` (401 UI). */
  unauthorized?: string;
}

/** A parallel-route slot declared at the matched page's own level. */
export interface RouteMapSlot {
  /** The slot name, without the `@`. */
  name: string;
  /** How many routable pages the slot's subtree holds. */
  pages: number;
}

/** The matched page and everything that renders around it. */
export interface RouteMapPage {
  /** The route pattern, e.g. `/blog/[slug]`. */
  routePath: string;
  /** Dynamic parameters extracted from the probed path. */
  params: RouteParams;
  /** The page module, relative to the app directory. */
  file: string;
  /** The page module's own boundary. */
  boundary: RouteBoundary;
  /** Layout modules from outermost (root) to innermost. */
  layouts: RouteMapModule[];
  /** Template modules, outermost to innermost. */
  templates: RouteMapModule[];
  /** The page's loading/error/not-found/… files. */
  boundaries: RouteMapBoundaries;
  /** Parallel-route slots at this page's level. */
  slots: RouteMapSlot[];
  /**
   * The page's exported segment config (`revalidate`, `dynamic`, …) when the route
   * manifest carries one. The manifest does not record segment config today, so this is
   * always absent — the field is here so a consumer written against it keeps working
   * once the manifest grows it.
   */
  segmentConfig?: Record<string, unknown>;
}

/** The API route matched at the same path, if any. */
export interface RouteMapApi {
  /** The route pattern, e.g. `/api/user/[id]`. */
  routePath: string;
  /** The route handler module, relative to the app directory. */
  file: string;
}

/**
 * Everything that renders at one path: the structured form of {@link routeMap}'s text.
 *
 * An unmatched path is `matched: false` with no `page`/`api` — not an error, so a caller
 * (the DevTools Routes tab) can render "nothing here" without special-casing a failure.
 */
export interface RouteMapData {
  /** The path that was probed. */
  path: string;
  /** Whether a page OR an API route matched it. */
  matched: boolean;
  /** The matched page's render tree, when a page matched. */
  page?: RouteMapPage;
  /** The matched API route, when one matched. */
  api?: RouteMapApi;
  /**
   * Absolute path of the app directory every `file` above is relative to. Lets a consumer
   * turn a display path back into an absolute one — the DevTools Routes tab needs it to
   * hand a file to `/_denext/open-in-editor`.
   */
  appDir: string;
}

/** "client" if a module declares `"use client"`, else "server" (the default). */
function boundaryOf(filePath: string, directives?: Map<string, Directive>): RouteBoundary {
  return directives?.get(filePath) === "client" ? "client" : "server";
}

/** The boundary special files of a page, each relativized, absent ones omitted. */
function routeBoundaries(route: PageRoute, rel: (p: string) => string): RouteMapBoundaries {
  const out: RouteMapBoundaries = {};
  if (route.loading) out.loading = rel(route.loading);
  if (route.error) out.error = rel(route.error);
  if (route.notFound) out.notFound = rel(route.notFound);
  if (route.forbidden) out.forbidden = rel(route.forbidden);
  if (route.unauthorized) out.unauthorized = rel(route.unauthorized);
  return out;
}

/** The matched page's render tree: page module, layout/template chains, boundaries, slots. */
function pageMapData(
  match: PageMatch,
  rel: (p: string) => string,
  directives?: Map<string, Directive>,
): RouteMapPage {
  const r = match.route;
  const mod = (p: string): RouteMapModule => ({
    file: rel(p),
    boundary: boundaryOf(p, directives),
  });
  return {
    routePath: r.routePath,
    params: match.params,
    file: rel(r.filePath),
    boundary: boundaryOf(r.filePath, directives),
    layouts: r.layoutChain.map(mod),
    templates: r.templateChain.map(mod),
    boundaries: routeBoundaries(r, rel),
    slots: Object.entries(r.slots ?? {}).map(([name, slot]) => ({
      name,
      pages: slot.pages.length,
    })),
  };
}

/**
 * Map the full render tree at a path from an ALREADY-SCANNED manifest: the matched page
 * (+ params), its layout and template chains with each module's client/server boundary,
 * its loading/error/… boundaries and parallel slots, and any API route at the same path.
 *
 * Pure and synchronous — it never touches the filesystem — so the dev server can answer
 * `/_denext/dev-routes` from its cached manifest instead of re-scanning the app directory.
 *
 * @param manifest The route manifest to match against.
 * @param appDir Absolute path of the app directory (module paths are reported relative to it).
 * @param path The route path to map.
 * @returns The structured map; `matched: false` when nothing matches.
 */
export function routeMapData(
  manifest: RouteManifest,
  appDir: string,
  path: string,
): RouteMapData {
  const rel = (p: string) => relative(appDir, p);
  const api = matchApi(manifest, path);
  const page = matchPage(manifest, path);
  const data: RouteMapData = { path, matched: Boolean(page || api), appDir };
  if (api) data.api = { routePath: api.route.routePath, file: rel(api.route.filePath) };
  if (page) data.page = pageMapData(page, rel, manifest.directives);
  return data;
}

/** Boundary field → the label {@link formatRouteMap} prints it under, in print order. */
const BOUNDARY_LABELS: readonly (readonly [keyof RouteMapBoundaries, string])[] = [
  ["loading", "loading"],
  ["error", "error"],
  ["notFound", "not-found"],
  ["forbidden", "forbidden"],
  ["unauthorized", "unauthorized"],
];

/** The page half of {@link formatRouteMap}'s report, one line per module. */
function pageLines(page: RouteMapPage): string[] {
  const lines = [
    `Page: ${page.routePath}   params: ${JSON.stringify(page.params)}`,
    `  page: ${page.file} [${page.boundary}]`,
  ];
  for (const l of page.layouts) lines.push(`  layout: ${l.file} [${l.boundary}]`);
  for (const t of page.templates) lines.push(`  template: ${t.file} [${t.boundary}]`);
  for (const [field, label] of BOUNDARY_LABELS) {
    const file = page.boundaries[field];
    if (file) lines.push(`  ${label}: ${file}`);
  }
  for (const slot of page.slots) lines.push(`  @${slot.name} slot: ${slot.pages} page(s)`);
  return lines;
}

/**
 * Render a {@link RouteMapData} as the compact text map an MCP client reads.
 *
 * @param map A structured route map.
 * @returns The text map, or a "no match" hint.
 */
export function formatRouteMap(map: RouteMapData): string {
  if (!map.matched) return `No route matches "${map.path}". Try denext_list_routes.`;
  const lines: string[] = [];
  if (map.api) lines.push(`API route: ${map.api.routePath} → ${map.api.file}`);
  if (map.page) lines.push(...pageLines(map.page));
  return lines.join("\n");
}

/**
 * Map the full render tree at a path: the matched page (+ params), its layout and template
 * chains with each module's client/server boundary, its loading/error/… boundaries and
 * parallel slots, and any API route at the same path — all from the route manifest.
 *
 * @param dir The project directory.
 * @param path The route path to map.
 * @returns A compact text map, or a "no match" hint.
 */
export async function routeMap(dir: string, path: string): Promise<string> {
  const paths = await resolveProject(dir);
  const manifest = await scanRoutes(paths.appDir);
  return formatRouteMap(routeMapData(manifest, paths.appDir, path));
}
