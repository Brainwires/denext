// Production server: serve SSR pages plus the pre-built client bundles.

import { join } from "@std/path";
import { applyDefaultSecurityHeaders, createApp } from "../server/app.ts";
import { scanRoutes } from "../router/manifest.ts";
import type { PageRoute } from "../router/manifest.ts";
import { defaultLoader } from "../server/mod.ts";
import { applyPlugins, getPluginRequestHandler, runPluginTeardown } from "../plugin/mod.ts";
import { serveStatic } from "../server/static.ts";
import {
  buildBoundaryManifest,
  computeBoundaryRoutes,
  importFunctionExports,
  routeEntryFiles,
} from "./module-graph.ts";
import { tagServerModules } from "../runtime/server-action.ts";
import { FLIGHT_BUNDLE_FILE } from "./build.ts";
import { createUseCacheLoader } from "./use-cache-loader.ts";
import { createNextCompatServerLoader, redirectBoundaryToCompat } from "./next-compat-loader.ts";
import { type ProjectPaths, resolveProject, routeId } from "./paths.ts";
import { serveWithPortFallback } from "../server/serve-utils.ts";
import { createMiddlewareRunner, type MiddlewareRunner } from "../server/middleware.ts";
import { cacheStoreHealthy, PageCache } from "../server/cache.ts";
import { loadInstrumentation, runRegister } from "../server/instrumentation.ts";
import { resolveConfigRules } from "../server/config.ts";
import { imageOptionsFromConfig, optimizeImage } from "../server/image-optimizer.ts";
import { IMAGE_ENDPOINT } from "../runtime/image.ts";

const CLIENT_PREFIX = "/_denext/client/";

export interface ProdServerOptions {
  projectDir: string;
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
  onListen?: (info: { hostname: string; port: number }) => void;
  /** Fail instead of falling back if the port is taken (explicit --port). */
  strictPort?: boolean;
}

export async function startProdServer(
  options: ProdServerOptions,
): Promise<Deno.HttpServer> {
  const paths: ProjectPaths = await resolveProject(options.projectDir);
  const clientDir = join(paths.outDir, "client");

  // Fail fast if the build hasn't run.
  try {
    await Deno.stat(clientDir);
  } catch {
    throw new Error(
      `No build output at ${clientDir}. Run \`denext build\` first.`,
    );
  }

  // Set up plugins before scanning so route-synthesizer plugins register in time.
  await applyPlugins({
    projectRoot: paths.projectDir,
    appDir: paths.appDir,
    config: paths.config ?? {},
    mode: "prod",
    load: defaultLoader,
  });

  const manifest = await scanRoutes(paths.appDir);

  // Routes the build determined are static (no client JS): they have no bundle on
  // disk by design, get no hydration <script>, and are skipped by the missing-
  // bundle check below. Absent field (older build) → treat none as static.
  let staticRoutes = new Set<string>();
  // next-compat: the build rewrote route modules to denext's single React. Read
  // the source→server-bundle map to redirect the SSR loader. The Flight boundary
  // is preserved in compat too (Stage 4b): boundary routes render server components
  // server-side and hydrate only their islands via the compat flight bundle.
  let nextCompat = false;
  const compatModuleMap = new Map<string, string>();
  try {
    const bm = JSON.parse(await Deno.readTextFile(join(paths.outDir, "manifest.json")));
    if (Array.isArray(bm.staticRoutes)) staticRoutes = new Set<string>(bm.staticRoutes);
    nextCompat = bm.nextCompat === true;
    if (bm.compatServerModules && typeof bm.compatServerModules === "object") {
      for (const [relSrc, relBundle] of Object.entries(bm.compatServerModules)) {
        compatModuleMap.set(
          join(paths.projectDir, relSrc),
          join(paths.outDir, relBundle as string),
        );
      }
    }
  } catch { /* no/invalid build manifest → treat none as static */ }

  // Flight boundary: which routes reach a client island, and the client modules
  // to tag. Computed once at startup via the import-graph crawl. The boundary
  // manifest is built unconditionally (not only when a client island exists) so
  // its "use server" modules are discovered even for pure progressive-enhancement
  // pages — routes with a `<form action={serverActionFn}>` but no client island,
  // which are never "flight" routes yet still must render a working action URL.
  const flightRoutes = await computeBoundaryRoutes(paths.appDir, manifest.pages);
  const boundary = await buildBoundaryManifest(paths.appDir, [
    ...new Set(manifest.pages.flatMap(routeEntryFiles)),
  ], {
    exportsOf: importFunctionExports,
  });
  // Register every discovered "use server" module up front so its exports
  // serialize as action references and dispatch on ANY route — not just routes
  // that also reach a client island (the flight-only tagging path below).
  await tagServerModules(boundary.server);

  // next-compat: the SSR renderer must tag (and render for first paint) the SAME
  // island/action instances the page's react→denext server bundle references — the
  // ones in the shared runtime chunk, NOT the raw npm-React source. Redirect each
  // boundary ref's URL to its compat server bundle so `tagClientModules` /
  // `tagServerModules` import the rewritten module. Identity holds because the
  // island is a separate build entry → its bundle re-exports the shared-chunk
  // instance the page bundle also imports.
  if (nextCompat && boundary) {
    redirectBoundaryToCompat(boundary, compatModuleMap);
  }

  // Fail fast on a partial/incomplete build: every non-Flight page route must
  // have its client entry on disk. Otherwise the page would SSR but silently
  // never hydrate (the browser 404s the missing entry, and the loader swallows
  // it). Flight routes share the app-wide flight.js, checked once.
  const missing: string[] = [];
  for (const page of manifest.pages) {
    if (flightRoutes.has(page.routePath)) continue;
    if (staticRoutes.has(page.routePath)) continue; // no bundle by design
    const entry = join(clientDir, `${routeId(page.routePath)}.js`);
    try {
      await Deno.stat(entry);
    } catch {
      missing.push(`${page.routePath} -> ${entry}`);
    }
  }
  if (flightRoutes.size > 0) {
    try {
      await Deno.stat(join(clientDir, FLIGHT_BUNDLE_FILE));
    } catch {
      missing.push(`(flight) -> ${join(clientDir, FLIGHT_BUNDLE_FILE)}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Incomplete build: ${missing.length} client entry file(s) missing. Re-run ` +
        `\`denext build\`.\n  ${missing.join("\n  ")}`,
    );
  }

  // Asset URLs carry the assetPrefix (CDN origin) or basePath so the browser
  // requests them at the right place; `assetPrefix` wins when both are set.
  const basePath = paths.config?.basePath?.replace(/\/$/, "") || "";
  const assetPrefix = paths.config?.assetPrefix?.replace(/\/$/, "") || basePath;
  const asset = (path: string): string => `${assetPrefix}${path}`;

  const clientEntryFor = (route: PageRoute): string | undefined =>
    staticRoutes.has(route.routePath) ? undefined : asset(
      flightRoutes.has(route.routePath)
        ? `${CLIENT_PREFIX}${FLIGHT_BUNDLE_FILE}`
        : `${CLIENT_PREFIX}${routeId(route.routePath)}.js`,
    );

  // Routes with an extracted stylesheet on disk (written by `denext build`).
  const cssRoutes = new Set<string>();
  for (const route of manifest.pages) {
    try {
      await Deno.stat(join(clientDir, `${routeId(route.routePath)}.css`));
      cssRoutes.add(route.routePath);
    } catch { /* no stylesheet for this route */ }
  }
  const styleHrefsFor = (route: PageRoute): string[] | undefined =>
    cssRoutes.has(route.routePath)
      ? [asset(`${CLIENT_PREFIX}${routeId(route.routePath)}.css`)]
      : undefined;

  // Cache Components (experimental): wrap the module loader so `"use cache"`
  // directives compile into server-side caching. Clear any transformed copies from
  // a previous run first (copy names key on source URL, not content, so a stale
  // copy could otherwise shadow edited source when restarted without a rebuild).
  let load = defaultLoader;
  // next-compat: redirect route source modules to their react→denext server
  // bundles (innermost, above defaultLoader) so use-cache/native both operate on
  // real files while SSR renders on the single denext React.
  if (nextCompat && compatModuleMap.size > 0) {
    load = createNextCompatServerLoader(load, { moduleMap: compatModuleMap });
  }
  if (paths.config?.experimental?.cacheComponents) {
    const cacheDir = join(paths.outDir, "server-cache");
    await Deno.remove(cacheDir, { recursive: true }).catch(() => {});
    load = createUseCacheLoader(load, { projectDir: paths.projectDir, cacheDir });
  }

  // Load middleware once at startup.
  let middlewareRunner: MiddlewareRunner = null;
  if (paths.middlewarePath) {
    const mod = await load(paths.middlewarePath);
    middlewareRunner = createMiddlewareRunner(mod as never);
  }

  // Instrumentation: run register() once at boot; wire onRequestError.
  const instrumentation = await loadInstrumentation(paths.instrumentationPath);
  await runRegister(instrumentation);

  // Resolve denext.config redirect/rewrite/header rules once at startup.
  const rules = await resolveConfigRules(paths.config);

  const appHandler = createApp({
    getManifest: () => manifest,
    load,
    publicDir: paths.publicDir,
    clientEntryFor,
    styleHrefsFor,
    matchExternal: getPluginRequestHandler(),
    getMiddleware: () => middlewareRunner,
    onRequestError: instrumentation.onRequestError,
    i18n: paths.i18n ?? undefined,
    basePath: paths.config?.basePath,
    trailingSlash: paths.config?.trailingSlash,
    redirects: rules.redirects,
    rewrites: rules.rewrites,
    headerRules: rules.headers,
    pageCache: new PageCache(), // ISR for routes opting in via revalidate/dynamic
    flight: flightRoutes.size > 0,
    appDir: paths.appDir,
    flightRoutes,
    flightClients: boundary?.client,
    flightServers: boundary?.server,
    cacheComponents: paths.config?.experimental?.cacheComponents,
  });

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // L5: framework-served responses (health, image, client assets) bypass
    // createApp's finalize(), so they'd otherwise ship without the default
    // hardening headers (notably X-Content-Type-Options: nosniff). Apply the same
    // set here. HSTS is added only over HTTPS; these endpoints sit in front of any
    // proxy-header trust logic, so we key off the connection scheme alone.
    const secure = url.protocol === "https:";
    // Liveness probe (for load balancers / k8s). Always 200 — the site serves
    // even when the cache backend is down (reads degrade to live renders) — but
    // the body reports cache reachability so operators aren't blind to an outage.
    if (url.pathname === "/_denext/health") {
      const cache = (await cacheStoreHealthy()) ? "ok" : "degraded";
      return applyDefaultSecurityHeaders(
        Response.json({ status: "ok", cache }, { status: 200 }),
        secure,
      );
    }
    // Built-in image optimization endpoint.
    if (url.pathname === IMAGE_ENDPOINT) {
      const res = await optimizeImage(
        request,
        imageOptionsFromConfig(paths.config?.images, paths.publicDir),
      );
      return applyDefaultSecurityHeaders(res, secure);
    }
    // Client assets may be requested under basePath; strip it before matching.
    let assetPath = url.pathname;
    if (basePath && assetPath.startsWith(basePath)) assetPath = assetPath.slice(basePath.length);
    if (assetPath.startsWith(CLIENT_PREFIX)) {
      const rel = assetPath.slice(CLIENT_PREFIX.length);
      const asset = await serveStatic(
        clientDir,
        "/" + rel,
        request.headers.get("accept-encoding") ?? undefined,
      );
      if (asset) {
        asset.headers.set("cache-control", "public, max-age=31536000, immutable");
        return applyDefaultSecurityHeaders(asset, secure);
      }
      return applyDefaultSecurityHeaders(new Response("// not found", { status: 404 }), secure);
    }
    return appHandler(request);
  }

  const server = serveWithPortFallback(
    {
      port: options.port ?? 3000,
      hostname: options.hostname ?? "0.0.0.0",
      signal: options.signal,
      strict: options.strictPort,
      onListen: options.onListen ??
        (({ hostname, port }) => console.log(`denext start ▸ http://${hostname}:${port}`)),
    },
    handler,
  );
  // Run plugin teardowns once the server has drained (signal aborted → closed).
  server.finished.then(() => runPluginTeardown());
  return server;
}
