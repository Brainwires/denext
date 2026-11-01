// `denext dev`: which files exist, for the platform-file scan (./platform-extensions.ts), and
// which files' contents changed anywhere in the project.
//
// The dev servers' own watchers cover the app folder and the entry's tree; a platform file can
// sit anywhere in the project (`components/Button.ios.tsx`). This watcher reports every created,
// removed or renamed path in the project's source folders, so the scan is redone only when
// the set of files changes: content edits never rescan. It watches each top-level folder a scan
// enters (recursively) and the root itself (not recursively), and re-arms when a top-level
// folder comes or goes, so `node_modules`, dot-folders and build output are never watched.
// Given `onEdit`, it also reports every changed path (content edits included) outside the
// folders a scan skips at any depth, so an edit to `components/X.tsx` reaches the dev loop.
// Neither report includes what a new watch replays of the writes made before it opened.

import { join, relative, resolve } from "@std/path";
import { isScannedDir } from "./platform-extensions.ts";

/** The event kinds that change which files exist. */
const STRUCTURAL: ReadonlySet<Deno.FsEvent["kind"]> = new Set(["create", "remove", "rename"]);

/** The event kinds that change a file: its contents, or whether it exists. */
const CHANGES: ReadonlySet<Deno.FsEvent["kind"]> = new Set([...STRUCTURAL, "modify"]);

/** How long after the watchers start an event can still be a replay of a write made before. */
const STARTUP_REPLAY_MS = 2000;

/**
 * Whether `path`'s change event is a replay of a write made before the watchers started, not an
 * edit: macOS's FSEvents delivers the recent history of a folder to a new watch, so the files a
 * scaffold or a checkout wrote just before `denext dev` arrived as edits — a config "changed"
 * note, a new generation in the middle of the first render (its actions forgotten while it
 * tagged them, its island routes recrawled), copies of untouched modules, a reload for a page
 * nothing changed. Within {@linkcode STARTUP_REPLAY_MS} of the start, an event for a file last
 * modified no later than the start's millisecond is dropped (a write made just before the watch
 * opens can share that millisecond; no edit made after it realistically does); later events, and
 * one for a file that is gone, always count (an extracted archive keeps old mtimes on purpose).
 *
 * @param path The event's path.
 * @param startedAt When the watchers started (epoch ms).
 * @param now The time the event arrived (epoch ms).
 * @param mtimeOf The file's modification time (epoch ms), or null when it can't be read.
 * @returns Whether to drop the event.
 */
export function startupReplay(
  path: string,
  startedAt: number,
  now: number,
  mtimeOf: (path: string) => number | null = statMtime,
): boolean {
  if (now - startedAt > STARTUP_REPLAY_MS) return false;
  const mtime = mtimeOf(path);
  return mtime !== null && mtime <= startedAt;
}

/** `path`'s modification time (epoch ms), or null when it is gone or has none. */
function statMtime(path: string): number | null {
  try {
    return Deno.statSync(path).mtime?.getTime() ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether `path` lies in the project under `roots` (its root as given and as its real path)
 * outside every folder a scan skips, at any depth (a nested `node_modules`, `.denext`, `dist`).
 */
function inScannedTree(roots: readonly string[], path: string): boolean {
  for (const root of roots) {
    const rel = relative(root, path);
    if (rel === "" || rel.startsWith("..")) continue;
    return rel.split(/[\\/]/).slice(0, -1).every(isScannedDir);
  }
  return false;
}

/** A debounced reporter: paths accumulate until 60 ms pass with no more. */
function debounced(onBurst: (paths: string[]) => void) {
  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    report(paths: readonly string[]) {
      if (paths.length === 0) return;
      pending.push(...paths);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const burst = pending;
        pending = [];
        onBurst(burst);
      }, 60);
    },
    stop() {
      if (timer) clearTimeout(timer);
    },
  };
}

/** The top-level folders of `root` a platform scan enters. */
function scannedTopDirs(root: string): string[] {
  const out: string[] = [];
  try {
    for (const entry of Deno.readDirSync(root)) {
      if (entry.isDirectory && isScannedDir(entry.name)) out.push(join(root, entry.name));
    }
  } catch { /* no root */ }
  return out.sort();
}

/**
 * Report each burst of created / removed / renamed paths under `rootDir`'s source folders to
 * `onChange` (debounced), until `signal` aborts; with `onEdit`, also each burst of changed paths
 * (content edits included) outside the folders a scan skips.
 *
 * @param rootDir The project root.
 * @param onChange Called with the paths of one burst.
 * @param signal Stops watching.
 * @param onEdit Called with the paths of one burst of changes of any kind.
 */
export function watchProjectStructure(
  rootDir: string,
  onChange: (paths: string[]) => void,
  signal?: AbortSignal,
  onEdit?: (paths: string[]) => void,
): void {
  const root = resolve(rootDir);
  const roots = [root];
  try {
    const real = Deno.realPathSync(root);
    if (real !== root) roots.push(real); // a watcher may report paths through the real path
  } catch { /* no root */ }
  const structure = debounced(onChange);
  const edits = onEdit ? debounced(onEdit) : null;
  // Before the watches open: a file written before this instant did not change anything.
  const startedAt = Date.now();
  const report = (event: Deno.FsEvent) => {
    const now = Date.now();
    const paths = event.paths.filter((p) => !startupReplay(p, startedAt, now));
    if (STRUCTURAL.has(event.kind)) structure.report(paths);
    if (edits && CHANGES.has(event.kind)) {
      edits.report(paths.filter((p) => inScannedTree(roots, p)));
    }
  };
  let folders: Deno.FsWatcher | null = null;
  let dirs = "";
  const consume = async (watcher: Deno.FsWatcher, onEvent: (event: Deno.FsEvent) => void) => {
    try {
      for await (const event of watcher) if (CHANGES.has(event.kind)) onEvent(event);
    } catch { /* closed */ }
  };
  // (Re-)watch the top-level folders when the set of them changed.
  const arm = () => {
    const top = scannedTopDirs(root);
    if (top.join("\n") === dirs) return;
    dirs = top.join("\n");
    try {
      folders?.close();
    } catch { /* already closed */ }
    folders = null;
    if (top.length === 0) return;
    try {
      folders = Deno.watchFs(top, { recursive: true });
    } catch {
      return; // a folder vanished between the listing and the watch: the root event re-arms
    }
    void consume(folders, report);
  };
  arm();
  let rootWatcher: Deno.FsWatcher | null = null;
  try {
    rootWatcher = Deno.watchFs(root, { recursive: false });
    void consume(rootWatcher, (event) => {
      if (STRUCTURAL.has(event.kind)) arm();
      report(event);
    });
  } catch { /* no root */ }
  signal?.addEventListener("abort", () => {
    structure.stop();
    edits?.stop();
    for (const w of [folders, rootWatcher]) {
      try {
        w?.close();
      } catch { /* already closed */ }
    }
  });
}
