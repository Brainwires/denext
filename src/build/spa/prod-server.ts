// SPA mode: serve a built SPA — client assets, `public/`, and the shell for every
// navigation (history-API fallback), with an optional backend reverse proxy.

import { join } from "@std/path";
import { applyDefaultSecurityHeaders } from "../../server/app.ts";
import { compressOrPassThrough } from "../../server/compress.ts";

import {
  displayHost,
  serveImmutableAsset,
  serveWithPortFallback,
} from "../../server/serve-utils.ts";
import { serveStatic } from "../../server/static.ts";
import { createAppLinksHandler } from "../../server/app-links.ts";
import { resolveProject } from "../paths.ts";
import { CLIENT_PREFIX, SHELL_FILE, wantsShell } from "./shared.ts";

export interface SpaProdServerOptions {
  projectDir: string;
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
  onListen?: (info: { hostname: string; port: number }) => void;
  strictPort?: boolean;
}

/** The shell response for a navigation (no body for HEAD). */
function shellResponse(request: Request, shell: string): Response {
  return new Response(request.method === "HEAD" ? null : shell, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

/**
 * Serve a built SPA (`denext build` output): client assets under `/_denext/client/`,
 * `public/` assets, and the HTML shell for every navigation (history-API fallback).
 */
export async function startSpaProdServer(
  options: SpaProdServerOptions,
): Promise<Deno.HttpServer> {
  const paths = await resolveProject(options.projectDir);
  const clientDir = join(paths.outDir, "client");
  const shellPath = join(clientDir, SHELL_FILE);
  let shell: string;
  try {
    shell = await Deno.readTextFile(shellPath);
  } catch {
    throw new Error(`No SPA build at ${shellPath}. Run \`denext build\` first.`);
  }
  const hstsCfg = paths.config?.hsts;
  // Optional backend reverse proxy (spa.proxy). Imported lazily so proxy-less SPAs
  // never pull in the proxy module (and its `npm:ws` dependency) at all.
  const proxyCfg = paths.config?.spa?.proxy;
  const proxy = proxyCfg ? await import("../dev-proxy.ts") : undefined;
  const appLinks = createAppLinksHandler(paths.config?.appLinks);
  // Response compression (config `compress`, default on — the same rules as `createApp`):
  // the shell and uncompressed `public/` files are encoded per request; the precompressed
  // client bundles already carry a Content-Encoding and pass through untouched.
  const compress = paths.config?.compress !== false;

  const serveLocal = async (request: Request, url: URL, secure: boolean): Promise<Response> => {
    if (url.pathname.startsWith(CLIENT_PREFIX)) {
      const rel = "/" + url.pathname.slice(CLIENT_PREFIX.length);
      return serveImmutableAsset(clientDir, rel, request, secure, hstsCfg);
    }
    const accEnc = request.headers.get("accept-encoding") ?? undefined;
    const pub = await serveStatic(paths.publicDir, url.pathname, accEnc, request);
    if (pub) return applyDefaultSecurityHeaders(pub, secure, hstsCfg);
    const res = wantsShell(request, url.pathname)
      ? shellResponse(request, shell)
      : new Response("not found", { status: 404 });
    return applyDefaultSecurityHeaders(res, secure, hstsCfg);
  };

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const secure = url.protocol === "https:";
    const association = appLinks(request);
    if (association) return applyDefaultSecurityHeaders(association, secure, hstsCfg);
    // Proxied prefixes go to the backend before any local serving (an /api or /ws
    // request must reach the backend even if a same-named asset happens to exist). The
    // backend's response is relayed as-is: its encoding is the backend's business.
    if (proxyCfg && proxy && proxy.matchesProxyPrefix(url.pathname, proxyCfg.prefixes)) {
      return await proxy.proxyToBackend(request, url, proxyCfg);
    }
    const res = await serveLocal(request, url, secure);
    return compress ? await compressOrPassThrough(request, res) : res;
  };

  return serveWithPortFallback(
    {
      port: options.port ?? 3000,
      hostname: options.hostname ?? "0.0.0.0",
      signal: options.signal,
      strict: options.strictPort,
      onListen: options.onListen ??
        (({ hostname, port }) =>
          console.log(`denext start ▸ http://${displayHost(hostname)}:${port}`)),
    },
    handler,
  );
}
