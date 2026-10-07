// An app's routes as data: the pages and API route handlers `scanRoutes` finds under `app/`,
// with their dynamic params, their file and (for an API route) the HTTP methods it exports.
// One source for both readers — `denext routes` (a table, or `--json`) and the MCP
// `denext_list_routes` tool (its plain-text listing) — so the two never disagree.
//
// Nothing here imports a route module: the methods are read from the source text, so listing
// the routes never runs project code and works without a dev server or a build.

import { relative } from "@std/path";
import { resolveProject } from "./paths.ts";
import { scanRoutes } from "../router/manifest.ts";
import type { Segment } from "../router/segments.ts";

/** The HTTP methods a route module can export, in the order a listing shows them. */
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** One route in the listing. */
export interface RouteListEntry {
  /** A page (`page.tsx`) or an API route handler (`route.ts`). */
  readonly kind: "page" | "api";
  /** The route path as written in `app/`, e.g. `/blog/[slug]`. */
  readonly path: string;
  /** The dynamic params, in path order (`slug`, a catch-all's name, …). */
  readonly params: readonly string[];
  /** The module, relative to the project directory (`/`-separated). */
  readonly file: string;
  /**
   * The HTTP methods an API route exports, found in its source text (`export function GET`,
   * `export const POST = …`, `export { handler as PUT }`). Absent for a page.
   */
  readonly methods?: readonly string[];
}

/** Every route of an app. */
export interface RouteList {
  /** The page routes, most specific first. */
  readonly pages: readonly RouteListEntry[];
  /** The API routes, most specific first. */
  readonly api: readonly RouteListEntry[];
}

/** The dynamic params of a parsed route pattern. */
function paramsOf(pattern: readonly Segment[]): string[] {
  return pattern.filter((s) => s.kind !== "static").map((s) => s.value);
}

/**
 * The HTTP methods a route module's source exports. A static read: a method exported through
 * `export * from` or built at runtime is not seen.
 *
 * @param source The module's source text.
 * @returns The exported methods, in {@link HTTP_METHODS} order.
 */
export function exportedMethods(source: string): string[] {
  const found = new Set<string>();
  const declared = /export\s+(?:async\s+)?(?:function\s*\*?|const|let|var)\s+([A-Z]+)\b/g;
  for (const m of source.matchAll(declared)) found.add(m[1]);
  for (const [, typeOnly, names] of source.matchAll(/export\s*(type\s*)?\{([^}]*)\}/g)) {
    if (typeOnly) continue;
    for (const item of names.split(",")) {
      const name = item.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) found.add(name);
    }
  }
  return HTTP_METHODS.filter((m) => found.has(m));
}

/** The methods of one API route module (empty when it can't be read). */
async function methodsOf(file: string): Promise<string[]> {
  try {
    return exportedMethods(await Deno.readTextFile(file));
  } catch {
    return [];
  }
}

/**
 * Scan a project's `app/` directory into a {@link RouteList}.
 *
 * @param dir The project directory.
 * @returns Its pages and API routes.
 */
export async function collectRoutes(dir: string): Promise<RouteList> {
  const paths = await resolveProject(dir);
  const manifest = await scanRoutes(paths.appDir);
  const rel = (file: string) => relative(paths.projectDir, file).replaceAll("\\", "/");
  return {
    pages: manifest.pages.map((p) => ({
      kind: "page" as const,
      path: p.routePath,
      params: paramsOf(p.pattern),
      file: rel(p.filePath),
    })),
    api: await Promise.all(manifest.api.map(async (a) => ({
      kind: "api" as const,
      path: a.routePath,
      params: paramsOf(a.pattern),
      file: rel(a.filePath),
      methods: await methodsOf(a.filePath),
    }))),
  };
}

/**
 * The plain-text listing the MCP `denext_list_routes` tool returns.
 *
 * @param list The routes.
 * @returns Pages, then API routes, each line with its params.
 */
export function formatRouteListText(list: RouteList): string {
  const fmt = (r: RouteListEntry): string =>
    `  ${r.path}${r.params.length ? `   (params: ${r.params.join(", ")})` : ""}`;
  const pages = list.pages.map(fmt);
  const api = list.api.map(fmt);
  if (pages.length === 0 && api.length === 0) return "No routes found (is this a denext app dir?).";
  return `Pages (${pages.length}):\n${pages.join("\n") || "  (none)"}\n\n` +
    `API routes (${api.length}):\n${api.join("\n") || "  (none)"}`;
}

/**
 * The listing as an aligned table — what `denext routes` prints.
 *
 * @param list The routes.
 * @returns The table (a header, then one row per route), or a one-line note when there are none.
 */
export function formatRouteTable(list: RouteList): string {
  const rows = [...list.pages, ...list.api];
  if (rows.length === 0) return "No routes found (is this a denext app dir?).";
  const cells = [
    ["KIND", "ROUTE", "METHODS", "PARAMS", "FILE"],
    ...rows.map((r) => [
      r.kind,
      r.path,
      r.kind === "page" ? "GET" : (r.methods?.join(",") || "-"),
      r.params.join(",") || "-",
      r.file,
    ]),
  ];
  const widths = cells[0].map((_, i) => Math.max(...cells.map((row) => row[i].length)));
  return cells
    .map((row) => row.map((c, i) => i === row.length - 1 ? c : c.padEnd(widths[i])).join("  "))
    .join("\n");
}
