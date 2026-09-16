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
import { cronError, cronMatches } from "../../runtime/cron.ts";
import { jsonResponse, panelResponder, type UiContext } from "../html.ts";
import { Mono, Note, OpForm, Panel, Table } from "../components.ts";
import { renderView } from "../view.ts";
import { ConfigTabs, isCompatApp } from "./config-next.ts";
import { cliInvocation, runDeno } from "../proc.ts";
import { parseJsonDocument } from "../child-json.ts";

/** Where the feature is documented. */
const DOCS = "https://denext.dev/docs/tasks";

/** The editor that owns `scheduledTasks` — where this panel sends a write. */
const CONFIG_SECTION = "/config?section=scheduledTasks";

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
}

/** What one request knows about this project's tasks. */
interface CronState {
  readonly tasks: readonly TaskInfo[];
  readonly schedules: readonly ScheduledEntry[];
  readonly configScheduled: Record<string, string | string[]>;
  /** Whether the runtime schedules through `Deno.cron` rather than the userland tick. */
  readonly denoCron: boolean;
  /** Why the listing is empty or incomplete, when it is. */
  readonly error?: string;
}

// ── discovery ────────────────────────────────────────────────────────────────

const listCache = new Map<string, { at: number; state: CronState }>();
const inFlight = new Map<string, Promise<CronState>>();

/** The child's listing, or `null` when it printed nothing parsable. */
function parseTaskListing(output: string): TaskListing | null {
  return parseJsonDocument<TaskListing>(output);
}

/** An empty state carrying the reason discovery produced nothing. */
function empty(error?: string): CronState {
  return {
    tasks: [],
    schedules: [],
    configScheduled: {},
    denoCron: false,
    ...(error === undefined ? {} : { error }),
  };
}

/** Spawn `denext task --list --json` and read the listing back. Never rejects. */
async function discover(dir: string, offline: boolean): Promise<CronState> {
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
function readState(dir: string, offline: boolean): Promise<CronState> {
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
  { entry, state }: { readonly entry: ScheduledEntry; readonly state: CronState },
): VNode {
  const skip = skipReason(entry, state.tasks);
  const editable = fromConfig(entry, state.configScheduled);
  const upcoming = skip === null ? nextRuns(entry.cron, 2) : [];
  return h(
    "tr",
    null,
    h("td", null, h(Mono, null, entry.cron)),
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
  );
}

/** The schedule table, or an empty state that names the next action. */
function Schedules({ state }: { readonly state: CronState }): VNode {
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
  return h(Table, {
    head: ["When (UTC)", "Task", "Source", "Next runs"],
    rows: state.schedules.map((entry) =>
      h(ScheduleRow, { key: `${entry.task} ${entry.cron}`, entry, state })
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
  { ctx, state, compat, notice }: {
    readonly ctx: UiContext;
    readonly state: CronState;
    readonly compat: boolean;
    readonly notice?: VNode;
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
    h(Schedules, { state }),
    h("h2", null, "Tasks"),
    h(Tasks, { state }),
    h(AddForm, { ctx, state }),
  );
}

/** The one write this panel offers: add or replace a `scheduledTasks` entry. */
function AddForm(
  { ctx, state }: { readonly ctx: UiContext; readonly state: CronState },
): VNode {
  const names = state.tasks.map((task) => task.name);
  return h(
    Fragment,
    null,
    h("h2", null, "Schedule a task"),
    h(
      "p",
      { class: "lead" },
      "Checks the expression against this project's tasks, then opens the ",
      h(Mono, null, "scheduledTasks"),
      " editor with the change ready to preview — the config file has one writer, and it is the ",
      h("a", { href: CONFIG_SECTION }, "Config editor"),
      ". A task's own ",
      h(Mono, null, "schedule"),
      " is code and is not editable from the UI at all.",
    ),
    names.length === 0 ? h(Note, null, "There is no task to schedule yet.") : h(OpForm, {
      csrf: ctx.csrf,
      action: "/config/cron",
      label: "Preview",
      disabled: ctx.readOnly,
      extra: h(
        Fragment,
        null,
        h("label", { for: "cron-task" }, "Task"),
        h(
          "select",
          { id: "cron-task", name: "task" },
          names.map((name) => h("option", { key: name, value: name }, name)),
        ),
        h("label", { for: "cron-expr" }, "Cron expression (UTC)"),
        h("input", {
          id: "cron-expr",
          name: "cron",
          type: "text",
          value: "",
          placeholder: "0 3 * * *",
          required: true,
        }),
      ),
    }),
  );
}

// ── the request ──────────────────────────────────────────────────────────────

/** The panel shell: the bare section for `ui.js`, the whole document for a navigation. */
const panelResponse = panelResponder("Cron", "/config/cron");

/** The machine view (the `/api/config/cron` payload). */
function payload(state: CronState): Record<string, unknown> {
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
  if (ctx.json) return jsonResponse({ ok: true, ...payload(state) });
  const compat = await isCompatApp(ctx.dir);
  return panelResponse(ctx, renderView(h(CronPanel, { ctx, state, compat })));
}

/** Re-render with a refusal against the form. */
async function refuse(ctx: UiContext, state: CronState, reason: string, status: number) {
  if (ctx.json) return jsonResponse({ ok: false, reason }, status);
  const compat = await isCompatApp(ctx.dir);
  const notice = h(Note, { role: "alert" }, reason);
  return panelResponse(ctx, renderView(h(CronPanel, { ctx, state, compat, notice })), status);
}

/** One posted field. */
function field(ctx: UiContext, name: string): string {
  const posted = ctx.form?.get(name);
  if (typeof posted === "string") return posted.trim();
  const value = (ctx.body as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Add one `scheduledTasks` entry. The value is merged into the key the config already has, so
 * scheduling a second task on the same expression appends rather than replacing.
 */
function merged(
  configScheduled: Record<string, string | string[]>,
  cron: string,
  task: string,
): Record<string, string | string[]> {
  const next: Record<string, string | string[]> = { ...configScheduled };
  const current = next[cron];
  if (current === undefined) next[cron] = task;
  else {
    const list = Array.isArray(current) ? current : [current];
    next[cron] = list.includes(task) ? current : [...list, task];
  }
  return next;
}

/**
 * Validate the posted entry and send the browser to the editor that owns this key.
 *
 * This panel deliberately does NOT write. `scheduledTasks` is already a fully editable map on
 * `/config` — preview, diff, confirm, the `_base` stale check, the config validator — and a
 * second writer for the same key would mean a second copy of all of those to keep in step. So
 * Cron validates what it can validate better than a generic map widget can (a real cron parse,
 * against the tasks that actually exist) and then hands over rather than half-owning the write.
 *
 * The merged value is still computed, because the JSON twin returns it: a machine client gets
 * the `scheduledTasks` it should POST to `/api/config` itself.
 */
async function submit(ctx: UiContext, state: CronState): Promise<Response> {
  if (ctx.readOnly) return await refuse(ctx, state, "read-only — the config is not written", 403);
  const cron = field(ctx, "cron");
  const task = field(ctx, "task");
  if (cron === "") return await refuse(ctx, state, "a cron expression is required", 400);
  const bad = cronError(cron);
  if (bad !== null) return await refuse(ctx, state, bad, 422);
  if (!state.tasks.some((candidate) => candidate.name === task)) {
    return await refuse(ctx, state, `no task named "${task}"`, 400);
  }
  const scheduledTasks = merged(state.configScheduled, cron, task);
  if (ctx.json) {
    return jsonResponse({ ok: true, applied: false, scheduledTasks, next: CONFIG_SECTION });
  }
  return new Response(null, { status: 303, headers: { location: CONFIG_SECTION } });
}
