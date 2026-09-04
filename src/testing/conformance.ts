/**
 * Rendered-app conformance probe — render **every route** of a denext app in
 * process (the real SSR path) and assert each produces a well-formed HTML
 * document with no server crash.
 *
 * Where the dependency probes in `examples/next-compat-feasibility` answer "would
 * this app's packages LOAD under Deno?", the conformance probe answers the harder
 * question: "does every route actually RENDER, and is the output a valid App
 * Router document?" It walks the route manifest, expands dynamic routes through
 * `generateStaticParams` (or params you supply), requests each concrete pathname
 * through {@linkcode createTestApp}'s in-process handler, and runs a fixed set of
 * conformance checks against the response.
 *
 * It renders the **JavaScript-disabled** surface (no client bundle is emitted), so
 * a passing probe is also proof the app's progressive-enhancement path is intact.
 * Each route is classified **static** (ships 0 KB JS) or **interactive** via
 * {@linkcode routeNeedsHydration} — informational, not a pass/fail.
 *
 * ```ts
 * import { formatReport, probeApp } from "@denext/denext/testing";
 * const report = await probeApp("./");
 * console.log(formatReport(report));
 * if (!report.ok) Deno.exit(1);
 * ```
 *
 * @module
 */

import { createApp, defaultLoader, PageCache, scanRoutes } from "../server/mod.ts";
import type { ModuleLoader, PageModule } from "../server/types.ts";
import type { PageRoute, RouteManifest } from "../router/manifest.ts";
import { fillPattern, type RouteParams } from "../router/segments.ts";
import { resolveProject } from "../build/paths.ts";
import {
  buildBoundaryManifest,
  computeBoundaryRoutes,
  importFunctionExports,
  routeEntryFiles,
} from "../build/module-graph.ts";
import { routeNeedsHydration } from "../build/hydration.ts";
import { tagServerModules } from "../runtime/server-action.ts";
import { createMiddlewareRunner } from "../server/mod.ts";
import { resolve, toFileUrl } from "@std/path";
// Intentional, benign barrel cycle: `mod.ts` is the public `denext/testing` barrel
// that both DEFINES the test client and re-exports this module's `probeApp`/
// `formatReport`. ESM resolves it safely — nothing here is used at module-init time,
// only inside `probeApp`/`buildHandler` at call time. Splitting the ~350-line client
// out of the barrel to break it re-attributes that moved code as "new" complexity, a
// worse trade than this one documented edge.
// fallow-ignore-next-line circular-dependency -- benign test-only barrel cycle (call-time only)
import { createTestClient, type TestHandler } from "./mod.ts";

/** One conformance check applied to a single rendered route. */
export interface ProbeCheck {
  /** The check's stable name (e.g. `"doctype"`, `"single-document"`). */
  name: string;
  /** Whether the check passed. */
  pass: boolean;
  /** A short explanation shown when the check fails. */
  detail?: string;
}

/** The result of probing one concrete route path. */
export interface RouteProbe {
  /** The route's manifest path, e.g. `"/blog/[slug]"`. */
  routePath: string;
  /** The concrete pathname requested, e.g. `"/blog/hello"`. */
  path: string;
  /** The final HTTP status (redirects are NOT followed). */
  status: number;
  /** Whether a full HTML document was rendered and structurally checked. */
  rendered: boolean;
  /** `true` if the route needs a client bundle; `false` if it ships 0 KB JS. */
  interactive: boolean;
  /** Every applicable check passed (a redirect/404 with no failing check is ok). */
  ok: boolean;
  /** The checks run against this route. */
  checks: ProbeCheck[];
  /** Why the route wasn't fully rendered (redirect, not-found, skipped), if so. */
  note?: string;
}

/** The full report from {@linkcode probeApp}. */
export interface ConformanceReport {
  /** One entry per concrete route path probed. */
  routes: RouteProbe[];
  /** Total routes probed. */
  total: number;
  /** Routes that rendered a document and passed every check. */
  passed: number;
  /** Routes with at least one failing check. */
  failed: number;
  /** Routes that responded but didn't render a full document (redirect/404). */
  skipped: number;
  /** Routes classified as static (0 KB JS). */
  static: number;
  /** `true` when no route failed a check. */
  ok: boolean;
}

/** Options for {@linkcode probeApp}. */
export interface ProbeOptions {
  /** Origin used to resolve request paths. Default `"http://localhost"`. */
  origin?: string;
  /** Keep only routes whose manifest path this returns `true` for. */
  include?: (routePath: string) => boolean;
  /**
   * Params to render for a dynamic route, keyed by its manifest path
   * (e.g. `{ "/blog/[slug]": [{ slug: "hello" }] }`). Supplements
   * `generateStaticParams`; a dynamic route with neither is skipped.
   */
  params?: Record<string, RouteParams[]>;
  /**
   * Extra concrete pathnames to probe beyond the route manifest (e.g. a locale
   * prefix, a known deep link). Each is requested and structurally checked.
   */
  extraPaths?: string[];
  /**
   * Expected status for specific concrete paths (e.g. an auth-gated route that
   * should 307 to `/login`: `{ "/notes": 307 }`). A path with an expectation
   * fails if its status differs; without one, any status < 500 is acceptable.
   */
  expect?: Record<string, number>;
  /** Called as each route finishes — for streaming progress output. */
  onRoute?: (probe: RouteProbe) => void;
  /** A custom module loader (defaults to {@linkcode defaultLoader}). */
  load?: ModuleLoader;
}

/** Build the in-process handler AND return the manifest (probe needs both). */
async function buildHandler(
  projectDir: string,
  load: ModuleLoader,
): Promise<{ handler: TestHandler; manifest: RouteManifest; appDir: string }> {
  const paths = await resolveProject(resolve(projectDir));
  const manifest = await scanRoutes(paths.appDir);
  let getMiddleware: (() => ReturnType<typeof createMiddlewareRunner>) | undefined;
  if (paths.middlewarePath) {
    const mod = await import(toFileUrl(resolve(paths.middlewarePath)).href);
    const runner = createMiddlewareRunner(mod);
    getMiddleware = () => runner;
  }
  const boundary = await buildBoundaryManifest(
    paths.appDir,
    [...new Set(manifest.pages.flatMap(routeEntryFiles))],
    { exportsOf: importFunctionExports },
  );
  await tagServerModules(boundary.server);
  const flightRoutes = await computeBoundaryRoutes(paths.appDir, manifest.pages);
  const handler = createApp({
    getManifest: () => manifest,
    load,
    publicDir: paths.publicDir,
    getMiddleware,
    pageCache: new PageCache(),
    i18n: paths.i18n ?? undefined,
    flight: flightRoutes.size > 0,
    appDir: paths.appDir,
    flightRoutes,
    flightClients: boundary.client,
    flightServers: boundary.server,
  });
  return { handler, manifest, appDir: paths.appDir };
}

/** Concrete pathnames to probe for one route (dynamic → param-expanded). */
async function pathsForRoute(
  route: PageRoute,
  load: ModuleLoader,
  supplied: RouteParams[] | undefined,
): Promise<{ paths: string[]; skipped: boolean }> {
  const isDynamic = route.pattern.some((s) => s.kind !== "static");
  if (!isDynamic) return { paths: [fillPattern(route.pattern, {})], skipped: false };

  let paramSets = supplied;
  if (!paramSets) {
    const mod = (await load(route.filePath)) as PageModule;
    if (typeof mod.generateStaticParams === "function") {
      paramSets = (await mod.generateStaticParams()).map((s) => ({ ...s }));
    }
  }
  if (!paramSets || paramSets.length === 0) return { paths: [], skipped: true };
  return { paths: paramSets.map((p) => fillPattern(route.pattern, p)), skipped: false };
}

/** Count non-overlapping occurrences of a lowercase tag opener in `html`. */
function countTag(html: string, tag: string): number {
  return (html.toLowerCase().match(new RegExp(`<${tag}(\\s|>)`, "g")) ?? []).length;
}

/** Run the structural conformance checks against a rendered HTML document. */
function checkDocument(html: string): ProbeCheck[] {
  const lower = html.trimStart().toLowerCase();
  const checks: ProbeCheck[] = [];

  checks.push({
    name: "doctype",
    pass: lower.startsWith("<!doctype html"),
    detail: "document does not start with <!DOCTYPE html>",
  });

  const htmlCount = countTag(html, "html");
  const headCount = countTag(html, "head");
  const bodyCount = countTag(html, "body");
  checks.push({
    name: "single-document",
    pass: htmlCount === 1 && headCount === 1 && bodyCount === 1,
    detail: `expected one each of <html>/<head>/<body>, got ${htmlCount}/${headCount}/${bodyCount}`,
  });

  const title = html.match(/<title>([\s\S]*?)<\/title>/i);
  checks.push({
    name: "title",
    pass: Boolean(title && title[1].trim()),
    detail: "no non-empty <title> (metadata not rendered)",
  });

  // A well-formed render never leaks the framework's 500 fallback body or a raw
  // stack frame into the HTML.
  const crashy = /Internal Server Error/.test(html) ||
    /\bat\s+[\w.$]+\s+\(\S+:\d+:\d+\)/.test(html);
  checks.push({
    name: "no-crash-marker",
    pass: !crashy,
    detail: "output contains a 500 body or a raw stack trace",
  });

  return checks;
}

/**
 * Probe every route of the denext app at `projectDir`: render each in process
 * and assert it produces a valid HTML document with no server crash.
 *
 * @param projectDir The app directory (contains `app/`, optional `middleware.ts`).
 * @param options Route filters, params for dynamic routes, and status expectations.
 * @returns A {@linkcode ConformanceReport}.
 */
export async function probeApp(
  projectDir: string,
  options: ProbeOptions = {},
): Promise<ConformanceReport> {
  const load = options.load ?? defaultLoader;
  const { handler, manifest } = await buildHandler(projectDir, load);
  const client = createTestClient(handler, {
    origin: options.origin,
    followRedirects: false,
  });

  const routes: RouteProbe[] = [];
  const record = (p: RouteProbe) => {
    routes.push(p);
    options.onRoute?.(p);
  };

  for (const route of manifest.pages) {
    if (options.include && !options.include(route.routePath)) continue;
    // Intercepting routes only match during soft nav; skip them on a hard probe.
    if (route.intercept) continue;

    const interactive = await routeNeedsHydration(route);
    const { paths, skipped } = await pathsForRoute(route, load, options.params?.[route.routePath]);

    if (skipped) {
      record(skippedProbe(route.routePath, interactive));
      continue;
    }

    for (const path of paths) {
      record(await probePath(client, route, path, interactive, options.expect?.[path]));
    }
  }

  for (const path of options.extraPaths ?? []) {
    record(await probePath(client, syntheticRoute(path), path, false, options.expect?.[path]));
  }

  return summarize(routes);
}

/** The probe recorded for a dynamic route with no params to render. */
function skippedProbe(routePath: string, interactive: boolean): RouteProbe {
  return {
    routePath,
    path: routePath,
    status: 0,
    rendered: false,
    interactive,
    ok: true,
    checks: [],
    note: "dynamic route without generateStaticParams or supplied params — skipped",
  };
}

/** Roll the per-route probes up into the report totals. */
function summarize(routes: RouteProbe[]): ConformanceReport {
  const failed = routes.filter((r) => !r.ok).length;
  return {
    routes,
    total: routes.length,
    passed: routes.filter((r) => r.rendered && r.ok).length,
    failed,
    skipped: routes.filter((r) => r.ok && !r.rendered).length,
    static: routes.filter((r) => !r.interactive).length,
    ok: failed === 0,
  };
}

/** A stand-in route for an `extraPaths` entry that has no manifest route. */
function syntheticRoute(path: string): PageRoute {
  return {
    kind: "page",
    pattern: [],
    routePath: path,
    filePath: "",
    layoutChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
  };
}

/** Request one concrete path and run the applicable conformance checks. */
async function probePath(
  client: ReturnType<typeof createTestClient>,
  route: PageRoute,
  path: string,
  interactive: boolean,
  expected: number | undefined,
): Promise<RouteProbe> {
  const res = await client.get(path);
  const checks: ProbeCheck[] = [];

  // The floor for every route: the server must not crash.
  checks.push({
    name: "reachable",
    pass: res.status < 500,
    detail: `server responded ${res.status}`,
  });

  if (expected !== undefined) {
    checks.push({
      name: "status",
      pass: res.status === expected,
      detail: `expected ${expected}, got ${res.status}`,
    });
  }

  const isHtmlDoc = res.status === 200 &&
    (res.headers.get("content-type") ?? "").includes("text/html");
  let rendered = false;
  let note: string | undefined;

  if (isHtmlDoc) {
    rendered = true;
    checks.push(...checkDocument(res.text));
  } else if (res.status >= 300 && res.status < 400) {
    note = `redirect → ${res.location ?? "?"}`;
  } else if (res.status === 404) {
    note = "not found (no matching route or notFound())";
  } else if (res.status !== 200) {
    note = `status ${res.status}`;
  } else {
    note = `non-HTML response (${res.headers.get("content-type") ?? "no content-type"})`;
  }

  return {
    routePath: route.routePath,
    path,
    status: res.status,
    rendered,
    interactive,
    ok: checks.every((c) => c.pass),
    checks,
    note,
  };
}

/** ANSI-free status glyph for a route line. */
function glyph(p: RouteProbe): string {
  if (!p.ok) return "✗";
  if (!p.rendered) return "–";
  return "✓";
}

/** One route's report line, plus one line per failed check. */
function routeLines(p: ConformanceReport["routes"][number], width: number): string[] {
  const tag = p.rendered ? (p.interactive ? "interactive" : "static") : "";
  const status = p.status ? String(p.status) : "—";
  const note = p.note ? `  (${p.note})` : "";
  const line = `  ${glyph(p)} ${p.path.padEnd(width)}  ${status.padStart(3)}  ${tag}${note}`;
  if (p.ok) return [line];
  const failures = p.checks.filter((c) => !c.pass).map((c) =>
    `      ✗ ${c.name}: ${c.detail ?? "failed"}`
  );
  return [line, ...failures];
}

/**
 * Render a {@linkcode ConformanceReport} as a human-readable table with a summary
 * line. Suitable for CLI output or a test failure message.
 *
 * @param report The report from {@linkcode probeApp}.
 * @returns A multi-line string.
 */
export function formatReport(report: ConformanceReport): string {
  const width = Math.max(4, ...report.routes.map((r) => r.path.length));
  const lines = report.routes.flatMap((p) => routeLines(p, width));
  lines.push("");
  lines.push(
    `  ${report.passed} rendered · ${report.skipped} skipped · ${report.failed} failed` +
      `  ·  ${report.static}/${report.total} static (0 KB JS)`,
  );
  lines.push(`  ${report.ok ? "PASS — every route conforms." : "FAIL — see failures above."}`);
  return lines.join("\n");
}
