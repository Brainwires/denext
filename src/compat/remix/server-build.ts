// A Remix `ServerBuild` synthesized from denext's route manifest — for the code a Remix app
// pointed at its server build: `@nasa-gcn/remix-seo`'s `generateSitemap(request,
// build.routes, …)` (the Epic Stack passes `context.serverBuild` from `getLoadContext`),
// anything else that reflects over `routes[id].module.handle`.
//
// The migrator's page/layout/`route.ts` wrappers export a `remixRoute` marker (the Remix
// route id + its data module), so each denext route maps back to the Remix module it came
// from — `handle`, `loader`, `meta`, … are the app's own, and `default` is present exactly
// when the route renders a component (a resource route has none). The tree is FLAT: every
// route's `path` is its full URL pattern (`users/:username/notes`) under `root`, which is
// what path composition over `parentId` yields for the nested original.

import type { PageRoute } from "../../router/manifest.ts";
import type { Segment } from "../../router/segments.ts";
import { envGet } from "../../runtime/env-safe.ts";
import { currentContext, type RouteRegistry } from "../../server/request-context.ts";
import type { ModuleLoader } from "../../server/types.ts";

/** The exports of one Remix route module, as a `ServerBuild` exposes them. */
export interface ServerRouteModule {
  /** The route component — absent for a resource route. */
  default?: unknown;
  /** The app's `handle` export (`getSitemapEntries`, breadcrumbs, …). */
  handle?: unknown;
  /** Everything else the module exported (`loader`, `action`, `meta`, `links`, …). */
  [name: string]: unknown;
}

/** One route of a Remix `ServerBuild`. */
export interface ServerRoute {
  /** The Remix route id (`routes/users+/index`). */
  id: string;
  /** The parent route's id (`root` for every route of the flat synthesized tree). */
  parentId?: string;
  /** The URL pattern relative to the parent (`users/:username`), absent for an index route. */
  path?: string;
  /** An index route (the parent's own URL). */
  index?: boolean;
  /** The route's module exports. */
  module: ServerRouteModule;
}

/**
 * The Remix `ServerBuild` shape denext synthesizes ({@link remixServerBuild}): the routes
 * keyed by id plus the mode. `build` is the build itself — the Epic Stack's custom server
 * hands loaders `{ error, build }` and its sitemap reads `serverBuild.build.routes`; the
 * alias lets both that and a plain `serverBuild.routes` work.
 */
export interface ServerBuild {
  /** Every route keyed by its Remix id, `root` included. */
  routes: Record<string, ServerRoute>;
  /** `development` under `NODE_ENV=development`, else `production`. */
  mode: "development" | "production";
  /** The build itself (the `{ error, build }` wrapper shape). */
  build: ServerBuild;
  /** Always `undefined` (the `{ error, build }` wrapper shape). */
  error?: undefined;
}

/**
 * The marker a migrated route wrapper exports so the build can map a denext route back to
 * its Remix module.
 */
export interface RemixRouteExport {
  /** The Remix route id. */
  id: string;
  /** The route's data module (`loader`/`action`/`meta`/`links`/`handle`), or `{}`. */
  module: Record<string, unknown>;
}

const BUILD_MEMO = Symbol.for("denext.remix.serverBuild");

/**
 * The synthesized Remix `ServerBuild` for the running app — what a Remix app's `getLoadContext`
 * exposed as `serverBuild`. Memoized per request. Outside a request (or when the server
 * registered no route registry) the build is empty.
 *
 * @returns The build (its `.build` is itself, see {@link ServerBuild}).
 */
export async function remixServerBuild(): Promise<ServerBuild> {
  const ctx = currentContext();
  const registry = ctx?.routes;
  if (!registry) return finishBuild({ root: { id: "root", path: "", module: {} } });
  const memo = ctx.memo;
  let slot = memo.get(BUILD_MEMO);
  if (!slot) memo.set(BUILD_MEMO, slot = new Map());
  const cached = slot.get("build") as Promise<ServerBuild> | undefined;
  if (cached) return await cached;
  const pending = synthesize(registry).catch((err) => {
    // A manifest/loader failure must not take the request down with an unhandled rejection.
    console.warn("denext/remix: remixServerBuild failed — serving an empty build:", err);
    return finishBuild({ root: { id: "root", path: "", module: {} } });
  });
  slot.set("build", pending);
  return await pending;
}

function finishBuild(routes: Record<string, ServerRoute>): ServerBuild {
  const mode = envGet("NODE_ENV") === "development" ? "development" : "production";
  const build = { routes, mode, error: undefined } as ServerBuild;
  build.build = build;
  return build;
}

async function synthesize(registry: RouteRegistry): Promise<ServerBuild> {
  const manifest = await registry.manifest();
  const routes: Record<string, ServerRoute> = {};
  const root = manifest.rootLayout ? await loadRoute(registry.load, manifest.rootLayout) : null;
  routes.root = { id: "root", path: "", module: root?.module ?? {} };
  const seenLayouts = new Set<string>();
  for (const page of manifest.pages) {
    await addLayouts(routes, registry.load, page, seenLayouts, manifest.rootLayout);
    const loaded = await loadRoute(registry.load, page.filePath);
    if (loaded) addRoute(routes, loaded, page.pattern);
  }
  for (const api of manifest.api) {
    const loaded = await loadRoute(registry.load, api.filePath);
    // A page's own `route.ts` (its POST handler) shares the page's id — already present.
    if (loaded?.marker && !routes[loaded.marker.id]) addRoute(routes, loaded, api.pattern);
  }
  return finishBuild(routes);
}

/** A page's layouts (root excluded), each at the depth of the segments above it. */
async function addLayouts(
  routes: Record<string, ServerRoute>,
  load: ModuleLoader,
  page: PageRoute,
  seen: Set<string>,
  rootLayout: string | null,
): Promise<void> {
  const depths = page.layoutDepths ?? [];
  for (let i = 0; i < page.layoutChain.length; i++) {
    const file = page.layoutChain[i];
    if (file === rootLayout || seen.has(file)) continue;
    seen.add(file);
    const loaded = await loadRoute(load, file);
    if (loaded) addRoute(routes, loaded, page.pattern.slice(0, depths[i] ?? 0));
  }
}

interface LoadedRoute {
  marker: RemixRouteExport | null;
  module: ServerRouteModule;
  component: boolean;
}

/** Load a route module; null when it fails to load (a module that needs a request, etc.). */
async function loadRoute(load: ModuleLoader, file: string): Promise<LoadedRoute | null> {
  try {
    const mod = await load(file) as { default?: unknown; remixRoute?: RemixRouteExport };
    const marker = isMarker(mod.remixRoute) ? mod.remixRoute : null;
    const component = typeof mod.default === "function";
    const module: ServerRouteModule = { ...(marker?.module ?? {}) };
    if (component) module.default = mod.default;
    return { marker, module, component };
  } catch {
    return null;
  }
}

function isMarker(value: unknown): value is RemixRouteExport {
  return typeof value === "object" && value !== null &&
    typeof (value as RemixRouteExport).id === "string" &&
    typeof (value as RemixRouteExport).module === "object";
}

function addRoute(
  routes: Record<string, ServerRoute>,
  loaded: LoadedRoute,
  pattern: Segment[],
): void {
  const path = remixPath(pattern);
  const id = loaded.marker?.id ?? (path === "" ? "routes/_index" : `routes/${path}`);
  if (routes[id]) return;
  const module = loaded.component ? loaded.module : withoutDefault(loaded.module);
  routes[id] = path === ""
    ? { id, parentId: "root", index: true, module }
    : { id, parentId: "root", path, module };
}

function withoutDefault(module: ServerRouteModule): ServerRouteModule {
  const { default: _component, ...rest } = module;
  return rest;
}

/** A denext pattern as a Remix path: `users/:username/*` (no leading slash). */
export function remixPath(pattern: Segment[]): string {
  return pattern.map((s) => {
    if (s.kind === "static") return s.value;
    if (s.kind === "dynamic") return `:${s.value}`;
    return "*";
  }).join("/");
}
