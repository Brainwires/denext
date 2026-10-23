// Production build: the shared build context every stage under `./` reads and fills in.
// `denext build` runs the stages in order (see `../build.ts`); this record is the explicit
// form of what used to be the locals of one 430-line function.

import type { PageRoute, RouteManifest } from "../../router/manifest.ts";
import type { AppCss } from "../css.ts";
import type { BoundaryManifest } from "../module-graph.ts";
import type { ClassRuntimeMode } from "../bundle.ts";
import type { ProjectPaths } from "../paths.ts";

/**
 * The bundle key of the app-wide Flight (RSC) client entry, and its output's basename:
 * namespaced, like {@link GLOBAL_ERROR_ENTRY_KEY}, so it can't collide with a route's bundle (a
 * `/flight` route's id is `flight`).
 */
const FLIGHT_ENTRY_KEY = "__denext_flight__";

/** The file name of the app-wide Flight (RSC) client bundle. */
export const FLIGHT_BUNDLE_FILE = `${FLIGHT_ENTRY_KEY}.js`;

/** The base name of the Flight entry's deferred boot (`build/flight-boot.ts`). */
export const FLIGHT_BOOT_KEY = "__denext_flight_boot__";

/**
 * The bundle key the global-error entry is built under, and its output's basename: namespaced so
 * it can't collide with a route's bundle (a `/global-error` route's id is `global-error`, and a
 * routeId only starts with `_` for a dynamic segment, never with this name; the build refuses
 * the one segment that would spell it).
 */
export const GLOBAL_ERROR_ENTRY_KEY = "__denext_global_error__";

/** The file name of the `global-error.tsx` hydration bundle (single root file). */
export const GLOBAL_ERROR_BUNDLE_FILE = `${GLOBAL_ERROR_ENTRY_KEY}.js`;

/**
 * The client bundle ids the framework writes under fixed names. A route whose id is one of
 * them (only a dynamic segment spelling it exactly can be) would overwrite that bundle.
 */
export const RESERVED_BUNDLE_IDS: readonly string[] = [
  GLOBAL_ERROR_ENTRY_KEY,
  FLIGHT_ENTRY_KEY,
  FLIGHT_BOOT_KEY,
];

/**
 * Refuse routes whose bundle id is reserved.
 *
 * @param routePaths The client routes' paths.
 * @param idOf The routeId function.
 * @throws {Error} Naming the route and the reserved id.
 */
export function assertNoReservedRouteIds(
  routePaths: readonly string[],
  idOf: (routePath: string) => string,
): void {
  for (const routePath of routePaths) {
    const id = idOf(routePath);
    if (RESERVED_BUNDLE_IDS.includes(id)) {
      throw new Error(
        `denext build: route ${routePath} has the bundle id "${id}", which a framework bundle ` +
          "uses; rename that dynamic segment",
      );
    }
  }
}

export interface BuildResult {
  routes: Array<{ routePath: string; bundle: string }>;
  outDir: string;
}

/** Everything the build stages share for one `denext build`. */
export interface BuildContext {
  readonly projectDir: string;
  readonly paths: ProjectPaths;
  readonly manifest: RouteManifest;
  /** Staging dir the client build is written into (atomically swapped in at the end). */
  readonly clientDir: string;
  /** The final `client/` dir the staging dir replaces. */
  readonly finalClientDir: string;
  /** next-compat mode (drop-in npm React): react→denext rewriting at bundle time. */
  readonly compat: boolean;
  /** Route paths with a Flight (RSC) boundary. */
  readonly flightRoutes: Set<string>;
  readonly boundaryRoutes: PageRoute[];
  readonly hasFlight: boolean;
  /** The app's CSS assets (null when the app has no stylesheets). */
  readonly css: AppCss | null;
  /** The bundler import map's CSS shims. */
  cssImportMap: Record<string, string>;
  /** The client transforms (auto-memo, qrl, AsyncContext, feature folds) by module file URL. */
  transforms: Record<string, string>;
  /**
   * The web target's platform-file redirects (`.web.tsx`, native path only; empty when the app
   * has none), keyed by file URL. The client bundles resolve them with the action stubs and the
   * transforms (./client-imports.ts).
   */
  readonly platformRedirects: Record<string, string>;
  /** Route bundles produced so far (the manifest's `generatedRoutes`). */
  readonly routes: BuildResult["routes"];
  /** Routes that ship no client JS. */
  readonly staticRoutes: string[];
  /** Non-Flight routes that need a hydration bundle. */
  readonly clientRoutes: PageRoute[];
  /** The app-wide boundary manifest (only when the app has a Flight route). */
  boundary: BoundaryManifest | null;
  /**
   * The boundary the build crawled, Flight route or not: `manifest.json` records it so
   * `denext start` never re-crawls the import graph (a `deno info` child per start, which a
   * least-privilege start without `--allow-run` cannot spawn). Null with no page route.
   */
  crawledBoundary: BoundaryManifest | null;
  /**
   * The `"use server"` modules every route reaches (the boundary's `server`, computed whether or
   * not the app has a Flight route): each client bundle gets an action stub for them.
   */
  serverModules: BoundaryManifest["server"];
  /** Whether the Flight entry bundles the Live transport. */
  usesLive: boolean;
  /** Whether the app defines a live view (the Flight entry registers the live-view island). */
  usesLiveView: boolean;
  /**
   * How the generated entries get the class-component runtime: `"eager"` when the build scan
   * saw a class (or `classComponents: true`), `"off"` for `classComponents: false`, else
   * `"lazy"` (loaded on demand when the server-rendered document says a class rendered).
   */
  classRuntime: ClassRuntimeMode;
  /** Whether the generated entries install the Activity offscreen scheduler (scan). */
  usesActivity: boolean;
  /** Whether the generated entries install the ViewTransition marking runtime (scan). */
  usesViewTransition: boolean;
  /** Whether the app writes a `client:*` directive: route entries install the island runtime. */
  usesIsoIslands: boolean;
  /** Whether the generated entries install the host-singleton runtime (scan). */
  usesSingletons: boolean;
  /** Whether the app may render a blur placeholder (scan; the `__DENEXT_IMAGE_BLUR__` define). */
  usesImageBlur: boolean;
  /** Whether the app may write a form action (scan; the `__DENEXT_FORM_ACTIONS__` define). */
  usesFormActions: boolean;
  /** Whether the app may write a route-pattern href (scan; the `__DENEXT_HREF_PARAMS__` define). */
  usesHrefParams: boolean;
  /** next-compat: source module (project-relative) → server bundle (outDir-relative). */
  readonly compatServerModules: Record<string, string>;
}

/** Print one build progress line. */
export { timed } from "../../runtime/timing.ts";

export function log(msg: string): void {
  console.log(`  ${msg}`);
}
