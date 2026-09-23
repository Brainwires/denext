// A web-standard request handler that serves an over-the-air UI export to the native
// `DenextOta` plugin: `_denext/ota.json` plus exactly the files it lists, with
// `Cache-Control: no-store`. Auth stays the app's job: wrap the handler with the same check
// the app's API uses. Node servers implement the same three rules in their own route.

import { contentType } from "@std/media-types";
import { extname, join, SEPARATOR } from "@std/path";
import { isOtaManifest, OTA_MANIFEST_PATH, type OtaManifest } from "../mobile/ota-manifest.ts";

/** Options for {@linkcode createOtaHandler}. */
export interface OtaHandlerOptions {
  /** The export directory holding `_denext/ota.json` (e.g. `"out"`). */
  dir: string;
  /**
   * The URL path the UI is served under, e.g. `"/mobile-ui"` (the client's `baseUrl` is
   * then `https://host/mobile-ui`). Default `""`: the origin root.
   */
  basePath?: string;
}

/** The parsed manifest, re-read when the file's mtime changes. */
interface Cached {
  mtime: number;
  manifest: OtaManifest;
  paths: Set<string>;
}

/** A path segment list that stays inside the directory. */
function safeSegments(path: string): string[] | null {
  if (path === "" || path.includes("\\") || path.includes("\0")) return null;
  const segments = path.split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== "..") ? segments : null;
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
 * Only `GET`/`HEAD` are answered. The manifest is re-read when its mtime changes, so a
 * re-export (plus `denext ota manifest`) needs no restart.
 *
 * @param options The export directory and the path it is served under.
 * @returns `(request) => Response | null`: `null` for a request that is not for the UI.
 * @example
 * ```ts
 * import { createOtaHandler } from "denext/server";
 *
 * const ota = createOtaHandler({ dir: "out", basePath: "/mobile-ui" });
 * Deno.serve(async (req) => {
 *   if (new URL(req.url).pathname.startsWith("/mobile-ui/")) {
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

  const noStore = (type: string, length: number) =>
    new Headers({
      "content-type": type,
      "content-length": String(length),
      "cache-control": "no-store",
    });

  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith(`${base}/`)) return null;
    let rel: string;
    try {
      rel = decodeURIComponent(pathname.slice(base.length + 1));
    } catch {
      return null;
    }
    const current = await load();
    if (!current) return null;
    const head = request.method === "HEAD";
    if (rel === OTA_MANIFEST_PATH) {
      const body = new TextEncoder().encode(JSON.stringify(current.manifest));
      const headers = noStore("application/json; charset=utf-8", body.byteLength);
      return new Response(head ? null : body, { headers });
    }
    const segments = current.paths.has(rel) ? safeSegments(rel) : null;
    if (!segments) return null;
    let bytes: Uint8Array;
    try {
      // The real path must stay inside the export: a listed file later swapped for a
      // symlink (or a symlinked parent) cannot reach anything outside it.
      const real = await Deno.realPath(join(options.dir, ...segments));
      if (!real.startsWith((await Deno.realPath(options.dir)) + SEPARATOR)) return null;
      bytes = await Deno.readFile(real);
    } catch {
      return null;
    }
    const type = contentType(extname(rel)) ?? "application/octet-stream";
    return new Response(head ? null : bytes as Uint8Array<ArrayBuffer>, {
      headers: noStore(type, bytes.byteLength),
    });
  };
}
