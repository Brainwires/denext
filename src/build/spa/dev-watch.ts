// SPA mode dev server: watch the entry's source tree + public/, invalidating the cached
// bundle and deciding the live-reload action for each debounced batch of edits.

import { resolve } from "@std/path";
import { stopNextCompat } from "../next-compat.ts";
import {
  broadcastFrame,
  broadcastUpdate,
  ensureUnbundled,
  getUnbundledCss,
  type SpaDevState,
} from "./dev-state.ts";
import { classifySpaChange } from "./shared.ts";

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
  if (batch.every((p) => p.endsWith(".css"))) {
    await getUnbundledCss(st);
    broadcastFrame(st, "css");
    return;
  }
  if (!isSwappableBatch(batch, entryPath, paths.publicDir)) {
    broadcastFrame(st, classifySpaChange(batch, entryPath, paths.publicDir));
    return;
  }
  broadcastHmr(st, st.unbundled!.onChange(batch));
}

/** Only component-module edits (not the entry, not a public asset) can hot-swap per module. */
function isSwappableBatch(batch: string[], entryPath: string, publicDir: string): boolean {
  return batch.every((p) => /\.(tsx|jsx)$/.test(p)) &&
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
async function flushBatch(st: SpaDevState, batch: string[]): Promise<void> {
  st.generation++;
  st.devDir = null;
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
 * (so its dir contains outDir). Changed paths accumulate across a 60 ms debounce window
 * so the flush can decide Fast Refresh vs a full reload for the whole batch.
 */
export function watch(st: SpaDevState): void {
  const { paths } = st;
  const watched = existingPaths([resolve(st.entryPath, ".."), paths.publicDir]);
  if (watched.length === 0) return;
  const watcher = Deno.watchFs(watched, { recursive: true });
  installShutdown(st, watcher);
  const ignored = (p: string): boolean =>
    p.startsWith(paths.outDir) || p.includes("/node_modules/") || p.includes("/.git/");
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
          void flushBatch(st, batch);
        }, 60);
      }
    } catch { /* watcher closed on shutdown */ }
  })();
}
