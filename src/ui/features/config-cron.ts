// `/config/cron` — the project's scheduled tasks: what is registered, when each next fires, and
// an editor for the half that lives in config.
//
// A schedule comes from one of two places, and only one of them is editable here:
//   * `denext.config.ts`'s `scheduledTasks` — DATA, spliced by the same comment-preserving
//     writer `/config` uses, through the same diff-then-confirm and the same `_base` stale check.
//   * a task file's own `schedule:` inside `defineTask({ … })` — CODE. Shown, never written:
//     rewriting a TypeScript call expression is exactly what the config editor refuses to do.
//
// Discovery is ONE `deno` subprocess (`denext task --list --json`), never this process: listing
// tasks means importing the project's task modules, which is project code. The child returns the
// merged schedule `collectSchedules` computes — the same function the scheduler calls at boot —
// so this page shows what will really fire rather than re-deriving the merge and drifting.
//
// Honesty about what will NOT fire is the point of the page: `scheduleTasks` silently skips an
// entry whose cron is malformed or whose task is not defined (an error at boot, nothing more).
// Both are surfaced here as warnings against the row, because a schedule that looks live and
// never runs is worse than no schedule at all.

import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode } from "../../jsx/types.ts";
import { cronError, cronMatches, describeCron } from "../../runtime/cron.ts";
import { jsonResponse, panelResponder, type UiContext } from "../html.ts";
import type { DenextConfig } from "../../server/config.ts";
import { validateDenextConfig } from "../../server/config-validate.ts";
import {
  Badge,
  CsrfField,
  DiffBlock,
  Hidden,
  Input,
  Mono,
  NoChange,
  Note,
  OpForm,
  Panel,
  PreviewLead,
  Row,
  Table,
} from "../components.ts";
import { renderView } from "../view.ts";
import { ConfigTabs, isCompatApp } from "./config-next.ts";
import { cliInvocation, runDeno } from "../proc.ts";
import { parseJsonDocument } from "../child-json.ts";
import { join } from "@std/path";
import { CONFIG_FILES } from "../../build/paths.ts";
import {
  clearTaskHistory,
  readTaskHistory,
  TASK_HISTORY_DB,
  type TaskHistoryRow,
} from "../../server/task-history.ts";
import { deleteConfigValue, setConfigValue } from "../../build/config-edit.ts";
import { readContained, StaleWriteError, stampOf, writeFileAtomic } from "../security.ts";
import { confirmed, postedField } from "./plugins.ts";

/** Where the feature is documented. */
const DOCS = "https://denext.dev/docs/tasks";

/**
 * Why a form built against an older file is refused. Spelled once so the rendered refusal and the
 * resolver's reason cannot drift into saying different things about the same situation.
 */
const STALE_BASE = "changed on disk since this form was rendered — nothing was written. " +
  "Reload the tab and re-apply your change.";

/** The config key this panel edits. */
const KEY = "scheduledTasks";

/** What a project with no denext config gets created for it, so a first schedule can be written. */
const EMPTY_CONFIG = "export default {\n};\n";

/** The optimistic-concurrency stamp every form carries: a SHA-256 of the source it was built on. */
const BASE_FIELD = "_base";

/** The confirm form's hidden field: the exact value the diff was computed from, as JSON. */
const VALUE_FIELD = "value";

/**
 * What the submit means. A write this destructive must be ASKED for: an empty form posts no rows,
 * and reading that as "delete every schedule" would let a dropped field, a stale tab or a
 * malformed confirm silently wipe the key. `/config` takes the same line — its own delete is a
 * separate `clear=1` button, never the absence of a value.
 */
const INTENT_FIELD = "intent";

/** Save whatever rows were posted (the ordinary submit). */
const INTENT_SAVE = "save";

/** Remove `scheduledTasks` outright — only ever from the button that says so. */
const INTENT_CLEAR = "clear";

/** Turn `tasks.history` on or off. A different key and a different value type from the
 * schedules above, so it takes its own path through `submit` rather than through
 * `proposed()`, whose Proposal is a `scheduledTasks` map. */
const INTENT_HISTORY = "history";

/** Delete every recorded run. Touches no config: only rows go. */
const INTENT_CLEAR_HISTORY = "clear-history";

/** The value the history toggle carries: `"on"` or `"off"`. */
const HISTORY_FIELD = "history";

/** How long the discovery child gets before the panel gives up on it. */
const DISCOVERY_BUDGET_MS = 15_000;

/** How long a SUCCESSFUL listing is reused before the next request re-discovers. */
const LIST_TTL_MS = 5000;

/** How far ahead {@linkcode nextRuns} looks before reporting that nothing fires. */
const HORIZON_MINUTES = 366 * 24 * 60;

/** One task, as `denext task --list --json` describes it. */
interface TaskInfo {
  readonly name: string;
  readonly description?: string;
  /** The cron expression(s) the task file itself declares. */
  readonly schedule?: readonly string[];
}

/** One (cron, task) pairing the scheduler will register. */
interface ScheduledEntry {
  readonly cron: string;
  readonly task: string;
}

/** The document the discovery child prints. */
interface TaskListing {
  readonly tasks?: readonly TaskInfo[];
  readonly schedules?: readonly ScheduledEntry[];
  readonly configScheduled?: Record<string, string | string[]>;
  readonly denoCron?: boolean;
  readonly history?: boolean;
}

/** What one request knows about this project's tasks. */
interface CronState {
  readonly tasks: readonly TaskInfo[];
  readonly schedules: readonly ScheduledEntry[];
  readonly configScheduled: Record<string, string | string[]>;
  /** Whether the runtime schedules through `Deno.cron` rather than the userland tick. */
  readonly denoCron: boolean;
  /**
   * Whether `tasks.history` is on, as the discovery child RESOLVED it. This panel cannot evaluate
   * `denext.config.ts` — it reads the source as text — so the answer comes from the same loader
   * the server uses rather than from parsing a boolean out of TypeScript.
   */
  readonly history: boolean;
  /** Why the listing is empty or incomplete, when it is. */
  readonly error?: string;
  /** The denext config's file name (the one that would be created, when there is none). */
  readonly configName: string;
  /** Its source, or `""` when the project has no denext config yet. */
  readonly source: string;
  /** The SHA-256 of that source — the `_base` stamp every form carries. */
  readonly base: string;
}

/** The denext config as this panel reads it: its name, its bytes, and its stamp. */
interface ConfigFile {
  readonly configName: string;
  readonly source: string;
  readonly base: string;
}

/**
 * Read the project's denext config.
 *
 * Deliberately NOT cached alongside the task listing: the listing is a subprocess result worth
 * reusing for a few seconds, but the source and its stamp decide whether a write is refused as
 * stale. A cached stamp would make that check a formality.
 */
async function readConfigFile(dir: string): Promise<ConfigFile> {
  for (const configName of CONFIG_FILES) {
    const source = await readContained(dir, configName);
    if (source !== null) return { configName, source, base: await stampOf(source) };
  }
  return { configName: CONFIG_FILES[0], source: "", base: await stampOf("") };
}

/** The config's schedules as editable rows: an array value becomes one row per task. */
function configRows(
  configScheduled: Record<string, string | string[]>,
): Array<{ cron: string; task: string }> {
  const rows: Array<{ cron: string; task: string }> = [];
  for (const [cron, value] of Object.entries(configScheduled)) {
    for (const task of Array.isArray(value) ? value : [value]) rows.push({ cron, task });
  }
  return rows;
}

/** Rows back into the config's shape: one task stays a string, several become an array. */
function toScheduledTasks(
  rows: readonly { cron: string; task: string }[],
): Record<string, string | string[]> {
  const out: Record<string, string[]> = {};
  for (const { cron, task } of rows) {
    const list = out[cron] ??= [];
    if (!list.includes(task)) list.push(task);
  }
  return Object.fromEntries(
    Object.entries(out).map(([cron, list]) => [cron, list.length === 1 ? list[0] : list]),
  );
}

// ── discovery ────────────────────────────────────────────────────────────────

const listCache = new Map<string, { at: number; state: Listing }>();
const inFlight = new Map<string, Promise<Listing>>();

/** The child's listing, or `null` when it printed nothing parsable. */
function parseTaskListing(output: string): TaskListing | null {
  return parseJsonDocument<TaskListing>(output);
}

/** The listing half of the state — what the discovery child found. */
type Listing = Omit<CronState, "configName" | "source" | "base">;

/** An empty listing carrying the reason discovery produced nothing. */
function empty(error?: string): Listing {
  return {
    tasks: [],
    schedules: [],
    configScheduled: {},
    denoCron: false,
    history: false,
    ...(error === undefined ? {} : { error }),
  };
}

/** Spawn `denext task --list --json` and read the listing back. Never rejects. */
async function discover(dir: string, offline: boolean): Promise<Listing> {
  const lines: string[] = [];
  const argv = [...cliInvocation({ offline, dir }), "task", "--list", "--json", "--cwd", dir];
  try {
    await runDeno(argv, {
      cwd: dir,
      onLine: (line) => lines.push(line),
      signal: AbortSignal.timeout(DISCOVERY_BUDGET_MS),
    });
  } catch {
    return empty("the task listing did not finish — tasks and schedules are not shown");
  }
  const listing = parseTaskListing(lines.join("\n"));
  if (!listing) return empty("denext task --list printed no listing");
  return {
    tasks: listing.tasks ?? [],
    schedules: listing.schedules ?? [],
    configScheduled: listing.configScheduled ?? {},
    denoCron: listing.denoCron === true,
    history: listing.history === true,
  };
}

/**
 * This project's tasks and schedules. Overlapping requests share one child, and a successful
 * listing is reused briefly; a failure is never cached.
 *
 * @param dir The project directory.
 * @param offline `denext ui --offline`: the child runs `--deny-net --cached-only`.
 * @returns The state the panel renders.
 */
async function readState(dir: string, offline: boolean): Promise<CronState> {
  const [listing, config] = await Promise.all([listingFor(dir, offline), readConfigFile(dir)]);
  return { ...listing, ...config };
}

/** The cached half: overlapping requests share one child, and only a real answer is reused. */
function listingFor(dir: string, offline: boolean): Promise<Listing> {
  const key = `${offline}:${dir}`;
  const cached = listCache.get(key);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return Promise.resolve(cached.state);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const started = discover(dir, offline).then((state) => {
    if (state.error === undefined) listCache.set(key, { at: Date.now(), state });
    return state;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}

// ── cron reading ─────────────────────────────────────────────────────────────

/**
 * The next few times `expr` fires, in UTC — the timezone `Deno.cron` and the userland scheduler
 * both use, so what is shown is what will happen wherever the app runs.
 *
 * Walks minute by minute to a one-year horizon rather than solving the expression: a sparse
 * schedule (`0 6 1 1 *` fires once a year) must report honestly instead of looping forever.
 *
 * @param expr The cron expression.
 * @param count How many upcoming runs to return.
 * @param from The instant to search forward from.
 * @returns The run times, formatted; empty when nothing fires within the horizon.
 */
export function nextRuns(expr: string, count = 3, from: Date = new Date()): string[] {
  if (cronError(expr) !== null) return [];
  const out: string[] = [];
  const at = new Date(Math.floor(from.getTime() / 60_000) * 60_000);
  for (let i = 0; i < HORIZON_MINUTES && out.length < count; i++) {
    at.setUTCMinutes(at.getUTCMinutes() + 1);
    if (cronMatches(expr, at)) out.push(`${at.toISOString().slice(0, 16).replace("T", " ")} UTC`);
  }
  return out;
}

/** How many days the history counts cover. */
const HISTORY_WINDOW_DAYS = 7;

/**
 * Where this project's run history lives.
 *
 * The convention is joined here rather than resolved: `resolveProject` imports the project's
 * config module, and this process never evaluates project code. A SQLite file the framework
 * wrote is data, not code — strictly less dangerous than the TypeScript source this panel
 * already reads.
 *
 * @param dir The project directory.
 * @returns The database path.
 */
function historyPath(dir: string): string {
  return join(dir, ".denext", TASK_HISTORY_DB);
}

/**
 * The history half of the JSON twin.
 *
 * Read fresh on every request, deliberately NOT through `listCache`: the subprocess listing
 * deserves a TTL, but a `SELECT … LIMIT 20` does not, and sharing that cache would hide a
 * just-finished run for seconds.
 *
 * @param state The panel state (only `history` and `dir` matter).
 * @param dir The project directory.
 * @returns `available`, the window, and the rows — never `enabled`, which the caller supplies.
 */
function historyPayload(state: CronState, dir: string): Record<string, unknown> {
  // Off: there is nothing to read, and opening the file would be the UI creating state the app
  // never asked for.
  if (!state.history) return { available: false, windowDays: HISTORY_WINDOW_DAYS };
  const read = readTaskHistory({ path: historyPath(dir) }, HISTORY_WINDOW_DAYS);
  return {
    available: read.available,
    ...(read.reason === undefined ? {} : { reason: read.reason }),
    windowDays: read.windowDays,
    tasks: read.tasks,
    recent: read.recent,
  };
}

/** A recorded instant, in the same UTC spelling the next-run column uses. */
function atUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Run history: what actually ran, and whether it worked.
 *
 * Four states have to look different. "Off" and "on but nothing recorded yet" are the pair that
 * matters — collapsing them into one empty table is the failure this section exists to avoid.
 */
function History(
  { ctx, state }: { readonly ctx: UiContext; readonly state: CronState },
): VNode {
  if (!state.history) return h(HistoryOff, { ctx, state });
  const read = readTaskHistory({ path: historyPath(ctx.dir) }, HISTORY_WINDOW_DAYS);
  if (!read.available) {
    return h(
      "p",
      { class: "lead" },
      read.reason === "no history recorded yet"
        ? "Enabled, but nothing has been recorded yet. If you just turned this on, restart the app — the recorder is installed at server boot."
        : `Enabled, but the history could not be read: ${read.reason ?? "unknown reason"}.`,
    );
  }
  if (read.tasks.length === 0) {
    return h("p", { class: "lead" }, `No runs in the last ${read.windowDays} days.`);
  }
  return h(
    Fragment,
    null,
    h(HistoryTable, { read }),
    h(HistoryToggle, { ctx, state, on: false }),
    h(OpForm, {
      csrf: ctx.csrf,
      action: "/config/cron",
      label: "Clear history",
      disabled: ctx.readOnly,
      className: "ghost",
      fields: { [INTENT_FIELD]: INTENT_CLEAR_HISTORY },
    }),
  );
}

/** The table of per-task standing. */
function HistoryTable({ read }: { readonly read: ReturnType<typeof readTaskHistory> }): VNode {
  return h(Table, {
    head: ["Task", "Last run (UTC)", "Last result", "Succeeded", "Failed"],
    rows: read.tasks.map((row) =>
      h(
        "tr",
        { key: row.task },
        h("td", null, h(Mono, null, row.task)),
        h("td", null, atUtc(row.lastRunAt)),
        h(
          "td",
          null,
          h(Badge, { tone: row.lastOk ? "ok" : "fail" }, row.lastOk ? "ok" : "failed"),
          ` ${row.lastDurationMs} ms`,
        ),
        h("td", null, String(row.successes)),
        h("td", null, String(row.failures)),
      )
    ),
  });
}

/** History is off: say so, and offer the switch rather than an empty table. */
function HistoryOff(
  { ctx, state }: { readonly ctx: UiContext; readonly state: CronState },
): VNode {
  return h(
    Fragment,
    null,
    h(
      "p",
      { class: "lead" },
      "Run history is off, so nothing records what these tasks did. Turning it on writes ",
      h(Mono, null, "tasks: { history: true }"),
      " to your denext config and records every run — scheduled and manual — to ",
      h(Mono, null, ".denext/tasks.db"),
      ". It takes effect the next time the app starts.",
    ),
    h(HistoryToggle, { ctx, state, on: true }),
  );
}

/** The switch itself — the ordinary diff-then-confirm, for one boolean. */
function HistoryToggle(
  { ctx, state, on }: {
    readonly ctx: UiContext;
    readonly state: CronState;
    readonly on: boolean;
  },
): VNode {
  return h(OpForm, {
    csrf: ctx.csrf,
    action: "/config/cron",
    disabled: ctx.readOnly,
    label: on ? "Enable run history" : "Disable run history",
    fields: {
      [INTENT_FIELD]: INTENT_HISTORY,
      [HISTORY_FIELD]: on ? "on" : "off",
      [BASE_FIELD]: state.base,
    },
  });
}

/** Why the scheduler will skip this entry, or null when it will register it. */
function skipReason(entry: ScheduledEntry, tasks: readonly TaskInfo[]): string | null {
  const bad = cronError(entry.cron);
  if (bad !== null) return bad;
  if (!tasks.some((task) => task.name === entry.task)) {
    return `no task named "${entry.task}" — this schedule is skipped at startup`;
  }
  return null;
}

/** Whether a cron expression came from the config (editable) rather than a task file (code). */
function fromConfig(entry: ScheduledEntry, configScheduled: Record<string, string | string[]>) {
  const named = configScheduled[entry.cron];
  if (named === undefined) return false;
  return Array.isArray(named) ? named.includes(entry.task) : named === entry.task;
}

// ── the views ────────────────────────────────────────────────────────────────

/** One row of the schedule table: when it fires, what it runs, and whether it really will. */
function ScheduleRow(
  { entry, state, standing }: {
    readonly entry: ScheduledEntry;
    readonly state: CronState;
    readonly standing: Map<string, TaskHistoryRow> | null;
  },
): VNode {
  const skip = skipReason(entry, state.tasks);
  const editable = fromConfig(entry, state.configScheduled);
  const upcoming = skip === null ? nextRuns(entry.cron, 2) : [];
  const said = describeCron(entry.cron);
  return h(
    "tr",
    null,
    h(
      "td",
      null,
      h(Mono, null, entry.cron),
      said === null ? null : h("div", { class: "lead flush-sm" }, said),
    ),
    h("td", null, h(Mono, null, entry.task)),
    h(
      "td",
      null,
      skip !== null
        ? h("span", { class: "badge warn" }, "never fires")
        : h("span", { class: "badge ok" }, editable ? "config" : "in code"),
    ),
    h(
      "td",
      null,
      skip !== null
        ? skip
        : upcoming.length === 0
        ? "no run in the next year"
        : upcoming.join(", "),
    ),
    standing === null ? null : h(LastResult, { row: standing.get(entry.task) }),
  );
}

/**
 * One task's last result. Absent history is not a failure — it means the task has not run inside
 * the window, which is a different thing from having failed, and the cell says so.
 *
 * @param props `row`: that task's standing, when it has one.
 * @returns The cell.
 */
function LastResult({ row }: { readonly row: TaskHistoryRow | undefined }): VNode {
  if (row === undefined) return h("td", null, h("span", { class: "lead" }, "not yet"));
  return h(
    "td",
    null,
    h(Badge, { tone: row.lastOk ? "ok" : "fail" }, row.lastOk ? "ok" : "failed"),
    ` ${row.lastDurationMs} ms`,
  );
}

/**
 * Each task's last result, keyed by task name — or `null` when there is no history to show.
 *
 * Read once here and handed down. A row that fetched its own would open the database once per
 * schedule, and the answer is per TASK anyway: a task scheduled under two expressions has one
 * history, shown twice.
 *
 * @param ctx The request context.
 * @param state The panel state.
 * @returns The lookup, or `null` when history is off or unreadable.
 */
function standingOf(ctx: UiContext, state: CronState): Map<string, TaskHistoryRow> | null {
  if (!state.history) return null;
  const read = readTaskHistory({ path: historyPath(ctx.dir) }, HISTORY_WINDOW_DAYS);
  if (!read.available) return null;
  return new Map(read.tasks.map((row) => [row.task, row]));
}

/** The schedule table, or an empty state that names the next action. */
function Schedules(
  { state, standing }: {
    readonly state: CronState;
    readonly standing: Map<string, TaskHistoryRow> | null;
  },
): VNode {
  if (state.schedules.length === 0) {
    return h(
      "p",
      { class: "lead" },
      "Nothing is scheduled. Add a ",
      h(Mono, null, "scheduledTasks"),
      " entry below, or give a task its own ",
      h(Mono, null, "schedule"),
      " in its ",
      h(Mono, null, "tasks/"),
      " file.",
    );
  }
  const head = ["When (UTC)", "Task", "Source", "Next runs"];
  return h(Table, {
    head: standing === null ? head : [...head, "Last result"],
    rows: state.schedules.map((entry) =>
      h(ScheduleRow, { key: `${entry.task} ${entry.cron}`, entry, state, standing })
    ),
  });
}

/** Every discovered task, with the schedules its own file declares. */
function Tasks({ state }: { readonly state: CronState }): VNode {
  if (state.tasks.length === 0) {
    return h(
      "p",
      { class: "lead" },
      "No tasks found. Add ",
      h(Mono, null, "tasks/<name>.ts"),
      " exporting ",
      h(Mono, null, "defineTask({ … })"),
      " — or scaffold one with ",
      h(Mono, null, "denext generate task <name>"),
      ".",
    );
  }
  return h(Table, {
    head: ["Task", "Description", "Its own schedule"],
    rows: state.tasks.map((task) =>
      h(
        "tr",
        { key: task.name },
        h("td", null, h(Mono, null, task.name)),
        h("td", null, task.description ?? ""),
        h(
          "td",
          null,
          (task.schedule ?? []).length === 0
            ? "—"
            : h(Mono, null, (task.schedule ?? []).join(", ")),
        ),
      )
    ),
  });
}

/** How this runtime will schedule: managed `Deno.cron`, or the userland tick. */
function SchedulerNote({ state }: { readonly state: CronState }): VNode {
  if (state.denoCron) {
    return h(
      Note,
      null,
      "This runtime exposes Deno.cron, so schedules are managed by the platform — they survive " +
        "isolate cycling and never overlap a run with itself.",
    );
  }
  return h(
    Note,
    null,
    "This runtime has no Deno.cron, so denext uses its own minute-tick scheduler: schedules " +
      "only fire while a denext server process is running. Deno Deploy (or --unstable-cron) " +
      "gets the managed scheduler instead.",
  );
}

/** The whole panel. */
function CronPanel(
  { ctx, state, compat, notice, body }: {
    readonly ctx: UiContext;
    readonly state: CronState;
    readonly compat: boolean;
    readonly notice?: VNode;
    /** Rendered in place of the editor — the diff preview of a pending change. */
    readonly body?: VNode;
  },
): VNode {
  return h(
    Panel,
    { name: "Cron", title: "Config" },
    h(ConfigTabs, { active: "/config/cron", compat }),
    h(
      "p",
      { class: "lead" },
      "The cron schedules this project registers at server startup — from ",
      h(Mono, null, "scheduledTasks"),
      " in your denext config, and from each task's own ",
      h(Mono, null, "schedule"),
      ". Times are UTC, which is what both schedulers use. ",
      h("a", { href: DOCS }, "Scheduled tasks ↗"),
    ),
    state.error === undefined ? null : h(Note, { role: "alert" }, `denext ui: ${state.error}`),
    notice ?? null,
    h(SchedulerNote, { state }),
    h("h2", null, "Schedule"),
    h(Schedules, { state, standing: standingOf(ctx, state) }),
    h("h2", null, "Tasks"),
    h(Tasks, { state }),
    state.error === undefined ? h("h2", null, "Run history") : null,
    state.error === undefined ? h(History, { ctx, state }) : null,
    // A pending change replaces the editor with its diff: reviewing and editing at once would
    // let the form drift from the value the confirm button carries.
    body ?? h(ScheduleEditor, { ctx, state }),
  );
}

/** A task picker, or a plain text field when discovery found no tasks to pick from. */
function TaskField(
  { id, value, names }: {
    readonly id: string;
    readonly value: string;
    readonly names: readonly string[];
  },
): VNode {
  if (names.length === 0) {
    return h(Input, { id, name: "task", value, ariaLabel: "Task name" });
  }
  // The current value is offered even when it names no task, so an entry that already points at
  // a missing task is editable rather than silently rewritten to something else on save.
  const options = names.includes(value) || value === "" ? names : [value, ...names];
  return h(
    "select",
    { id, name: "task", "aria-label": "Task" },
    options.map((name) => h("option", { key: name, value: name, selected: name === value }, name)),
  );
}

/** One editable row: the expression, the task it runs, and a checkbox that drops it. */
function ScheduleFields(
  { index, cron, task, names }: {
    readonly index: number;
    readonly cron: string;
    readonly task: string;
    readonly names: readonly string[];
  },
): VNode {
  const id = `cron-${index}`;
  const bad = cron === "" ? null : cronError(cron);
  return h(
    "div",
    { class: "field" },
    h(
      Row,
      null,
      h(Input, {
        id: `${id}-expr`,
        name: "cron",
        value: cron,
        placeholder: "0 3 * * *",
        ariaLabel: "Cron expression (UTC)",
      }),
      h(TaskField, { id: `${id}-task`, value: task, names }),
      h(
        "label",
        { for: `${id}-drop` },
        h(Input, { id: `${id}-drop`, type: "checkbox", name: `drop.${index}`, value: "on" }),
        " remove",
      ),
    ),
    bad === null ? null : h("p", { class: "note field-error", role: "alert" }, bad),
  );
}

/**
 * The editor: every schedule the CONFIG declares, as an editable row, plus one blank row to add
 * another. The whole map is rebuilt from what is posted, so editing an expression in place is an
 * edit rather than an add-and-orphan.
 *
 * A task's own `schedule` is not here — it lives in a `defineTask({ … })` call, and the UI does
 * not rewrite code. Those rows are in the table above, marked `in code`.
 */
function ScheduleEditor(
  { ctx, state }: { readonly ctx: UiContext; readonly state: CronState },
): VNode {
  const names = state.tasks.map((task) => task.name);
  const rows = configRows(state.configScheduled);
  return h(
    Fragment,
    null,
    h("h2", null, "Edit schedules"),
    h(
      "p",
      { class: "lead" },
      "The schedules your denext config declares. A change is previewed as a diff before ",
      "anything is written, and every other byte of the file — comments included — is kept.",
    ),
    h(
      "form",
      { method: "post", action: "/config/cron", "data-dirty-track": "1" },
      h(CsrfField, { csrf: ctx.csrf }),
      h(Hidden, { name: BASE_FIELD, value: state.base }),
      rows.map((row, index) =>
        h(ScheduleFields, {
          key: `${row.cron}:${row.task}:${index}`,
          index,
          cron: row.cron,
          task: row.task,
          names,
        })
      ),
      h(ScheduleFields, { key: "new", index: rows.length, cron: "", task: "", names }),
      // The ordinary submit is UNNAMED so `ui.js` recognises it as this form's Save and can hold
      // it inert until something actually changes; its intent rides in a hidden field. The
      // destructive one is named, and a named submitter's value wins over the hidden field.
      h(Hidden, { name: INTENT_FIELD, value: INTENT_SAVE }),
      h(
        Row,
        null,
        h("button", { type: "submit", disabled: ctx.readOnly }, "Preview changes"),
        rows.length === 0 ? null : h(
          "button",
          {
            type: "submit",
            class: "ghost",
            name: INTENT_FIELD,
            value: INTENT_CLEAR,
            title: `Delete ${KEY} from the config`,
            disabled: ctx.readOnly,
          },
          "Remove all schedules",
        ),
      ),
    ),
  );
}

/** The preview: the diff, and a confirm form carrying exactly the value it was computed from. */
function PreviewView(
  { ctx, diff, fields }: {
    readonly ctx: UiContext;
    readonly diff: string;
    /**
     * What the confirm button carries back. Supplied by the caller rather than built here: this
     * panel now writes two different keys, and a preview that knew about only one of them would
     * have to be duplicated for the other.
     */
    readonly fields: Readonly<Record<string, string>>;
  },
): VNode {
  return h(
    Fragment,
    null,
    h("h2", null, "Review the change"),
    h(PreviewLead, null),
    diff === "" ? h(NoChange, null) : h(DiffBlock, { diff }),
    diff === "" ? null : h(OpForm, {
      csrf: ctx.csrf,
      action: "/config/cron",
      label: "Apply",
      disabled: ctx.readOnly,
      // `_base` rides along so the SECOND step is stale-checked too: the file can change between
      // reviewing a diff and applying it, and an unguarded confirm would overwrite that.
      fields: { ...fields, confirm: "1" },
    }),
  );
}

// ── the request ──────────────────────────────────────────────────────────────

/** The panel shell: the bare section for `ui.js`, the whole document for a navigation. */
const panelResponse = panelResponder("Cron", "/config/cron");

/** The machine view (the `/api/config/cron` payload). */
function payload(state: CronState, dir: string): Record<string, unknown> {
  return {
    tasks: state.tasks,
    schedules: state.schedules.map((entry) => ({
      ...entry,
      source: fromConfig(entry, state.configScheduled) ? "config" : "task",
      skipped: skipReason(entry, state.tasks),
      next: nextRuns(entry.cron, 2),
    })),
    configScheduled: state.configScheduled,
    denoCron: state.denoCron,
    history: { enabled: state.history, ...historyPayload(state, dir) },
    ...(state.error === undefined ? {} : { error: state.error }),
  };
}

/**
 * Serve the cron panel: the registered schedule, the discovered tasks, and a form that adds a
 * `scheduledTasks` entry through the config writer's ordinary diff-then-confirm.
 *
 * @param _request The incoming request.
 * @param ctx The kernel's request context.
 * @returns The panel, its JSON twin, a preview, or a `303` back to the tab.
 */
export async function cronPanel(_request: Request, ctx: UiContext): Promise<Response> {
  const state = await readState(ctx.dir, ctx.offline === true);
  if (ctx.method === "POST") return await submit(ctx, state);
  if (ctx.json) return jsonResponse({ ok: true, ...payload(state, ctx.dir) });
  const compat = await isCompatApp(ctx.dir);
  // A write redirects here with `?saved=1` (POST/redirect/GET, so a reload never re-posts); say
  // so, or the page it lands on looks identical to the one it left and the write reads as a no-op.
  const cleared = ctx.url.searchParams.get("cleared") === "1";
  const toggled = ctx.url.searchParams.get("history");
  if (cleared) {
    return panelResponse(
      ctx,
      renderView(h(CronPanel, {
        ctx,
        state,
        compat,
        notice: h(Note, null, "Run history cleared. Recording continues."),
      })),
    );
  }
  const notice = ctx.url.searchParams.get("saved") === "1"
    ? h(
      Note,
      null,
      `Saved ${state.configName}.`,
      toggled === null ? null : ` Run history is ${toggled === "on" ? "on" : "off"} from the ` +
        "next time the app starts — the recorder is installed at server boot, and the dev " +
        "server does not re-run task boot on reload.",
    )
    : undefined;
  return panelResponse(ctx, renderView(h(CronPanel, { ctx, state, compat, notice })));
}

/**
 * The refusal for a form built against a file that has since changed, or `null` when it has not.
 *
 * Both writers carry `_base`, and both must refuse the same way — a second copy of this message
 * is how two paths drift into disagreeing about what a stale form means.
 *
 * @param ctx The request context.
 * @param state The panel state.
 * @returns A `409`, or `null` when the stamp still matches.
 */
async function staleBase(ctx: UiContext, state: CronState): Promise<Response | null> {
  const posted = postedField(ctx, BASE_FIELD);
  if (posted === "" || posted === state.base) return null;
  return await refuse(ctx, state, `${state.configName} ${STALE_BASE}`, 409);
}

/**
 * The confirmed write itself: atomic, contained, and refused when the file moved underneath it.
 *
 * Returns `null` on success so each caller keeps its own answer — the schedules report
 * `scheduledTasks`, the toggle reports `history` and redirects elsewhere. Only the failure
 * modes, and the cache clear they both need, live here.
 *
 * @param ctx The request context.
 * @param state The panel state.
 * @param source The full file text to write.
 * @returns A refusal, or `null` when the write landed.
 */
async function applyWrite(
  ctx: UiContext,
  state: CronState,
  source: string,
): Promise<Response | null> {
  try {
    await writeFileAtomic(ctx.dir, state.configName, source, { unchangedFrom: state.source });
  } catch (error) {
    if (error instanceof StaleWriteError) {
      return await refuse(
        ctx,
        state,
        `${state.configName} changed on disk while this change was being applied — nothing was ` +
          "written. Reload the tab and re-apply your change.",
        409,
      );
    }
    const why = error instanceof Error ? error.message : String(error);
    return await refuse(ctx, state, `${state.configName} could not be written: ${why}`, 403);
  }
  // The listing carries both `configScheduled` and `history`, so it is stale the moment the file
  // changes — without this a write appears not to have worked until the TTL expires.
  listCache.clear();
  return null;
}

/**
 * The review step both writers share: the diff to confirm, or `null` when there is nothing to
 * review and the caller should go straight to writing.
 *
 * @param ctx The request context.
 * @param state The panel state.
 * @param diff The unified diff the edit produced.
 * @param fields What the confirm button carries back.
 * @returns The preview page, or `null` when this POST was the confirm.
 */
async function previewOr(
  ctx: UiContext,
  state: CronState,
  diff: string,
  fields: Readonly<Record<string, string>>,
): Promise<Response | null> {
  if (confirmed(ctx) && diff !== "") return null;
  const compat = await isCompatApp(ctx.dir);
  const preview = h(PreviewView, { ctx, diff, fields });
  return panelResponse(ctx, renderView(h(CronPanel, { ctx, state, compat, body: preview })));
}

/** Re-render with a refusal against the form. */
async function refuse(ctx: UiContext, state: CronState, reason: string, status: number) {
  if (ctx.json) return jsonResponse({ ok: false, reason }, status);
  const compat = await isCompatApp(ctx.dir);
  const notice = h(Note, { role: "alert" }, reason);
  return panelResponse(ctx, renderView(h(CronPanel, { ctx, state, compat, notice })), status);
}

/** Every value of a repeated field, in document order. */
function readAll(ctx: UiContext, name: string): string[] {
  if (ctx.form) {
    return ctx.form.getAll(name).filter((v): v is string => typeof v === "string");
  }
  const value = (ctx.body as Record<string, unknown> | undefined)?.[name];
  return (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .filter((v): v is string => typeof v === "string");
}

/**
 * The rows a submit proposes: the parallel `cron`/`task` fields, minus the ones ticked for
 * removal and the blank one the add row posts when it is left alone.
 */
function postedRows(ctx: UiContext): Array<{ cron: string; task: string }> {
  const crons = readAll(ctx, "cron");
  const tasks = readAll(ctx, "task");
  const rows: Array<{ cron: string; task: string }> = [];
  for (let i = 0; i < crons.length; i++) {
    if (postedField(ctx, `drop.${i}`) === "on") continue;
    const cron = (crons[i] ?? "").trim();
    const task = (tasks[i] ?? "").trim();
    if (cron === "" && task === "") continue; // the untouched add row
    rows.push({ cron, task });
  }
  return rows;
}

/** The first thing wrong with the proposed rows, or null when every one is writable. */
function rowProblem(
  rows: readonly { cron: string; task: string }[],
  names: readonly string[],
): string | null {
  for (const { cron, task } of rows) {
    if (cron === "") return `"${task}" has no cron expression`;
    const bad = cronError(cron);
    if (bad !== null) return bad;
    if (task === "") return `"${cron}" names no task`;
    // An unknown name is refused rather than written: the scheduler would skip it at boot, and
    // writing a schedule that can never fire is not a service to anyone.
    if (names.length > 0 && !names.includes(task)) return `no task named "${task}"`;
  }
  return null;
}

/** The proposed config, for the validator — the whole file's value with this key replaced. */
function validationProblem(
  value: Record<string, string | string[]>,
  configName: string,
): string | null {
  try {
    validateDenextConfig({ [KEY]: value } as DenextConfig, configName);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** A refusal a resolver hands back: the message, and the status it answers with. */
interface Refusal {
  readonly reason: string;
  readonly status: number;
}

/** The value a submit proposes, or why it cannot be read as one. */
type Proposal = { readonly value: Record<string, string | string[]> } | { readonly no: Refusal };

/** The value a confirm step carried, re-read rather than recomputed. */
function carriedValue(carried: string): Proposal {
  try {
    const parsed: unknown = JSON.parse(carried);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { no: { reason: "the confirm form carried an unreadable value", status: 400 } };
    }
    return { value: parsed as Record<string, string | string[]> };
  } catch {
    return { no: { reason: "the confirm form carried an unreadable value", status: 400 } };
  }
}

/** The value the editor's rows propose, validated against the tasks that exist. */
function rowValue(ctx: UiContext, state: CronState): Proposal {
  const rows = postedRows(ctx);
  const problem = rowProblem(rows, state.tasks.map((task) => task.name));
  if (problem !== null) return { no: { reason: problem, status: 422 } };
  // An empty form is not a request to delete everything: a dropped field or a stale tab would
  // otherwise wipe the key. Removing them all is its own button.
  if (rows.length === 0 && Object.keys(state.configScheduled).length > 0) {
    return {
      no: {
        reason: "that would remove every schedule — use “Remove all schedules” if that is what " +
          "you mean",
        status: 400,
      },
    };
  }
  return { value: toScheduledTasks(rows) };
}

/** What this POST proposes to write: its stamp checked, its intent named, its value read. */
function proposed(ctx: UiContext, state: CronState): Proposal {
  const posted = postedField(ctx, BASE_FIELD);
  if (posted !== "" && posted !== state.base) {
    // The message lives in `staleBase`; this resolver only reports that it is stale.
    return { no: { reason: `${state.configName} ${STALE_BASE}`, status: 409 } };
  }
  const intent = postedField(ctx, INTENT_FIELD);
  if (intent === INTENT_CLEAR) return { value: {} };
  if (intent !== INTENT_SAVE) {
    return { no: { reason: "the submit named no action", status: 400 } };
  }
  const carried = postedField(ctx, VALUE_FIELD);
  return carried === "" ? rowValue(ctx, state) : carriedValue(carried);
}

async function submit(ctx: UiContext, state: CronState): Promise<Response> {
  if (ctx.readOnly) return await refuse(ctx, state, "read-only — the config is not written", 403);
  const intent = postedField(ctx, INTENT_FIELD);
  if (intent === INTENT_HISTORY) return await submitHistory(ctx, state);
  if (intent === INTENT_CLEAR_HISTORY) return await submitClearHistory(ctx, state);
  const proposal = proposed(ctx, state);
  if ("no" in proposal) return await refuse(ctx, state, proposal.no.reason, proposal.no.status);
  const { value } = proposal;

  const invalid = validationProblem(value, state.configName);
  if (invalid !== null) return await refuse(ctx, state, invalid, 422);

  // An empty map means "no schedules": remove the key rather than leave `scheduledTasks: {}`.
  const from = state.source === "" ? EMPTY_CONFIG : state.source;
  const edit = Object.keys(value).length === 0
    ? await deleteConfigValue(from, [KEY])
    : await setConfigValue(from, [KEY], value);
  if (!edit.ok) return await refuse(ctx, state, edit.reason, 422);

  if (ctx.json && !confirmed(ctx)) {
    return jsonResponse({ ok: true, applied: false, diff: edit.diff, scheduledTasks: value });
  }
  const review = await previewOr(ctx, state, edit.diff, {
    [VALUE_FIELD]: JSON.stringify(value),
    [BASE_FIELD]: state.base,
    [INTENT_FIELD]: INTENT_SAVE,
  });
  if (review) return review;
  const refused = await applyWrite(ctx, state, edit.source);
  if (refused) return refused;
  if (ctx.json) {
    return jsonResponse({ ok: true, applied: true, diff: edit.diff, scheduledTasks: value });
  }
  return new Response(null, { status: 303, headers: { location: "/config/cron?saved=1" } });
}

/**
 * Turn `tasks.history` on or off: the same diff-then-confirm the schedules use, for one boolean.
 *
 * It does not go through `proposed()` — that resolver's value is a `scheduledTasks` map, and a
 * boolean at a nested path is a different write. What it does share is everything that makes the
 * write safe: the `_base` stale check, a diff you confirm before anything lands, `writeFileAtomic`
 * and the `409` when the file moved underneath.
 */
function ConfirmClear(
  { ctx, count, windowDays }: {
    readonly ctx: UiContext;
    readonly count: number;
    readonly windowDays: number;
  },
): VNode {
  return h(
    Fragment,
    null,
    h("h2", null, "Clear run history"),
    h(
      "p",
      { class: "lead" },
      count === 0
        ? "This deletes every recorded run. "
        : `This deletes every recorded run — ${count} in the last ${windowDays} days, and any older ones still kept. `,
      "It cannot be undone. Your denext config is not changed, and recording continues.",
    ),
    h(OpForm, {
      csrf: ctx.csrf,
      action: "/config/cron",
      label: "Delete every recorded run",
      disabled: ctx.readOnly,
      fields: { [INTENT_FIELD]: INTENT_CLEAR_HISTORY, confirm: "1" },
    }),
  );
}

async function submitClearHistory(ctx: UiContext, state: CronState): Promise<Response> {
  // Deleting run data cannot be previewed as a diff — no file changes — so the confirm step says
  // how much goes instead. Every other write here is two steps, and so is this.
  if (!confirmed(ctx)) {
    const read = readTaskHistory({ path: historyPath(ctx.dir) }, HISTORY_WINDOW_DAYS);
    // The window total, not `recent.length`: the feed is capped at 20, so a project with
    // hundreds of runs would otherwise be told "at least 20", which is true but useless.
    const count = read.tasks.reduce((n, row) => n + row.successes + row.failures, 0);
    const compat = await isCompatApp(ctx.dir);
    const body = h(ConfirmClear, { ctx, count, windowDays: read.windowDays });
    return panelResponse(ctx, renderView(h(CronPanel, { ctx, state, compat, body })), 409);
  }
  const done = clearTaskHistory({ path: historyPath(ctx.dir) });
  if (!done.cleared) {
    return await refuse(ctx, state, `the history could not be cleared: ${done.reason}`, 422);
  }
  if (ctx.json) return jsonResponse({ ok: true, applied: true, cleared: true });
  return new Response(null, { status: 303, headers: { location: "/config/cron?cleared=1" } });
}

async function submitHistory(ctx: UiContext, state: CronState): Promise<Response> {
  const stale = await staleBase(ctx, state);
  if (stale) return stale;
  const wanted = postedField(ctx, HISTORY_FIELD);
  if (wanted !== "on" && wanted !== "off") {
    return await refuse(ctx, state, "the history toggle named no value", 400);
  }
  const on = wanted === "on";
  const from = state.source === "" ? EMPTY_CONFIG : state.source;
  const edit = await setConfigValue(from, ["tasks", "history"], on);
  if (!edit.ok) return await refuse(ctx, state, edit.reason, 422);

  if (ctx.json && !confirmed(ctx)) {
    return jsonResponse({ ok: true, applied: false, diff: edit.diff, history: on });
  }
  const review = await previewOr(ctx, state, edit.diff, {
    [INTENT_FIELD]: INTENT_HISTORY,
    [HISTORY_FIELD]: wanted,
    [BASE_FIELD]: state.base,
  });
  if (review) return review;
  const refused = await applyWrite(ctx, state, edit.source);
  if (refused) return refused;
  if (ctx.json) return jsonResponse({ ok: true, applied: true, diff: edit.diff, history: on });
  return new Response(null, {
    status: 303,
    headers: { location: `/config/cron?saved=1&history=${wanted}` },
  });
}
