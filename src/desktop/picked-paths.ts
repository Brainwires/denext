/**
 * The per-launch set of paths the user picked through a native dialog — the capability-handle store
 * that lets a page reach a file/folder OUTSIDE the app's own directories, but only one the user
 * actively chose by clicking.
 *
 * A pick returns an opaque `handle` (a random id); the page never receives authority from a path
 * string (a dialog's `path` is display-only). `fs` and `shell` reach a picked location only by
 * presenting a handle the user created. Handles are in-memory and per launch (they die on quit),
 * capped so repeated dialogs cannot grow the set without bound, and each carries a mode:
 * - `read`     — one file, read only (openFile, a file dropped on the window, an opened file).
 * - `readwrite` — one file, read + write (saveFile).
 * - `folder`   — a directory, read + write, recursive (pickFolder).
 * - `readFolder` — a directory, read only, recursive (a folder dropped on the window).
 *
 * Access is confined with the same {@link confineRelative} machinery `fs` uses, so a relative path
 * under a picked folder still cannot `..`-escape it or follow a symlink out of it.
 *
 * Runtime-only (imported by the desktop caps, never a client bundle).
 *
 * @module
 */

import { dirname } from "@std/path";
import { DesktopCapError } from "./extension.ts";
import { confineRelative } from "./path-scope.ts";

/** How much access a picked handle grants. */
export type PickMode = "read" | "readwrite" | "folder" | "readFolder";

/** The default maximum number of live handles (oldest dropped past it). */
const DEFAULT_MAX = 1000;

/** A resolved access: the confined absolute path plus the root dir to ensure before a write. */
export interface PickedTarget {
  /** The confined absolute path of the file to operate on. */
  readonly target: string;
  /** The directory that must exist before a write (the folder, or the file's parent). */
  readonly root: string;
}

/** A `forbidden` (403) error. */
function forbidden(message: string): DesktopCapError {
  return new DesktopCapError("forbidden", message, { status: 403 });
}

/**
 * The runtime's picked-path set. One instance per launch is threaded (by the caps resolver) into the
 * `dialogs` cap (which {@link add}s a pick) and the `fs` / `shell` caps (which {@link resolve} a
 * handle back to a confined path).
 */
export class PickedPaths {
  /** handle → {realPath, mode}; insertion order so the oldest is dropped first at the cap. */
  readonly #entries = new Map<string, { realPath: string; mode: PickMode }>();
  readonly #max: number;

  /** A handle table that keeps at most `max` handles, dropping the oldest past it. */
  constructor(max: number = DEFAULT_MAX) {
    this.#max = max;
  }

  /** Number of live handles (tests). */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Record a picked `realPath` (already real-resolved by the dialogs cap) and return its handle.
   * Drops the oldest handle when the set is at its cap.
   */
  add(realPath: string, mode: PickMode): string {
    if (this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    const handle = crypto.randomUUID();
    this.#entries.set(handle, { realPath, mode });
    return handle;
  }

  /**
   * Resolve `(handle, rel)` to a confined absolute {@link PickedTarget} for the requested access, or
   * throw `forbidden` for an unknown/expired handle, a write to a read-only handle, or a relative
   * path on a single-file handle.
   *
   * @param handle The opaque handle from a dialog.
   * @param rel The relative path within a folder handle (ignored / must be empty for a file handle).
   * @param write Whether the access writes (gated by the handle's mode).
   */
  async resolve(handle: unknown, rel: string, write: boolean): Promise<PickedTarget> {
    const entry = typeof handle === "string" ? this.#entries.get(handle) : undefined;
    if (!entry) throw forbidden("unknown or expired picked handle");
    if (write && (entry.mode === "read" || entry.mode === "readFolder")) {
      throw forbidden("this handle is read-only");
    }
    if (entry.mode === "folder" || entry.mode === "readFolder") {
      const target = await confineRelative(entry.realPath, rel && rel.length > 0 ? rel : ".");
      return { target, root: entry.realPath };
    }
    // A single-file handle: only the file itself (no relative sub-path).
    if (rel && rel !== "" && rel !== ".") throw forbidden("this handle refers to a single file");
    return { target: entry.realPath, root: dirname(entry.realPath) };
  }
}
