// Discovery for the `tasks/` directory: scan it, import each module, and register its
// default-exported {@linkcode Task}. Kept separate from `./tasks.ts` (the runtime core that user
// task files import `defineTask` from) so that core stays free of the filesystem walk. Runtime
// discovery — like route discovery, denext imports task modules from source at server boot, so no
// build manifest is needed.

import { walk } from "@std/fs";
import { join, toFileUrl } from "@std/path";
import { collectSchedules, isTask, registerTask, scheduleTasks } from "./tasks.ts";

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
  config: { scheduledTasks?: Record<string, string | string[]> } | undefined,
): Promise<() => void> {
  const names = await discoverTasks(join(projectDir, "tasks"));
  const entries = collectSchedules(config?.scheduledTasks);
  if (names.length === 0 && entries.length === 0) return () => {};
  const dispose = scheduleTasks(entries);
  console.log(
    `  ${names.length} task(s)` +
      (entries.length ? `, ${entries.length} schedule(s) registered` : " (no schedules)"),
  );
  return dispose;
}
