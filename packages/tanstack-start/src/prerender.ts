// `denext export` of a Start app: TanStack Start's own prerender, run against the app's server
// bundle in-process, with the options Start's plugin takes (`prerender`, `pages`) and its
// semantics (`@tanstack/start-plugin-core`'s `prerender`):
//
// - **The pages** are the app's `pages` (or `/`), plus every static path the route tree has
//   (`autoStaticPathsDiscovery`, as Start's generator plugin finds them: no `$` segment, not a
//   pathless layout, a `component`), plus the links each prerendered page has (`crawlLinks`).
//   `filter`, a page's `prerender.enabled`, `headers`, `outputPath`, `autoSubfolderIndex`,
//   `maxRedirects`, `retryCount` / `retryDelay`, `onSuccess`, `concurrency` and `failOnError`
//   (a page that is not a 2xx fails the export) apply as in Start.
// - **A route that needs a server is refused**, as the `static` deploy preset refuses one: a
//   server route (`server` handlers), a page whose route chain reaches a server function in the
//   browser (its RPC answers only from a server), and a dynamic route no page of which was
//   prerendered. The export leaves them out and lists each with the reason.
// - **A page is written as its final HTML**: each streamed Suspense boundary's content in place of
//   its fallback (./static-html.ts), so the static file reads the same with JavaScript off.

import { join } from "@std/path";
import type { ClientGraph } from "./compile.ts";
import { isAppModule } from "./protect.ts";
import { inlineStreamedBoundaries } from "./static-html.ts";

/** A route the generator found. */
export interface RouteInfo {
  /** The route's id (`/posts/$postId`, `/_layout/a`; `__root__` for the root route). */
  id: string;
  /** The URL path it matches (`/posts/$postId`; `/` for the root route). */
  path: string;
  /** Its module (absolute). */
  file: string;
  /** The root route or a pathless layout: it never answers a URL by itself. */
  layout: boolean;
  /** The options its `createFileRoute(…)({…})` declares (`component`, `server`, `loader`, …). */
  options: string[];
  /** Its parent route (the root route's children have the root route). */
  parent?: RouteInfo;
}

/** A page's prerender options (Start's `pagePrerenderOptionsSchema`). */
export interface PagePrerenderOptions {
  /** `false` leaves the page out. */
  enabled?: boolean;
  /** Where the page's HTML is written (a path under the export). */
  outputPath?: string;
  /** Write `/about` as `about/index.html` (default) rather than `about.html`. */
  autoSubfolderIndex?: boolean;
  /** Prerender the links the page has (default `true`). */
  crawlLinks?: boolean;
  /** Retries of a failed page (default 0). */
  retryCount?: number;
  /** Milliseconds between retries (default 500). */
  retryDelay?: number;
  /** Called with each prerendered page; a returned object is merged into the page. */
  onSuccess?: (result: { page: StartPage; html: string }) => unknown;
  /** Request headers for the page. */
  headers?: Record<string, string>;
}

/** A page to prerender (Start's `pages` entry). */
export interface StartPage {
  /** The page's path, under the router's base path. */
  path: string;
  /** This page's prerender options (over the `prerender` ones). */
  prerender?: PagePrerenderOptions;
  /** Start's sitemap options (accepted; denext writes no sitemap). */
  sitemap?: Record<string, unknown>;
  /** Found by crawling a prerendered page's links. */
  fromCrawl?: boolean;
}

/** Start's `prerender` options. */
export interface PrerenderOptions extends PagePrerenderOptions {
  /** How many pages render at once (default: the CPU count). */
  concurrency?: number;
  /** Whether a page is prerendered (a falsy return leaves it out). */
  filter?: (page: StartPage) => unknown;
  /** A page that fails fails the export (default `true`). */
  failOnError?: boolean;
  /** Add the route tree's static paths to the pages (default `true`). */
  autoStaticPathsDiscovery?: boolean;
  /** Redirects followed for a page (default 5). */
  maxRedirects?: number;
}

/** A route the export leaves to a server, and why. */
export interface Refusal {
  /** The route's path (or, for a page, the page's). */
  path: string;
  /** The route's module (absolute), when known. */
  file?: string;
  reason: string;
}

/** What {@link prerenderPages} needs. */
export interface PrerenderInput {
  options: PrerenderOptions;
  pages: StartPage[];
  /** The route tree (`null` when the plugin does not generate it: no discovery, no refusals). */
  routes: RouteInfo[] | null;
  /** The browser build's graph (which modules call a server function). */
  client: ClientGraph | null;
  /** The project root (the client graph's paths are under it). */
  projectRoot: string;
  /** The router's base path (`""` when none). */
  basePath: string;
  /** Answer a request (Start's server entry). */
  fetch(request: Request): Promise<Response>;
  /** Write one page's HTML, at a path relative to the export's root. */
  write(file: string, html: string): Promise<void>;
}

/** What the export wrote and what it refused. */
export interface PrerenderResult {
  /** The paths of the pages written. */
  written: string[];
  /** The routes left to a server. */
  refused: Refusal[];
}

const ORIGIN = "http://localhost";

/** The paths Start discovers (its generator plugin's `getPrerenderablePaths`). */
export function staticPaths(routes: RouteInfo[]): string[] {
  const paths = new Set(["/"]);
  for (const r of routes) {
    if (r.layout || !r.id || r.id.includes("$") || !r.options.includes("component")) continue;
    paths.add(r.path);
  }
  return [...paths];
}

/** A path without its trailing slash (`/` stays). */
const trimSlash = (path: string) => path.length > 1 ? path.replace(/\/+$/, "") : path;

/** A route path as a matcher of URL paths (`$id` one segment, `$` the rest, `{-$id}` optional). */
function routeMatcher(path: string): RegExp {
  const segments = trimSlash(path).split("/").filter(Boolean).map((seg) => {
    if (seg === "$") return "(?:/.*)?";
    if (/^\{-\$\w+\}$/.test(seg)) return "(?:/[^/]+)?";
    if (/^\$\w+$/.test(seg)) return "/[^/]+";
    return "/" + seg.replace(/[{}]/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^${segments.join("") || "/"}$`);
}

/** The route a URL path renders: the most specific match (fewest dynamic segments, an index). */
export function routeFor(routes: RouteInfo[], urlPath: string): RouteInfo | undefined {
  const path = trimSlash(urlPath.split(/[?#]/)[0]);
  const dynamic = (r: RouteInfo) => (r.path.match(/\$/g) ?? []).length;
  return routes
    .filter((r) => !r.layout && routeMatcher(r.path).test(path))
    .sort((a, b) =>
      dynamic(a) - dynamic(b) || Number(b.id.endsWith("/")) - Number(a.id.endsWith("/"))
    )[0];
}

/** Whether `file` reaches, through the app's modules, one the browser gets as RPC stubs. */
function reachesServerFn(client: ClientGraph, file: string, projectRoot: string): boolean {
  const seen = new Set([file]);
  const queue = [file];
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i];
    if (client.serverFnModules.has(at)) return true;
    for (const { to } of client.graph.imports.get(at) ?? []) {
      if (seen.has(to) || !isAppModule(to, projectRoot)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return false;
}

/** Why a route needs a server, or `null`. */
function serverNeed(route: RouteInfo, input: PrerenderInput): string | null {
  if (route.options.includes("server")) {
    return "a server route (server.handlers): it answers requests";
  }
  if (input.client && reachesServerFn(input.client, route.file, input.projectRoot)) {
    return "calls a server function (createServerFn): its RPC answers only from a server";
  }
  return null;
}

/** Why a page needs a server (its route, or a route above it), or `null`. */
function pageNeed(
  input: PrerenderInput,
  path: string,
  cache: Map<RouteInfo, string | null>,
): Refusal | null {
  if (!input.routes) return null;
  for (let r = routeFor(input.routes, path); r; r = r.parent) {
    if (!cache.has(r)) cache.set(r, serverNeed(r, input));
    const reason = cache.get(r);
    if (reason) return { path: r.layout ? path : r.path, file: r.file, reason };
  }
  return null;
}

/** The `<a href>` links of a page Start crawls (root-relative and `./` ones). */
function extractLinks(html: string): string[] {
  const links: string[] = [];
  for (const m of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/g)) {
    if (m[1].startsWith("/") || m[1].startsWith("./")) links.push(m[1]);
  }
  return links;
}

/** A page path inside the router's base: `/x` (a link under the base path loses it). */
function pagePath(path: string, basePath: string): string {
  const url = new URL(path, ORIGIN + (basePath || "") + "/");
  if (url.origin !== ORIGIN) throw new Error(`prerender page path must be relative: ${path}`);
  let pathname = decodeURIComponent(url.pathname);
  if (basePath && (pathname === basePath || pathname.startsWith(basePath + "/"))) {
    pathname = pathname.slice(basePath.length) || "/";
  }
  return pathname + url.search;
}

/** Where a page's HTML is written (Start's file naming), relative to the export's root. */
function outputFile(page: StartPage, opts: PagePrerenderOptions, contentType: string): string {
  const clean = (opts.outputPath || page.path).split(/[?#]/)[0];
  const implicitHtml = !clean.endsWith(".html") && contentType.includes("html");
  const withIndex = clean.endsWith("/") ? clean + "index" : clean;
  const html = clean.endsWith("/") || (opts.autoSubfolderIndex ?? true)
    ? `${clean.replace(/\/$/, "")}/index.html`
    : `${clean}.html`;
  const file = (implicitHtml ? html : withIndex).replace(/^\/+/, "");
  if (file.split("/").some((s) => s === ".." || s === ".")) {
    throw new Error(`Prerender output path must stay within the client output directory: ${file}`);
  }
  return file;
}

/** Fetch a page, following redirects inside the app. */
async function fetchPage(
  input: PrerenderInput,
  path: string,
  headers: Record<string, string>,
  redirects: number,
): Promise<Response> {
  const res = await input.fetch(
    new Request(ORIGIN + input.basePath + path, { headers, redirect: "manual" }),
  );
  const location = res.headers.get("location")?.trim();
  if ([301, 302, 303, 307, 308].includes(res.status) && location && redirects > 0) {
    const url = new URL(location, ORIGIN + input.basePath + path);
    if (url.origin === ORIGIN) {
      return fetchPage(
        input,
        pagePath(url.pathname + url.search, input.basePath),
        headers,
        redirects - 1,
      );
    }
  }
  return res;
}

/** A page failed for good: the export fails unless `failOnError` is `false`. */
function failed(err: unknown, options: PrerenderOptions): void {
  if (options.failOnError ?? true) throw err;
}

/** Start's retry delay: a non-negative whole number of milliseconds, else 500. */
function retryDelay(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 500;
}

/** Fetch one page and write its HTML; the HTML, or a throw when it is not a 2xx. */
async function renderPage(
  input: PrerenderInput,
  page: StartPage,
  opts: PrerenderOptions,
): Promise<string> {
  const res = await fetchPage(input, page.path, opts.headers ?? {}, opts.maxRedirects ?? 5);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Failed to fetch ${page.path}: ${res.status} ${res.statusText}`);
  }
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  // A static file has no streaming: each Suspense boundary's content goes in its place, so the
  // page reads the same with JavaScript off.
  const html = type === "" || type.includes("html") ? inlineStreamedBoundaries(body) : body;
  await input.write(outputFile(page, opts, type), html);
  return html;
}

/**
 * Prerender a Start app's pages: Start's prerender loop over the app's server entry, refusing
 * the routes that need a server.
 *
 * @param input The options, the pages, the route tree, the server entry and the writer.
 */
export async function prerenderPages(input: PrerenderInput): Promise<PrerenderResult> {
  const { options, routes } = input;
  const pages = input.pages.length ? [...input.pages] : [{ path: "/" }];
  if (routes && (options.autoStaticPathsDiscovery ?? true)) {
    const known = new Set(pages.map((p) => p.path));
    for (const path of staticPaths(routes)) if (!known.has(path)) pages.push({ path });
  }
  const seen = new Set<string>();
  const written: string[] = [];
  const refused = new Map<string, Refusal>();
  const needs = new Map<RouteInfo, string | null>();
  const queue: Array<() => Promise<void>> = [];
  const add = (page: StartPage) => {
    const path = pagePath(page.path, input.basePath);
    const key = trimSlash(path);
    if (seen.has(key)) return;
    seen.add(key);
    page = { ...page, path };
    if (!(page.prerender?.enabled ?? true)) return;
    if (options.filter && !options.filter(page)) return;
    const need = pageNeed(input, path, needs);
    if (need) {
      refused.set(need.path, need);
      return;
    }
    queue.push(() => render(page, 0));
  };
  const done = async (page: StartPage, opts: PrerenderOptions, html: string) => {
    written.push(page.path);
    const update = await opts.onSuccess?.({ page, html });
    if (update && typeof update === "object") Object.assign(page, update);
    if (!(opts.crawlLinks ?? true)) return;
    for (const link of extractLinks(html)) add({ path: link, fromCrawl: true });
  };
  const render = async (page: StartPage, attempt: number): Promise<void> => {
    const opts = { ...options, ...page.prerender };
    let html: string;
    try {
      html = await renderPage(input, page, opts);
    } catch (err) {
      if (attempt >= (opts.retryCount ?? 0)) return failed(err, options);
      await new Promise((resolve) => setTimeout(resolve, retryDelay(opts.retryDelay)));
      return render(page, attempt + 1);
    }
    await done(page, opts, html);
  };
  for (const page of pages) add(page);
  // Start's queue: `concurrency` workers, each taking the next page; a page's links add more,
  // so an idle worker waits for the running ones before it stops.
  const workers = Math.max(1, options.concurrency ?? navigator.hardwareConcurrency ?? 1);
  let failure: unknown;
  let running = 0;
  const idle: Array<() => void> = [];
  const worker = async () => {
    while (failure === undefined) {
      const job = queue.shift();
      if (!job) {
        if (running === 0) return;
        await new Promise<void>((resolve) => idle.push(resolve));
        continue;
      }
      running++;
      try {
        await job();
      } catch (err) {
        failure ??= err;
      } finally {
        running--;
        for (const wake of idle.splice(0)) wake();
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  if (failure !== undefined) throw failure;
  for (const r of routes ?? []) refuseUnserved(r, input, written, needs, refused);
  return { written, refused: [...refused.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

/** A route no page covered that needs a server: a server route, or a dynamic page route. */
function refuseUnserved(
  route: RouteInfo,
  input: PrerenderInput,
  written: string[],
  needs: Map<RouteInfo, string | null>,
  refused: Map<string, Refusal>,
): void {
  if (route.layout || refused.has(route.path)) return;
  if (written.some((path) => routeFor(input.routes!, path) === route)) return;
  if (!needs.has(route)) needs.set(route, serverNeed(route, input));
  const need = needs.get(route);
  if (need) {
    refused.set(route.path, { path: route.path, file: route.file, reason: need });
  } else if (route.path.includes("$") && route.options.includes("component")) {
    refused.set(route.path, {
      path: route.path,
      file: route.file,
      reason: "a dynamic route no prerendered page links to: list its paths in `pages`",
    });
  }
}

/**
 * The export's report of the routes it left to a server (the `static` deploy preset's shape), or
 * `null` when it left none.
 *
 * @param refused The refused routes.
 * @param projectRoot Paths are shown relative to it.
 */
export function formatRefusals(refused: Refusal[], projectRoot: string): string | null {
  if (refused.length === 0) return null;
  const rel = (file: string) =>
    file.startsWith(projectRoot) ? file.slice(projectRoot.length + 1).replace(/\\/g, "/") : file;
  const lines = refused.map((r) =>
    `    ${r.path}${r.file ? `  (${rel(r.file)})` : ""} — ${r.reason}`
  );
  return `[@denext/tanstack-start] ${refused.length} route(s) need a server and are not in ` +
    `the export:\n${lines.join("\n")}\n  \`denext start\` (or a server deploy preset) serves ` +
    `them.`;
}

/** The directory a plugin-owned export's pages go to (the export copies it to its root). */
export const PAGES_DIR = "pages-static";

/** Write a page under `<outDir>/pages-static/`. */
export function pageWriter(outDir: string): (file: string, html: string) => Promise<void> {
  return async (file, html) => {
    const dest = join(outDir, PAGES_DIR, ...file.split("/"));
    await Deno.mkdir(join(dest, ".."), { recursive: true });
    await Deno.writeTextFile(dest, html);
  };
}
