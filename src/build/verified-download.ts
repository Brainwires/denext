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

/** A download's progress line ({@linkcode downloadProgress}). */
export interface DownloadProgress {
  /** The bytes received so far. */
  update(bytes: number): void;
  /** Clear the line (the download ended, either way). */
  done(): void;
}

/** The seams of {@linkcode downloadProgress} (all default to the process's stderr and clock). */
export interface DownloadProgressOptions {
  /** Whether stderr is a terminal (no line otherwise: a log or CI gets nothing). */
  readonly isTerminal?: () => boolean;
  /** Write raw text to stderr. */
  readonly write?: (text: string) => void;
  /** Milliseconds now. */
  readonly now?: () => number;
  /** The least time between two redraws, in ms (default 100). */
  readonly intervalMs?: number;
}

/** `12.3 MB` (decimal megabytes, one decimal). */
function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/**
 * One self-redrawing stderr line for a download — `  <what>: 12.3 / 69.6 MB (17%)`, or just the
 * bytes when the total is unknown — redrawn at most every 100 ms and cleared when it ends. Silent
 * when stderr is not a terminal, so logs and CI output stay clean.
 *
 * @param what What is being downloaded (`denext's Deno toolchain 2.9.7-denext.22`).
 * @param total Its size in bytes, when known.
 * @param options Seams for tests.
 * @returns The reporter.
 */
export function downloadProgress(
  what: string,
  total: number | undefined,
  options: DownloadProgressOptions = {},
): DownloadProgress {
  const terminal = (options.isTerminal ?? (() => Deno.stderr.isTerminal()))();
  const encoder = new TextEncoder();
  const write = options.write ?? ((t: string) => void Deno.stderr.writeSync(encoder.encode(t)));
  const now = options.now ?? (() => Date.now());
  const interval = options.intervalMs ?? 100;
  let last = -Infinity;
  let drawn = false;
  return {
    update(bytes) {
      if (!terminal) return;
      const t = now();
      const finished = total !== undefined && bytes >= total;
      if (t - last < interval && !finished) return;
      last = t;
      const amount = total
        ? `${megabytes(bytes)} / ${megabytes(total)} (${Math.floor((bytes / total) * 100)}%)`
        : megabytes(bytes);
      write(`\r\x1b[2K  ${what}: ${amount}`);
      drawn = true;
    },
    done() {
      if (drawn) write("\r\x1b[2K");
      drawn = false;
    },
  };
}

/**
 * Stream `body` into the NEW file `dest` (it must not exist), hashing it as it goes and refusing it
 * as soon as it holds more than `maxSize` bytes.
 *
 * @param body The download.
 * @param dest The file to create.
 * @param maxSize The most bytes accepted.
 * @param errors The refusals' wording.
 * @param progress Told the running byte count after each chunk (a {@linkcode downloadProgress}).
 * @returns The byte count and SHA-256.
 */
export async function streamHashed(
  body: ReadableStream<Uint8Array>,
  dest: string,
  maxSize: number,
  errors: StreamHashedErrors,
  progress?: (bytes: number) => void,
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
      progress?.(size);
    }
  } catch (err) {
    if (err === refused) throw err;
    throw errors.interrupted(size, err);
  } finally {
    file.close();
  }
  return { size, sha256: hash.digest("hex") };
}
