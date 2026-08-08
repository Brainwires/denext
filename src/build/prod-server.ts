// Production server: serve SSR pages plus the pre-built client bundles.

import { join } from "@std/path";
import { createApp } from "../server/app.ts";
import { scanRoutes } from "../router/manifest.ts";
import type { PageRoute } from "../router/manifest.ts";
import { defaultLoader } from "../server/mod.ts";
import { serveStatic } from "../server/static.ts";
import {
  buildBoundaryManifest,
  computeBoundaryRoutes,
  importFunctionExports,
} from "./module-graph.ts";
import { FLIGHT_BUNDLE_FILE } from "./build.ts";
import { type ProjectPaths, resolveProject, routeId } from "./paths.ts";
import { serveWithPortFallback } from "../server/serve-utils.ts";
import { createMiddlewareRunner, type MiddlewareRunner } from "../server/middleware.ts";
import { PageCache } from "../server/cache.ts";
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

  // Flight boundary: which routes reach a client island, and the client modules
  // to tag. Computed once at startup via the import-graph crawl.
  const flightRoutes = await computeBoundaryRoutes(paths.appDir, manifest.pages);
  const boundary = flightRoutes.size > 0
    ? await buildBoundaryManifest(paths.appDir, manifest.pages.map((p) => p.filePath), {
      exportsOf: importFunctionExports,
    })
    : null;

  // Asset URLs carry the assetPrefix (CDN origin) or basePath so the browser
  // requests them at the right place; `assetPrefix` wins when both are set.
  const basePath = paths.config?.basePath?.replace(/\/$/, "") || "";
  const assetPrefix = paths.config?.assetPrefix?.replace(/\/$/, "") || basePath;
  const asset = (path: string): string => `${assetPrefix}${path}`;

  const clientEntryFor = (route: PageRoute): string =>
    asset(
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
    // Built-in image optimization endpoint.
    if (url.pathname === IMAGE_ENDPOINT) {
      return optimizeImage(request, { publicDir: paths.publicDir });
    }
    // Client assets may be requested under basePath; strip it before matching.
    let assetPath = url.pathname;
    if (basePath && assetPath.startsWith(basePath)) assetPath = assetPath.slice(basePath.length);
    if (assetPath.startsWith(CLIENT_PREFIX)) {
      const rel = assetPath.slice(CLIENT_PREFIX.length);
      const asset = await serveStatic(clientDir, "/" + rel);
      if (asset) {
        asset.headers.set("cache-control", "public, max-age=31536000, immutable");
        return asset;
      }
      return new Response("// not found", { status: 404 });
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
