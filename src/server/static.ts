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
  request?: Request,
): Promise<Response | null> {
  const decoded = safeDecode(pathname);
  if (decoded === null) return null;
  const rootAbs = resolve(publicDir);
  const target = resolveWithin(rootAbs, decoded);
  if (target === null) return null;
  // Defense in depth: the lexical check blocks `../` traversal, but a symlink *inside*
  // publicDir can still point outside it (stat/open follow symlinks). Resolve the real
  // path and re-check it stays within publicDir.
  if (!(await realPathWithin(rootAbs, target))) return null;
  const file = await openFile(target);
  if (!file) return null;
  // stat the OPEN handle so the declared length always matches the bytes streamed.
  const info = await file.stat();
  if (!info.isFile) {
    file.close();
    return null;
  }
  const type = contentType(extname(target)) ?? "application/octet-stream";
  const validators = validatorHeaders(info);
  if (request && notModified(request.headers, info, validators.get("etag")!)) {
    file.close();
    return new Response(null, { status: 304, headers: validators });
  }
  if (acceptEncoding && /(^|,)\s*gzip\b/i.test(acceptEncoding)) {
    const gz = await serveGzipSibling(rootAbs, target, type, info, validators);
    if (gz) {
      file.close();
      return gz;
    }
  }
  return rangeOrFull(file, info, type, validators, request);
}

/** Open `path` for reading, or null when it vanished. */
async function openFile(path: string): Promise<Deno.FsFile | null> {
  try {
    return await Deno.open(path, { read: true });
  } catch {
    return null;
  }
}

/** `ETag` (weak, size + mtime), `Last-Modified`, `Accept-Ranges`, `Vary`, `Cache-Control`. */
function validatorHeaders(info: Deno.FileInfo): Headers {
  const mtime = info.mtime?.getTime() ?? 0;
  const headers = new Headers({
    "etag": `W/"${info.size.toString(16)}-${mtime.toString(16)}"`,
    "accept-ranges": "bytes",
    "vary": "Accept-Encoding",
    // `public/` files are mutable: browsers revalidate with the validators every time
    // (immutable hashed assets take the separate immutable path).
    "cache-control": "public, max-age=0, must-revalidate",
  });
  if (info.mtime) headers.set("last-modified", info.mtime.toUTCString());
  return headers;
}

/** `If-None-Match` (any listed tag, or `*`) then `If-Modified-Since` (second precision). */
function notModified(req: Headers, info: Deno.FileInfo, etag: string): boolean {
  const inm = req.get("if-none-match");
  if (inm !== null) return inm === "*" || inm.split(",").some((t) => t.trim() === etag);
  const ims = req.get("if-modified-since");
  if (ims === null || !info.mtime) return false;
  const since = Date.parse(ims);
  return Number.isFinite(since) &&
    Math.floor(info.mtime.getTime() / 1000) <= Math.floor(since / 1000);
}

/**
 * The full body (200); a byte range (206) or several as `multipart/byteranges` (206, RFC 9110
 * §14.6) when `Range` asks for them and `If-Range` (when sent) still holds; 416 when none of
 * the ranges can be satisfied.
 */
async function rangeOrFull(
  file: Deno.FsFile,
  info: Deno.FileInfo,
  type: string,
  validators: Headers,
  request: Request | undefined,
): Promise<Response> {
  const headers = new Headers(validators);
  headers.set("content-type", type);
  const rangeHeader = request?.headers.get("range") ?? null;
  const ranges = rangeHeader === null || !ifRangeHolds(request!.headers, info)
    ? undefined
    : parseRanges(rangeHeader, info.size);
  if (ranges === null) {
    file.close();
    headers.set("content-range", `bytes */${info.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (ranges === undefined) {
    headers.set("content-length", String(info.size));
    return new Response(file.readable, { status: 200, headers });
  }
  if (ranges.length > 1) return multipartRanges(file, info.size, type, headers, ranges);
  const [range] = ranges;
  await file.seek(range.start, Deno.SeekMode.Start);
  const length = range.end - range.start + 1;
  headers.set("content-length", String(length));
  headers.set("content-range", `bytes ${range.start}-${range.end}/${info.size}`);
  return new Response(file.readable.pipeThrough(limitBytes(length)), { status: 206, headers });
}

/**
 * `If-Range` (RFC 9110 §13.1.5): absent, or a validator that still names this file, lets the
 * range through; anything else asks for the whole file. An entity tag needs a strong match,
 * which the weak `ETag` here (one tag for the identity and the gzipped file) never gives — a
 * client keeps a weak tag out of `If-Range` — so only the `Last-Modified` date can match, to the
 * second.
 */
function ifRangeHolds(req: Headers, info: Deno.FileInfo): boolean {
  const value = req.get("if-range")?.trim();
  if (value === undefined) return true;
  if (value.startsWith('"') || value.startsWith("W/")) return false;
  const date = Date.parse(value);
  return info.mtime !== null && Number.isFinite(date) &&
    Math.floor(info.mtime.getTime() / 1000) === Math.floor(date / 1000);
}

/**
 * One `bytes=start-end` / `bytes=start-` / `bytes=-suffix` range against `size`:
 * `undefined` = ignore the header (unsupported form or multiple ranges → serve the whole
 * file), `null` = unsatisfiable (416). {@linkcode parseRanges} reads a header with several.
 *
 * @param header The request's `Range` header.
 * @param size The resource's size in bytes.
 * @returns The inclusive byte range, `undefined` to serve it all, or `null` for a 416.
 */
export function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | null | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return undefined;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return null;
  return { start, end };
}

/** More range specs than this in one `Range` header and it is ignored (the whole file, 200). */
const MAX_RANGES = 64;

/**
 * Every `bytes=` range of a `Range` header against `size` (RFC 9110 §14.1.2), sorted and with
 * overlapping or adjacent ranges coalesced: `undefined` = ignore the header (a malformed or
 * non-`bytes` header, or more than {@linkcode MAX_RANGES} specs → serve the whole file),
 * `null` = none satisfiable (416). An unsatisfiable spec among satisfiable ones is dropped.
 *
 * @param header The request's `Range` header.
 * @param size The resource's size in bytes.
 * @returns The inclusive byte ranges, `undefined` to serve it all, or `null` for a 416.
 */
export function parseRanges(
  header: string,
  size: number,
): { start: number; end: number }[] | null | undefined {
  const m = /^bytes\s*=\s*(.*)$/i.exec(header.trim());
  if (!m) return undefined;
  const specs = m[1].split(",").map((spec) => spec.trim()).filter((spec) => spec !== "");
  if (specs.length === 0 || specs.length > MAX_RANGES) return undefined;
  const ranges: { start: number; end: number }[] = [];
  for (const spec of specs) {
    const range = parseRange(`bytes=${spec}`, size);
    if (range === undefined) return undefined;
    if (range !== null) ranges.push(range);
  }
  if (ranges.length === 0) return null;
  ranges.sort((a, b) => a.start - b.start);
  const merged = [ranges[0]];
  for (const range of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else merged.push(range);
  }
  return merged;
}

/**
 * Several ranges as one `multipart/byteranges` body: each part carries its own `Content-Type`
 * and `Content-Range`, read from the open file in turn. The length is known up front.
 */
function multipartRanges(
  file: Deno.FsFile,
  size: number,
  type: string,
  headers: Headers,
  ranges: { start: number; end: number }[],
): Response {
  const boundary = `denext-${crypto.randomUUID().replaceAll("-", "")}`;
  const encoder = new TextEncoder();
  const heads = ranges.map((r, i) =>
    encoder.encode(
      `${i === 0 ? "" : "\r\n"}--${boundary}\r\ncontent-type: ${type}\r\n` +
        `content-range: bytes ${r.start}-${r.end}/${size}\r\n\r\n`,
    )
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const length = ranges.reduce((n, r, i) => n + heads[i].byteLength + r.end - r.start + 1, 0) +
    tail.byteLength;
  headers.set("content-type", `multipart/byteranges; boundary=${boundary}`);
  headers.set("content-length", String(length));
  return new Response(rangeParts(file, ranges, heads, tail), { status: 206, headers });
}

/** The parts' bytes: each head, then its range read from `file` in chunks; the file is closed after. */
function rangeParts(
  file: Deno.FsFile,
  ranges: { start: number; end: number }[],
  heads: Uint8Array[],
  tail: Uint8Array,
): ReadableStream<Uint8Array> {
  const CHUNK = 64 * 1024;
  let part = 0;
  let at = -1; // the next byte of the current part's range, or -1 before its head is sent
  return new ReadableStream({
    async pull(controller) {
      try {
        if (part === ranges.length) {
          controller.enqueue(tail);
          controller.close();
          file.close();
          return;
        }
        const range = ranges[part];
        if (at < 0) {
          controller.enqueue(heads[part]);
          at = range.start;
          await file.seek(at, Deno.SeekMode.Start);
          return;
        }
        const buf = new Uint8Array(Math.min(CHUNK, range.end - at + 1));
        const n = await file.read(buf);
        if (n === null) throw new Error("the file ended before its range");
        controller.enqueue(buf.subarray(0, n));
        at += n;
        if (at > range.end) {
          part++;
          at = -1;
        }
      } catch (error) {
        file.close();
        controller.error(error);
      }
    },
    cancel() {
      file.close();
    },
  });
}

/** Pass through exactly `length` bytes, then close (the file's readable keeps going otherwise). */
function limitBytes(length: number): TransformStream<Uint8Array, Uint8Array> {
  let remaining = length;
  return new TransformStream({
    transform(chunk, controller) {
      if (remaining <= 0) return;
      const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      remaining -= slice.byteLength;
      controller.enqueue(slice);
      if (remaining <= 0) controller.terminate();
    },
  });
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
  validators: Headers,
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
  const headers = new Headers(validators);
  headers.set("content-type", type);
  headers.set("content-encoding", "gzip");
  headers.set("content-length", String(gzInfo.size));
  headers.delete("accept-ranges"); // a compressed representation is not range-addressable
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
