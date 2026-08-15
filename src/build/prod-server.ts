// Production server: serve SSR pages plus the pre-built client bundles.

import { join } from "@std/path";
import { applyDefaultSecurityHeaders, createApp } from "../server/app.ts";
import { scanRoutes } from "../router/manifest.ts";
import type { PageRoute } from "../router/manifest.ts";
import { defaultLoader } from "../server/mod.ts";
import { serveStatic } from "../server/static.ts";
import {
  buildBoundaryManifest,
  computeBoundaryRoutes,
  importFunctionExports,
  routeEntryFiles,
} from "./module-graph.ts";
import { FLIGHT_BUNDLE_FILE } from "./build.ts";
import { type ProjectPaths, resolveProject, routeId } from "./paths.ts";
import { serveWithPortFallback } from "../server/serve-utils.ts";
import { createMiddlewareRunner, type MiddlewareRunner } from "../server/middleware.ts";
import { cacheStoreHealthy, PageCache } from "../server/cache.ts";
import { loadInstrumentation, runRegister } from "../server/instrumentation.ts";
import { resolveConfigRules } from "../server/config.ts";
import { optimizeImage } from "../server/image-optimizer.ts";
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

  const manifest = await scanRoutes(paths.appDir);

  // Routes the build determined are static (no client JS): they have no bundle on
  // disk by design, get no hydration <script>, and are skipped by the missing-
  // bundle check below. Absent field (older build) → treat none as static.
  let staticRoutes = new Set<string>();
  try {
    const bm = JSON.parse(await Deno.readTextFile(join(paths.outDir, "manifest.json")));
    if (Array.isArray(bm.staticRoutes)) staticRoutes = new Set<string>(bm.staticRoutes);
  } catch { /* no/invalid build manifest → treat none as static */ }

  // Flight boundary: which routes reach a client island, and the client modules
  // to tag. Computed once at startup via the import-graph crawl.
  const flightRoutes = await computeBoundaryRoutes(paths.appDir, manifest.pages);
  const boundary = flightRoutes.size > 0
    ? await buildBoundaryManifest(paths.appDir, [
      ...new Set(manifest.pages.flatMap(routeEntryFiles)),
    ], {
      exportsOf: importFunctionExports,
    })
    : null;

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

  // Load middleware once at startup.
  let middlewareRunner: MiddlewareRunner = null;
  if (paths.middlewarePath) {
    const mod = await defaultLoader(paths.middlewarePath);
    middlewareRunner = createMiddlewareRunner(mod as never);
  }

  // Instrumentation: run register() once at boot; wire onRequestError.
  const instrumentation = await loadInstrumentation(paths.instrumentationPath);
  await runRegister(instrumentation);

  // Resolve denext.config redirect/rewrite/header rules once at startup.
  const rules = await resolveConfigRules(paths.config);

  const appHandler = createApp({
    getManifest: () => manifest,
    load: defaultLoader,
    publicDir: paths.publicDir,
    clientEntryFor,
    styleHrefsFor,
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
      const res = await optimizeImage(request, {
        publicDir: paths.publicDir,
        allowedHosts: paths.config?.images?.domains,
        remotePatterns: paths.config?.images?.remotePatterns,
        deviceSizes: paths.config?.images?.deviceSizes,
        imageSizes: paths.config?.images?.imageSizes,
      });
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

  return serveWithPortFallback(
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
}
