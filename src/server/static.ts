// Serve files from a public directory, with path-traversal protection.

import { contentType } from "@std/media-types";
import { extname, join, normalize, resolve } from "@std/path";

/**
 * Try to serve `pathname` from `publicDir`. Returns a Response, or null if no
 * matching file exists (so the caller can fall through to routing).
 *
 * When `acceptEncoding` includes `gzip` and a build-time `<file>.gz` sibling
 * exists, the precompressed variant is served with `Content-Encoding: gzip`
 * (immutable client bundles are gzipped once at build — see precompress.ts).
 */
export async function serveStatic(
  publicDir: string,
  pathname: string,
  acceptEncoding?: string,
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

  const type = contentType(extname(target)) ?? "application/octet-stream";

  // Serve a precompressed `.gz` sibling when the client accepts gzip and one was
  // emitted at build time. `Vary: Accept-Encoding` keeps shared caches from serving the
  // gzipped body to a client that didn't ask for it.
  if (acceptEncoding && /(^|,)\s*gzip\b/i.test(acceptEncoding)) {
    const gzPath = target + ".gz";
    try {
      const gzInfo = await Deno.stat(gzPath);
      if (gzInfo.isFile) {
        // Same symlink-escape recheck as the identity file: a `<file>.gz` symlink could
        // point outside the served root even though its lexical path sits inside it. On
        // any escape/error we throw and fall through to the validated identity file.
        const realRootGz = await Deno.realPath(rootAbs);
        const realGz = await Deno.realPath(gzPath);
        if (realGz !== realRootGz && !realGz.startsWith(realRootGz + separator())) {
          throw new Error("gz sibling escapes publicDir");
        }
        const gzFile = await Deno.open(gzPath, { read: true });
        const headers = new Headers({
          "content-type": type,
          "content-encoding": "gzip",
          "vary": "Accept-Encoding",
          "content-length": String(gzInfo.size),
        });
        if (info.mtime) headers.set("last-modified", info.mtime.toUTCString());
        return new Response(gzFile.readable, { status: 200, headers });
      }
    } catch {
      // No `.gz` sibling (or unreadable) — fall through to the identity file.
    }
  }

  const file = await Deno.open(target, { read: true });
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
