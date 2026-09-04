// Production build: the shared build context every stage under `./` reads and fills in.
// `denext build` runs the stages in order (see `../build.ts`); this record is the explicit
// form of what used to be the locals of one 430-line function.

import type { PageRoute, RouteManifest } from "../../router/manifest.ts";
import type { AppCss } from "../css.ts";
import type { BoundaryManifest } from "../module-graph.ts";
import type { ProjectPaths } from "../paths.ts";

/** The file name of the app-wide Flight (RSC) client bundle. */
export const FLIGHT_BUNDLE_FILE = "flight.js";

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
  /** The bundler import map: CSS shims + the client-transform redirects. */
  cssImportMap: Record<string, string>;
  /** Route bundles produced so far (the manifest's `generatedRoutes`). */
  readonly routes: BuildResult["routes"];
  /** Routes that ship no client JS. */
  readonly staticRoutes: string[];
  /** Non-Flight routes that need a hydration bundle. */
  readonly clientRoutes: PageRoute[];
  /** The app-wide boundary manifest (only when the app has a Flight route). */
  boundary: BoundaryManifest | null;
  /** Whether the Flight entry bundles the Live transport. */
  usesLive: boolean;
  /** next-compat: source module (project-relative) → server bundle (outDir-relative). */
  readonly compatServerModules: Record<string, string>;
}

/** Print one build progress line. */
export function log(msg: string): void {
  console.log(`  ${msg}`);
}
