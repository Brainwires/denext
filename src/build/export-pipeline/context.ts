// Static export: the shared context every stage under `./` reads and fills in.
// `denext export` runs the stages in order (see `../export.ts`).

import type { PageRoute, RouteManifest } from "../../router/manifest.ts";
import type { I18nConfig } from "../../server/i18n.ts";
import type { ModuleLoader } from "../../server/types.ts";
import type { AppCss } from "../css.ts";
import type { ProjectPaths } from "../paths.ts";
import { routeId } from "../paths.ts";
import { FLIGHT_BUNDLE_FILE } from "../build-pipeline/context.ts";

export interface StaticExportResult {
  /** Absolute path of the output directory. */
  outDir: string;
  /** Number of HTML pages written. */
  pages: number;
  /** Route paths skipped (dynamic without generateStaticParams). */
  skipped: string[];
}

export interface StaticExportOptions {
  /** Output directory name (relative to the project); defaults to "out". */
  outDir?: string;
  /** i18n config; when set, each page is emitted once per locale. */
  i18n?: I18nConfig;
}

/** Everything the export stages share for one `denext export`. */
export interface ExportContext {
  readonly projectDir: string;
  readonly paths: ProjectPaths;
  readonly manifest: RouteManifest;
  readonly i18n: I18nConfig | undefined;
  /** The host-anywhere output dir (`out/`). */
  readonly outDir: string;
  /** `<outDir>/_denext/client` — bundles + stylesheets. */
  readonly clientOut: string;
  /** The module loader the render uses (wrapped for Cache Components / next-compat). */
  load: ModuleLoader;
  /** Route paths with a Flight (RSC) boundary — they share one Flight bundle. */
  readonly flightRoutes: Set<string>;
  /** Route paths that ship no client JS and no hydration script. */
  readonly staticRoutes: Set<string>;
  /** Route paths that got a stylesheet. */
  readonly cssRoutes: Set<string>;
  css: AppCss | null;
  /** next-compat mode. */
  compat: boolean;
  /** next-compat: source module → compat bundle (to redirect the Flight boundary refs). */
  compatModuleMap: Map<string, string> | null;
  /** Pages written so far. */
  pages: number;
  /** Route paths / pathnames skipped. */
  readonly skipped: string[];
}

/** The hydration script for a route, or none for a static route. */
export function clientEntryFor(ctx: ExportContext, route: PageRoute): string | undefined {
  if (ctx.staticRoutes.has(route.routePath)) return undefined; // static → no hydration script
  if (ctx.flightRoutes.has(route.routePath)) return `/_denext/client/${FLIGHT_BUNDLE_FILE}`;
  return `/_denext/client/${routeId(route.routePath)}.js`;
}

/** The stylesheet links for a route (when it has one). */
export function styleHrefsFor(ctx: ExportContext, route: PageRoute): string[] | undefined {
  return ctx.cssRoutes.has(route.routePath)
    ? [`/_denext/client/${routeId(route.routePath)}.css`]
    : undefined;
}
