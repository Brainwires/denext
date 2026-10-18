/**
 * Rendered-app conformance probe — render **every route** of a denext app in
 * process (the real SSR path) and assert each produces a well-formed HTML
 * document with no server crash — including an error an `error.tsx` boundary caught
 * and rendered at 200, which the probe reads through its own `onRequestError` hook
 * (nothing about it is added to the response).
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
import type { ModuleLoader } from "../server/types.ts";
import type { AppConfig } from "../server/app-config.ts";
import type { PageRoute, RouteManifest } from "../router/manifest.ts";
import { fillPattern, type RouteParams } from "../router/segments.ts";
import { enumerateStaticParams } from "../server/static-params.ts";
import { type ProjectPaths, resolveProject } from "../build/paths.ts";
import { withBuildDirLock } from "../build/project-locks.ts";
import { type AppPlugins, setupAppPlugins } from "../plugin/mod.ts";
import {
  buildBoundaryManifest,
  computeBoundaryRoutes,
  importFunctionExports,
  routeEntryFiles,
} from "../build/module-graph.ts";
import { routeNeedsHydration } from "../build/hydration.ts";
import { tagServerModules } from "../runtime/server-action.ts";
import { createMiddlewareRunner } from "../server/mod.ts";
import { relative, resolve, toFileUrl } from "@std/path";
import { createTestClient, type TestHandler } from "./client.ts";
import { errorDigest } from "../runtime/error-boundary.ts";
import type { RequestErrorContext } from "../server/instrumentation.ts";
import { SWAP_RUNTIME_BODY } from "../server/swap-runtime.ts";

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

/**
 * The errors the server reported while rendering, by requested path (`pathname + search`):
 * the probe's own `onRequestError` hook, so an `error.tsx` that rendered a caught error at 200
 * is seen without anything about it reaching the response.
 */
type RenderErrors = Map<string, unknown[]>;

/** The probe's `onRequestError`: records each render error under the path that raised it. */
function recordRenderErrors(errors: RenderErrors) {
  return (error: unknown, request: { path: string }, context: RequestErrorContext): void => {
    if (context.routeType !== "render") return;
    const list = errors.get(request.path) ?? [];
    list.push(error);
    errors.set(request.path, list);
  };
}

/** What {@linkcode buildTestHandler} builds. */
export interface BuiltTestHandler {
  /** The in-process request handler. */
  handler: TestHandler;
  /** The scanned route manifest (plugin synthesizers applied). */
  manifest: RouteManifest;
  /** The App Router directory. */
  appDir: string;
  /** Run the app's plugin teardowns (a no-op when it has no plugins). */
  close(): Promise<void>;
}

/**
 * Build the in-process handler `createTestApp` returns AND the manifest (the probe needs
 * both): the production request pipeline with the "use client"/"use server" boundary
 * discovered by crawling the import graph, no build and no client bundle.
 *
 * The config's `plugins` are set up the way `denext dev` sets them up (mode `"dev"`, so a
 * plugin needs no build output): their prepare steps run once, their route synthesizers shape
 * the manifest, their request handlers claim what the App Router does not match, and `close()`
 * runs their teardowns. The registrations are this handler's own — two apps built in one
 * process never share a plugin.
 *
 * @param projectDir The app directory.
 * @param load The module loader.
 * @param onRequestError The app's `onRequestError` (the probe records render errors with it).
 * @returns The handler, the route manifest, the app directory and the plugin teardown.
 */
export async function buildTestHandler(
  projectDir: string,
  load: ModuleLoader,
  onRequestError?: AppConfig["onRequestError"],
): Promise<BuiltTestHandler> {
  const paths = await resolveProject(resolve(projectDir));
  const plugins = await testAppPlugins(paths, load);
  try {
    const manifest = await scanRoutes(paths.appDir, { synthesizers: plugins?.synthesizers });
    const handler = await testAppHandler(paths, manifest, load, {
      onRequestError,
      matchExternal: plugins?.requestHandler,
    });
    const close = () => plugins?.teardown() ?? Promise.resolve();
    return { handler, manifest, appDir: paths.appDir, close };
  } catch (error) {
    await plugins?.teardown();
    throw error;
  }
}

/** The project's plugins set up for one test app, their prepare steps run; `null` without any. */
async function testAppPlugins(paths: ProjectPaths, load: ModuleLoader): Promise<AppPlugins | null> {
  const config = paths.config ?? {};
  if (!config.plugins?.length) return null;
  const base = { projectRoot: paths.projectDir, appDir: paths.appDir, config };
  const plugins = await setupAppPlugins({ ...base, mode: "dev", load });
  try {
    // The codegen the app imports (e.g. content-collections), as `denext dev` runs it at startup.
    await withBuildDirLock(
      paths.projectDir,
      () => plugins.runPrepareSteps({ ...base, outDir: paths.outDir }),
    );
  } catch (error) {
    await plugins.teardown();
    throw error;
  }
  return plugins;
}

/** `createApp` over `manifest`, with middleware and the boundary discovered from the graph. */
async function testAppHandler(
  paths: ProjectPaths,
  manifest: RouteManifest,
  load: ModuleLoader,
  hooks: Pick<AppConfig, "onRequestError" | "matchExternal">,
): Promise<TestHandler> {
  let getMiddleware: (() => ReturnType<typeof createMiddlewareRunner>) | undefined;
  if (paths.middlewarePath) {
    const mod = await import(toFileUrl(resolve(paths.middlewarePath)).href);
    const runner = createMiddlewareRunner(mod, relative(paths.projectDir, paths.middlewarePath));
    getMiddleware = () => runner;
  }
  const boundary = await buildBoundaryManifest(
    paths.appDir,
    [...new Set(manifest.pages.flatMap(routeEntryFiles))],
    { exportsOf: importFunctionExports },
  );
  await tagServerModules(boundary.server);
  const flightRoutes = await computeBoundaryRoutes(paths.appDir, manifest.pages);
  return createApp({
    getManifest: () => manifest,
    load,
    publicDir: paths.publicDir,
    getMiddleware,
    pageCache: new PageCache(),
    i18n: paths.i18n ?? undefined,
    appLinks: paths.config?.appLinks,
    flight: flightRoutes.size > 0,
    appDir: paths.appDir,
    flightRoutes,
    flightClients: boundary.client,
    flightServers: boundary.server,
    ...hooks,
  });
}

/** Concrete pathnames to probe for one route (dynamic → param-expanded). */
async function pathsForRoute(
  route: PageRoute,
  load: ModuleLoader,
  supplied: RouteParams[] | undefined,
): Promise<{ paths: string[]; skipped: boolean }> {
  const isDynamic = route.pattern.some((s) => s.kind !== "static");
  if (!isDynamic) return { paths: [fillPattern(route.pattern, {})], skipped: false };

  const paramSets = supplied ?? await enumerateStaticParams(route, load) ?? undefined;
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
  // stack frame into the HTML. The fallback is the bare text "Internal Server Error"
  // (the WHOLE response) — the phrase inside a rendered document is prose (a changelog,
  // a docs page about error handling), not a crash.
  const crashy = /^\s*Internal Server Error\s*$/.test(html) ||
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
  const renderErrors: RenderErrors = new Map();
  const { handler, manifest, close } = await buildTestHandler(
    projectDir,
    load,
    recordRenderErrors(renderErrors),
  );
  try {
    return await probeRoutes(handler, manifest, load, renderErrors, options);
  } finally {
    await close();
  }
}

/** Probe every manifest route (and `options.extraPaths`) through `handler`. */
async function probeRoutes(
  handler: TestHandler,
  manifest: RouteManifest,
  load: ModuleLoader,
  renderErrors: RenderErrors,
  options: ProbeOptions,
): Promise<ConformanceReport> {
  const client = createTestClient(handler, {
    origin: options.origin,
    followRedirects: false,
  });
  const probe: RouteProber = (route, path, interactive) =>
    probePath(client, renderErrors, route, path, interactive, options.expect?.[path]);

  const routes: RouteProbe[] = [];
  const record = (p: RouteProbe) => {
    routes.push(p);
    options.onRoute?.(p);
  };

  for (const route of manifest.pages) {
    if (options.include && !options.include(route.routePath)) continue;
    // Intercepting routes only match during soft nav; skip them on a hard probe.
    if (route.intercept) continue;
    await probeRoute(route, load, options, probe, record);
  }

  for (const path of options.extraPaths ?? []) {
    record(await probe(syntheticRoute(path), path, false));
  }

  return summarize(routes);
}

/** Probes one concrete path of a route. */
type RouteProber = (route: PageRoute, path: string, interactive: boolean) => Promise<RouteProbe>;

/** Record one manifest route's probes as each finishes: each concrete path, or one skipped entry. */
async function probeRoute(
  route: PageRoute,
  load: ModuleLoader,
  options: ProbeOptions,
  probe: RouteProber,
  record: (probe: RouteProbe) => void,
): Promise<void> {
  const interactive = await routeNeedsHydration(route);
  const { paths, skipped } = await pathsForRoute(route, load, options.params?.[route.routePath]);
  if (skipped) return record(skippedProbe(route.routePath, interactive));
  for (const path of paths) record(await probe(route, path, interactive));
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

/** One caught error as a check detail: its message and the digest the server logged it under. */
function describeCaught(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${JSON.stringify(message.length > 200 ? `${message.slice(0, 200)}…` : message)} ` +
    `[digest ${errorDigest(error)}]`;
}

/**
 * The check that a rendered page carries no caught render error: an `error.tsx` boundary
 * that caught one renders its fallback at 200, which the structural checks accept.
 */
function boundaryCheck(errors: readonly unknown[]): ProbeCheck {
  return {
    name: "no-caught-error",
    pass: errors.length === 0,
    detail: `an error boundary rendered a caught error: ${errors.map(describeCaught).join("; ")}`,
  };
}

/**
 * The Suspense holes a document left on their fallback: every `data-dnx-b` placeholder of a
 * streamed document (one carrying the swap runtime) that no `<template data-dnx-r>` fills,
 * and every placeholder marked `data-dnx-failed` (a boundary that failed before the shell
 * flushed, in any document). A hole whose render threw with nothing inside it to catch
 * streams no template, so its fallback is what the user keeps seeing — in a 200 page.
 */
export function stuckHoles(html: string): string[] {
  if (!html.includes(SWAP_RUNTIME_BODY)) {
    const failed = html.matchAll(/<div data-dnx-b="([^"]+)" data-dnx-failed/g);
    return [...new Set([...failed].map((m) => m[1]))];
  }
  const filled = new Set([...html.matchAll(/<template data-dnx-r="([^"]+)"/g)].map((m) => m[1]));
  const placeholders = [...html.matchAll(/<div data-dnx-b="([^"]+)"/g)].map((m) => m[1]);
  return [...new Set(placeholders)].filter((id) => !filled.has(id));
}

/**
 * The render-error check for a rendered page. A streamed hole stuck on its fallback fails
 * `no-stuck-hole` (with the errors the server reported, usually the hole's own throw);
 * otherwise any reported error is one an `error.tsx` boundary caught (`no-caught-error`).
 */
function renderErrorCheck(html: string, errors: readonly unknown[]): ProbeCheck {
  const stuck = stuckHoles(html);
  if (stuck.length === 0) return boundaryCheck(errors);
  const cause = errors.length > 0
    ? `: ${errors.map(describeCaught).join("; ")}`
    : " (no error was reported: the stream was aborted or timed out)";
  return {
    name: "no-stuck-hole",
    pass: false,
    detail: `streamed Suspense hole${stuck.length > 1 ? "s" : ""} ${stuck.join(", ")} ` +
      `kept the fallback${cause}`,
  };
}

/** Request one concrete path and run the applicable conformance checks. */
async function probePath(
  client: ReturnType<typeof createTestClient>,
  renderErrors: RenderErrors,
  route: PageRoute,
  path: string,
  interactive: boolean,
  expected: number | undefined,
): Promise<RouteProbe> {
  renderErrors.delete(path);
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
  if (isHtmlDoc) {
    checks.push(
      ...checkDocument(res.text),
      renderErrorCheck(res.text, renderErrors.get(path) ?? []),
    );
  }

  return {
    routePath: route.routePath,
    path,
    status: res.status,
    rendered: isHtmlDoc,
    interactive,
    ok: checks.every((c) => c.pass),
    checks,
    note: isHtmlDoc ? undefined : unrenderedNote(res),
  };
}

/** Why a response is not a rendered document (a redirect, a 404, another status or type). */
function unrenderedNote(
  res: { status: number; location?: string | null; headers: Headers },
): string {
  if (res.status >= 300 && res.status < 400) return `redirect → ${res.location ?? "?"}`;
  if (res.status === 404) return "not found (no matching route or notFound())";
  if (res.status !== 200) return `status ${res.status}`;
  return `non-HTML response (${res.headers.get("content-type") ?? "no content-type"})`;
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
