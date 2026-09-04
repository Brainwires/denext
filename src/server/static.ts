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
  const rootAbs = resolve(publicDir);
  const target = resolveWithin(rootAbs, decoded);
  if (target === null) return null;
  const info = await statFile(target);
  if (!info) return null;
  // Defense in depth: the lexical check blocks `../` traversal, but a symlink *inside*
  // publicDir can still point outside it (stat/open follow symlinks). Resolve the real
  // path and re-check it stays within publicDir.
  if (!(await realPathWithin(rootAbs, target))) return null;
  const type = contentType(extname(target)) ?? "application/octet-stream";
  if (acceptEncoding && /(^|,)\s*gzip\b/i.test(acceptEncoding)) {
    const gz = await serveGzipSibling(rootAbs, target, type, info);
    if (gz) return gz;
  }
  const file = await Deno.open(target, { read: true });
  const headers = new Headers({ "content-type": type });
  if (info.size != null) headers.set("content-length", String(info.size));
  if (info.mtime) headers.set("last-modified", info.mtime.toUTCString());
  return new Response(file.readable, { status: 200, headers });
}

/** Resolve `decoded` inside `rootAbs`, or null when the lexical path escapes it. */
function resolveWithin(rootAbs: string, decoded: string): string | null {
  const target = resolve(join(rootAbs, "." + normalize("/" + decoded)));
  if (target !== rootAbs && !target.startsWith(rootAbs + separator())) return null;
  return target;
}

/** `Deno.stat` for an existing regular file, else null. */
async function statFile(path: string): Promise<Deno.FileInfo | null> {
  try {
    const info = await Deno.stat(path);
    return info.isFile ? info : null;
  } catch {
    return null;
  }
}

/** Whether `target`'s REAL path (symlinks followed) stays under `rootAbs`'s real path. */
async function realPathWithin(rootAbs: string, target: string): Promise<boolean> {
  try {
    const realRoot = await Deno.realPath(rootAbs);
    const realTarget = await Deno.realPath(target);
    return realTarget === realRoot || realTarget.startsWith(realRoot + separator());
  } catch {
    return false;
  }
}

/**
 * Serve a precompressed `.gz` sibling emitted at build time (immutable client bundles are
 * gzipped once — see precompress.ts). `Vary: Accept-Encoding` keeps shared caches from
 * serving the gzipped body to a client that didn't ask for it. The sibling gets the same
 * symlink-escape recheck as the identity file. Null (fall through to the identity file)
 * when absent, unreadable or escaping.
 */
async function serveGzipSibling(
  rootAbs: string,
  target: string,
  type: string,
  info: Deno.FileInfo,
): Promise<Response | null> {
  const gzPath = target + ".gz";
  const gzInfo = await statFile(gzPath);
  if (!gzInfo || !(await realPathWithin(rootAbs, gzPath))) return null;
  let gzFile: Deno.FsFile;
  try {
    gzFile = await Deno.open(gzPath, { read: true });
  } catch {
    return null;
  }
  const headers = new Headers({
    "content-type": type,
    "content-encoding": "gzip",
    "vary": "Accept-Encoding",
    "content-length": String(gzInfo.size),
  });
  if (info.mtime) headers.set("last-modified", info.mtime.toUTCString());
  return new Response(gzFile.readable, { status: 200, headers });
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
