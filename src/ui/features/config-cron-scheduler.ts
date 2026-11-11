// The Cron page's "OS scheduler" section: which of the project's scheduled jobs `denext job
// install` has handed to the operating system's scheduler (launchd, a systemd timer, the crontab,
// Task Scheduler), with Install / Uninstall behind a dry-run preview of every file and command.
//
// Every read and write is a `denext job install … --json` child, never this process: the verb
// imports the project's job modules (project code) and runs the scheduler's programs. The child's
// document is the CLI's own `--json` output, so the page shows exactly what the command does.
// Writes go through the page's POST (the kernel's CSRF check) and `--read-only` refuses them.
//
// Under `denext ui --offline` the section is not read at all: the scheduler is reached through
// programs, and `--offline` keeps the page's children from starting programs (`--deny-run`).

import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode } from "../../jsx/types.ts";
import { jsonResponse, type UiContext } from "../html.ts";
import { Badge, Mono, Note, OpForm, Out, Table } from "../components.ts";
import { parseJsonDocument } from "../child-json.ts";
import { cliInvocation, runDeno } from "../proc.ts";
import { confirmed, postedField } from "./plugins.ts";

/** The POST intent that previews (then, confirmed, applies) an install. */
const INTENT_OS_INSTALL = "os-install";

/** The POST intent that previews (then, confirmed, applies) an uninstall. */
const INTENT_OS_UNINSTALL = "os-uninstall";

/** Why the section is empty under `denext ui --offline`. */
const OFFLINE = "denext ui --offline does not read or change the OS scheduler: that runs its " +
  "programs (launchctl, systemctl, crontab, schtasks), which --offline keeps its children from " +
  "starting";

/** One entry of this project's the scheduler holds. */
interface InstalledEntry {
  readonly backend: string;
  readonly slug: string;
  /** The job it runs, when a defined job has that slug. */
  readonly job?: string;
}

/** `denext job install --status --json`. */
export interface SchedulerStatus {
  /** The scheduler an install writes to (`null`: none here). */
  readonly backend: string | null;
  readonly scope: string;
  readonly os: string;
  readonly installed: readonly InstalledEntry[];
  readonly warnings: readonly string[];
}

/** The section's state: the status, or why there is none. */
export type SchedulerRead =
  | { readonly status: SchedulerStatus }
  | { readonly unavailable: string };

/** One change a dry run would make (the CLI's `DryRunStep`). */
type Step =
  | { readonly kind: "write"; readonly path: string; readonly content: string }
  | { readonly kind: "mkdir" | "remove"; readonly path: string }
  | {
    readonly kind: "run";
    readonly tool: string;
    readonly args: readonly string[];
    readonly stdin?: string;
  };

/** `denext job install [--uninstall] [--dry-run] --json`. */
interface InstallDoc {
  readonly backend: string | null;
  readonly installed: readonly { job: string; crons: readonly string[]; guarded: boolean }[];
  readonly removed: readonly { backend: string; slug: string }[];
  readonly warnings: readonly string[];
  /** The command the entries run is the fallback (`deno run` on the CLI module). */
  readonly warning?: string;
  readonly steps?: readonly Step[];
}

/** Runs a CLI child: its argv (after `deno`) and the project directory; resolves its lines. */
export type SchedulerChild = (argv: readonly string[], dir: string) => Promise<readonly string[]>;

/** How long a child may take: a cold CLI start that loads the project's jobs. */
const CHILD_BUDGET_MS = 60_000;

/** The real child: `deno <argv>` in the project, bounded by {@linkcode CHILD_BUDGET_MS}. */
const realChild: SchedulerChild = async (argv, dir) => {
  const lines: string[] = [];
  const signal = AbortSignal.timeout(CHILD_BUDGET_MS);
  // Waited on to its exit, not cut off at its document (`jsonDocument`): an install changes the
  // scheduler before it prints, and a job module it imports may print JSON of its own first.
  await runDeno([...argv], { cwd: dir, onLine: (line) => lines.push(line), signal });
  if (signal.aborted) {
    throw new Error(`it did not finish within ${CHILD_BUDGET_MS / 1000} s`);
  }
  return lines;
};

let child: SchedulerChild = realChild;

/**
 * Replace the child runner (`null` restores the real one), clearing the cached status.
 *
 * @internal Test seam: a test never touches this machine's scheduler.
 * @param fn The runner.
 * @returns The runner that was in force.
 */
export function setCronSchedulerChild(fn: SchedulerChild | null): SchedulerChild {
  const previous = child;
  child = fn ?? realChild;
  statusCache.clear();
  return previous;
}

/** The `denext job install` argv for the project, with `flags`. */
function argvFor(dir: string, flags: readonly string[]): string[] {
  return [...cliInvocation({ dir }), "job", "install", ...flags, "--json", "--cwd", dir];
}

/** Terminal colour and cursor sequences. */
// deno-lint-ignore no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Why a child printed no document: from the last line denext itself wrote (`denext job install:
 * nothing changed.`, whose reasons follow it indented) to the end, else the last non-empty line.
 */
function failureOf(lines: readonly string[]): string {
  const plain = lines.map((line) => line.replace(ANSI, "").trim());
  let from = -1;
  for (let i = plain.length - 1; i >= 0 && from < 0; i--) {
    if (plain[i].startsWith("denext")) from = i;
  }
  const said = (from < 0 ? plain.filter((l) => l !== "").slice(-1) : plain.slice(from))
    .filter((l) => l !== "");
  return said.length === 0 ? "it printed nothing" : said.join(" ");
}

/** Run the verb with `flags`: its JSON document, or the reason there is none. */
async function runVerb(
  dir: string,
  flags: readonly string[],
): Promise<Record<string, unknown> | string> {
  let lines: readonly string[];
  try {
    lines = await child(argvFor(dir, flags), dir);
  } catch (error) {
    return `denext job install did not finish: ${error instanceof Error ? error.message : error}`;
  }
  return parseJsonDocument<Record<string, unknown>>(lines.join("\n")) ??
    `denext job install failed: ${failureOf(lines)}`;
}

/** How long a status read is reused. */
const STATUS_TTL_MS = 5000;

const statusCache = new Map<string, { at: number; read: SchedulerRead }>();

/** The status document, read defensively: a field of the wrong shape is empty. */
function statusOf(doc: Record<string, unknown>): SchedulerStatus {
  const installed = Array.isArray(doc.installed) ? doc.installed as InstalledEntry[] : [];
  return {
    backend: typeof doc.backend === "string" ? doc.backend : null,
    scope: typeof doc.scope === "string" ? doc.scope : "user",
    os: typeof doc.os === "string" ? doc.os : "",
    installed: installed.filter((e) => typeof e?.slug === "string"),
    warnings: Array.isArray(doc.warnings) ? doc.warnings.map(String) : [],
  };
}

/**
 * The project's entries in the user's OS scheduler (`denext job install --status`). A
 * successful read is reused briefly; a failure is never cached. Never rejects.
 *
 * @param dir The project directory.
 * @param offline `denext ui --offline`: nothing is read.
 * @returns The status, or why there is none.
 */
export async function readScheduler(dir: string, offline: boolean): Promise<SchedulerRead> {
  if (offline) return { unavailable: OFFLINE };
  const cached = statusCache.get(dir);
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.read;
  const doc = await runVerb(dir, ["--status"]);
  if (typeof doc === "string") return { unavailable: doc };
  const read = { status: statusOf(doc) };
  statusCache.set(dir, { at: Date.now(), read });
  return read;
}

/**
 * The section's half of the `/api/config/cron` read.
 *
 * @param read The section's state.
 * @returns `{ backend, scope, os, installed, warnings }`, or `{ unavailable }`.
 */
export function schedulerPayload(read: SchedulerRead): Record<string, unknown> {
  return "status" in read ? { ...read.status } : { unavailable: read.unavailable };
}

/** One row of the section's table. */
function EntryRow(
  { job, entry, scheduled }: {
    readonly job: string;
    readonly entry: InstalledEntry | undefined;
    readonly scheduled: boolean;
  },
): VNode {
  const state = entry === undefined
    ? h(Badge, { tone: "todo" }, "not installed")
    : scheduled
    ? h(Badge, { tone: "ok" }, "installed")
    : h(Badge, { tone: "warn" }, "stale — the next install removes it");
  return h(
    "tr",
    null,
    h("td", null, h(Mono, null, job)),
    h("td", null, entry?.backend ?? "—"),
    h("td", null, state),
  );
}

/** The table: every scheduled job, then any entry no scheduled job accounts for. */
function EntryTable(
  { status, scheduled }: {
    readonly status: SchedulerStatus;
    readonly scheduled: readonly string[];
  },
): VNode {
  const byJob = new Map(status.installed.flatMap((e) => (e.job ? [[e.job, e] as const] : [])));
  const others = status.installed.filter((e) => !e.job || !scheduled.includes(e.job));
  return h(Table, {
    head: ["Job", "Scheduler", "State"],
    rows: [
      ...scheduled.map((job) =>
        h(EntryRow, { key: `job:${job}`, job, entry: byJob.get(job), scheduled: true })
      ),
      ...others.map((e) =>
        h(EntryRow, {
          key: `entry:${e.backend}:${e.slug}`,
          job: e.job ?? e.slug,
          entry: e,
          scheduled: false,
        })
      ),
    ],
  });
}

/**
 * The section: the scheduler's entries for this project, and Install / Uninstall.
 *
 * @param props `ctx`: the request; `read`: the status; `scheduled`: the jobs whose schedules fire.
 * @returns The section's content (its heading is the page's).
 */
export function SchedulerSection(
  { ctx, read, scheduled }: {
    readonly ctx: UiContext;
    readonly read: SchedulerRead;
    readonly scheduled: readonly string[];
  },
): VNode {
  if (!("status" in read)) return h(Note, null, read.unavailable);
  const { status } = read;
  if (status.backend === null) {
    return h(
      "p",
      { class: "lead" },
      `This machine has no ${status.scope} scheduler denext job install can write to (${status.os}).`,
    );
  }
  return h(
    Fragment,
    null,
    h(
      "p",
      { class: "lead" },
      "A schedule fires only while a denext server runs. ",
      h(Mono, null, "denext job install"),
      ` hands this project's schedules to ${status.backend} instead, so each job runs in this ` +
        "directory with no server. Install and Uninstall preview every file and command first.",
    ),
    status.warnings.map((note, i) => h(Note, { key: i, tone: "warn" }, note)),
    scheduled.length === 0 && status.installed.length === 0
      ? h("p", { class: "lead" }, "No job is scheduled, so there is nothing to install.")
      : h(EntryTable, { status, scheduled }),
    scheduled.length === 0 ? null : h(OpForm, {
      csrf: ctx.csrf,
      action: "/config/cron",
      label: status.installed.length === 0 ? "Preview install" : "Preview reinstall",
      disabled: ctx.readOnly,
      fields: { intent: INTENT_OS_INSTALL },
    }),
    status.installed.length === 0 ? null : h(OpForm, {
      csrf: ctx.csrf,
      action: "/config/cron",
      label: "Preview uninstall",
      disabled: ctx.readOnly,
      className: "ghost",
      fields: { intent: INTENT_OS_UNINSTALL },
    }),
  );
}

/** A dry run's commands, as a shell would read them (the CLI's own text form). */
function commandText(steps: readonly Step[]): string {
  return steps.flatMap((step) => {
    if (step.kind === "mkdir") return [`mkdir -p ${step.path}`];
    if (step.kind === "remove") return [`rm ${step.path}`];
    if (step.kind !== "run") return [];
    const line = `${step.tool} ${step.args.join(" ")}`;
    return step.stdin === undefined ? [line] : [line, `# (stdin)\n${step.stdin.trimEnd()}`];
  }).join("\n");
}

/** What a run did or would do, one line each. */
function summary(doc: InstallDoc, verb: string): string[] {
  return [
    ...doc.removed.map((r) => `${verb}remove ${r.slug} (${r.backend})`),
    ...doc.installed.map((e) =>
      `${verb}install ${e.job}: ${e.crons.join("; ")} UTC (${doc.backend})` +
      (e.guarded ? " — guarded with --if-due, as local time moves" : "")
    ),
  ];
}

/** The dry run's review: what would change, every file and command, and the apply button. */
function PreviewBody(
  { ctx, doc, intent }: {
    readonly ctx: UiContext;
    readonly doc: InstallDoc;
    readonly intent: string;
  },
): VNode {
  const installing = intent === INTENT_OS_INSTALL;
  const lines = summary(doc, "would ");
  const steps = doc.steps ?? [];
  const writes = steps.filter((s): s is Extract<Step, { kind: "write" }> => s.kind === "write");
  const commands = commandText(steps);
  return h(
    Fragment,
    null,
    h("h2", null, installing ? "Install in the OS scheduler" : "Uninstall from the OS scheduler"),
    h(
      "p",
      { class: "lead" },
      "Nothing has changed yet — review what would be written and run, then apply.",
    ),
    doc.warning === undefined ? null : h(Note, { tone: "warn" }, doc.warning),
    doc.warnings.map((note, i) => h(Note, { key: i, tone: "warn" }, note)),
    lines.length === 0
      ? h(
        Note,
        null,
        installing ? "No scheduled jobs to install." : "Nothing of this project's to remove.",
      )
      : h("ul", null, lines.map((line) => h("li", { key: line }, line))),
    writes.map((w) =>
      h(
        "details",
        { key: w.path, open: true },
        h("summary", null, h(Mono, null, w.path)),
        h(Out, null, w.content),
      )
    ),
    commands === "" ? null : h(Out, null, commands),
    lines.length === 0 ? null : h(OpForm, {
      csrf: ctx.csrf,
      action: "/config/cron",
      label: installing ? "Install" : "Uninstall",
      disabled: ctx.readOnly,
      fields: { intent, confirm: "1" },
    }),
  );
}

/** The document an install child printed, or `null` when it is not one. */
function installDoc(doc: Record<string, unknown>): InstallDoc | null {
  if (!Array.isArray(doc.installed) || !Array.isArray(doc.removed)) return null;
  return {
    backend: typeof doc.backend === "string" ? doc.backend : null,
    installed: doc.installed as InstallDoc["installed"],
    removed: doc.removed as InstallDoc["removed"],
    warnings: Array.isArray(doc.warnings) ? doc.warnings.map(String) : [],
    ...(typeof doc.warning === "string" ? { warning: doc.warning } : {}),
    ...(Array.isArray(doc.steps) ? { steps: doc.steps as Step[] } : {}),
  };
}

/** How the page answers for the section's POSTs. */
export interface SchedulerResponder {
  /** The page with a refusal against it. */
  refuse(reason: string, status: number): Response;
  /** The page with `body` in place of the editor. */
  review(body: VNode): Response;
}

/**
 * An Install / Uninstall POST: unconfirmed, the dry run's review (the CLI with `--dry-run`);
 * confirmed, the change itself, then a `303` back to the page.
 *
 * @param ctx The request (`--read-only` is refused before this is reached).
 * @param intent {@linkcode INTENT_OS_INSTALL} or {@linkcode INTENT_OS_UNINSTALL}.
 * @param page How the page answers.
 * @returns The review, the JSON envelope, a refusal, or the redirect.
 */
export async function submitScheduler(
  ctx: UiContext,
  intent: string,
  page: SchedulerResponder,
): Promise<Response> {
  if (ctx.offline === true) return page.refuse(OFFLINE, 403);
  const apply = confirmed(ctx);
  const flags = [
    ...(intent === INTENT_OS_UNINSTALL ? ["--uninstall"] : []),
    ...(apply ? [] : ["--dry-run"]),
  ];
  const raw = await runVerb(ctx.dir, flags);
  const doc = typeof raw === "string" ? null : installDoc(raw);
  if (doc === null) {
    return page.refuse(typeof raw === "string" ? raw : "denext job install printed no report", 422);
  }
  if (apply) statusCache.delete(ctx.dir);
  if (ctx.json) return jsonResponse({ ok: true, applied: apply, ...doc });
  if (!apply) return page.review(h(PreviewBody, { ctx, doc, intent }));
  const done = intent === INTENT_OS_UNINSTALL ? "uninstalled" : "installed";
  return new Response(null, {
    status: 303,
    headers: { location: `/config/cron?scheduler=${done}` },
  });
}

/**
 * The notice a redirected Install / Uninstall lands on, or `null`.
 *
 * @param ctx The request.
 * @returns The note.
 */
export function schedulerNotice(ctx: UiContext): VNode | null {
  const done = ctx.url.searchParams.get("scheduler");
  if (done === "installed") return h(Note, null, "Installed in the OS scheduler.");
  if (done === "uninstalled") return h(Note, null, "Removed from the OS scheduler.");
  return null;
}

/** Whether a POST's intent is one of this section's. */
export function schedulerIntent(ctx: UiContext): string | null {
  const intent = postedField(ctx, "intent");
  return intent === INTENT_OS_INSTALL || intent === INTENT_OS_UNINSTALL ? intent : null;
}
