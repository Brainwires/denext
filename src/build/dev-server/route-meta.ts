// DevTools metadata for the BUNDLED App Router dev path (`DENEXT_DEV_UNBUNDLED=0`).
//
// The unbundled dev loop and SPA dev both append a `__dnxMeta(…)` footer to every module
// they transform (`devtools-meta.ts`), so the inspector can show a component's source
// location and name its hook cells. The bundled path has no per-module transform — the
// whole route is handed to `deno bundle` — but its GENERATED entry already registers each
// route-structural component (page, layouts, templates, loading, error, slots) under the
// family id `"<url>#default"` (`routeRefreshBlock` in `bundle.ts`). This module computes the
// matching metadata for exactly those files, so the entry can carry it next to the
// registrations: one shared import, then each file's calls.
//
// Components those files merely RENDER are not covered (nothing instruments their modules
// on this path). Each file's calls are cached by absolute path and mtime on the dev state,
// so a rebuild after an unrelated edit re-parses nothing. Correctness-first: an unreadable
// or unparseable file contributes no metadata — it never fails the route's build.

import { toFileUrl } from "@std/path";
import type { PageRoute } from "../../router/manifest.ts";
import { routeSourceFiles } from "../bundle.ts";
import { META_IMPORT, metaCalls, metaEnabled, routeModuleMeta } from "../devtools-meta.ts";
import { type ParsedModule, parseModule } from "../swc-ast.ts";
import type { DevState } from "./state.ts";

/** A module parser (`parseModule` in production; tests inject a counting one). */
type Parse = (source: string) => Promise<ParsedModule | null>;

/** Route files swc can parse — an `.mdx`/`.md` page keeps its registration, minus metadata. */
const SCRIPT_RE = /\.(tsx|ts|jsx|js|mjs)$/;

/** A file's mtime in ms; `NaN` when the FS reports none (never a cache hit); null if gone. */
async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await Deno.stat(file)).mtime?.getTime() ?? NaN;
  } catch {
    return null;
  }
}

/** One route file's `__dnxMeta` calls, or `""` when it can't be read or parsed. */
async function fileCalls(file: string, parse: Parse): Promise<string> {
  try {
    const parsed = await parse(await Deno.readTextFile(file));
    if (!parsed) return "";
    const url = toFileUrl(file).href;
    return metaCalls(url, routeModuleMeta(parsed, url));
  } catch {
    return ""; // best-effort: no metadata, never a thrown build
  }
}

/** {@link fileCalls} through the dev state's mtime cache. */
async function cachedCalls(
  cache: DevState["routeMetaCache"],
  file: string,
  parse: Parse,
): Promise<string> {
  const mtimeMs = await mtimeOf(file);
  if (mtimeMs === null) {
    cache.delete(file); // deleted since it was cached: don't keep its footer around
    return "";
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.footer;
  const footer = await fileCalls(file, parse);
  cache.set(file, { mtimeMs, footer });
  return footer;
}

/**
 * The DevTools metadata footer for a route's bundled dev entry: the `registerComponentMeta`
 * import plus a `__dnxMeta("<url>#<Name>", {…})` call for every tracked declaration of each
 * of the route's own source files ({@linkcode routeSourceFiles}) — the default export keyed
 * `#default`, the id the entry's `registerFamily` uses. Pass it to `generateRouteEntry` as
 * `devMetaFooter`. `""` when `DENEXT_DEV_META=0` or nothing is tracked; a file whose calls
 * exceed the 16 KB cap contributes none.
 *
 * @param st The dev state (its `routeMetaCache` holds each file's calls by mtime).
 * @param route The page route.
 * @param parse The module parser (defaults to `parseModule`; injectable for tests).
 * @returns The footer source, or `""`.
 */
export async function routeDevMeta(
  st: Pick<DevState, "routeMetaCache">,
  route: PageRoute,
  parse: Parse = parseModule,
): Promise<string> {
  if (!metaEnabled()) return "";
  const files = [...new Set(routeSourceFiles(route))].filter((f) => SCRIPT_RE.test(f));
  const calls = await Promise.all(files.map((f) => cachedCalls(st.routeMetaCache, f, parse)));
  const body = calls.join("");
  return body ? META_IMPORT + body : "";
}
