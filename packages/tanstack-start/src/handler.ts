// The request side: the client bundle's files under `/_tss/`, and every other request the app
// owns answered by TanStack Start's own handler (the generated server entry) — a page streamed
// through the matched routes, a server function call under `/_serverFn/`, a server route's
// handler. Before Start sees a request denext applies its own rules: a server function called
// with a mutating method must come from the app's origin (the same proof Server Actions need),
// and a request body is read under a size cap.

import { join } from "@std/path";
import {
  bufferedRequest,
  readCappedBody,
  STALLED,
  TOO_LARGE,
  verifyOrigin,
} from "@denext/denext/plugin-kit";
import type { OriginCheckOptions } from "@denext/denext/plugin-kit";

/** The URL prefix the client bundle is served under. */
export const CLIENT_PREFIX = "/_tss/";

/** The client entry's file name in the client directory. */
export const CLIENT_ENTRY = "client.js";

/** Start's server-function URL segment (`TSS_SERVER_FN_BASE` is `<basePath>/_serverFn/`). */
export const SERVER_FN_SEGMENT = "/_serverFn/";

/** What the handler needs. */
export interface HandlerOptions {
  /** Imports the generated server entry. */
  loadServerEntry: () => Promise<{ fetch(request: Request): Promise<Response> }>;
  /** The client bundle's directory, once built (dev builds it on first use). */
  client: () => Promise<string>;
  /** The app's `basePath` (`""` when none). */
  basePath: string;
  /** The same-origin rule a mutating server-function call must pass. */
  origin: OriginCheckOptions;
  /** The request-body cap, in bytes. */
  maxBodyBytes: number;
  /** Whether `path` (app-relative) is a file denext serves itself (`public/`). */
  isStaticFile: (path: string) => Promise<boolean>;
}

/**
 * Start's router manifest for the client entry: a module script on the root route, which the
 * root route's `<Scripts />` renders into the document.
 */
export function routerManifest(src: string): unknown {
  return { routes: { __root__: { scripts: [{ attrs: { type: "module", src, async: true } }] } } };
}

const isRead = (method: string) => method === "GET" || method === "HEAD";

/** The plugin's request handler. */
export function createHandler(
  opts: HandlerOptions,
): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const path = appPath(new URL(request.url).pathname, opts.basePath);
    if (path.startsWith(CLIENT_PREFIX)) {
      return isRead(request.method) ? await clientFile(opts, path) : null;
    }
    if (await isDenextFile(path, opts)) return null;
    const forwarded = await guarded(request, path.startsWith(SERVER_FN_SEGMENT), opts);
    if (forwarded instanceof Response) return forwarded;
    await opts.client();
    const entry = await opts.loadServerEntry();
    return await entry.fetch(forwarded);
  };
}

/** The request path without the app's `basePath`. */
function appPath(pathname: string, basePath: string): string {
  if (!basePath || !pathname.startsWith(basePath)) return pathname;
  return pathname.slice(basePath.length) || "/";
}

/** denext's own files (`/_denext/`), and a file request that `public/` holds. */
async function isDenextFile(path: string, opts: HandlerOptions): Promise<boolean> {
  if (path.startsWith("/_denext/")) return true;
  if (path.startsWith(SERVER_FN_SEGMENT) || !/\.[a-z0-9]+$/i.test(path)) return false;
  return await opts.isStaticFile(path);
}

/**
 * denext's rules for a mutating request: a server function must be called from the app's own
 * origin — a cross-site page can make the browser POST to one with the user's cookies — and the
 * body is read under the cap. The request to forward, or the refusal.
 */
async function guarded(
  request: Request,
  serverFn: boolean,
  opts: HandlerOptions,
): Promise<Request | Response> {
  if (isRead(request.method)) return request;
  if (serverFn && !verifyOrigin(request, opts.origin)) {
    return new Response("Forbidden: cross-origin server function call", { status: 403 });
  }
  return await capBody(request, opts.maxBodyBytes);
}

/** Read the body under the cap (the route-handler cap does not reach a plugin handler). */
async function capBody(request: Request, maxBytes: number): Promise<Request | Response> {
  if (!request.body) return request;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return new Response("Payload Too Large", { status: 413 });
  const body = await readCappedBody(request, maxBytes);
  if (body === TOO_LARGE) return new Response("Payload Too Large", { status: 413 });
  if (body === STALLED) return new Response("Request Timeout", { status: 408 });
  return bufferedRequest(request, body);
}

/** The client bundle's sub-directory for the assets the bundles emit (content-hashed names). */
export const ASSETS_DIR = "assets";

/** The content type of a client file the plugin serves, by extension (null: not served). */
function clientFileType(name: string): string | null {
  if (/^[\w.-]+\.js$/.test(name)) return "text/javascript; charset=utf-8";
  const asset = new RegExp(`^${ASSETS_DIR}/[\\w.-]+\\.(\\w+)$`).exec(name);
  if (!asset || name.includes("..")) return null;
  return ASSET_TYPES[asset[1].toLowerCase()] ?? "application/octet-stream";
}

/** Content types of the assets the bundles emit (Vite's asset imports). */
const ASSET_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  json: "application/json",
};

async function clientFile(opts: HandlerOptions, path: string): Promise<Response> {
  const name = path.slice(CLIENT_PREFIX.length);
  const type = clientFileType(name);
  if (type === null) return new Response("Not Found", { status: 404 });
  const body = await Deno.readFile(join(await opts.client(), ...name.split("/"))).catch(() => null);
  if (body === null) return new Response("Not Found", { status: 404 });
  return new Response(body, {
    headers: {
      "content-type": type,
      // The entry keeps its name across builds; the chunks it imports are content-hashed.
      "cache-control": name === CLIENT_ENTRY ? "no-cache" : "public, max-age=31536000, immutable",
    },
  });
}
