// A Start app's routes as the deploy manifest lists them (`.denext/deploy-manifest.json`, the
// `DeployManifest` of `denext/deploy`), so a deploy adapter sees what the app serves:
//
// - **Server routes** (a route's `server.handlers`) are `"route-handler"`s, with the methods its
//   handlers name when they can be read.
// - **Server functions** (`createServerFn`) are `"route-handler"`s at `/_serverFn/<id>`, the URL
//   Start's RPC calls, one per function.
// - **Pages** are classified as `denext export` classifies them: a page whose route chain reaches a
//   server function in the browser, or with a dynamic segment, is `"dynamic"` (with the reason);
//   the rest are `"static"` (the export writes them).
//
// - **The client files** under `/_tss/` are the manifest's asset groups: the entry (`client.js`,
//   revalidated) and the content-hashed chunks and assets (immutable), with the `Cache-Control`
//   the handler sends — the files it serves, nothing else in the client directory.
//
// Paths are written in the manifest's pattern syntax: `$id` → `[id]`, `{-$id}` → `[[id]]`, a
// splat `$` → `[..._splat]` (TanStack names its splat param `_splat`).

import type { DeployAssetGroup, DeployRoute } from "@denext/denext/plugin-kit";
import { isAbsolute, join, relative } from "@std/path";
import type { ClientGraph } from "./compile.ts";
import {
  ASSETS_DIR,
  CLIENT_ENTRY,
  CLIENT_PREFIX,
  clientFileType,
  ENTRY_CACHE_CONTROL,
  HASHED_CACHE_CONTROL,
  SERVER_FN_SEGMENT,
} from "./handler.ts";
import { routeFor, type RouteInfo, routeNeed } from "./prerender.ts";
import type { ServerFnInfo } from "./toolchain.ts";

/** What {@link deployRoutes} reads. */
export interface DeployInput {
  /** The route tree (`null` when the plugin does not generate it: no route is listed). */
  routes: RouteInfo[] | null;
  /** The app's server functions, by id. */
  serverFns: Record<string, ServerFnInfo>;
  /** The browser build's graph (which routes reach a server function), when one was built. */
  client: ClientGraph | null;
  /** The project root: sources are listed relative to it. */
  projectRoot: string;
  /** Its real path, when it differs (a symlinked checkout). */
  realRoot?: string;
  /** A route module's source (its server handlers' methods are read from it). */
  readSource(file: string): Promise<string>;
}

/** The HTTP methods Start's `server.handlers` take (its `RouteMethod`, and `ANY`). */
const METHOD = /\b(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|ANY)\b\s*(?::|\()/g;

/** A route path in the manifest's pattern syntax (`/posts/$postId` → `/posts/[postId]`). */
export function deployPattern(path: string): string {
  const segments = path.split("/").map((seg) => {
    if (seg === "$") return "[..._splat]";
    const optional = /^\{-\$(\w+)\}$/.exec(seg);
    if (optional) return `[[${optional[1]}]]`;
    const param = /^\$(\w+)$/.exec(seg);
    return param ? `[${param[1]}]` : seg;
  });
  const out = segments.join("/");
  return out.length > 1 ? out.replace(/\/+$/, "") : out;
}

/** The methods a server route's `handlers` name, when the source reads as one. */
function handlerMethods(source: string): string[] | undefined {
  if (!/\bhandlers\b/.test(source)) return undefined;
  const methods = new Set([...source.matchAll(METHOD)].map((m) => m[1]));
  return methods.size ? [...methods].sort() : undefined;
}

/**
 * A path relative to the project, `/`-separated (kept as is outside it). The project is tried by
 * each of its paths: the generator names routes under the root as given, the compiler names
 * server functions under its real path.
 */
function projectPath(file: string, input: DeployInput): string {
  if (!isAbsolute(file)) return file.replace(/\\/g, "/");
  for (const root of [input.projectRoot, input.realRoot ?? input.projectRoot]) {
    const rel = relative(root, file);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return rel.replace(/\\/g, "/");
  }
  return file.replace(/\\/g, "/");
}

/** One route's entries: a server route's handler and, when it renders, its page. */
async function routeEntries(route: RouteInfo, input: DeployInput): Promise<DeployRoute[]> {
  const path = deployPattern(route.path);
  const source = projectPath(route.file, input);
  const out: DeployRoute[] = [];
  if (route.options.includes("server")) {
    const methods = handlerMethods(await input.readSource(route.file).catch(() => ""));
    out.push({
      path,
      kind: "route-handler",
      source,
      reason: "a server route (server.handlers)",
      ...(methods ? { methods } : {}),
    });
    if (!route.options.includes("component")) return out;
  }
  // A layout route whose index child renders its URL (`/posts` and `/posts/`) is listed once.
  if (input.routes && routeFor(input.routes, route.path) !== route) return out;
  const need = routeNeed(route, input);
  if (need) {
    out.push({ path, kind: "dynamic", source, reason: need.reason });
  } else if (route.path.includes("$")) {
    out.push({
      path,
      kind: "dynamic",
      source,
      reason: "a dynamic route, rendered per request (`denext export` writes the paths it " +
        "prerenders)",
    });
  } else {
    out.push({ path, kind: "static", source });
  }
  return out;
}

/** A server function's name as the app exports it (the compiler appends its handler's role). */
const exportName = (name: string) => name.replace(/_createServerFn_handler$/, "");

/**
 * The deploy manifest's entries for a Start app: its server routes, its pages and its server
 * functions.
 *
 * @param input The route tree, the server functions, the browser build's graph.
 */
export async function deployRoutes(input: DeployInput): Promise<DeployRoute[]> {
  const out: DeployRoute[] = [];
  for (const route of input.routes ?? []) {
    if (!route.layout) out.push(...await routeEntries(route, input));
  }
  for (const [id, fn] of Object.entries(input.serverFns)) {
    out.push({
      path: `${SERVER_FN_SEGMENT}${id}`,
      kind: "route-handler",
      source: projectPath(fn.filename, input),
      reason: `a server function (createServerFn \`${exportName(fn.functionName)}\`), called ` +
        "over Start's RPC",
    });
  }
  return out;
}

/**
 * The client bundle's files under `/_tss/` as the deploy manifest's asset groups: the entry
 * (revalidated) and the content-hashed files (immutable), with the `Cache-Control` the handler
 * sends. Only the files the handler serves are listed; none before a build.
 *
 * @param clientDir The client bundle's directory (absolute).
 * @param projectRoot The project root: the directory is listed relative to it.
 */
export async function deployAssets(
  clientDir: string,
  projectRoot: string,
): Promise<DeployAssetGroup[]> {
  const names: string[] = [];
  const list = async (sub: string) => {
    try {
      for await (const entry of Deno.readDir(join(clientDir, sub))) {
        const name = sub ? `${sub}/${entry.name}` : entry.name;
        if (entry.isFile && clientFileType(name) !== null) names.push(name);
      }
    } catch {
      // Not built: nothing to list.
    }
  };
  await list("");
  await list(ASSETS_DIR);
  const dir = relative(projectRoot, clientDir).replace(/\\/g, "/");
  const group = (files: string[], cacheControl: string, immutable: boolean) =>
    files.length ? [{ urlPrefix: CLIENT_PREFIX, dir, cacheControl, immutable, files }] : [];
  const hashed = names.filter((n) => n !== CLIENT_ENTRY).sort();
  return [
    ...group(names.filter((n) => n === CLIENT_ENTRY), ENTRY_CACHE_CONTROL, false),
    ...group(hashed, HASHED_CACHE_CONTROL, true),
  ];
}
