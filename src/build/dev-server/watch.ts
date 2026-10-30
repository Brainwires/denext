// The file watcher: debounce a burst of changes, then choose the cheapest way to apply
// it — a CSS hot-swap, a per-module HMR update, a whole-route Fast Refresh, or a full
// reload — and kick off the async type-check.

import { cachedGraphHas, resetModuleGraphCache } from "../module-graph.ts";
import { clearLiveCacheResults } from "../../server/cache.ts";
import { forgetTaggedClients } from "../../runtime/client-reference.ts";
import { forgetTaggedServers } from "../../runtime/server-action.ts";
import { getPluginPrepareWatchDirs, runMatchingPrepareSteps } from "../../plugin/mod.ts";
import { withBuildDirLock } from "../project-locks.ts";
import { outsideLockTasks } from "../file-lock.ts";
import type { PluginPrepareContext } from "../../plugin/mod.ts";
import { basename, extname, join, SEPARATOR } from "@std/path";
import { typeCheck } from "./dev-endpoints.ts";
import { getUnbundled } from "./manifest.ts";
import { reactNativeOptions } from "../../server/config.ts";
import { broadcast, broadcastUpdate, closeReloadClients } from "./reload.ts";
import type { DevState } from "./state.ts";
import { watchPlatformFiles } from "./platform.ts";
import { isSelfWrite } from "../self-writes.ts";
import { watchProjectStructure } from "../platform-watch.ts";
import { workspaceMemberDirs } from "../workspace-imports.ts";

/**
 * Whether a change set can be handled by Fast Refresh (re-import the route entry,
 * preserving state) rather than a full reload. Only JSX component modules qualify:
 * `.css`/assets need a stylesheet refetch, and `.ts` server/config/middleware edits need
 * the server to re-render. Empty → reload. In React Native mode `.js` holds JSX too.
 */
function refreshable(st: DevState, changedPaths: string[]): boolean {
  if (changedPaths.length === 0) return false;
  const { middlewarePath, publicDir } = st.paths;
  const component = reactNativeOptions(st.paths.config) ? /\.(tsx|jsx|js)$/ : /\.(tsx|jsx)$/;
  return changedPaths.every((p) => {
    if (!component.test(p)) return false;
    if (middlewarePath && p === middlewarePath) return false;
    if (publicDir && p.startsWith(publicDir)) return false;
    return true;
  });
}

/**
 * True when every change is a stylesheet — a CSS hot-swap (re-fetch the `<link>`) instead
 * of a full reload. The route CSS endpoint is rebuilt per generation, so a cache-busted
 * refetch picks up the edit with no reload.
 */
function cssOnly(changedPaths: string[]): boolean {
  return changedPaths.length > 0 && changedPaths.every((p) => p.endsWith(".css"));
}

/**
 * Unbundled dev loop: hot-swap only the changed accept-boundary module(s). A change the
 * unbundled client graph does not own (a flight-route island, a bundled/MDX route's
 * component) still Fast-Refreshes in place through the bundled whole-entry path; a module
 * ON an unbundled route that changed structurally (propagated to the route entry) needs a
 * full reload.
 */
async function applyUnbundledChange(st: DevState, changedPaths: string[]): Promise<void> {
  const unbundled = getUnbundled(st);
  const { updates, reload, unknownOnly } = unbundled.onChange(changedPaths);
  // React Native mode: an edit importing a name its dependency bundle lacks rebuilds it, and the
  // rebuild reloads the page — a hot-swap now would link against the old bundle.
  if (await unbundled.refreshDeps()) return;
  if (updates.length > 0 && !reload) broadcastUpdate(st, updates);
  else if (unknownOnly) broadcast(st, "refresh");
  else broadcast(st, "reload");
}

/** Start a new generation: bust the module, graph and bundle caches. */
function bumpGeneration(st: DevState): void {
  st.generation++;
  st.manifest = null;
  resetModuleGraphCache(); // the import graph may have changed shape
  clearLiveCacheResults(); // in-process "use cache" trees are keyed by module URL, not content
  // Re-tag the boundary on the next render or action: an edited island or `"use server"` module
  // is a new instance (its copy), and must be tagged and registered again.
  forgetTaggedClients();
  forgetTaggedServers();
  st.bundleCache.clear();
  st.chunkCache.clear();
}

/**
 * A platform file came or went (anywhere in the project, not only the watched folders): the
 * scan was forgotten, so every import may resolve to another file. Start a new generation,
 * drop the per-module loop's transforms (each names the files its imports resolved to) and
 * reload the page.
 */
function applyPlatformFilesChange(st: DevState): void {
  bumpGeneration(st);
  st.unbundled?.invalidateTransforms();
  broadcast(st, "reload");
}

/**
 * Apply one debounced change set: bump the generation (busting module + bundle caches),
 * type-check off the render path, then pick CSS hot-swap / HMR update / Fast Refresh /
 * full reload.
 */
function applyChanges(st: DevState, changedPaths: string[]): void {
  // Before the new generation's loaders exist: each edited module (and its importers) renders
  // as a fresh copy from now on.
  st.devCopies.markEdited(changedPaths);
  bumpGeneration(st);
  typeCheck(st, changedPaths);
  // React Native mode: a changed dependency manifest drops the dependency bundle (the reload
  // such an edit gets rebuilds it).
  void st.unbundled?.depsInvalidated(changedPaths);
  if (cssOnly(changedPaths)) broadcast(st, "css");
  else if (st.unbundledActive && refreshable(st, changedPaths)) {
    void applyUnbundledChange(st, changedPaths).catch((err) => {
      console.warn(`denext: hot update failed, reloading — ${err}`);
      broadcast(st, "reload");
    });
  } else {
    // Bundled path: source-only edits Fast-Refresh (whole route entry); everything else
    // (assets/middleware/server) needs a full reload.
    broadcast(st, refreshable(st, changedPaths) ? "refresh" : "reload");
  }
}

/**
 * Config files: the project's own deno.json (not the framework's) plus
 * denext.config.{ts,js}. A change there can't be hot-applied in-process — most config is
 * captured at startup — so they are watched to print an honest "restart to apply" note
 * rather than silently ignoring the edit.
 */
function configFilesOf(st: DevState): Set<string> {
  const files = new Set<string>();
  if (st.paths.configPath.startsWith(st.paths.projectDir)) files.add(st.paths.configPath);
  for (const name of ["denext.config.ts", "denext.config.js"]) {
    files.add(join(st.paths.projectDir, name));
  }
  return files;
}

/** The context a prepare re-run gets in dev (mirrors the build-time context). */
function prepareContext(st: DevState): PluginPrepareContext {
  return {
    projectRoot: st.paths.projectDir,
    appDir: st.paths.appDir,
    outDir: st.paths.outDir,
    config: st.paths.config ?? {},
  };
}

/** The existing paths to watch (Deno.watchFs throws NotFound for a missing one). */
function watchedPaths(st: DevState, configFiles: Set<string>): string[] {
  const candidates = [
    st.paths.appDir,
    st.paths.publicDir,
    ...configFiles,
    // Directories a plugin prepare step watches (e.g. a content-collections `content/` tree +
    // `content.config.ts`) so editing content regenerates its types/store live.
    ...getPluginPrepareWatchDirs(st.paths.projectDir),
  ];
  if (st.paths.middlewarePath) candidates.push(st.paths.middlewarePath);
  return candidates.filter((p) => {
    try {
      Deno.statSync(p);
      return true;
    } catch {
      return false;
    }
  });
}

/** The file kinds a project-wide content edit can be: modules, data and stylesheets. */
const EDITED_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".json",
  ".css",
  ".md",
  ".mdx",
]);

/**
 * A filter over the project-wide watcher's paths (../platform-watch.ts) for the change sets the
 * folder watcher does not already deliver: a source file outside the watched paths (each as
 * given and through its real path) and not one of denext's own writes, which the app's module
 * graph reaches — a stylesheet always (route CSS is crawled apart), and any file when no crawl is
 * cached to ask.
 */
function outsideEdits(
  projectDir: string,
  watched: readonly string[],
): (paths: string[]) => string[] {
  const roots = new Set<string>();
  for (const p of watched) {
    roots.add(p);
    try {
      roots.add(Deno.realPathSync(p));
    } catch { /* gone */ }
  }
  const covered = (p: string) =>
    [...roots].some((r) => p === r || p.startsWith(r.endsWith(SEPARATOR) ? r : r + SEPARATOR));
  return (paths) =>
    [...new Set(paths)].filter((p) => {
      const ext = extname(p);
      if (!EDITED_EXTS.has(ext) || covered(p) || isSelfWrite(p)) return false;
      return ext === ".css" || cachedGraphHas(p, projectDir) !== false;
    });
}

/** How long after the watchers start an event can still be a replay of a write made before. */
const STARTUP_REPLAY_MS = 2000;

/**
 * Whether `path`'s change event is a replay of a write made before the watchers started, not an
 * edit: macOS's FSEvents delivers the recent history of a folder to a new watch, so the files a
 * scaffold or a checkout wrote just before `denext dev` arrived as edits — a config "changed"
 * note, a new generation in the middle of the first render (its actions forgotten while it
 * tagged them), copies of untouched modules. Within {@linkcode STARTUP_REPLAY_MS} of the start,
 * an event for a file last modified before the start is dropped; later events, and one for a
 * file that is gone, always count (an extracted archive keeps old mtimes on purpose).
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
  return mtime !== null && mtime < startedAt;
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
 * Split a change set into config edits (restart note) and the rest (rebuild). Config edits
 * are classified by BASENAME: Deno.watchFs may report realpath-resolved event paths (e.g.
 * `/private/var/…` on macOS) that won't string-equal the logical config paths.
 */
function handleChangeSet(st: DevState, configBasenames: Set<string>, changedPaths: string[]): void {
  const configChanged = changedPaths.filter((p) => configBasenames.has(basename(p)));
  const rest = changedPaths.filter((p) => !configBasenames.has(basename(p)));
  if (configChanged.length > 0) {
    const names = configChanged.map((p) => p.split("/").pop()).join(", ");
    console.log(`\n  ⚠  ${names} changed — restart the dev server to apply config changes.\n`);
  }
  if (rest.length > 0) applyChanges(st, rest);
}

/**
 * Watch the other members of the app's Deno workspace (`packages/ui` beside `apps/web`): an edit
 * to a package the app imports by name reaches the dev loop like an edit under `components/`.
 * Each member is watched with the project-wide watch's skip rules (its `node_modules`, dot-folders
 * and build output never report).
 *
 * @param st The dev state.
 * @param onEdit Called with each burst of changed paths.
 */
async function watchWorkspaceMembers(
  st: DevState,
  onEdit: (paths: string[]) => void,
): Promise<void> {
  for (const dir of await workspaceMemberDirs(st.paths.projectDir)) {
    watchProjectStructure(dir, () => {}, st.options.signal, onEdit);
  }
}

/**
 * Watch app + public dirs (and middleware/config), and every other project source through the
 * project-wide watch, and invalidate on change. Closes cleanly on shutdown so the watchers and
 * live-reload streams don't outlive the server.
 */
export async function watch(st: DevState): Promise<void> {
  const configFiles = configFilesOf(st);
  const configBasenames = new Set([...configFiles].map((p) => basename(p)));
  const watched = watchedPaths(st, configFiles);
  // Before the watches open: a file written before this instant is not an edit (startupReplay).
  const startedAt = Date.now();
  const watcher = Deno.watchFs(watched, { recursive: true });
  let debounce: ReturnType<typeof setTimeout> | undefined;
  // Accumulate the paths changed during a debounce window so the refresh-vs-reload
  // decision sees the whole burst.
  let changed: string[] = [];
  const queue = (events: readonly string[]) => {
    const now = Date.now();
    const paths = events.filter((p) => !startupReplay(p, startedAt, now));
    if (paths.length === 0) return;
    changed.push(...paths);
    if (debounce) clearTimeout(debounce);
    // Outside every lock task: a batch is its own rebuild, never part of one whose `import()`
    // left its context behind (stock Deno).
    debounce = setTimeout(() =>
      outsideLockTasks(() => {
        const changedPaths = changed;
        changed = [];
        // Regenerate any plugin prepare outputs whose watch globs matched FIRST (awaited), so the
        // reload the change set triggers serves freshly generated types/store — then apply the
        // set. Under the build-dir lock: this is one dev rebuild's codegen into `.denext/`.
        void withBuildDirLock(
          st.paths.projectDir,
          () => runMatchingPrepareSteps(prepareContext(st), changedPaths),
        )
          .catch(() => false)
          .finally(() => handleChangeSet(st, configBasenames, changedPaths));
      }), 60);
  };
  // The project-wide watch (one walk's skip rules: dot-folders, node_modules, build output) also
  // delivers content edits outside the watched folders — `components/X.tsx` — as the same
  // change sets an edit under `app/` makes.
  const outside = outsideEdits(st.paths.projectDir, watched);
  watchPlatformFiles(st, () => applyPlatformFilesChange(st), (paths) => queue(outside(paths)));
  await watchWorkspaceMembers(st, (paths) => queue(outside(paths)));
  st.options.signal?.addEventListener("abort", () => {
    try {
      watcher.close();
    } catch { /* already closed */ }
    closeReloadClients(st);
    // Release the unbundled dev loop's esbuild service (no-op if it never started).
    void st.unbundled?.stop();
  });
  try {
    for await (const event of watcher) queue(event.paths);
  } catch { /* watcher closed on shutdown */ }
}
