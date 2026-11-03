/**
 * Where a desktop window's UI files come from: the bundled export (inside the signed app, served
 * straight from its folder), or the signed UI overlay of `denext/desktop/updater`, whose every file
 * is read through {@linkcode DesktopUiOverlay.read} — verified against the signed manifest when it
 * is served — and never straight from its folder. Once the overlay is withdrawn (a file changed
 * after launch), everything comes from the bundled export.
 *
 * The overlay's files are served whole from the verified bytes, never streamed from the folder
 * after the check (which would let a file change between the check and the read); a UI export's
 * files are small, and the bundled export keeps the streaming path (ranges, `.gz` siblings).
 *
 * Runtime-only (imported by `runDesktop`); it imports the updater's types only, so an app without
 * the updater does not pull it in.
 *
 * @module
 */

import { contentType } from "@std/media-types";
import { extname, join } from "@std/path";
import { parseRange, serveStatic } from "../server/static.ts";
import { DESKTOP_PRELOAD_FILE, inlineSafeScript, readDesktopPreload } from "../desktop/preload.ts";
import type { DesktopUi, DesktopUiOverlay } from "../desktop/updater.ts";

/** The UI files a desktop window is served from. */
export interface DesktopUiFiles {
  /**
   * The file `pathname` names, as a static asset (content type, `Range`), or `null` when the UI has
   * no such file.
   */
  asset(pathname: string, acceptEncoding: string | undefined, request: Request): Promise<
    Response | null
  >;
  /** The text of the UI file at `pathname` (an exported page, `/x/index.html`), or `null`. */
  text(pathname: string): Promise<string | null>;
  /** The `desktop.preload` bundle, inline-safe, or `undefined` when the UI has none. */
  preload(): Promise<string | undefined>;
}

/**
 * The bundled export in `dir`, served from its folder ({@link serveStatic}: path-traversal and
 * symlink checks, `.gz` siblings, ranges).
 *
 * @param dir The export.
 * @returns Its files.
 */
export function bundledUiFiles(dir: string): DesktopUiFiles {
  return {
    asset: (pathname, acceptEncoding, request) =>
      serveStatic(dir, pathname, acceptEncoding, request),
    async text(pathname) {
      const res = await serveStatic(dir, pathname);
      if (res?.status === 200) return await res.text();
      await res?.body?.cancel();
      return null;
    },
    preload: () => readDesktopPreload(join(dir, DESKTOP_PRELOAD_FILE)),
  };
}

/** The UI-relative path a request `pathname` names, or `null` (undecodable, or a directory). */
function uiPath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const rel = decoded.replace(/^\/+/, "");
  return rel === "" || rel.endsWith("/") ? null : rel;
}

/** A 200 (or, for one satisfiable `Range`, 206 / 416) response over verified `bytes`. */
function bytesResponse(bytes: Uint8Array, rel: string, request: Request): Response {
  const headers = new Headers({
    "content-type": contentType(extname(rel)) ?? "application/octet-stream",
    "accept-ranges": "bytes",
  });
  const head = request.method === "HEAD";
  const rangeHeader = request.headers.get("range");
  const range = rangeHeader === null ? undefined : parseRange(rangeHeader, bytes.length);
  if (range === null) {
    headers.set("content-range", `bytes */${bytes.length}`);
    return new Response(null, { status: 416, headers });
  }
  const body = range ? bytes.subarray(range.start, range.end + 1) : bytes;
  headers.set("content-length", String(body.length));
  if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${bytes.length}`);
  return new Response(head ? null : body as Uint8Array<ArrayBuffer>, {
    status: range ? 206 : 200,
    headers,
  });
}

/**
 * The verified overlay's files, falling back to `bundled` once the overlay is withdrawn.
 *
 * @param overlay The overlay `openDesktopUi` resolved.
 * @param bundled The bundled export's files.
 * @returns Its files.
 */
function overlayUiFiles(
  overlay: DesktopUiOverlay,
  bundled: DesktopUiFiles,
): DesktopUiFiles {
  return {
    async asset(pathname, acceptEncoding, request) {
      const rel = uiPath(pathname);
      if (rel === null) return null;
      const read = await overlay.read(rel);
      if (read.status === "withdrawn") {
        return await bundled.asset(pathname, acceptEncoding, request);
      }
      return read.status === "ok" ? bytesResponse(read.bytes, rel, request) : null;
    },
    async text(pathname) {
      const rel = uiPath(pathname);
      if (rel === null) return null;
      const read = await overlay.read(rel);
      if (read.status === "withdrawn") return await bundled.text(pathname);
      return read.status === "ok" ? new TextDecoder().decode(read.bytes) : null;
    },
    // Only a file the signed manifest lists (an extra one withdraws the overlay at launch).
    async preload() {
      const read = await overlay.read(DESKTOP_PRELOAD_FILE);
      if (read.status === "withdrawn") return await bundled.preload();
      return read.status === "ok"
        ? inlineSafeScript(new TextDecoder().decode(read.bytes))
        : undefined;
    },
  };
}

/**
 * The files of the UI `openDesktopUi` resolved: the overlay's when one is active, else the bundled
 * export's.
 *
 * @param ui The resolved UI.
 * @returns Its files.
 */
export function desktopUiFiles(ui: DesktopUi): DesktopUiFiles {
  const bundled = bundledUiFiles(ui.bundledDir);
  return ui.overlay ? overlayUiFiles(ui.overlay, bundled) : bundled;
}
