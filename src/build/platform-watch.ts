// `denext dev`: which files exist, for the platform-file scan (./platform-extensions.ts).
//
// The dev servers' own watchers cover the app folder and the entry's tree; a platform file can
// sit anywhere in the project (`components/Button.ios.tsx`). This watcher reports every created,
// removed or renamed path in the project's source folders, so the scan is redone only when
// the set of files changes: content edits never rescan. It watches each top-level folder a scan
// enters (recursively) and the root itself (not recursively), and re-arms when a top-level
// folder comes or goes, so `node_modules`, dot-folders and build output are never watched.

import { join, resolve } from "@std/path";
import { isScannedDir } from "./platform-extensions.ts";

/** The event kinds that change which files exist. */
const STRUCTURAL: ReadonlySet<Deno.FsEvent["kind"]> = new Set(["create", "remove", "rename"]);

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
 * `onChange` (debounced), until `signal` aborts.
 *
 * @param rootDir The project root.
 * @param onChange Called with the paths of one burst.
 * @param signal Stops watching.
 */
export function watchProjectStructure(
  rootDir: string,
  onChange: (paths: string[]) => void,
  signal?: AbortSignal,
): void {
  const root = resolve(rootDir);
  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const report = (paths: string[]) => {
    pending.push(...paths);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const burst = pending;
      pending = [];
      onChange(burst);
    }, 60);
  };
  let folders: Deno.FsWatcher | null = null;
  let dirs = "";
  const consume = async (watcher: Deno.FsWatcher, onEvent: (event: Deno.FsEvent) => void) => {
    try {
      for await (const event of watcher) if (STRUCTURAL.has(event.kind)) onEvent(event);
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
    void consume(folders, (event) => report(event.paths));
  };
  arm();
  let rootWatcher: Deno.FsWatcher | null = null;
  try {
    rootWatcher = Deno.watchFs(root, { recursive: false });
    void consume(rootWatcher, (event) => {
      arm();
      report(event.paths);
    });
  } catch { /* no root */ }
  signal?.addEventListener("abort", () => {
    if (timer) clearTimeout(timer);
    for (const w of [folders, rootWatcher]) {
      try {
        w?.close();
      } catch { /* already closed */ }
    }
  });
}
