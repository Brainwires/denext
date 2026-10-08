// `react-router.config.ts`'s `prerender` on denext. React Router renders the listed URLs at
// build time; denext's equivalents are segment config on the generated page wrapper:
//
//   • a listed URL of a STATIC route ⇒ `export const dynamic = "force-static"` — rendered
//     once and served from the page cache by `denext start`, written by `denext export`;
//   • listed URLs of a DYNAMIC route ⇒ `export function generateStaticParams()` returning
//     their params — written by `denext export`; other params still render on demand.
//
// `prerender: true` lists every static path, and the function form gets them as
// `getStaticPaths()`, as in React Router.

import { expandOptionalSegments, type RouteNode } from "./route-tree.ts";

/** `react-router.config.ts`'s `prerender` (React Router v7). */
export type PrerenderConfig =
  | boolean
  | string[]
  | ((
    args: { getStaticPaths: () => string[] },
  ) => string[] | Promise<string[]>);

/** The URL pattern variants a node serves, or none for a pure layout / resource route. */
function pagePatterns(node: RouteNode): string[] {
  return node.layout ? [] : expandOptionalSegments(node.pattern);
}

/** Whether an RR pattern has a dynamic (`:param`) or splat (`*`) segment. */
function isDynamic(pattern: string): boolean {
  return pattern.split("/").some((seg) => seg.startsWith(":") || seg === "*");
}

/** `/a/b/` and `a/b` alike ⇒ `/a/b` (`/` for the root). */
function normalizePath(path: string): string {
  const trimmed = path.split(/[?#]/)[0].replace(/^\/+|\/+$/g, "");
  return `/${trimmed}`;
}

/** Every static URL the route config serves (what `prerender: true` renders). */
function staticPaths(nodes: RouteNode[]): string[] {
  const out = new Set<string>();
  for (const node of nodes) {
    for (const pattern of pagePatterns(node)) {
      if (!isDynamic(pattern)) out.add(normalizePath(pattern));
    }
  }
  return [...out];
}

/**
 * The URLs a `prerender` config lists, normalized, or null when it lists none.
 *
 * @param config The config's `prerender` value.
 * @param nodes The route tree (`prerender: true` / `getStaticPaths()` read its static paths).
 * @returns The listed paths, or null for `false` / no config.
 */
export async function resolvePrerenderPaths(
  config: PrerenderConfig | undefined,
  nodes: RouteNode[],
): Promise<string[] | null> {
  if (config === undefined || config === false) return null;
  if (config === true) return staticPaths(nodes);
  const listed = typeof config === "function"
    ? await config({ getStaticPaths: () => staticPaths(nodes) })
    : config;
  if (!Array.isArray(listed) || listed.some((p) => typeof p !== "string")) {
    throw new Error(
      "react-router: `prerender` must be a boolean, a path list, or return one",
    );
  }
  return [...new Set(listed.map(normalizePath))];
}

/** The params `path` gives `pattern` (RR syntax), or null when it doesn't match. */
export function matchPattern(
  pattern: string,
  path: string,
): Record<string, string> | null {
  const segs = pattern.split("/").filter((s) => s !== "");
  const parts = normalizePath(path).split("/").filter((s) => s !== "");
  const params: Record<string, string> = {};
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === "*") {
      if (i >= parts.length) return null;
      params.splat = parts.slice(i).map(decodeURIComponent).join("/");
      return params;
    }
    if (i >= parts.length) return null;
    if (seg.startsWith(":")) {
      params[seg.slice(1)] = decodeURIComponent(parts[i]);
    } else if (seg !== parts[i]) return null;
  }
  return parts.length === segs.length ? params : null;
}

/** A param set as the generated `generateStaticParams` returns it (`splat` is a segment list). */
function staticParams(
  params: Record<string, string>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = { ...params };
  if (params.splat !== undefined) out.splat = params.splat.split("/");
  return out;
}

/**
 * The segment config a page wrapper gains from the `prerender` list (see the module docs),
 * or `""` when no listed URL is one of its routes.
 *
 * @param node The route.
 * @param paths The listed URLs ({@link resolvePrerenderPaths}).
 * @returns Source to append to the generated page wrapper.
 */
export function prerenderExports(
  node: RouteNode,
  paths: string[] | null,
): string {
  if (!paths?.length) return "";
  let staticHit = false;
  const params: Record<string, string | string[]>[] = [];
  for (const pattern of pagePatterns(node)) {
    for (const path of paths) {
      const match = matchPattern(pattern, path);
      if (!match) continue;
      if (isDynamic(pattern)) params.push(staticParams(match));
      else staticHit = true;
    }
  }
  const out: string[] = [];
  if (staticHit && params.length === 0) {
    out.push(`export const dynamic = "force-static";`);
  }
  if (params.length) {
    out.push(
      `export function generateStaticParams() {\n  return ${JSON.stringify(params)};\n}`,
    );
  }
  return out.length ? `\n// react-router.config.ts \`prerender\`\n${out.join("\n")}\n` : "";
}
