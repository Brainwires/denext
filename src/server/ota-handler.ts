// A web-standard request handler that serves an over-the-air UI export to the native
// `DenextOta` plugin: `_denext/ota.json` plus exactly the files it lists, with
// `Cache-Control: no-store`. Auth stays the app's job: wrap the handler with the same check
// the app's API uses. Node servers implement the same three rules in their own route.

import { contentType } from "@std/media-types";
import { extname, join, SEPARATOR } from "@std/path";
import {
  isOtaManifest,
  isOtaManifestPath,
  OTA_MANIFEST_PATH,
  type OtaManifest,
} from "../mobile/ota-manifest.ts";

/** Options for {@linkcode createOtaHandler}. */
export interface OtaHandlerOptions {
  /** The export directory holding `_denext/ota.json` (e.g. `"out"`). */
  dir: string;
  /**
   * The URL path the UI is served under, e.g. `"/mobile-ui"` (the client's `baseUrl` is
   * then `https://host/mobile-ui`). Default `""`: the origin root.
   */
  basePath?: string;
  /**
   * Answer CORS for the web app's manifest request (`checkForUiUpdate` / `prepareUiUpdate`
   * fetch `_denext/ota.json` from the webview's origin, and an `Authorization` header makes that
   * a preflighted request). `true` allows the Capacitor webview origins `capacitor://localhost`
   * (iOS), `https://localhost` and `http://localhost` (Android); a string or list allows exactly
   * those origins. An allowed `OPTIONS` preflight is answered `204` with
   * `Access-Control-Allow-Headers: authorization`, and `GET`/`HEAD` responses carry
   * `Access-Control-Allow-Origin` for an allowed `Origin`. Default: no CORS headers, and
   * `OPTIONS` is not answered. A preflight carries no credentials, so route `OPTIONS` to the
   * handler before your auth check. Native file downloads are not subject to CORS.
   */
  cors?: true | string | readonly string[];
}

/** The webview origins `cors: true` allows. */
const CAPACITOR_ORIGINS: readonly string[] = [
  "capacitor://localhost",
  "https://localhost",
  "http://localhost",
];

/** The parsed manifest, re-read when the file's mtime changes. */
interface Cached {
  mtime: number;
  manifest: OtaManifest;
  paths: Set<string>;
}

/** A path segment list that stays inside the directory (no control characters either). */
function safeSegments(path: string): string[] | null {
  if (!isOtaManifestPath(path) || path.includes("\\")) return null;
  const segments = path.split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== "..") ? segments : null;
}

/** The set of origins `cors` allows (empty: CORS off). */
function allowedOrigins(cors: OtaHandlerOptions["cors"]): ReadonlySet<string> {
  if (cors === true) return new Set(CAPACITOR_ORIGINS);
  if (typeof cors === "string") return new Set([cors]);
  return new Set(cors ?? []);
}

/** The CORS headers for `request`'s `Origin` when it is allowed, else none. */
function corsHeaders(request: Request, origins: ReadonlySet<string>): Record<string, string> {
  const origin = request.headers.get("origin");
  if (origins.size === 0) return {};
  if (origin === null || !origins.has(origin)) return { vary: "Origin" };
  return { "access-control-allow-origin": origin, vary: "Origin" };
}

/** The `204` answer to an allowed preflight. */
function preflight(cors: Record<string, string>): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...cors,
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "authorization",
      "access-control-max-age": "600",
    },
  });
}

/**
 * Build a handler that serves an OTA UI export to `checkForUiUpdate` / the native
 * `DenextOta` plugin, following the serving rules every OTA server must keep:
 *
 * 1. serve `_denext/ota.json` and ONLY the files it lists (anything else resolves `null`,
 *    so a request can never reach a file the manifest does not name);
 * 2. put it behind the same auth as the app's API (wrap the handler; it does no auth);
 * 3. send `Cache-Control: no-store`, so no cache serves a stale manifest or file.
 *
 * Only `GET`/`HEAD` are answered (plus an `OPTIONS` preflight from an origin `cors` allows).
 * The manifest is re-read when its mtime changes, so a re-stamp (`denext ota manifest`, which
 * replaces the file atomically) needs no restart. Re-exporting in place is not atomic (a phone
 * could fetch a new manifest and old files, which then fail their hash check): export into a
 * new directory and point the handler at it, e.g. through a symlink you swap.
 *
 * @param options The export directory, the path it is served under, and CORS.
 * @returns `(request) => Response | null`: `null` for a request that is not for the UI.
 * @example
 * ```ts
 * import { createOtaHandler } from "denext/server";
 *
 * const ota = createOtaHandler({ dir: "out", basePath: "/mobile-ui", cors: true });
 * Deno.serve(async (req) => {
 *   if (new URL(req.url).pathname.startsWith("/mobile-ui/")) {
 *     // A CORS preflight carries no credentials: answer it before the auth check.
 *     if (req.method === "OPTIONS") return (await ota(req)) ?? new Response(null, { status: 404 });
 *     if (!(await isAuthorized(req))) return new Response("Unauthorized", { status: 401 });
 *     return (await ota(req)) ?? new Response("Not Found", { status: 404 });
 *   }
 *   return app(req);
 * });
 * ```
 */
export function createOtaHandler(
  options: OtaHandlerOptions,
): (request: Request) => Promise<Response | null> {
  const base = (options.basePath ?? "").replace(/\/+$/, "");
  const manifestFile = join(options.dir, ...OTA_MANIFEST_PATH.split("/"));
  let cached: Cached | null = null;

  async function load(): Promise<Cached | null> {
    let mtime: number;
    try {
      mtime = (await Deno.stat(manifestFile)).mtime?.getTime() ?? 0;
    } catch {
      return cached = null;
    }
    if (cached && cached.mtime === mtime) return cached;
    try {
      const manifest: unknown = JSON.parse(await Deno.readTextFile(manifestFile));
      if (!isOtaManifest(manifest)) return cached = null;
      return cached = { mtime, manifest, paths: new Set(manifest.files.map((f) => f.path)) };
    } catch {
      return cached = null;
    }
  }

  const origins = allowedOrigins(options.cors);

  const noStore = (type: string, length: number, cors: Record<string, string>) =>
    new Headers({
      ...cors,
      "content-type": type,
      "content-length": String(length),
      "cache-control": "no-store",
    });

  /** The request's path relative to `base`, or null when it is not under it. */
  function relativePath(request: Request): string | null {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith(`${base}/`)) return null;
    try {
      return decodeURIComponent(pathname.slice(base.length + 1));
    } catch {
      return null;
    }
  }

  /** The bytes of the listed file `rel`, or null when it is not listed or leaves the export. */
  async function readListed(current: Cached, rel: string): Promise<Uint8Array | null> {
    const segments = current.paths.has(rel) ? safeSegments(rel) : null;
    if (!segments) return null;
    try {
      // The real path must stay inside the export: a listed file later swapped for a
      // symlink (or a symlinked parent) cannot reach anything outside it.
      const real = await Deno.realPath(join(options.dir, ...segments));
      if (!real.startsWith((await Deno.realPath(options.dir)) + SEPARATOR)) return null;
      return await Deno.readFile(real);
    } catch {
      return null;
    }
  }

  return async (request) => {
    const rel = relativePath(request);
    if (rel === null) return null;
    const cors = corsHeaders(request, origins);
    if (request.method === "OPTIONS") {
      return "access-control-allow-origin" in cors ? preflight(cors) : null;
    }
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    const current = await load();
    if (!current) return null;
    const head = request.method === "HEAD";
    if (rel === OTA_MANIFEST_PATH) {
      const body = new TextEncoder().encode(JSON.stringify(current.manifest));
      const headers = noStore("application/json; charset=utf-8", body.byteLength, cors);
      return new Response(head ? null : body, { headers });
    }
    const bytes = await readListed(current, rel);
    if (!bytes) return null;
    const type = contentType(extname(rel)) ?? "application/octet-stream";
    return new Response(head ? null : bytes as Uint8Array<ArrayBuffer>, {
      headers: noStore(type, bytes.byteLength, cors),
    });
  };
}
