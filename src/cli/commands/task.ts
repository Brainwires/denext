// `denext task <name>` — run a background task on demand, or `denext task --list` to see them.
// Discovers `tasks/**` the same way the server does at boot, then runs the named task (or lists).
// Loads the app modules (`loadsModules: true`), so the CLI entrypoint runs the env + CSS/module
// re-exec gate first. The positional is the TASK name (not a directory) — resolve the project
// from `--cwd`/cwd, never from the positional.

import { resolve } from "@std/path";
import { join } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import { type ProjectPaths, resolveProject } from "../../build/paths.ts";
import {
  discoverTasks,
  historyEnabled,
  historyStoreFor,
  startRunHistory,
} from "../../server/task-loader.ts";
import {
  collectSchedules,
  getTask,
  runTask,
  type ScheduledEntry,
  taskNames,
} from "../../server/tasks.ts";

/** Discover this project's tasks, keeping the resolved paths the caller also needs. */
async function loadTasks(ctx: CommandContext): Promise<{ names: string[]; paths: ProjectPaths }> {
  const paths = await resolveProject(resolve(ctx.global.cwd ?? "."));
  return { names: await discoverTasks(join(paths.projectDir, "tasks")), paths };
}

/** One task, as `denext task --list --json` describes it. */
interface TaskInfo {
  /** Its name: the path under `tasks/`, e.g. `cleanup` or `reports/daily`. */
  readonly name: string;
  /** Its one-line description, when it declares one. */
  readonly description?: string;
  /** The cron expression(s) the task file itself declares (code, not config). */
  readonly schedule: readonly string[];
}

/**
 * The whole `denext task --list --json` document. Not exported: `denext ui`'s Cron panel reads
 * this over a subprocess boundary and declares its own structural view of it, so exporting the
 * type here would imply a coupling that does not exist.
 */
interface TaskListing {
  /** Every discovered task, sorted by name. */
  readonly tasks: readonly TaskInfo[];
  /**
   * Every (cron, task) pairing that will actually be registered at boot — config
   * `scheduledTasks` merged with each task's own `schedule`, deduped. This is the SAME
   * `collectSchedules` the scheduler calls, so a caller sees what will really fire rather
   * than re-deriving the merge and drifting from it.
   */
  readonly schedules: readonly ScheduledEntry[];
  /** The config's `scheduledTasks` as written, which is the half a caller may edit. */
  readonly configScheduled: Record<string, string | string[]>;
  /**
   * Whether the runtime exposes `Deno.cron`. False means the userland minute-tick scheduler
   * runs instead — the same schedules, but only while a server process is alive.
   */
  readonly denoCron: boolean;
  /**
   * Whether `tasks.history` is on — the RESOLVED value, from the same loader the server uses.
   * `denext ui` reads this rather than parsing the config source, which it cannot evaluate.
   */
  readonly history: boolean;
  /**
   * Whose store keeps the history: `"default"` (the `.denext/tasks.db` file, which `denext ui`
   * reads itself) or `"custom"` (`tasks: { history: { store } }` — project code, so the UI asks
   * this verb's `--history` / `--clear-history` instead).
   */
  readonly historyStore: "default" | "custom";
}

/** Everything a machine caller needs about this project's tasks and their schedules. */
function listing(paths: ProjectPaths, names: string[]): TaskListing {
  const configScheduled = paths.config?.scheduledTasks ?? {};
  return {
    tasks: names.map((name) => ({
      name,
      ...(getTask(name)?.description === undefined
        ? {}
        : { description: getTask(name)?.description }),
      schedule: schedulesOf(getTask(name)?.schedule),
    })),
    schedules: collectSchedules(configScheduled),
    configScheduled,
    denoCron: typeof (Deno as { cron?: unknown }).cron === "function",
    history: historyEnabled(paths.config ?? undefined),
    historyStore: historyStoreKind(paths.config?.tasks?.history),
  };
}

/** Whether the configured history store is the default file or the app's own. */
function historyStoreKind(history: unknown): "default" | "custom" {
  return history && typeof history === "object" && (history as { store?: unknown }).store
    ? "custom"
    : "default";
}

/** The window `--history` reports on, in days — what `denext ui`'s Cron page shows. */
const HISTORY_WINDOW_DAYS = 7;

/**
 * `denext task --history` / `--clear-history`: read or clear the run history through the
 * configured store — the path `denext ui` takes for a store only project code can construct.
 * Prints JSON with `--json`. History off is an answer (`{ enabled: false }`), not an error.
 */
async function historyVerb(ctx: CommandContext, paths: ProjectPaths): Promise<void> {
  const clear = ctx.flags["clear-history"] === true;
  const out = await historyAnswer(paths, clear, ctx.flags["read-only"] === true);
  if (ctx.global.json) console.log(JSON.stringify(out, null, 2));
  else if (clear) console.log(out.cleared ? "run history cleared" : `not cleared: ${out.reason}`);
  else printHistory(out);
}

/** Read (or clear) through the configured store, closing it afterwards. */
async function historyAnswer(
  paths: ProjectPaths,
  clear: boolean,
  readOnly: boolean,
): Promise<Record<string, unknown>> {
  const resolved = historyStoreFor(paths.config ?? undefined, paths.outDir);
  if (!resolved) {
    return clear
      ? { enabled: false, cleared: false, reason: "run history is off" }
      : { enabled: false, available: false, windowDays: HISTORY_WINDOW_DAYS };
  }
  // Refused before the store is touched: clearing is the one write this verb can make.
  if (clear && readOnly) return { enabled: true, cleared: false, reason: "read-only" };
  const { store } = resolved;
  try {
    const answer = clear
      ? await store.clear()
      : await store.read({ windowDays: HISTORY_WINDOW_DAYS, readOnly });
    return { enabled: true, ...answer };
  } finally {
    try {
      await store.close?.();
    } catch { /* the answer is already in hand */ }
  }
}

/** The human-readable `--history` summary. */
function printHistory(out: Record<string, unknown>): void {
  const history = out as { enabled: boolean; available?: boolean; reason?: string } & {
    tasks?: { task: string; lastOk: boolean; successes: number; failures: number }[];
  };
  if (!history.enabled) {
    console.log("Run history is off (tasks: { history: true } turns it on).");
    return;
  }
  if (!history.available) {
    console.log(`No history: ${history.reason ?? "unavailable"}`);
    return;
  }
  console.log(`Last ${HISTORY_WINDOW_DAYS} days:`);
  for (const row of history.tasks ?? []) {
    const status = row.lastOk ? "ok" : "failed";
    console.log(`  ${row.task}  ${status}  ${row.successes} ok / ${row.failures} failed`);
  }
}

/** `--payload`'s JSON, or exit 1 when it is not JSON. */
function parsePayload(raw: unknown): unknown {
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    console.error("denext: --payload must be valid JSON");
    Deno.exit(1);
  }
}

/**
 * Run one task by name, recording the run when history is on; exit 1 when it fails.
 *
 * This verb never boots the scheduler, so without installing the recorder here a manual run
 * would record nothing while the same task on a schedule recorded fine — false exactly where
 * someone would look first. A no-op unless the project turned history on.
 */
async function runOne(paths: ProjectPaths, name: string, payload: unknown): Promise<void> {
  console.log(`running task "${name}"…`);
  const stopRecording = startRunHistory(paths.config ?? undefined, paths.outDir, {
    closeCustom: true,
  });
  const started = performance.now();
  try {
    const result = await runTask(name, payload, { trigger: "manual" });
    console.log(`✓ "${name}" finished in ${Math.round(performance.now() - started)} ms`);
    if (result !== undefined) console.log(result);
    await stopRecording();
  } catch (err) {
    console.error(`✗ task "${name}" failed:`, err);
    // Explicitly, not in a `finally`: `Deno.exit` below would skip one.
    await stopRecording();
    Deno.exit(1);
  }
}

/** `undefined | string | string[]` → a string array. */
function schedulesOf(schedule: string | string[] | undefined): string[] {
  return schedule == null ? [] : Array.isArray(schedule) ? schedule : [schedule];
}

function listTasks(names: string[], hint: boolean): void {
  if (names.length === 0) {
    console.log("No tasks found. Add tasks/<name>.ts exporting `defineTask(...)`.");
    return;
  }
  console.log(`${names.length} task(s):`);
  for (const n of names) {
    const desc = getTask(n)?.description;
    console.log(`  ${n}${desc ? `  —  ${desc}` : ""}`);
  }
  if (hint) console.log("\nRun one with:  denext task <name>");
}

export const taskCommand: CommandSpec = {
  name: "task",
  summary: "Run a background task by name, or list them (--list)",
  loadsModules: true,
  flags: [
    { name: "list", alias: "l", type: "boolean", help: "List the app's tasks and exit" },
    {
      name: "history",
      type: "boolean",
      help: "Print the run history (tasks.history) through its configured store",
    },
    {
      name: "clear-history",
      type: "boolean",
      help: "Delete every recorded run through the configured history store",
    },
    {
      name: "read-only",
      type: "boolean",
      help: "With --history: read without changing anything; refuses --clear-history",
    },
    {
      name: "payload",
      type: "string",
      valueName: "<json>",
      help: "JSON passed to the task's ctx.payload",
    },
  ],
  positionals: [{ name: "name", help: "Task name (its path under tasks/, e.g. cleanup)" }],
  // The positional is the TASK name, not a directory — resolve the project from `--cwd`/cwd so
  // the CLI's module-loading gate doesn't treat the task name as the project dir.
  moduleDir: (ctx) => resolve(ctx.global.cwd ?? "."),
  usage: "denext task <name> [--payload '<json>']\ndenext task --list [--json]\n" +
    "denext task --history [--read-only] [--json]\ndenext task --clear-history [--json]",
  run: async (ctx: CommandContext) => {
    if (ctx.flags.history === true || ctx.flags["clear-history"] === true) {
      // No task module is imported for this: only the config (and its store) is needed.
      await historyVerb(ctx, await resolveProject(resolve(ctx.global.cwd ?? ".")));
      return;
    }
    const { names, paths } = await loadTasks(ctx);
    const name = ctx.positionals[0];
    if (ctx.flags.list === true || !name) {
      // `--json` is a global flag, so `denext task --list --json` needs no declaration here.
      if (ctx.global.json) console.log(JSON.stringify(listing(paths, names), null, 2));
      else listTasks(names, !name && ctx.flags.list !== true);
      return;
    }
    if (!getTask(name)) {
      console.error(`denext: no task "${name}" (known: ${taskNames().join(", ") || "none"})`);
      Deno.exit(1);
    }
    await runOne(paths, name, parsePayload(ctx.flags.payload));
  },
};
