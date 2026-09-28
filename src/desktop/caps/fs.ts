/**
 * The `fs` capability: `readFile` / `writeFile` / `deleteFile` / `listDir` / `downloadToFile` on
 * Deno Desktop, backed by the OS filesystem under the app's own directories. It answers the
 * `denext/mobile` filesystem calls (see `src/desktop/native.ts`), which on the web use OPFS.
 *
 * SECURITY — this is a path-scoping boundary for an untrusted page:
 * - A page-supplied `path` is joined onto the base directory for its {@link FileDirectory}, then
 *   BOTH `..` traversal (via {@link resolve} normalization) AND symlinks (via {@link Deno.realPath}
 *   of the deepest existing ancestor) are resolved BEFORE the scope check, so neither a `../`
 *   escape nor a symlink out of the tree passes. An absolute `path` is refused outright.
 * - Each {@link FileDirectory} maps to a config token (`data`→`$APPDATA`, `cache`→`$CACHE`,
 *   `documents`→`$DOCUMENTS`); an operation is refused (`forbidden`) unless that token is in the
 *   capability's read set (reads/listing) or write set (writes/delete/download). This mirrors the
 *   least-privilege `--allow-read` / `--allow-write` the package scripts bake in, so the runtime
 *   never grants what the packaged binary would not.
 * - TOCTOU: the check resolves symlinks as they are AT CHECK TIME; a same-user process racing a
 *   symlink swap between the check and the operation is the Electron-equivalent local-process
 *   boundary the bridge does not defend against (see `bridge.ts`). The page itself has no symlink
 *   primitive here, and the base dirs are app-owned.
 *
 * Runtime-only (imported by the desktop entry via the caps resolver, never a client bundle).
 *
 * @module
 */

import { dirname, isAbsolute, join, relative, resolve, SEPARATOR } from "@std/path";
import { base64ToBytes, bytesToBase64 } from "../../mobile/base64.ts";
import type { FileDirectory, FileEntry } from "../../mobile/filesystem.ts";
import type { DesktopAppDirs } from "../app-dirs.ts";
import { type DesktopCapability, DesktopCapError } from "../extension.ts";

/** The config path token each {@link FileDirectory} resolves to (for the read/write scope check). */
const DIRECTORY_TOKEN: Readonly<Record<FileDirectory, string>> = {
  data: "$APPDATA",
  cache: "$CACHE",
  documents: "$DOCUMENTS",
};

/** The roots and scope tokens an {@link fsCapability} instance was built with. */
export interface FsCapabilityConfig {
  /** The resolved absolute base directories (`data` / `cache` / `documents`). */
  readonly dirs: DesktopAppDirs;
  /** The path tokens (`$APPDATA` / `$CACHE` / `$DOCUMENTS`) the page may READ from. */
  readonly read: ReadonlySet<string>;
  /** The path tokens the page may WRITE to (also gates delete and download). */
  readonly write: ReadonlySet<string>;
}

/** `p` is `base` itself or lies within it (using the platform separator). */
function isWithin(base: string, p: string): boolean {
  return p === base || p.startsWith(base + SEPARATOR);
}

/** A validation error (a bad `directory`, absolute path, or malformed arg). */
function badInput(message: string): DesktopCapError {
  return new DesktopCapError("validation", message);
}

/** The base dir for `directory`, checking the config scope for the given access. */
function baseFor(cfg: FsCapabilityConfig, directory: unknown, write: boolean): string {
  if (directory !== "data" && directory !== "cache" && directory !== "documents") {
    throw badInput(`unknown directory "${String(directory)}"`);
  }
  const token = DIRECTORY_TOKEN[directory];
  const scope = write ? cfg.write : cfg.read;
  if (!scope.has(token)) {
    throw new DesktopCapError(
      "forbidden",
      `the fs capability is not allowed to ${write ? "write" : "read"} "${directory}" ` +
        `(add ${token} to desktop.capabilities.fs.${write ? "write" : "read"})`,
      { status: 403 },
    );
  }
  return cfg.dirs[directory];
}

/**
 * Resolve a page-supplied relative `path` against `base` and confine it: reject an absolute path,
 * normalize `..`, then resolve symlinks in the deepest EXISTING ancestor and re-check the
 * reconstructed real path against the real base. Returns the resolved (non-real, for a
 * not-yet-existing file) path to operate on.
 */
async function scopedPath(base: string, path: unknown): Promise<string> {
  if (typeof path !== "string" || path.length === 0) {
    throw badInput("path must be a non-empty string");
  }
  if (isAbsolute(path)) throw badInput("path must be relative to its directory");
  const resolved = resolve(base, path);
  if (!isWithin(base, resolved)) {
    throw new DesktopCapError("forbidden", "path escapes its directory", { status: 403 });
  }
  // Resolve symlinks: realPath the deepest existing prefix, then re-attach the not-yet-existing
  // tail and confirm the real target is still within the real base.
  const realBase = await Deno.realPath(base).catch(() => resolve(base));
  let existing = resolved;
  // Walk up until an ancestor exists (or we hit the base, which exists after ensureBase).
  for (;;) {
    let real: string;
    try {
      real = await Deno.realPath(existing);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) break; // reached the filesystem root without an existing ancestor
      existing = parent;
      continue;
    }
    const tail = relative(existing, resolved);
    const realTarget = tail && tail !== "." ? join(real, tail) : real;
    if (!isWithin(realBase, realTarget)) {
      throw new DesktopCapError("forbidden", "path escapes its directory", { status: 403 });
    }
    break;
  }
  return resolved;
}

/** `mkdir -p path`, treating an existing directory as success (used for the base and write parents). */
async function mkdirp(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true }).catch((err) => {
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
  });
}

/** One `readDir` entry as a {@link FileEntry} (size/mtime from a stat; 0/absent on failure). */
async function toFileEntry(dir: string, name: string, isDirectory: boolean): Promise<FileEntry> {
  const base: FileEntry = { name, type: isDirectory ? "directory" : "file", size: 0 };
  try {
    const info = await Deno.stat(join(dir, name));
    const size = isDirectory ? 0 : info.size;
    const mtime = info.mtime?.getTime();
    return typeof mtime === "number" ? { ...base, size, mtime } : { ...base, size };
  } catch {
    return base;
  }
}

/** Validate a {@link FileEncoding} arg, defaulting to `"utf8"`. */
function encodingOf(value: unknown): "utf8" | "base64" {
  if (value === undefined || value === "utf8") return "utf8";
  if (value === "base64") return "base64";
  throw badInput(`unknown encoding "${String(value)}"`);
}

/**
 * Build the `fs` capability over `cfg`. The factory closes over the resolved base dirs and the
 * read/write scope; every method confines its path before touching the disk.
 *
 * @param cfg The resolved directories and the read/write token scope.
 * @returns The `fs` {@link DesktopCapability}.
 */
export function fsCapability(cfg: FsCapabilityConfig): DesktopCapability {
  return {
    name: "fs",
    methods: {
      readFile: {
        permissions: { read: [...cfg.read] },
        handler: async (args) => {
          const a = (args ?? {}) as { path?: unknown; directory?: unknown; encoding?: unknown };
          const base = baseFor(cfg, a.directory, false);
          const encoding = encodingOf(a.encoding);
          const target = await scopedPath(base, a.path);
          if (encoding === "utf8") return await Deno.readTextFile(target);
          return bytesToBase64(await Deno.readFile(target));
        },
      },
      writeFile: {
        permissions: { write: [...cfg.write] },
        handler: async (args) => {
          const a = (args ?? {}) as {
            path?: unknown;
            data?: unknown;
            directory?: unknown;
            encoding?: unknown;
            recursive?: unknown;
          };
          const base = baseFor(cfg, a.directory, true);
          const encoding = encodingOf(a.encoding);
          if (typeof a.data !== "string") throw badInput("data must be a string");
          await mkdirp(base);
          const target = await scopedPath(base, a.path);
          if (a.recursive === true) await mkdirp(dirname(target));
          if (encoding === "utf8") await Deno.writeTextFile(target, a.data);
          else await Deno.writeFile(target, base64ToBytes(a.data));
          return { path: target };
        },
      },
      deleteFile: {
        permissions: { write: [...cfg.write] },
        handler: async (args) => {
          const a = (args ?? {}) as { path?: unknown; directory?: unknown };
          const base = baseFor(cfg, a.directory, true);
          const target = await scopedPath(base, a.path);
          await Deno.remove(target).catch((err) => {
            if (!(err instanceof Deno.errors.NotFound)) throw err;
          });
          return { ok: true };
        },
      },
      listDir: {
        permissions: { read: [...cfg.read] },
        handler: async (args) => {
          const a = (args ?? {}) as { path?: unknown; directory?: unknown };
          const base = baseFor(cfg, a.directory, false);
          const target = await scopedPath(base, a.path);
          const entries: FileEntry[] = [];
          try {
            for await (const e of Deno.readDir(target)) {
              entries.push(await toFileEntry(target, e.name, e.isDirectory));
            }
          } catch (err) {
            if (err instanceof Deno.errors.NotFound) return [];
            throw err;
          }
          return entries;
        },
      },
      download: {
        // The runtime fetches the URL itself; no per-method timeout (a large file may take a while).
        timeoutMs: false,
        permissions: { write: [...cfg.write], net: ["*"] },
        handler: async (args, ctx) => {
          const a = (args ?? {}) as { url?: unknown; path?: unknown; directory?: unknown };
          if (typeof a.url !== "string") throw badInput("url must be a string");
          const base = baseFor(cfg, a.directory, true);
          await mkdirp(base);
          const target = await scopedPath(base, a.path);
          const res = await fetch(a.url, { signal: ctx.signal });
          if (!res.ok) {
            throw new DesktopCapError(
              "download_failed",
              `download failed with status ${res.status}`,
            );
          }
          await mkdirp(dirname(target));
          const bytes = new Uint8Array(await res.arrayBuffer());
          await Deno.writeFile(target, bytes);
          return { path: target };
        },
      },
    },
  };
}
