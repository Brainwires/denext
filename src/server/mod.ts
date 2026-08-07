// Server public surface: create/serve a denext app.

import { toFileUrl } from "@std/path";
import { type AppConfig, createApp, type RequestHandler } from "./app.ts";
import type { ModuleLoader } from "./types.ts";
import { serveWithPortFallback } from "./serve-utils.ts";

export { createApp } from "./app.ts";
export type { AppConfig, RequestHandler } from "./app.ts";
export { renderPage } from "./render-page.ts";
export { renderDocument, ROOT_ID } from "./document.ts";
export type { HydrationData } from "./document.ts";
export { serveStatic } from "./static.ts";
export { serveWithPortFallback } from "./serve-utils.ts";
export { handleApi } from "./api.ts";
export type * from "./types.ts";

export {
  createMiddlewareRunner,
  matcherToRegExp,
  matches,
  next,
  redirect,
  rewrite,
  withHeaders,
} from "./middleware.ts";
export type {
  Middleware,
  MiddlewareConfig,
  MiddlewareContext,
  MiddlewareModule,
  MiddlewareOutcome,
  MiddlewareResult,
  MiddlewareRunner,
} from "./middleware.ts";

/** Default module loader: dynamic import by absolute file path. */
export const defaultLoader: ModuleLoader = (filePath) => {
  const url = filePath.startsWith("file:") ? filePath : toFileUrl(filePath).href;
  return import(url);
};

export interface ServeOptions extends Partial<AppConfig> {
  getManifest: AppConfig["getManifest"];
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
  onListen?: (info: { hostname: string; port: number }) => void;
}

/** Create an app and serve it over HTTP via Deno.serve. */
export function serve(options: ServeOptions): Deno.HttpServer {
  const handler: RequestHandler = createApp({
    getManifest: options.getManifest,
    load: options.load ?? defaultLoader,
    publicDir: options.publicDir,
    clientEntryFor: options.clientEntryFor,
    getMiddleware: options.getMiddleware,
    devScript: options.devScript,
    onError: options.onError,
  });

  return serveWithPortFallback(
    {
      port: options.port ?? 3000,
      hostname: options.hostname ?? "0.0.0.0",
      signal: options.signal,
      onListen: options.onListen ??
        (({ hostname, port }) => console.log(`denext listening on http://${hostname}:${port}`)),
    },
    handler,
  );
}
