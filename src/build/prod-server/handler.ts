// Production server, stage 4: the framework-served endpoints in front of the app handler.

import { join } from "@std/path";
import { IMAGE_ENDPOINT } from "../../runtime/image.ts";
import { LIVE_ENDPOINT } from "../../runtime/live-protocol.ts";
import { applyDefaultSecurityHeaders } from "../../server/app.ts";
import { cacheStoreHealthy } from "../../server/cache.ts";
import { imageOptionsFromConfig, optimizeImage } from "../../server/image-optimizer.ts";
import { handleLiveUpgrade } from "../../server/live.ts";
import { serveImmutableAsset } from "../../server/serve-utils.ts";
import type { ProjectPaths } from "../paths.ts";
import { FONTS_PUBLIC_PREFIX } from "../self-host-fonts.ts";
import { CLIENT_PREFIX } from "./assets.ts";

/**
 * Liveness probe (for load balancers / k8s). Always 200 — the site serves even when the
 * cache backend is down (reads degrade to live renders) — but the body reports cache
 * reachability so operators aren't blind to an outage.
 */
async function healthResponse(paths: ProjectPaths, secure: boolean): Promise<Response> {
  const cache = (await cacheStoreHealthy()) ? "ok" : "degraded";
  return applyDefaultSecurityHeaders(
    Response.json({ status: "ok", cache }, { status: 200 }),
    secure,
    paths.config?.hsts,
  );
}

/**
 * L5: framework-served responses (health, self-hosted fonts, image optimizer, client
 * assets) bypass createApp's finalize(), so they'd otherwise ship without the default
 * hardening headers (notably X-Content-Type-Options: nosniff). Each branch applies the
 * same set here (directly, or via serveImmutableAsset). HSTS is added only over HTTPS;
 * these endpoints sit in front of any proxy-header trust logic, so we key off the
 * connection scheme alone. Returns null when the request is not a framework endpoint,
 * so the caller falls through to the app handler.
 */
async function serveFrameworkEndpoint(
  paths: ProjectPaths,
  clientDir: string,
  basePath: string,
  request: Request,
  url: URL,
  secure: boolean,
): Promise<Response | null> {
  const hstsCfg = paths.config?.hsts;
  if (url.pathname === "/_denext/health") return await healthResponse(paths, secure);
  // Self-hosted Google fonts (build-emitted under client/_fonts), immutable.
  if (url.pathname.startsWith(FONTS_PUBLIC_PREFIX + "/")) {
    const rel = url.pathname.slice(FONTS_PUBLIC_PREFIX.length);
    return serveImmutableAsset(join(clientDir, "_fonts"), rel, request, secure, hstsCfg);
  }
  // Built-in image optimization endpoint.
  if (url.pathname === IMAGE_ENDPOINT) {
    const res = await optimizeImage(
      request,
      imageOptionsFromConfig(paths.config?.images, paths.publicDir),
    );
    return applyDefaultSecurityHeaders(res, secure, hstsCfg);
  }
  // Client assets may be requested under basePath; strip it before matching.
  let assetPath = url.pathname;
  if (basePath && assetPath.startsWith(basePath)) assetPath = assetPath.slice(basePath.length);
  if (assetPath.startsWith(CLIENT_PREFIX)) {
    const rel = assetPath.slice(CLIENT_PREFIX.length);
    return serveImmutableAsset(clientDir, "/" + rel, request, secure, hstsCfg, "// not found");
  }
  return null;
}

/**
 * The prod request handler: the Live WebSocket upgrade (long-lived; handled outside
 * createApp to dodge the per-request timeout + concurrency ceiling), then the framework
 * endpoints, then the app.
 */
export function createProdHandler(
  paths: ProjectPaths,
  clientDir: string,
  basePath: string,
  hasFlight: boolean,
  appHandler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === LIVE_ENDPOINT && hasFlight) return handleLiveUpgrade(request);
    const secure = url.protocol === "https:";
    return (await serveFrameworkEndpoint(paths, clientDir, basePath, request, url, secure)) ??
      appHandler(request);
  };
}
