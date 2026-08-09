// Serve files from a public directory, with path-traversal protection.

import { contentType } from "@std/media-types";
import { extname, join, normalize, resolve } from "@std/path";

export interface StaticResult {
  response: Response;
}

/**
 * Try to serve `pathname` from `publicDir`. Returns a Response, or null if no
 * matching file exists (so the caller can fall through to routing).
 */
export async function serveStatic(
  publicDir: string,
  pathname: string,
): Promise<Response | null> {
  const decoded = safeDecode(pathname);
  if (decoded === null) return null;

  // Resolve within publicDir and reject anything that escapes it.
  const rootAbs = resolve(publicDir);
  const target = resolve(join(rootAbs, "." + normalize("/" + decoded)));
  if (target !== rootAbs && !target.startsWith(rootAbs + separator())) {
    return null;
  }

  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(target);
  } catch {
    return null;
  }
  if (!info.isFile) return null;

  // Defense in depth: the lexical check above blocks `../` traversal, but a
  // symlink *inside* publicDir can still point outside it (stat/open follow
  // symlinks). Resolve the real path and re-check it stays within publicDir.
  try {
    const realRoot = await Deno.realPath(rootAbs);
    const realTarget = await Deno.realPath(target);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + separator())) {
      return null;
    }
  } catch {
    return null;
  }

  const file = await Deno.open(target, { read: true });
  const type = contentType(extname(target)) ?? "application/octet-stream";
  const headers = new Headers({ "content-type": type });
  if (info.size != null) headers.set("content-length", String(info.size));
  if (info.mtime) headers.set("last-modified", info.mtime.toUTCString());

  return new Response(file.readable, { status: 200, headers });
}

function separator(): string {
  return Deno.build.os === "windows" ? "\\" : "/";
}

function safeDecode(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}
