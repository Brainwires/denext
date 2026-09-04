// SPA mode: serve a built SPA — client assets, `public/`, and the shell for every
// navigation (history-API fallback), with an optional backend reverse proxy.

import { join } from "@std/path";
import { applyDefaultSecurityHeaders } from "../../server/app.ts";

import {
  displayHost,
  serveImmutableAsset,
  serveWithPortFallback,
} from "../../server/serve-utils.ts";
import { serveStatic } from "../../server/static.ts";
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

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const secure = url.protocol === "https:";
    // Proxied prefixes go to the backend before any local serving (an /api or /ws
    // request must reach the backend even if a same-named asset happens to exist).
    if (proxyCfg && proxy && proxy.matchesProxyPrefix(url.pathname, proxyCfg.prefixes)) {
      return await proxy.proxyToBackend(request, url, proxyCfg);
    }
    if (url.pathname.startsWith(CLIENT_PREFIX)) {
      const rel = "/" + url.pathname.slice(CLIENT_PREFIX.length);
      return serveImmutableAsset(clientDir, rel, request, secure, hstsCfg);
    }
    const accEnc = request.headers.get("accept-encoding") ?? undefined;
    const pub = await serveStatic(paths.publicDir, url.pathname, accEnc);
    if (pub) return applyDefaultSecurityHeaders(pub, secure, hstsCfg);
    const res = wantsShell(request, url.pathname)
      ? shellResponse(request, shell)
      : new Response("not found", { status: 404 });
    return applyDefaultSecurityHeaders(res, secure, hstsCfg);
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
