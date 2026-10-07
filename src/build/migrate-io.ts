// The file operations `denext migrate` performs, behind one seam so `denext migrate --check`
// can run the SAME planners without touching the disk.
//
// Outside a dry run every call is the plain `Deno.*` operation. Inside `dryRunMigration`, the
// calls hit an in-memory overlay instead: writes, moves, removals and directory creation are
// recorded, and later reads in the same run (a `.gitignore` appended twice, a Remix route tree
// rewritten after it was relocated) see the planned state. The disk is only ever read, so a
// check needs nothing beyond read permission. When the run ends, the overlay is compared with
// the disk to produce the list of changes the real run would make.

import { dirname, join, resolve, SEPARATOR } from "@std/path";

/** One overlay entry: planned text, a file moved here from `from`, or a removal. */
type Entry =
  | { kind: "text"; text: string }
  | { kind: "moved"; from: string }
  | { kind: "deleted"; movedTo?: string };

/** The in-memory state a dry run accumulates. */
interface Overlay {
  files: Map<string, Entry>;
  /** Directories created by the run (absolute). */
  dirs: Set<string>;
  /** Directories removed by the run (absolute). */
  removedDirs: Set<string>;
}

/**
 * The overlay of the dry run in progress, or null. Module state rather than an
 * `AsyncLocalStorage`: a store entered by one run was observed to leak into a later, real
 * migration in the same process (through promises the planners cache across runs), which then
 * wrote nothing. A dry run is a short, sequential CLI step; {@link dryRunMigration} refuses to
 * start while another is in progress.
 */
let active: Overlay | null = null;

/** What a path is in the merged (overlay over disk) view. */
type Kind = "file" | "dir" | "none";

/** The minimal stat shape the migrate code reads. */
interface MigrateStat {
  isFile: boolean;
  isDirectory: boolean;
}

/** A change a migration makes to the project, relative to the project root. */
export interface PlannedChange {
  /** Path relative to the project root, `/`-separated. */
  path: string;
  /** `create` a new file, `modify` an existing one, `delete` it, or `move` it from `from`. */
  action: "create" | "modify" | "delete" | "move";
  /** For `move`: the original path, relative to the project root. */
  from?: string;
  /** For `create` / `modify`: the file's planned text. */
  content?: string;
}

function notFound(path: string): Deno.errors.NotFound {
  return new Deno.errors.NotFound(`No such file or directory: ${path}`);
}

/** Whether a path exists on disk, and as what (symlinks are followed, as `Deno.stat` does). */
async function diskKind(path: string): Promise<Kind> {
  try {
    const s = await Deno.stat(path);
    return s.isDirectory ? "dir" : "file";
  } catch {
    return "none";
  }
}

/** Whether some live overlay file or directory sits below `dir`. */
function overlayHasChildren(o: Overlay, dir: string): boolean {
  const prefix = dir.endsWith(SEPARATOR) ? dir : dir + SEPARATOR;
  for (const [p, e] of o.files) {
    if (e.kind !== "deleted" && p.startsWith(prefix)) return true;
  }
  for (const d of o.dirs) if (d.startsWith(prefix)) return true;
  return false;
}

/** What `path` is once the overlay is applied over the disk. */
async function mergedKind(o: Overlay, path: string): Promise<Kind> {
  const e = o.files.get(path);
  if (e) return e.kind === "deleted" ? "none" : "file";
  if (o.dirs.has(path)) return "dir";
  if (overlayHasChildren(o, path)) return "dir";
  if (o.removedDirs.has(path)) return "none";
  return await diskKind(path);
}

/** Directory entries of `dir` as the overlay sees them (disk listing plus planned changes). */
async function mergedEntries(o: Overlay, dir: string): Promise<Deno.DirEntry[]> {
  if ((await mergedKind(o, dir)) !== "dir") throw notFound(dir);
  const byName = new Map<string, Deno.DirEntry>();
  try {
    for await (const e of Deno.readDir(dir)) {
      const kind = await mergedKind(o, join(dir, e.name));
      if (kind !== "none") byName.set(e.name, entry(e.name, kind));
    }
  } catch {
    // a directory that exists only in the overlay
  }
  const prefix = dir.endsWith(SEPARATOR) ? dir : dir + SEPARATOR;
  const live = [
    ...[...o.files].filter(([, e]) => e.kind !== "deleted").map(([p]) => p),
    ...o.dirs,
  ];
  for (const p of live) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const name = rest.split(SEPARATOR)[0];
    if (!name || byName.has(name)) continue;
    byName.set(name, entry(name, await mergedKind(o, join(dir, name))));
  }
  return [...byName.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function entry(name: string, kind: Kind): Deno.DirEntry {
  return { name, isFile: kind === "file", isDirectory: kind === "dir", isSymlink: false };
}

/** Mark `dir` and its missing ancestors as created. */
async function markDirs(o: Overlay, dir: string): Promise<void> {
  let cur = dir;
  while ((await mergedKind(o, cur)) !== "dir") {
    o.dirs.add(cur);
    o.removedDirs.delete(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}

async function overlayRead(o: Overlay, path: string): Promise<string> {
  const e = o.files.get(path);
  if (e?.kind === "text") return e.text;
  if (e?.kind === "moved") return await Deno.readTextFile(e.from);
  if (e?.kind === "deleted" || o.removedDirs.has(path)) throw notFound(path);
  return await Deno.readTextFile(path);
}

async function overlayRemove(o: Overlay, path: string): Promise<void> {
  const kind = await mergedKind(o, path);
  if (kind === "none") throw notFound(path);
  if (kind === "file") {
    o.files.set(path, { kind: "deleted" });
    return;
  }
  if ((await mergedEntries(o, path)).length > 0) {
    throw new Error(`Directory not empty: ${path}`);
  }
  o.dirs.delete(path);
  o.removedDirs.add(path);
}

async function overlayRename(o: Overlay, from: string, to: string): Promise<void> {
  if ((await mergedKind(o, from)) !== "file") throw notFound(from);
  const e = o.files.get(from);
  const moved: Entry = e?.kind === "text"
    ? { kind: "text", text: e.text }
    : { kind: "moved", from: e?.kind === "moved" ? e.from : from };
  await markDirs(o, dirname(to));
  o.files.set(to, moved);
  o.files.set(from, { kind: "deleted", movedTo: to });
}

/**
 * The file operations the migrate planners use. Each is the `Deno.*` call of the same name,
 * except inside {@link dryRunMigration}, where it reads through and writes to the overlay.
 */
export const mfs = {
  async readTextFile(path: string): Promise<string> {
    const o = active;
    return o ? await overlayRead(o, resolve(path)) : await Deno.readTextFile(path);
  },
  async writeTextFile(path: string, text: string): Promise<void> {
    const o = active;
    if (!o) return await Deno.writeTextFile(path, text);
    const abs = resolve(path);
    await markDirs(o, dirname(abs));
    o.files.set(abs, { kind: "text", text });
  },
  async mkdir(path: string, options?: Deno.MkdirOptions): Promise<void> {
    const o = active;
    if (!o) return await Deno.mkdir(path, options);
    await markDirs(o, resolve(path));
  },
  async remove(path: string): Promise<void> {
    const o = active;
    if (!o) return await Deno.remove(path);
    await overlayRemove(o, resolve(path));
  },
  async rename(from: string, to: string): Promise<void> {
    const o = active;
    if (!o) return await Deno.rename(from, to);
    await overlayRename(o, resolve(from), resolve(to));
  },
  async stat(path: string): Promise<MigrateStat> {
    const o = active;
    if (!o) return await Deno.stat(path);
    const kind = await mergedKind(o, resolve(path));
    if (kind === "none") throw notFound(path);
    return { isFile: kind === "file", isDirectory: kind === "dir" };
  },
  async *readDir(path: string): AsyncGenerator<Deno.DirEntry> {
    const o = active;
    if (!o) {
      yield* Deno.readDir(path);
      return;
    }
    yield* await mergedEntries(o, resolve(path));
  },
};

/** The change one overlay entry stands for, or null when the disk already matches it. */
async function plannedChange(
  path: string,
  e: Entry,
  rel: (p: string) => string,
): Promise<PlannedChange | null> {
  if (e.kind === "moved") return { path: rel(path), action: "move", from: rel(e.from) };
  if (e.kind === "deleted") {
    // A move's source is reported with the move; a planned-then-dropped file never existed.
    const gone = e.movedTo || (await diskKind(path)) === "none";
    return gone ? null : { path: rel(path), action: "delete" };
  }
  const current = await Deno.readTextFile(path).catch(() => null);
  if (current === e.text) return null;
  return { path: rel(path), action: current === null ? "create" : "modify", content: e.text };
}

/** Compare the overlay with the disk: the changes a real run would make, sorted by path. */
async function plannedChanges(o: Overlay, root: string): Promise<PlannedChange[]> {
  // A filesystem root (`/`, `C:\`) already ends in the separator.
  const prefix = root.endsWith(SEPARATOR) ? root : root + SEPARATOR;
  const rel = (p: string) =>
    (p.startsWith(prefix) ? p.slice(prefix.length) : p).replace(/\\/g, "/");
  const out: PlannedChange[] = [];
  for (const [path, e] of o.files) {
    const change = await plannedChange(path, e, rel);
    if (change) out.push(change);
  }
  return out.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/**
 * Run `fn` (a migration of the project at `root`) against an in-memory overlay: nothing is
 * written, moved or removed on disk. Returns `fn`'s result and the changes it would have made.
 * A throw from `fn` propagates (the caller reports it).
 */
export async function dryRunMigration<T>(
  root: string,
  fn: () => Promise<T>,
): Promise<{ result: T; changes: PlannedChange[] }> {
  if (active) throw new Error("denext migrate: a dry run is already in progress");
  const overlay: Overlay = { files: new Map(), dirs: new Set(), removedDirs: new Set() };
  active = overlay;
  let result: T;
  try {
    result = await fn();
  } finally {
    active = null;
  }
  return { result, changes: await plannedChanges(overlay, resolve(root)) };
}
