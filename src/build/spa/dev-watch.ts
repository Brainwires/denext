// SPA mode dev server: watch the entry's source tree + public/, invalidating the cached
// bundle and deciding the live-reload action for each debounced batch of edits.

import { resolve } from "@std/path";
import { reactNativeOptions } from "../../server/config.ts";
import { stopNextCompat } from "../next-compat.ts";
import {
  broadcastFrame,
  broadcastUpdate,
  ensureUnbundled,
  getUnbundledCss,
  type SpaDevState,
} from "./dev-state.ts";
import { classifySpaChange } from "./shared.ts";
import { isSelfWrite } from "../self-writes.ts";
import { isFrameworkPath, linkedFrameworkDir } from "./framework-watch.ts";
import { hasPathSegment, inNodeModules } from "../path-segments.ts";
import { createPlatformScanner, keepPlatformScanner } from "../platform-extensions.ts";
import { watchProjectStructure } from "../platform-watch.ts";

/**
 * Keep one platform-file scan for the session (every rebuild's redirects come from it) and
 * forget it when a platform file comes or goes anywhere in the project: then rebuild, drop the
 * per-module loop's transforms (each names the files its imports resolved to) and reload.
 */
function watchPlatformFiles(st: SpaDevState): void {
  const scanner = createPlatformScanner(st.paths.projectDir);
  keepPlatformScanner(scanner, st.options.signal);
  watchProjectStructure(st.paths.projectDir, (changed) => {
    if (!scanner.invalidate(changed)) return;
    st.generation++;
    st.devDir = null;
    st.unbundled?.invalidateTransforms();
    broadcastFrame(st, "reload");
  }, st.options.signal);
}

function existingPaths(candidates: string[]): string[] {
  return candidates.filter((p) => {
    try {
      Deno.statSync(p);
      return true;
    } catch {
      return false;
    }
  });
}

/** On shutdown: close the watcher + every SSE client, and stop the warm build services. */
function installShutdown(st: SpaDevState, watcher: Deno.FsWatcher): void {
  st.options.signal?.addEventListener("abort", () => {
    try {
      watcher.close();
    } catch { /* already closed */ }
    for (const c of st.reloadClients) {
      try {
        c.close();
      } catch { /* already closed */ }
    }
    st.reloadClients.clear();
    // Dev rebuilds keep the esbuild service warm (see bundleSpaInto); stop it once here
    // on shutdown. A no-op if the plain `deno bundle` path was used.
    void stopNextCompat();
    void st.unbundled?.stop();
  });
}

/**
 * Unbundled dev loop: hot-swap only the changed module(s). A CSS edit re-links the
 * extracted stylesheet; a `.tsx/.jsx` component edit updates in place (or falls back to
 * the bundled Fast Refresh / a reload for the entry); anything else is classified like
 * the bundled loop.
 */
async function unbundledAction(st: SpaDevState, batch: string[]): Promise<void> {
  const { entryPath, paths } = st;
  // React Native mode: a dependency manifest, or an added / removed expo-router route, changes
  // the dependency bundle — the reload rebuilds it.
  if (await st.unbundled!.depsInvalidated(batch)) {
    broadcastFrame(st, "reload");
    return;
  }
  if (batch.every((p) => p.endsWith(".css"))) {
    await getUnbundledCss(st);
    broadcastFrame(st, "css");
    return;
  }
  const jsxInJs = reactNativeOptions(paths.config) !== null;
  if (!isSwappableBatch(batch, entryPath, paths.publicDir, jsxInJs)) {
    broadcastFrame(st, classifySpaChange(batch, entryPath, paths.publicDir));
    return;
  }
  const change = st.unbundled!.onChange(batch);
  // React Native mode: an edit importing a name the dependency bundle lacks rebuilds it, and
  // the rebuild reloads the page — a hot-swap now would link against the old bundle.
  if (await st.unbundled!.refreshDeps()) return;
  broadcastHmr(st, change);
}

/**
 * Only component-module edits (not the entry, not a public asset) can hot-swap per module —
 * `.tsx` / `.jsx`, and `.js` in React Native mode (`jsxInJs`: `.js` holds JSX there).
 */
function isSwappableBatch(
  batch: string[],
  entryPath: string,
  publicDir: string,
  jsxInJs: boolean,
): boolean {
  const component = jsxInJs ? /\.(tsx|jsx|js)$/ : /\.(tsx|jsx)$/;
  return batch.every((p) => component.test(p)) &&
    !batch.some((p) => p === entryPath || p.startsWith(publicDir));
}

/** Tell the clients what an HMR decision means: re-import boundaries, refresh, or reload. */
function broadcastHmr(
  st: SpaDevState,
  change: { updates: string[]; reload: boolean; unknownOnly: boolean },
): void {
  if (change.updates.length > 0 && !change.reload) broadcastUpdate(st, change.updates);
  else if (change.unknownOnly) broadcastFrame(st, "refresh");
  else broadcastFrame(st, "reload");
}

/** Invalidate the cached bundle for a batch of edits and tell the clients what to do. */
async function flushBatch(
  st: SpaDevState,
  batch: string[],
  framework: string | null,
): Promise<void> {
  st.generation++;
  st.devDir = null;
  // A framework source (denext run from a checkout): its pre-bundle is rebuilt on the reload.
  if (batch.some((p) => isFrameworkPath(p, framework))) {
    st.unbundled?.invalidateFramework();
    broadcastFrame(st, "reload");
    return;
  }
  if (batch.length > 0 && await ensureUnbundled(st) && st.unbundled) {
    await unbundledAction(st, batch);
    return;
  }
  broadcastFrame(st, classifySpaChange(batch, st.entryPath, st.paths.publicDir));
}

/**
 * Watch the entry's source tree + public/. Events under the build's own output
 * (`.denext/…`), node_modules, or .git are not source edits — ignoring them stops a
 * self-triggered rebuild→reload→rebuild loop when `spa.entry` sits at the project root
 * (so its dir contains outDir). So is a write denext itself made in the tree (the CSS
 * crawl's transient `deno.json` rewrite — see `self-writes.ts`): the file still holds what
 * denext wrote, so it is dropped too. Changed paths accumulate across a 60 ms debounce
 * window so the flush can decide Fast Refresh vs a full reload for the whole batch.
 */
export function watch(st: SpaDevState): void {
  const { paths } = st;
  watchPlatformFiles(st);
  const framework = linkedFrameworkDir();
  const watched = existingPaths([
    resolve(st.entryPath, ".."),
    paths.publicDir,
    ...(framework ? [framework] : []),
  ]);
  if (watched.length === 0) return;
  const watcher = Deno.watchFs(watched, { recursive: true });
  installShutdown(st, watcher);
  const ignored = (p: string): boolean =>
    p.startsWith(paths.outDir) || inNodeModules(p) || hasPathSegment(p, ".git") ||
    isSelfWrite(p);
  watchBatches(watcher, ignored, (batch) => void flushBatch(st, batch, framework));
}

/**
 * Hand `onBatch` each burst of `watcher`'s paths that `ignored` lets through, once 60 ms pass
 * without another (the paths of one burst accumulate, de-duplicated). Ends when the watcher closes.
 */
export function watchBatches(
  watcher: Deno.FsWatcher,
  ignored: (path: string) => boolean,
  onBatch: (batch: string[]) => void,
): void {
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<string>();
  (async () => {
    try {
      for await (const event of watcher) {
        const changed = event.paths.filter((p) => !ignored(p));
        if (changed.length === 0) continue;
        for (const p of changed) pending.add(p);
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          const batch = [...pending];
          pending.clear();
          onBatch(batch);
        }, 60);
      }
    } catch { /* watcher closed on shutdown */ }
  })();
}
