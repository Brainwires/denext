// The file watcher: debounce a burst of changes, then choose the cheapest way to apply
// it — a CSS hot-swap, a per-module HMR update, a whole-route Fast Refresh, or a full
// reload — and kick off the async type-check.

import { resetModuleGraphCache } from "../module-graph.ts";
import { basename, join } from "@std/path";
import { typeCheck } from "./dev-endpoints.ts";
import { getUnbundled } from "./manifest.ts";
import { broadcast, broadcastUpdate, closeReloadClients } from "./reload.ts";
import type { DevState } from "./state.ts";

/**
 * Whether a change set can be handled by Fast Refresh (re-import the route entry,
 * preserving state) rather than a full reload. Only JSX component modules qualify:
 * `.css`/assets need a stylesheet refetch, and `.ts` server/config/middleware edits need
 * the server to re-render. Empty → reload.
 */
function refreshable(st: DevState, changedPaths: string[]): boolean {
  if (changedPaths.length === 0) return false;
  const { middlewarePath, publicDir } = st.paths;
  return changedPaths.every((p) => {
    if (!/\.(tsx|jsx)$/.test(p)) return false;
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
function applyUnbundledChange(st: DevState, changedPaths: string[]): void {
  const { updates, reload, unknownOnly } = getUnbundled(st).onChange(changedPaths);
  if (updates.length > 0 && !reload) broadcastUpdate(st, updates);
  else if (unknownOnly) broadcast(st, "refresh");
  else broadcast(st, "reload");
}

/**
 * Apply one debounced change set: bump the generation (busting module + bundle caches),
 * type-check off the render path, then pick CSS hot-swap / HMR update / Fast Refresh /
 * full reload.
 */
function applyChanges(st: DevState, changedPaths: string[]): void {
  st.generation++;
  st.manifest = null;
  resetModuleGraphCache(); // the import graph may have changed shape
  st.bundleCache.clear();
  st.chunkCache.clear();
  typeCheck(st, changedPaths);
  if (cssOnly(changedPaths)) broadcast(st, "css");
  else if (st.unbundledActive && refreshable(st, changedPaths)) {
    applyUnbundledChange(st, changedPaths);
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

/** The existing paths to watch (Deno.watchFs throws NotFound for a missing one). */
function watchedPaths(st: DevState, configFiles: Set<string>): string[] {
  const candidates = [st.paths.appDir, st.paths.publicDir, ...configFiles];
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
 * Watch app + public dirs (and middleware/config) and invalidate on change. Closes cleanly
 * on shutdown so the watcher and live-reload streams don't outlive the server.
 */
export async function watch(st: DevState): Promise<void> {
  const configFiles = configFilesOf(st);
  const configBasenames = new Set([...configFiles].map((p) => basename(p)));
  const watcher = Deno.watchFs(watchedPaths(st, configFiles), { recursive: true });
  st.options.signal?.addEventListener("abort", () => {
    try {
      watcher.close();
    } catch { /* already closed */ }
    closeReloadClients(st);
    // Release the unbundled dev loop's esbuild service (no-op if it never started).
    void st.unbundled?.stop();
  });
  let debounce: ReturnType<typeof setTimeout> | undefined;
  // Accumulate the paths changed during a debounce window so the refresh-vs-reload
  // decision sees the whole burst.
  let changed: string[] = [];
  try {
    for await (const event of watcher) {
      for (const p of event.paths) changed.push(p);
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        const changedPaths = changed;
        changed = [];
        handleChangeSet(st, configBasenames, changedPaths);
      }, 60);
    }
  } catch { /* watcher closed on shutdown */ }
}
