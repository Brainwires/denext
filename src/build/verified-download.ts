// The pieces the pinned downloads share — the Deno Desktop runtime (desktop-runtime.ts) and
// denext's Deno toolchain (deno-toolchain.ts): streaming a download to a new file while hashing it
// and refusing it the moment it outgrows its pin, hashing a file on disk, reading a JSON marker,
// and sweeping what a crashed install left behind.

import { join } from "@std/path";
import { createHash } from "node:crypto";

/**
 * The lowercase hex SHA-256 of the file at `path`.
 *
 * @param path The file.
 * @returns Its hash.
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  // The readable closes the file once drained.
  const f = await Deno.open(path, { read: true });
  for await (const chunk of f.readable) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * The parsed JSON at `path`, or `null` when it is missing or malformed.
 *
 * @param path The file.
 * @returns Its contents.
 */
export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch {
    return null;
  }
}

/**
 * Remove the `.tmp-*` / `.stale-*` entries (files or directories) of `dir` older than a day: what
 * a crashed or raced install left behind.
 *
 * @param dir The directory to sweep.
 */
export async function sweepLeftovers(dir: string): Promise<void> {
  const cutoff = Date.now() - 24 * 3600_000;
  for await (const e of Deno.readDir(dir)) {
    if (!/^\.(tmp|stale)-/.test(e.name)) continue;
    const path = join(dir, e.name);
    const mtime = (await Deno.lstat(path).catch(() => null))?.mtime?.getTime();
    if (mtime !== undefined && mtime < cutoff) {
      await Deno.remove(path, { recursive: true }).catch(() => {});
    }
  }
}

/** How {@linkcode streamHashed} words its two refusals. */
export interface StreamHashedErrors {
  /** The download outgrew its pinned size (thrown as is). */
  readonly tooLarge: () => Error;
  /** The stream or a write failed after `size` bytes. */
  readonly interrupted: (size: number, cause: unknown) => Error;
}

/**
 * Stream `body` into the NEW file `dest` (it must not exist), hashing it as it goes and refusing it
 * as soon as it holds more than `maxSize` bytes.
 *
 * @param body The download.
 * @param dest The file to create.
 * @param maxSize The most bytes accepted.
 * @param errors The refusals' wording.
 * @returns The byte count and SHA-256.
 */
export async function streamHashed(
  body: ReadableStream<Uint8Array>,
  dest: string,
  maxSize: number,
  errors: StreamHashedErrors,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  let refused: Error | null = null;
  const file = await Deno.open(dest, { write: true, createNew: true });
  try {
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > maxSize) throw (refused = errors.tooLarge());
      hash.update(chunk);
      for (let off = 0; off < chunk.byteLength;) off += await file.write(chunk.subarray(off));
    }
  } catch (err) {
    if (err === refused) throw err;
    throw errors.interrupted(size, err);
  } finally {
    file.close();
  }
  return { size, sha256: hash.digest("hex") };
}
