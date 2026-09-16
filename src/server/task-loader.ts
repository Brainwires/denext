// Discovery for the `tasks/` directory: scan it, import each module, and register its
// default-exported {@linkcode Task}. Kept separate from `./tasks.ts` (the runtime core that user
// task files import `defineTask` from) so that core stays free of the filesystem walk. Runtime
// discovery — like route discovery, denext imports task modules from source at server boot, so no
// build manifest is needed.

import { walk } from "@std/fs";
import { join, toFileUrl } from "@std/path";
import { collectSchedules, isTask, registerTask, scheduleTasks, setTaskRecorder } from "./tasks.ts";
import { TASK_HISTORY_DB, taskHistoryRecorder } from "./task-history.ts";

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
      mod = await import(toFileUrl(entry.path).href);
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
    tasks?: { history?: boolean; historyMaxRuns?: number };
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
    stopRecording();
  };
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
 * @param config The project config (only `tasks` is read).
 * @param outDir The build directory the database lives in.
 * @returns A function that stops recording and closes the handle. A no-op when history is off.
 */
export function startRunHistory(
  config: { tasks?: { history?: boolean; historyMaxRuns?: number } } | undefined,
  outDir: string,
): () => void {
  if (config?.tasks?.history !== true) return () => {};
  if (onDenoDeploy()) {
    // Not refused: the app explicitly asked. But the file is per-isolate and ephemeral there, so
    // what the panel shows is one isolate's fragment that resets when it cycles — and a history
    // that is quietly wrong is worse than none. A latch cannot help, because the write SUCCEEDS.
    console.warn(
      "denext: tasks.history is on, but this is Deno Deploy — .denext/tasks.db is per-isolate " +
        "and ephemeral, so the history you see is one isolate's fragment and resets when it cycles.",
    );
  }
  try {
    const store = taskHistoryRecorder({
      path: join(outDir, TASK_HISTORY_DB),
      maxRuns: config.tasks.historyMaxRuns,
    });
    setTaskRecorder(store.record);
    return () => {
      setTaskRecorder(null);
      store.close();
    };
  } catch {
    // Installing history is never worth failing a boot over.
    return () => {};
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
