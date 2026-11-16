// SPA mode dev server: the content each watched file had, so an fs event for a file whose bytes
// did not change is not an edit.
//
// macOS's FSEvents can deliver the project's own just-written files (a scaffold's, a checkout's,
// a test fixture's) after the watcher starts, on a loaded machine well after the start-time
// window `startupReplay` (../platform-watch.ts) covers; each bumped the dev build generation right
// after start. Comparing content instead of times drops those, and a rewrite with the same bytes
// at any later point, while a real edit still counts on its first event.

import { createHash } from "node:crypto";
import { join } from "@std/path";
import { isScannedDir } from "../platform-extensions.ts";

/** Files larger than this are never hashed: their events always count. */
const MAX_HASH_BYTES = 2 * 1024 * 1024;
/** At most this many files are hashed at the watcher's start (the rest are learned lazily). */
const MAX_SNAPSHOT_FILES = 5000;

/** The SHA-256 (hex) of a regular file's bytes, or null when it is gone, not a file, or too big. */
function hashFile(path: string): string | null {
  try {
    const info = Deno.statSync(path);
    if (!info.isFile || info.size > MAX_HASH_BYTES) return null;
    return createHash("sha256").update(Deno.readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** A folder's entries, or none when it can't be read. */
function readDir(dir: string): Deno.DirEntry[] {
  try {
    return [...Deno.readDirSync(dir)];
  } catch {
    return [];
  }
}

/**
 * What each watched file held when the watcher started, or when an event last reported it.
 */
export class ContentBaseline {
  readonly #hashes = new Map<string, string>();
  readonly #hash: (path: string) => string | null;

  /** @param hash A file's content hash, or null when it can't be hashed (injected by tests). */
  constructor(hash: (path: string) => string | null = hashFile) {
    this.#hash = hash;
  }

  /** How many files have a recorded content. */
  get size(): number {
    return this.#hashes.size;
  }

  /** Record `path`'s current content (nothing when it can't be hashed). */
  capture(path: string): void {
    const h = this.#hash(path);
    if (h === null) this.#hashes.delete(path);
    else this.#hashes.set(path, h);
  }

  /**
   * Whether an event for `path` is a change: false only when the file is readable and holds the
   * bytes last recorded for it. A file seen for the first time, removed, a directory or too big
   * to hash always counts. The current content becomes the one later events are compared with.
   *
   * @param path The event's path.
   * @returns Whether the event changed the file.
   */
  changed(path: string): boolean {
    const now = this.#hash(path);
    const was = this.#hashes.get(path);
    if (now === null) {
      this.#hashes.delete(path);
      return true;
    }
    this.#hashes.set(path, now);
    return was !== now;
  }

  /**
   * Record the content of every file under `roots` that `ignored` lets through, skipping the
   * folders a platform-file scan skips (node_modules, dot-folders, build output) and stopping at
   * {@linkcode MAX_SNAPSHOT_FILES}. Run it BEFORE the watcher opens: a write after it then always
   * differs from what was recorded.
   *
   * @param roots The watched folders.
   * @param ignored The watcher's own filter (paths it never reports).
   */
  snapshot(roots: readonly string[], ignored: (path: string) => boolean): void {
    const stack = [...roots];
    let budget = MAX_SNAPSHOT_FILES;
    while (stack.length > 0 && budget > 0) {
      budget = this.#captureDir(stack.pop()!, ignored, stack, budget);
    }
  }

  /** Record `dir`'s files (within `budget`) and queue its scanned subfolders; the budget left. */
  #captureDir(
    dir: string,
    ignored: (path: string) => boolean,
    stack: string[],
    budget: number,
  ): number {
    for (const e of readDir(dir)) {
      const path = join(dir, e.name);
      if (ignored(path)) continue;
      if (e.isDirectory && isScannedDir(e.name)) stack.push(path);
      else if (e.isFile && budget > 0) {
        this.capture(path);
        budget--;
      }
    }
    return budget;
  }
}
