/**
 * The partial file a Deno Desktop `fs.download` keeps so a paused, interrupted or failed download
 * can continue where it stopped — after an app restart too. Beside the destination `<dest>` it
 * writes `<dest>.part` (the bytes so far) and `<dest>.part.json` (the sidecar: the URL, the
 * `If-Range` validator, the size if known, and the bytes written), the sidecar replaced atomically
 * (a temp file renamed over it). A destination the user picked as a single file grants that file
 * only, so its partial and sidecar live in the app's cache directory instead, named by a hash of
 * the destination ({@linkcode partialAt}): nothing is created or removed beside the picked file.
 *
 * A partial is only ever continued for the SAME URL (the sidecar's `url` must equal the request's)
 * and into the destination the request itself resolved inside a granted directory, so a stale
 * partial cannot be resumed into another path. Either file being a symlink, missing, oversized or
 * malformed discards both: the download then starts over.
 *
 * Runtime-only (imported by the `fs` capability).
 *
 * @module
 */

import { dirname, join } from "@std/path";

/** The sidecar's shape (version 1). */
interface PartialSidecar {
  readonly v: 1;
  readonly url: string;
  readonly validator: string | null;
  readonly total: number | null;
  readonly bytes: number;
}

/** A partial download that may be continued: its size on disk and the sidecar's fields. */
export interface KeptPartial {
  /** The `.part` file's size (the bytes to keep). */
  readonly bytes: number;
  /** The `If-Range` validator (a strong ETag or Last-Modified), or `null` (no resume). */
  readonly validator: string | null;
  /** The file's full size, when the server said. */
  readonly total: number | null;
}

/** The largest sidecar read back (bytes); a larger one is not ours. */
const MAX_SIDECAR_BYTES = 64 * 1024;

/** Where a download's partial lives: its destination, and the path its `.part` files extend. */
export interface PartialAt {
  /** The download's destination. */
  readonly target: string;
  /** The path `.part` / `.part.json` are appended to: the destination, or a cache-dir name. */
  readonly base: string;
}

/** The cache-dir subdirectory holding single-file destinations' partials. */
const CACHE_SUBDIR = "denext-downloads";

/**
 * Where `target`'s partial lives: beside it (`<target>.part`), or, given the app's cache
 * directory (a destination picked as a single file), `<cache>/denext-downloads/<sha-256 of the
 * destination>.part`.
 *
 * @param target The download's destination.
 * @param cacheDir The app's cache directory, for a single-file destination.
 * @returns The location.
 */
export async function partialAt(target: string, cacheDir?: string): Promise<PartialAt> {
  if (cacheDir === undefined) return { target, base: target };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(target));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { target, base: join(cacheDir, CACHE_SUBDIR, hex) };
}

/** The partial file and its sidecar for `at`. */
function partialPaths(at: PartialAt): { part: string; sidecar: string } {
  return { part: `${at.base}.part`, sidecar: `${at.base}.part.json` };
}

/**
 * The validator a resumed request's `If-Range` may carry: a STRONG `ETag`, else `Last-Modified`,
 * else `null`. A weak `ETag` never matches in `If-Range` (RFC 9110 §13.1.5), so it is never used.
 *
 * @param headers The response's headers.
 * @returns The validator, or `null`.
 */
export function strongValidator(headers: Headers): string | null {
  const etag = headers.get("etag")?.trim();
  if (etag && !etag.startsWith("W/")) return etag;
  return headers.get("last-modified");
}

/** `path`'s size when it is a regular file (not a symlink), else `undefined`. */
async function regularSize(path: string): Promise<number | undefined> {
  try {
    const info = await Deno.lstat(path);
    return info.isFile && !info.isSymlink ? info.size : undefined;
  } catch {
    return undefined;
  }
}

/** Remove `path` (a symlink itself, never its target); a missing one is fine. */
async function removeQuietly(path: string): Promise<void> {
  await Deno.remove(path).catch(() => {});
}

/**
 * Drop a download's partial file and sidecar.
 *
 * @param at Where the partial lives ({@linkcode partialAt}).
 */
export async function discardPartial(at: PartialAt): Promise<void> {
  const { part, sidecar } = partialPaths(at);
  await removeQuietly(part);
  await removeQuietly(sidecar);
}

/** The sidecar's fields, when `raw` is a well-formed version-1 sidecar. */
function parseSidecar(raw: string): PartialSidecar | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const s = value as Partial<PartialSidecar> | null;
  return s?.v === 1 && typeof s.url === "string" && nullOr(s.validator, isString) &&
      nullOr(s.total, isSize)
    ? s as PartialSidecar
    : undefined;
}

/** Whether `value` is `null` or passes `check`. */
function nullOr(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === null || check(value);
}

/** Whether `value` is a string. */
function isString(value: unknown): boolean {
  return typeof value === "string";
}

/** Whether `value` is a byte count. */
function isSize(value: unknown): boolean {
  return typeof value === "number" && value >= 0;
}

/**
 * The partial kept for `url`, or `null` (after discarding anything there that cannot be
 * continued: no sidecar, another URL, a symlink, a malformed or oversized sidecar).
 *
 * @param at Where the partial lives (its destination already confined to a granted directory).
 * @param url The URL the request names (the sidecar's must equal it).
 * @returns The kept partial, or `null`.
 */
export async function readPartial(at: PartialAt, url: string): Promise<KeptPartial | null> {
  const { part, sidecar } = partialPaths(at);
  const size = await regularSize(part);
  const sidecarSize = await regularSize(sidecar);
  let state: PartialSidecar | undefined;
  if (size !== undefined && sidecarSize !== undefined && sidecarSize <= MAX_SIDECAR_BYTES) {
    state = parseSidecar(await Deno.readTextFile(sidecar).catch(() => ""));
  }
  if (!state || state.url !== url || size === undefined) {
    await discardPartial(at);
    return null;
  }
  return { bytes: size, validator: state.validator, total: state.total };
}

/**
 * Write the sidecar atomically (a temp file renamed over it).
 *
 * @param at Where the partial lives.
 * @param state The URL, validator, size and bytes written.
 */
export async function writeSidecar(
  at: PartialAt,
  state: { url: string; validator: string | null; total: number | null; bytes: number },
): Promise<void> {
  const { sidecar } = partialPaths(at);
  const temp = `${sidecar}.${crypto.randomUUID()}.tmp`;
  const body: PartialSidecar = { v: 1, ...state };
  try {
    await Deno.writeTextFile(temp, JSON.stringify(body), { createNew: true });
    await Deno.rename(temp, sidecar);
  } catch (err) {
    await removeQuietly(temp);
    throw err;
  }
}

/**
 * Open the partial file for writing: appended to when `append` (it must be a regular file of
 * exactly `from` bytes, else this throws), else created anew (any old one removed first, never
 * followed). A cache-dir partial's directory is made first, private to the user.
 *
 * @param at Where the partial lives.
 * @param append Whether the kept bytes continue.
 * @param from The bytes kept (only checked when appending).
 * @returns The open file.
 */
export async function openPartial(
  at: PartialAt,
  append: boolean,
  from: number,
): Promise<Deno.FsFile> {
  const { part } = partialPaths(at);
  if (append) {
    // The kept bytes changed under the request (or became a symlink): nothing to append to.
    if ((await regularSize(part)) !== from) throw new Error("the partial file changed");
    return await Deno.open(part, { write: true, append: true });
  }
  if (at.base !== at.target) await Deno.mkdir(dirname(at.base), { recursive: true, mode: 0o700 });
  await removeQuietly(part);
  return await Deno.open(part, { write: true, createNew: true });
}

/**
 * Move a finished partial into place and drop its sidecar. A cache-dir partial on another volume
 * than its destination is copied over it, then removed.
 *
 * @param at Where the partial lives.
 */
export async function finalizePartial(at: PartialAt): Promise<void> {
  const { part, sidecar } = partialPaths(at);
  try {
    await Deno.rename(part, at.target);
  } catch (err) {
    if (at.base === at.target || !crossDevice(err)) throw err;
    await Deno.copyFile(part, at.target);
    await removeQuietly(part);
  }
  await removeQuietly(sidecar);
}

/** Whether a rename failed because its two paths are on different volumes. */
function crossDevice(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "EXDEV" || code === "ERROR_NOT_SAME_DEVICE" ||
    /cross-device|EXDEV|not same device|different disk drive/i.test(String(err));
}
