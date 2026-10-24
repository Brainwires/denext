/**
 * The partial file a Deno Desktop `fs.download` keeps so a paused, interrupted or failed download
 * can continue where it stopped — after an app restart too. Beside the destination `<dest>` it
 * writes `<dest>.part` (the bytes so far) and `<dest>.part.json` (the sidecar: the URL, the
 * `If-Range` validator, the size if known, and the bytes written), the sidecar replaced atomically
 * (a temp file renamed over it).
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

/** The partial file and its sidecar for destination `target`. */
function partialPaths(target: string): { part: string; sidecar: string } {
  return { part: `${target}.part`, sidecar: `${target}.part.json` };
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
 * Drop `target`'s partial file and sidecar.
 *
 * @param target The download's destination.
 */
export async function discardPartial(target: string): Promise<void> {
  const { part, sidecar } = partialPaths(target);
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
 * The partial `target` keeps for `url`, or `null` (after discarding anything there that cannot be
 * continued: no sidecar, another URL, a symlink, a malformed or oversized sidecar).
 *
 * @param target The download's destination (already confined to a granted directory).
 * @param url The URL the request names (the sidecar's must equal it).
 * @returns The kept partial, or `null`.
 */
export async function readPartial(target: string, url: string): Promise<KeptPartial | null> {
  const { part, sidecar } = partialPaths(target);
  const size = await regularSize(part);
  const sidecarSize = await regularSize(sidecar);
  let state: PartialSidecar | undefined;
  if (size !== undefined && sidecarSize !== undefined && sidecarSize <= MAX_SIDECAR_BYTES) {
    state = parseSidecar(await Deno.readTextFile(sidecar).catch(() => ""));
  }
  if (!state || state.url !== url || size === undefined) {
    await discardPartial(target);
    return null;
  }
  return { bytes: size, validator: state.validator, total: state.total };
}

/**
 * Write `target`'s sidecar atomically (a temp file renamed over it).
 *
 * @param target The download's destination.
 * @param state The URL, validator, size and bytes written.
 */
export async function writeSidecar(
  target: string,
  state: { url: string; validator: string | null; total: number | null; bytes: number },
): Promise<void> {
  const { sidecar } = partialPaths(target);
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
 * Open `target`'s partial file for writing: appended to when `append` (it must be a regular file
 * of exactly `at` bytes, else this throws), else created anew (any old one removed first, never
 * followed).
 *
 * @param target The download's destination.
 * @param append Whether the kept bytes continue.
 * @param at The bytes kept (only checked when appending).
 * @returns The open file.
 */
export async function openPartial(
  target: string,
  append: boolean,
  at: number,
): Promise<Deno.FsFile> {
  const { part } = partialPaths(target);
  if (append) {
    // The kept bytes changed under the request (or became a symlink): nothing to append to.
    if ((await regularSize(part)) !== at) throw new Error("the partial file changed");
    return await Deno.open(part, { write: true, append: true });
  }
  await removeQuietly(part);
  return await Deno.open(part, { write: true, createNew: true });
}

/**
 * Move a finished partial into place and drop its sidecar.
 *
 * @param target The download's destination.
 */
export async function finalizePartial(target: string): Promise<void> {
  const { part, sidecar } = partialPaths(target);
  await Deno.rename(part, target);
  await removeQuietly(sidecar);
}
