// Discovery for the `tasks/` directory: scan it, import each module, and register its
// default-exported {@linkcode Task}. Kept separate from `./tasks.ts` (the runtime core that user
// task files import `defineTask` from) so that core stays free of the filesystem walk. Runtime
// discovery — like route discovery, denext imports task modules from source at server boot, so no
// build manifest is needed.

import { walk } from "@std/fs";
import { join, toFileUrl } from "@std/path";
import {
  abortTaskRuns,
  collectSchedules,
  isTask,
  registerTask,
  scheduleTasks,
  setTaskRecorder,
} from "./tasks.ts";
import { sqliteTaskHistoryStore, TASK_HISTORY_DB, type TaskHistoryStore } from "./task-history.ts";
import type { TaskHistoryConfig } from "./config.ts";
import { inRootContext } from "./root-context.ts";

/**
 * Discover `tasks/**` under `tasksDir`, import each module, and register the task it
 * default-exports (or names `task`). Returns the discovered names, sorted. A missing directory is
 * fine (returns `[]`); a module that fails to load or lacks a `defineTask` default export is logged
 * and skipped — a bad task file never takes the server down.
 */
export async function discoverTasks(tasksDir: string): Promise<string[]> {
  try {
    if (!(await Deno.stat(tasksDir)).isDirectory) return [];
  } catch {
    return []; // no tasks/ directory
  }
  const found: string[] = [];
  for await (
    const entry of walk(tasksDir, {
      exts: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
      includeDirs: false,
      skip: [/[/\\]\.[^/\\]+/, /[/\\]_/], // dotfiles/dirs and `_private` files
    })
  ) {
    const rel = entry.path.slice(tasksDir.length).replace(/^[/\\]/, "");
    const name = rel.replace(/\.(tsx?|jsx?|mjs)$/, "").replace(/[/\\]/g, "/");
    let mod: Record<string, unknown>;
    try {
      // A task module belongs to no request, even when the first run is triggered by one.
      mod = await inRootContext(() => import(toFileUrl(entry.path).href));
    } catch (err) {
      console.error(`denext: failed to load task "${name}":`, err);
      continue;
    }
    const task = mod.default ?? mod.task;
    if (isTask(task)) {
      registerTask(name, task);
      found.push(name);
    } else {
      console.error(
        `denext: tasks/${rel} does not default-export defineTask(...) — skipped`,
      );
    }
  }
  return found.sort();
}

/**
 * Boot the scheduled-tasks subsystem at server startup: discover `<projectDir>/tasks/**`, then
 * register every schedule (per-task + `config.scheduledTasks`) with `Deno.cron` or the userland
 * scheduler. A no-op — and no log — when the app defines no tasks and no schedules. Returns a
 * disposer that stops the scheduler (for the dev server's re-boots / graceful shutdown).
 */
export async function bootScheduledTasks(
  projectDir: string,
  config: {
    scheduledTasks?: Record<string, string | string[]>;
    tasks?: HistoryConfigSlice;
  } | undefined,
  outDir?: string,
): Promise<() => void> {
  // Before the early return on purpose: an app with no tasks/ directory and no config schedules
  // can still register tasks programmatically and call `runTask` from a route handler, and those
  // runs belong in the history too. Installing costs nothing — the handle opens on the first run.
  const stopRecording = startRunHistory(config, outDir ?? join(projectDir, ".denext"));
  const names = await discoverTasks(join(projectDir, "tasks"));
  const entries = collectSchedules(config?.scheduledTasks);
  if (names.length === 0 && entries.length === 0) return stopRecording;
  const dispose = scheduleTasks(entries);
  console.log(
    `  ${names.length} task(s)` +
      (entries.length ? `, ${entries.length} schedule(s) registered` : " (no schedules)"),
  );
  return () => {
    dispose();
    abortTaskRuns(); // on-demand runs (`runTask` from a route handler) stop with the scheduler
    stopRecording();
  };
}

/** The part of the config the history wiring reads. */
type HistoryConfigSlice = { history?: boolean | TaskHistoryConfig; historyMaxRuns?: number };

/**
 * The configured history store, or `null` when history is off. `custom` says whether the app
 * passed its own (`tasks: { history: { store } }`) — denext owns only the default one.
 *
 * Not re-exported from `server/mod.ts`: denext's own wiring (`denext task --history` and the
 * server boot share it).
 *
 * @param config The project config (only `tasks` is read).
 * @param outDir The build directory the default database lives in.
 * @returns The store and whose it is, or `null`.
 */
export function historyStoreFor(
  config: { tasks?: HistoryConfigSlice } | undefined,
  outDir: string,
): { store: TaskHistoryStore; custom: boolean } | null {
  const history = config?.tasks?.history;
  if (history === true) {
    return {
      store: sqliteTaskHistoryStore({
        path: join(outDir, TASK_HISTORY_DB),
        maxRuns: config?.tasks?.historyMaxRuns,
      }),
      custom: false,
    };
  }
  if (!history || typeof history !== "object") return null;
  if (history.store) return { store: history.store, custom: true };
  return {
    store: sqliteTaskHistoryStore({
      path: join(outDir, TASK_HISTORY_DB),
      maxRuns: history.maxRuns ?? config?.tasks?.historyMaxRuns,
    }),
    custom: false,
  };
}

/** Whether the config turns history on (`true`, or the object form). */
export function historyEnabled(config: { tasks?: HistoryConfigSlice } | undefined): boolean {
  const history = config?.tasks?.history;
  return history === true || (!!history && typeof history === "object");
}

/**
 * Install the run recorder when — and only when — the project asked for it.
 *
 * Exported for `denext task <name>`, which never boots the scheduler and would otherwise record
 * nothing — the one place a human is most likely to look for a manual run. Not re-exported from
 * `server/mod.ts`: it is denext's own wiring, not an app's extension point.
 *
 * This is where "off by default" is decided, deliberately at boot rather than inside `runTask`:
 * a low-level function should not be loading config, and reading it once here means every
 * in-process `runTask` records, whether it came from the scheduler, a route handler or an action.
 *
 * The recorder never waits on the store and swallows anything it throws or rejects with: a run
 * is never failed or delayed by its own bookkeeping, whatever store the app configured.
 *
 * @param config The project config (only `tasks` is read).
 * @param outDir The build directory the default database lives in.
 * @param options `closeCustom`: the disposer also waits for the last writes and closes an
 *   app-supplied store (a one-shot `denext task` process, which ends right after). The server
 *   never closes one: a dev re-boot installs the same config's store again.
 * @returns A function that stops recording and closes the default store. A no-op when history
 *   is off.
 */
export function startRunHistory(
  config: { tasks?: HistoryConfigSlice } | undefined,
  outDir: string,
  options: { closeCustom?: boolean } = {},
): () => Promise<void> {
  const off = () => Promise.resolve();
  if (!historyEnabled(config)) return off;
  if (onDenoDeploy()) {
    // Not refused: the app explicitly asked. But the file is per-isolate and ephemeral there, so
    // what the panel shows is one isolate's fragment that resets when it cycles — and a history
    // that is quietly wrong is worse than none. A latch cannot help, because the write SUCCEEDS.
    // A custom store (Postgres) is shared, so the warning is for the default file only.
    const history = config?.tasks?.history;
    if (!(history && typeof history === "object" && history.store)) {
      console.warn(
        "denext: tasks.history is on, but this is Deno Deploy — .denext/tasks.db is per-isolate " +
          "and ephemeral, so the history you see is one isolate's fragment and resets when it cycles.",
      );
    }
  }
  try {
    const resolved = historyStoreFor(config, outDir);
    if (!resolved) return off;
    const { store, custom } = resolved;
    const pending = new Set<Promise<unknown>>();
    setTaskRecorder((run) => {
      try {
        // In the root context, whatever store it is: `runTask` may run inside a request, and a
        // store's lazily opened connection or timer must not carry that request along.
        const result = inRootContext(() => store.record(run));
        if (result && typeof (result as Promise<void>).then === "function") {
          const settled = Promise.resolve(result).catch(() => {}).finally(() =>
            pending.delete(settled)
          );
          pending.add(settled);
        }
      } catch { /* a store that throws loses its row, never the run */ }
    });
    return async () => {
      setTaskRecorder(null);
      if (custom && !options.closeCustom) return;
      try {
        await Promise.all(pending);
        await store.close?.();
      } catch { /* closing history is never worth a failed shutdown */ }
    };
  } catch {
    // Installing history is never worth failing a boot over.
    return off;
  }
}

/** Whether this process is running on Deno Deploy. */
function onDenoDeploy(): boolean {
  try {
    return Deno.env.get("DENO_DEPLOYMENT_ID") !== undefined;
  } catch {
    return false; // no --allow-env: not Deploy, as far as we can tell
  }
}
