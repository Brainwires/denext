// Static export: the shared context every stage under `./` reads and fills in.
// `denext export` runs the stages in order (see `../export.ts`).

import type { PageRoute, RouteManifest } from "../../router/manifest.ts";
import type { I18nConfig } from "../../server/i18n.ts";
import type { ModuleLoader } from "../../server/types.ts";
import type { AppCss } from "../css.ts";
import type { BoundaryManifest } from "../module-graph.ts";
import type { ProjectPaths } from "../paths.ts";
import { join } from "@std/path";
import { routeId } from "../paths.ts";
import type { Platform } from "../platform-extensions.ts";
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
  /**
   * The target whose platform files (`BigButton.ios.tsx`) the export resolves, client and
   * server render alike (default `web`). `denext export --platform`, `denext mobile build` and
   * `denext desktop package` set it.
   */
  platform?: Platform;
}

/** Everything the export stages share for one `denext export`. */
export interface ExportContext {
  readonly projectDir: string;
  readonly paths: ProjectPaths;
  readonly manifest: RouteManifest;
  readonly i18n: I18nConfig | undefined;
  /** The dir the export is WRITTEN to while in progress (`out.staging/`; see `finishExport`). */
  readonly outDir: string;
  /** The host-anywhere output dir (`out/`) the staging dir is swapped into when complete. */
  readonly finalOutDir: string;
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
  /** The target the export resolves platform files for. */
  readonly platform: Platform;
  /**
   * The target's platform files as file-URL redirects (the native path's `deno bundle` import
   * map and server loader; empty when the app has none).
   */
  readonly platformRedirects: Record<string, string>;
  /** Pages written so far. */
  pages: number;
  /** Route paths / pathnames skipped. */
  readonly skipped: string[];
}

/**
 * Where the export keeps its own build intermediates (the next-compat server bundle and client
 * runtime): `.denext/export/`, apart from the `denext build` output in `.denext/` that `denext
 * start` serves, so an export (run by the desktop and mobile package scripts) leaves that build
 * intact.
 *
 * @param paths The project paths.
 * @returns The directory.
 */
export function exportBuildDir(paths: ProjectPaths): string {
  return join(paths.outDir, "export");
}

/**
 * How the native client bundles resolve the app's modules: the CSS shims, and the target's
 * platform files and an action stub per `"use server"` module in `server` (./client-imports.ts,
 * which also reaches the ones an import-map alias names).
 */
export function exportClientResolution(
  ctx: ExportContext,
  server: BoundaryManifest["server"],
) {
  return {
    importMap: { ...ctx.css?.importMap },
    projectDir: ctx.projectDir,
    redirects: ctx.platformRedirects,
    server,
  };
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
