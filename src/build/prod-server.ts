// Production server: serve SSR pages plus the pre-built client bundles.

import { join } from "@std/path";
import { createApp } from "../server/app.ts";
import { scanRoutes } from "../router/manifest.ts";
import type { PageRoute } from "../router/manifest.ts";
import { defaultLoader } from "../server/mod.ts";
import { serveStatic } from "../server/static.ts";
import { type ProjectPaths, resolveProject, routeId } from "./paths.ts";
import { serveWithPortFallback } from "../server/serve-utils.ts";
import { createMiddlewareRunner, type MiddlewareRunner } from "../server/middleware.ts";

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

  const clientEntryFor = (route: PageRoute): string =>
    `${CLIENT_PREFIX}${routeId(route.routePath)}.js`;

  // Load middleware once at startup.
  let middlewareRunner: MiddlewareRunner = null;
  if (paths.middlewarePath) {
    const mod = await defaultLoader(paths.middlewarePath);
    middlewareRunner = createMiddlewareRunner(mod as never);
  }

  const appHandler = createApp({
    getManifest: () => manifest,
    load: defaultLoader,
    publicDir: paths.publicDir,
    clientEntryFor,
    getMiddleware: () => middlewareRunner,
    i18n: paths.i18n ?? undefined,
  });

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(CLIENT_PREFIX)) {
      const rel = url.pathname.slice(CLIENT_PREFIX.length);
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
