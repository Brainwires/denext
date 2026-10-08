// SPA mode dev server: the plugin seams `denext dev` runs for the App Router (see
// dev-server/dev-app.ts and dev-server/watch.ts). The config's plugins are set up and their
// prepare steps (codegen the app imports, e.g. content-collections' types and store) run at
// startup, before the first bundle; a step re-runs when a file under its `watch` globs changes,
// and the page reloads onto the regenerated output. Build steps stay a build's / an export's.

import { defaultLoader } from "../../server/mod.ts";
import {
  applyPlugins,
  getPluginPrepareWatchDirs,
  type PluginPrepareContext,
  runMatchingPrepareSteps,
  runPluginPrepareSteps,
  runPluginTeardown,
} from "../../plugin/mod.ts";
import { withBuildDirLock } from "../project-locks.ts";
import { isSelfWrite } from "../self-writes.ts";
import { hasPathSegment, inNodeModules } from "../path-segments.ts";
import { broadcastFrame, type SpaDevState } from "./dev-state.ts";
import { watchBatches } from "./dev-watch.ts";

/** The context a prepare step gets in SPA dev (the build-time one). */
function prepareContext(st: SpaDevState): PluginPrepareContext {
  return {
    projectRoot: st.paths.projectDir,
    appDir: st.paths.appDir,
    outDir: st.paths.outDir,
    config: st.paths.config ?? {},
  };
}

/**
 * Set the config's plugins up (mode `dev`) and run their prepare steps under the build-dir lock.
 * A step that fails is logged, not fatal. A SPA without plugins pays nothing.
 */
async function setUpPlugins(st: SpaDevState): Promise<void> {
  await applyPlugins({
    projectRoot: st.paths.projectDir,
    appDir: st.paths.appDir,
    config: st.paths.config ?? {},
    mode: "dev",
    load: defaultLoader,
  });
  await withBuildDirLock(st.paths.projectDir, () => runPluginPrepareSteps(prepareContext(st)));
}

/** The existing directories the prepare steps' `watch` globs name. */
function prepareWatchDirs(st: SpaDevState): string[] {
  return getPluginPrepareWatchDirs(st.paths.projectDir).filter((p) => {
    try {
      Deno.statSync(p);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Re-run the prepare steps whose `watch` globs a debounced batch of edits matches; when one ran,
 * the bundle is stale (it imports the regenerated output): rebuild and reload the page.
 */
function watchPrepareInputs(st: SpaDevState): void {
  const dirs = prepareWatchDirs(st);
  if (dirs.length === 0) return;
  const watcher = Deno.watchFs(dirs, { recursive: true });
  st.options.signal?.addEventListener("abort", () => {
    try {
      watcher.close();
    } catch { /* already closed */ }
  }, { once: true });
  // A step writes into the build output: never a source edit (no regenerate → reload loop).
  const ignored = (p: string) =>
    p.startsWith(st.paths.outDir) || inNodeModules(p) || hasPathSegment(p, ".git") ||
    isSelfWrite(p);
  watchBatches(watcher, ignored, (batch) => void regenerate(st, batch));
}

/** Re-run the prepare steps `batch` matches; when one ran, rebuild and reload onto its output. */
async function regenerate(st: SpaDevState, batch: string[]): Promise<void> {
  const ran = await withBuildDirLock(
    st.paths.projectDir,
    () => runMatchingPrepareSteps(prepareContext(st), batch),
  ).catch(() => false);
  if (!ran) return;
  st.generation++;
  st.devDir = null;
  st.unbundled?.invalidateTransforms();
  broadcastFrame(st, "reload");
}

/**
 * Start the SPA dev server's plugin seams: set up + prepare now (the first bundle waits on
 * `st.pluginsReady`), then watch the prepare steps' inputs; plugin teardowns run on shutdown.
 */
export function startSpaDevPlugins(st: SpaDevState): void {
  if ((st.paths.config?.plugins ?? []).length === 0) return;
  st.pluginsReady = setUpPlugins(st)
    .catch((error) => console.error("denext: plugin setup failed:", error))
    .then(() => {
      if (!st.options.signal?.aborted) watchPrepareInputs(st);
    });
  st.options.signal?.addEventListener("abort", () => void runPluginTeardown(), { once: true });
}
