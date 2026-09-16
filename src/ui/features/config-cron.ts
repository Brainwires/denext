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
import type { DenextConfig } from "../../server/config.ts";
import { validateDenextConfig } from "../../server/config-validate.ts";
import {
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
import { CONFIG_FILES } from "../../build/paths.ts";
import { deleteConfigValue, setConfigValue } from "../../build/config-edit.ts";
import { readContained, StaleWriteError, stampOf, writeFileAtomic } from "../security.ts";
import { confirmed, postedField } from "./plugins.ts";

/** Where the feature is documented. */
const DOCS = "https://denext.dev/docs/tasks";

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
    h(Schedules, { state }),
    h("h2", null, "Tasks"),
    h(Tasks, { state }),
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
  { ctx, diff, value, base }: {
    readonly ctx: UiContext;
    readonly diff: string;
    readonly value: Record<string, string | string[]>;
    /** The stamp of the source the diff was computed against. */
    readonly base: string;
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
      fields: {
        [VALUE_FIELD]: JSON.stringify(value),
        [BASE_FIELD]: base,
        [INTENT_FIELD]: INTENT_SAVE,
        confirm: "1",
      },
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
  // A write redirects here with `?saved=1` (POST/redirect/GET, so a reload never re-posts); say
  // so, or the page it lands on looks identical to the one it left and the write reads as a no-op.
  const notice = ctx.url.searchParams.get("saved") === "1"
    ? h(Note, null, `Saved ${state.configName}.`)
    : undefined;
  return panelResponse(ctx, renderView(h(CronPanel, { ctx, state, compat, notice })));
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
    return {
      no: {
        reason: `${state.configName} changed on disk since this form was rendered — nothing ` +
          "was written. Reload the tab and re-apply your change.",
        status: 409,
      },
    };
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
  if (!confirmed(ctx) || edit.diff === "") {
    const compat = await isCompatApp(ctx.dir);
    const preview = h(PreviewView, { ctx, diff: edit.diff, value, base: state.base });
    return panelResponse(ctx, renderView(h(CronPanel, { ctx, state, compat, body: preview })));
  }
  return await write(ctx, state, edit.source, edit.diff, value);
}

/** The confirmed write — contained, atomic, and refused when the file moved underneath it. */
async function write(
  ctx: UiContext,
  state: CronState,
  source: string,
  diff: string,
  value: Record<string, string | string[]>,
): Promise<Response> {
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
  // The listing carries `configScheduled`, so it is stale the moment the file changes.
  listCache.clear();
  if (ctx.json) return jsonResponse({ ok: true, applied: true, diff, scheduledTasks: value });
  return new Response(null, { status: 303, headers: { location: "/config/cron?saved=1" } });
}
