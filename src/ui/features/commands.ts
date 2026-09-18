// `/commands` — project command plug-ins: the verbs this project contributes through
// `commands:` in denext.config.ts or a plugin's `addCommand`, runnable from the browser with
// their output streamed back.
//
// Discovery is ONE `deno` subprocess: `denext commands --json`. The panel parses its listing
// and renders it; it never imports the project's `denext.config.ts`, never runs a plugin
// `setup()`, and never imports the CLI registry (every serving verb pulls the dev server in,
// and with it esbuild — which `tests/ui-server.test.ts` refuses for the whole `denext ui`
// module graph). That is the UI process's standing guarantee: PROJECT CODE NEVER RUNS IN THE
// UI'S PRIVILEGED PROCESS. `--read-only` bars the UI from writing; it does not (and cannot)
// stop the project's own config from executing inside that short-lived child, which is exactly
// why the child is where it runs.
//
// Concurrent page loads for the same directory SHARE one discovery — the child is spawned once
// and every waiter resolves from it — and a successful listing is reused for a few seconds. A
// failure or a timeout is never cached: the next request tries again.
//
// Running a verb is a MUTATION (a verb may write anything), so it is refused under
// `--read-only`, and only project/plugin verbs are offered a run form — built-ins belong in the
// terminal, where their long-lived output does. The form is typed from the verb's DECLARED flags
// and positionals (a checkbox per boolean, a number input per number, a text input per string,
// one input per positional and a row editor for a variadic one), and the argv is built on the
// server from the REFRESHED listing: a field the verb does not declare is never read, every
// value is its own argv element (array args, never a shell), and a positional may not start with
// `-` — so no field can smuggle in a flag the verb did not declare, least of all `--cwd`.
//
// Under `denext ui --offline` both children — discovery and every run — start with `--deny-net
// --cached-only` after `-A` (`proc.ts`): a verb can neither open a socket nor download a module.

import { type FlagSpec, GLOBAL_FLAGS, type PositionalSpec } from "../../cli/command.ts";
import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode } from "../../jsx/types.ts";
import { jsonResponse, panelResponder, type UiContext, type UiHandler } from "../html.ts";
import {
  Badge,
  FilterForm,
  Hidden,
  Input,
  type InputProps,
  Note,
  OpForm,
  Out,
  Panel,
  Row,
  Table,
} from "../components.ts";
import { Raw, renderView } from "../view.ts";
import { matchesTerms, matchNote } from "../filter.ts";
import { parseJsonDocument } from "../child-json.ts";
import { field, opButton } from "../form/control.ts";
import { applyListOp, OP_FIELD, parseOp } from "../form/value.ts";
import { broadcast, exitLine, sseProcess } from "../events.ts";
import { cliInvocation, runDeno, type RunDenoOptions } from "../proc.ts";

/** The panel's own path — its form action, and the nav entry it marks current. */
const PATH = "/commands";

/** Where the two extension seams are documented. */
const DOCS = "https://denext.dev/docs/plugins#project-commands";

/** What the panel says under `--offline`. */
const OFFLINE_NOTE = "Offline — every verb runs with --deny-net --cached-only: it can neither " +
  "open a socket nor download a module.";

/**
 * How long the whole discovery subprocess may take by default before the panel gives up on it.
 * Generous next to {@linkcode DEFAULT_BUDGET_MS}: the child pays Deno's own cold start before
 * it even begins importing the project's config.
 */
const DISCOVERY_BUDGET_MS = 8000;

/**
 * The discovery deadline in force: `DENEXT_UI_DISCOVERY_TIMEOUT_MS` when it is a positive
 * integer (a slow or heavily loaded machine — the end-to-end suite sets it), else
 * {@linkcode DISCOVERY_BUDGET_MS}. Without env permission the default applies.
 */
function discoveryDeadlineMs(): number {
  let raw: string | undefined;
  try {
    raw = Deno.env.get("DENEXT_UI_DISCOVERY_TIMEOUT_MS");
  } catch { /* no env permission */ }
  const ms = Number(raw);
  return Number.isInteger(ms) && ms > 0 ? ms : DISCOVERY_BUDGET_MS;
}

/** The plugin-setup budget handed to the child, matching the CLI's own default. */
const DEFAULT_BUDGET_MS = 1500;

/** How long a SUCCESSFUL listing is reused before the next request re-discovers. */
const LIST_TTL_MS = 5000;

/** Where a verb came from, as the panel groups them. */
export type VerbSource = "core" | "plugin" | "project";

/** One verb as the panel — and the `/api/commands` twin — describes it. */
export interface UiCommandInfo {
  /** The verb, as in `denext <name>`. */
  readonly name: string;
  /** Which seam contributed it. */
  readonly source: VerbSource;
  /** One-line summary. */
  readonly summary: string;
  /** Multi-line detail, when the verb declares one. */
  readonly usage?: string;
  /** Declared flags (the CLI's flag model has no "required" notion). */
  readonly flags: readonly FlagSpec[];
  /** Declared positionals. */
  readonly positionals: readonly PositionalSpec[];
  /**
   * Whether the verb runs with no argument at all (the CLI's notion: a project or plugin verb
   * with no required positional). The panel offers a run form to EVERY project and plugin verb —
   * a required positional is a required field there — and never to a built-in, since
   * `denext dev` would never exit.
   */
  readonly runnable: boolean;
}

/** What one discovery pass found. */
export interface UiCommandList {
  /** Every visible verb, built-ins first. */
  readonly commands: readonly UiCommandInfo[];
  /** True when the plugin budget elapsed — project verbs are missing from `commands`. */
  readonly timedOut: boolean;
  /** The failure message when the project's config could not be read. */
  readonly error?: string;
}

// ── the subprocess seam ──────────────────────────────────────────────────────

/**
 * How the panel shells out: `deno <argv>` in a child process, resolving to its exit code.
 * Swapped in tests so nothing is actually spawned.
 */
export type UiCommandRunner = (argv: string[], opts: RunDenoOptions) => Promise<number>;

/** The real runner: `src/ui/proc.ts`, array args only, never a shell. */
const defaultRunner: UiCommandRunner = async (argv, opts) => (await runDeno(argv, opts)).code;

let runner: UiCommandRunner = defaultRunner;
let budgetMs = DEFAULT_BUDGET_MS;

/**
 * Discovery in flight, keyed by project directory: every request that arrives while a child is
 * running waits on the SAME promise, so eight concurrent `/api/commands` calls spawn one
 * subprocess, not eight. Dropped the moment it settles.
 */
const inFlight = new Map<string, Promise<UiCommandList>>();

/** The last SUCCESSFUL listing per directory, reused for {@linkcode LIST_TTL_MS}. */
const listCache = new Map<string, { at: number; list: UiCommandList }>();

/**
 * Swap the subprocess runner, clearing the cached listing (a new runner answers differently).
 * Restore the returned value when done.
 *
 * @internal Test seam.
 * @param next The runner to install.
 * @returns The runner that was installed before.
 */
export function setCommandRunner(next: UiCommandRunner): UiCommandRunner {
  const previous = runner;
  runner = next;
  listCache.clear();
  return previous;
}

/**
 * Shorten (or lengthen) the plugin-setup budget handed to the discovery subprocess, clearing
 * the cached listing so the next request actually re-discovers under it.
 *
 * @internal Test seam.
 * @param ms The new budget in milliseconds.
 * @returns The budget that was in force before.
 */
export function setCommandBudget(ms: number): number {
  const previous = budgetMs;
  budgetMs = ms;
  listCache.clear();
  return previous;
}

// ── discovery ────────────────────────────────────────────────────────────────

/** The listing document `denext commands --json` prints (see `src/cli/commands/commands.ts`). */
export interface CommandListing {
  /** The built-ins denext ships. */
  readonly core?: readonly UiCommandInfo[];
  /** The verbs this project contributes. */
  readonly project?: readonly UiCommandInfo[];
  /** True when the child's plugin budget elapsed. */
  readonly timedOut?: boolean;
  /** The failure message when the child could not read the project's config. */
  readonly error?: string;
}

/**
 * Pull the child's JSON document out of its combined output. `commands --json` pretty-prints,
 * so the document opens on a bare `{` line and closes on a bare `}` line — anything Deno itself
 * wrote around it (a download line, a warning) is left out.
 *
 * @internal Exported for its unit test.
 * @param output Everything the child wrote, newline-joined.
 * @returns The parsed listing, or `null` when there was no parsable document.
 */
export function parseListing(output: string): CommandListing | null {
  return parseJsonDocument<CommandListing>(output);
}

/** Built-ins first, then the project's own verbs — the order the panel and the JSON twin use. */
function flatten(listing: CommandListing): UiCommandList {
  return {
    commands: [...listing.core ?? [], ...listing.project ?? []],
    timedOut: listing.timedOut === true,
    ...(typeof listing.error === "string" ? { error: listing.error } : {}),
  };
}

/**
 * Spawn `denext commands --json` against `dir` (without net when `offline`) and read its listing
 * back. Never rejects: a child that cannot start, times out, or prints nothing parsable degrades
 * to an empty list with an honest reason, which the panel renders as a notice.
 */
async function discover(dir: string, offline: boolean): Promise<UiCommandList> {
  const lines: string[] = [];
  const argv = [
    ...cliInvocation({ offline, dir }),
    "commands",
    "--json",
    "--timeout",
    String(budgetMs),
    "--cwd",
    dir,
  ];
  try {
    await runner(argv, {
      cwd: dir,
      onLine: (line) => lines.push(line),
      signal: AbortSignal.timeout(discoveryDeadlineMs()),
    });
  } catch {
    return { commands: [], timedOut: true };
  }
  const listing = parseListing(lines.join("\n"));
  if (!listing) {
    return { commands: [], timedOut: false, error: "denext commands printed no listing" };
  }
  return flatten(listing);
}

/** Whether a listing is worth reusing: a real answer, not a degraded one. */
function cacheable(list: UiCommandList): boolean {
  return !list.timedOut && list.error === undefined && list.commands.length > 0;
}

/**
 * Every verb this project can run: the built-ins the CLI ships, plus the `commands:` entries
 * and plugin `addCommand` verbs the project itself contributes.
 *
 * The work happens in a `deno` subprocess (`denext commands --json`), never in this process.
 * Overlapping requests for the same `dir` share one child, and a successful listing is reused
 * for {@linkcode LIST_TTL_MS}; a timeout or a failure is never cached.
 *
 * @param dir The project directory.
 * @param offline `denext ui --offline`: the discovery child runs `--deny-net --cached-only`.
 * @returns The verb list, plus whether discovery was cut short by the budget or a bad config.
 */
export function listCommands(dir: string, offline = false): Promise<UiCommandList> {
  const key = `${offline}:${dir}`;
  const cached = listCache.get(key);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return Promise.resolve(cached.list);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const started = discover(dir, offline).then((list) => {
    if (cacheable(list)) listCache.set(key, { at: Date.now(), list });
    return list;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}

// ── the run form ─────────────────────────────────────────────────────────────

/** The longest value one field may carry into argv — a string flag or a positional. */
const MAX_ARG = 4096;

/**
 * Flag names the form never offers, even when a verb declares one: the CLI's global flags (the
 * UI pins `--cwd` itself, and the parser lets a later duplicate win) plus the two it
 * short-circuits on.
 */
const RESERVED_FLAGS: ReadonlySet<string> = new Set([
  ...GLOBAL_FLAGS.map((flag) => flag.name),
  "help",
  "version",
]);

/** Every value the request carried for one field, in document order. */
type Read = (key: string) => string[];

/** The field a declared flag posts under — namespaced, so it cannot collide with `verb` or `op`. */
function flagKey(name: string): string {
  return `flag:${name}`;
}

/** The field a declared positional posts under. */
function posKey(index: number): string {
  return `pos:${index}`;
}

/** Whether the form offers (and a run honours) this declared flag. */
function settable(flag: FlagSpec): boolean {
  return !RESERVED_FLAGS.has(flag.name);
}

/** Whether the panel offers a run form: a project or plugin verb, never a built-in. */
function offersRun(info: UiCommandInfo): boolean {
  return info.source !== "core";
}

/** Values put back into ONE verb's form — a row edit re-renders it filled in. */
interface Held {
  /** The verb whose form they belong to. */
  readonly verb: string;
  /** The submitted fields. */
  readonly read: Read;
}

/** What the view needs beyond the listing. */
interface View {
  /** The CSRF token every form carries. */
  readonly csrf: string;
  /** `--read-only`: every run control renders disabled. */
  readonly readOnly: boolean;
  /** `--offline`: every run is started without net, and the panel says so. */
  readonly offline: boolean;
  /** The values to re-render one verb's form with, if any. */
  readonly held?: Held;
  /** A refusal to announce at the top of the panel (a form post with JavaScript off). */
  readonly notice?: string;
}

/** The values a re-rendered control shows, or `undefined` on a fresh page. */
function heldValues(view: View, info: UiCommandInfo, key: string): string[] | undefined {
  return view.held?.verb === info.name ? view.held.read(key) : undefined;
}

/**
 * One argument field of the run form: the shared input, with the argv length cap on a text
 * field and any step on a number field.
 */
function ArgInput(props: InputProps): VNode {
  return h(Input, {
    ...props,
    maxLength: props.type === "text" ? MAX_ARG : undefined,
    step: props.type === "number" ? "any" : undefined,
  });
}

/** The label a flag's control carries: its long name, and its short alias when it has one. */
function flagLabel(flag: FlagSpec): string {
  return `--${flag.name}${flag.alias ? `, -${flag.alias}` : ""}`;
}

/** Props of a boolean flag's control. */
type SwitchProps = {
  /** The declared flag. */
  readonly flag: FlagSpec;
  /** The checkbox's id (the one its `<label>` points at). */
  readonly id: string;
  /** The re-rendered value, when the form is being put back. */
  readonly held: string | undefined;
  /** `--read-only`: render disabled. */
  readonly off: boolean;
};

/**
 * A boolean flag as a checkbox, after a hidden `false` twin: an unchecked box still posts, so a
 * run can tell "switched off" from "not in the form" — which is what lets a default-on switch be
 * turned off at all.
 */
function SwitchControl({ flag, id, held, off }: SwitchProps): VNode {
  const key = flagKey(flag.name);
  const checked = held === undefined ? flag.default === true : held === "true";
  return h(
    Fragment,
    null,
    h(Hidden, { name: key, value: "false", disabled: off }),
    h(Input, { type: "checkbox", name: key, id, value: "true", checked, disabled: off }),
  );
}

/** Props of every per-verb piece of the view. */
type VerbProps = {
  /** The verb. */
  readonly info: UiCommandInfo;
  /** The request's view state. */
  readonly view: View;
};

/** One declared flag as a typed control: a checkbox, a number input, or a text input. */
function FlagControl({ info, flag, view }: VerbProps & { readonly flag: FlagSpec }): VNode {
  const key = flagKey(flag.name);
  const id = `cmd-${info.name}-${key}`;
  const held = heldValues(view, info, key)?.at(-1);
  const body = flag.type === "boolean"
    ? h(SwitchControl, { flag, id, held, off: view.readOnly })
    : h(ArgInput, {
      type: flag.type === "number" ? "number" : "text",
      name: key,
      id,
      value: held ?? "",
      placeholder: flag.default === undefined ? undefined : String(flag.default),
      disabled: view.readOnly,
    });
  return h(Raw, {
    html: field({ id, label: flagLabel(flag), help: flag.help, body: renderView(body) }),
  });
}

/** Props of a variadic positional's row editor. */
type RowsProps = {
  /** The field every row posts under (`pos:<index>`) — also the list the row buttons edit. */
  readonly list: string;
  /** The first row's id (the one the `<label>` points at). */
  readonly id: string;
  /** One value per row. */
  readonly rows: readonly string[];
  /** `--read-only`: render disabled, with no `+ Add`. */
  readonly off: boolean;
};

/** A variadic positional as a row editor: one text input per argument, `✕` per row, `+ Add`. */
function PositionalRows({ list, id, rows, off }: RowsProps): VNode {
  const lines = rows.map((value, at) =>
    h(
      Row,
      { key: at },
      h(ArgInput, {
        type: "text",
        name: list,
        id: at === 0 ? id : `${id}-${at}`,
        value,
        ariaLabel: `${list} ${at + 1}`,
        disabled: off,
      }),
      h(Raw, {
        html: opButton({ op: "remove", at, list, label: "✕", title: "Remove", disabled: off }),
      }),
    )
  );
  const add = opButton({ op: "add", at: rows.length, list, label: "+ Add", title: "Add" });
  return h("div", null, lines, off ? null : h(Raw, { html: add }));
}

/** One declared positional: a text input, or a row editor when it soaks up the rest. */
function PositionalControl(
  { info, spec, index, view }: VerbProps & {
    readonly spec: PositionalSpec;
    readonly index: number;
  },
): VNode {
  const key = posKey(index);
  const id = `cmd-${info.name}-${key}`;
  const held = heldValues(view, info, key);
  const body = spec.variadic
    ? h(PositionalRows, { list: key, id, rows: held ?? [""], off: view.readOnly })
    : h(ArgInput, {
      type: "text",
      name: key,
      id,
      value: held?.[0] ?? "",
      required: spec.required,
      disabled: view.readOnly,
    });
  const label = spec.variadic ? `${spec.name}…` : spec.name;
  const badges = spec.required ? [{ text: "required" }] : [];
  return h(Raw, { html: field({ id, label, help: spec.help, badges, body: renderView(body) }) });
}

/**
 * The implicit-submission target of a form that holds row buttons: Enter in a field activates
 * the form's FIRST submit button, which must be Run, not a row's `✕`.
 */
function DefaultRun(): VNode {
  return h(
    "button",
    { type: "submit", hidden: true, tabindex: "-1", "aria-hidden": "true" },
    "Run",
  );
}

/** The run form of one verb (a real POST, upgraded to fetch + SSE by ui.js). */
function RunForm({ info, view }: VerbProps): VNode {
  const rows = info.positionals.some((spec) => spec.variadic === true);
  const positionals = info.positionals.map((spec, index) =>
    h(PositionalControl, { key: posKey(index), info, spec, index, view })
  );
  const flags = info.flags.filter(settable).map((flag) =>
    h(FlagControl, { key: flag.name, info, flag, view })
  );
  return h(OpForm, {
    csrf: view.csrf,
    action: PATH,
    label: "Run",
    fields: { verb: info.name },
    extra: [rows ? h(DefaultRun, null) : null, ...positionals, ...flags],
    disabled: view.readOnly,
  });
}

// ── the view ─────────────────────────────────────────────────────────────────

/** One rendered group of verbs. */
interface Group {
  /** The source whose verbs it lists. */
  readonly source: VerbSource;
  /** The heading. */
  readonly title: string;
  /** The sentence under the heading. */
  readonly lead: string;
  /** Whether it renders inside a collapsed `<details>`. */
  readonly collapsed: boolean;
}

/** The three groups, in render order. */
const GROUPS: readonly Group[] = [
  {
    source: "project",
    title: "Project commands",
    lead: "Declared in denext.config.ts under commands: — no plugin needed.",
    collapsed: false,
  },
  {
    source: "plugin",
    title: "Plugin commands",
    lead: "Contributed by a plugin's addCommand seam.",
    collapsed: false,
  },
  {
    source: "core",
    title: "Built-in",
    lead: "The verbs denext itself ships. Run these from your terminal.",
    collapsed: true,
  },
];

/** One row of a built-in's flag table. */
function FlagRow({ flag }: { readonly flag: FlagSpec }): VNode {
  const signature = `${flagLabel(flag)}${flag.valueName ? ` ${flag.valueName}` : ""}`;
  return h(
    "tr",
    null,
    h("td", null, h("code", null, signature)),
    h("td", null, flag.type),
    h("td", null, flag.default === undefined ? "" : String(flag.default)),
    h("td", null, flag.help),
  );
}

/** The flag table of a built-in verb. */
function FlagTable({ flags }: { readonly flags: readonly FlagSpec[] }): VNode {
  return h(Table, {
    head: ["Flag", "Type", "Default", "What it does"],
    rows: flags.map((flag) => h(FlagRow, { key: flag.name, flag })),
  });
}

/** One positional of a built-in's argument list. */
function ArgItem({ positional }: { readonly positional: PositionalSpec }): VNode {
  return h(
    "li",
    null,
    h("code", null, `${positional.name}${positional.variadic ? "…" : ""}`),
    ` — ${positional.help}`,
    positional.required ? [" ", h("span", { class: "badge" }, "required")] : null,
  );
}

/** A built-in's reference: its argument list, then its flag table (each only when declared). */
function BuiltinReference({ info }: { readonly info: UiCommandInfo }): VNode {
  return h(
    Fragment,
    null,
    info.positionals.length === 0 ? null : h(
      "ul",
      { class: "args" },
      info.positionals.map((positional) => h(ArgItem, { key: positional.name, positional })),
    ),
    info.flags.length === 0 ? null : h(FlagTable, { flags: info.flags }),
  );
}

/**
 * One verb: what it is, and either its run form (a project or plugin verb — one control per
 * declared flag and positional) or, for a built-in, its argument list and flag table.
 */
function VerbCard({ info, view }: VerbProps): VNode {
  return h(
    "article",
    { class: "verb" },
    h(
      "h3",
      null,
      h("code", null, `denext ${info.name}`),
      " ",
      h(Badge, { tone: "info" }, info.source),
    ),
    h("p", null, info.summary),
    info.usage ? h("pre", { class: "mono" }, info.usage) : null,
    offersRun(info) ? h(RunForm, { info, view }) : h(BuiltinReference, { info }),
  );
}

/** Props of one group of verbs. */
type GroupProps = {
  /** The group. */
  readonly group: Group;
  /** Every discovered verb (the group picks its own). */
  readonly commands: readonly UiCommandInfo[];
  /** The request's view state. */
  readonly view: View;
};

/** One group: its verbs, or an honest "none" line. */
function VerbGroup({ group, commands, view }: GroupProps): VNode {
  const verbs = commands.filter((info) => info.source === group.source);
  const body = h(
    Fragment,
    null,
    h("p", { class: "lead" }, group.lead),
    verbs.length === 0
      ? h(Note, null, `None — this project contributes no ${group.source} verbs.`)
      : verbs.map((info) => h(VerbCard, { key: info.name, info, view })),
  );
  if (!group.collapsed) return h(Fragment, null, h("h2", null, group.title), body);
  return h("details", null, h("summary", null, `${group.title} (${verbs.length})`), body);
}

/** The plugin budget ran out: say so, and whether the built-ins survived it. */
function TimeoutNote({ empty }: { readonly empty: boolean }): VNode {
  return h(
    Note,
    null,
    `Plugin setup exceeded ${(budgetMs / 1000).toFixed(1)} s — project verbs not listed. `,
    empty
      ? [
        "Discovery itself was cut short; run ",
        h("code", null, "denext commands"),
        " in a terminal to see why.",
      ]
      : "Built-in verbs are unaffected.",
  );
}

/** Whatever cut discovery short, said plainly — never an empty page. */
function Notices({ list }: { readonly list: UiCommandList }): VNode {
  return h(
    Fragment,
    null,
    list.timedOut ? h(TimeoutNote, { empty: list.commands.length === 0 }) : null,
    list.error === undefined ? null : h(
      Note,
      null,
      `denext.config.ts could not be read — project verbs not listed: ${list.error}`,
    ),
  );
}

/** Props of the whole panel. */
type PanelProps = {
  /** The discovered verbs. */
  readonly list: UiCommandList;
  /** The request's view state. */
  readonly view: View;
  /** The finished run's output lines (empty on a plain page load). */
  readonly output: readonly string[];
  /** The `?q=` filter over verb name and summary (`""` for none). */
  readonly query: string;
};

/**
 * Whether a verb matches a search: its name or its one-line summary, every term having to match
 * something. `denext` ships 29 built-ins, so the reference is most of this page — a filter is how
 * you find the one you meant without reading all of them.
 *
 * @param info The verb.
 * @param query The raw `?q=` value.
 * @returns Whether to show it.
 */
function verbMatches(info: UiCommandInfo, query: string): boolean {
  return matchesTerms(`${info.name} ${info.summary}`, query);
}

/**
 * The panel `<section>` — the piece `ui.js` swaps. Its one `pre.out` (after the groups) is the
 * sink `ui.js` streams a run's output into.
 */
function CommandsPanel({ list, view, output, query }: PanelProps): VNode {
  const commands = query === ""
    ? list.commands
    : list.commands.filter((info) => verbMatches(info, query));
  return h(
    Panel,
    { name: "Commands", title: "Commands" },
    h(
      "p",
      { class: "lead" },
      "The verbs this project adds to ",
      h("code", null, "denext"),
      " — from denext.config.ts or a plugin's addCommand. ",
      h("a", { href: DOCS }, "Project commands ↗"),
    ),
    h(FilterForm, { action: PATH, query, label: "Filter verbs" }),
    h(Notices, { list }),
    view.notice === undefined ? null : h(Note, { role: "alert" }, view.notice),
    view.offline ? h(Note, { tone: "warn" }, OFFLINE_NOTE) : null,
    query === ""
      ? null
      : h("p", { class: "filter-note" }, matchNote(commands.length, query, "verb")),
    GROUPS.map((group) => h(VerbGroup, { key: group.source, group, commands, view })),
    h("h2", null, "Output"),
    h(Out, null, output.join("\n")),
  );
}

/** The panel's shell: a fragment for `ui.js`, the whole document for a plain navigation. */
const respond = panelResponder("Commands", PATH);

/** Answer with the panel: the bare section when ui.js asked for one, else the full document. */
function panelResponse(
  ctx: UiContext,
  list: UiCommandList,
  output: readonly string[],
  held?: Held,
  refused?: { readonly notice: string; readonly status: number },
): Response {
  const view: View = {
    csrf: ctx.csrf,
    readOnly: ctx.readOnly,
    offline: ctx.offline === true,
    held,
    notice: refused?.notice,
  };
  const query = (ctx.url.searchParams.get("q") ?? "").trim();
  return respond(
    ctx,
    renderView(h(CommandsPanel, { list, view, output, query })),
    refused?.status,
  );
}

/**
 * A refused run. The JSON twin gets `{ ok: false, … }`; a form post (JavaScript off) gets the
 * panel back with the reason as an alert, the same status, and the submitted values kept.
 */
function refusal(
  ctx: UiContext,
  list: UiCommandList,
  status: number,
  body: { readonly reason: string } & Record<string, unknown>,
  held?: Held,
): Response {
  if (ctx.json) return jsonResponse({ ok: false, ...body }, status);
  return panelResponse(ctx, list, [], held, { notice: body.reason, status });
}

// ── building a run's argv ────────────────────────────────────────────────────

/** A submitted value a run refuses — answered 422, naming the field. */
class FieldError extends Error {
  /** The field it names (`flag:<name>` or `pos:<index>`). */
  readonly field: string;

  /**
   * @param field The field at fault.
   * @param message Why, without the field name (the message is prefixed with it).
   */
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.field = field;
  }
}

/** A string value cleared for argv: bounded, and free of the NUL byte no argv can carry. */
function cleanText(key: string, value: string): string {
  if (value.length > MAX_ARG) throw new FieldError(key, `longer than ${MAX_ARG} characters`);
  if (value.includes("\0")) throw new FieldError(key, "contains a NUL byte");
  return value;
}

/** A number field's value as argv text — finite, or refused (`NaN`, `Infinity`, `1e400`). */
function finiteArg(key: string, value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new FieldError(key, `expects a finite number, got "${value.slice(0, 32)}"`);
  }
  return String(n);
}

/** A boolean's argv: `--name` when checked; `--name=false` only to turn a default-on switch off. */
function switchArgs(flag: FlagSpec, value: string): string[] {
  if (value === "true") return [`--${flag.name}`];
  return value === "false" && flag.default === true ? [`--${flag.name}=false`] : [];
}

/**
 * What one declared flag adds to argv, from its LAST submitted value (a checkbox posts after its
 * hidden `false` twin). A blank valued field is left out, so the CLI applies the declared
 * default; a value is always its own element — never `--name=value` built from browser text.
 */
function flagArgs(flag: FlagSpec, values: readonly string[]): string[] {
  const key = flagKey(flag.name);
  const value = values.at(-1);
  if (value === undefined) return [];
  if (flag.type === "boolean") return switchArgs(flag, value);
  if (flag.type === "number") {
    return value.trim() === "" ? [] : [`--${flag.name}`, finiteArg(key, value)];
  }
  return value === "" ? [] : [`--${flag.name}`, cleanText(key, value)];
}

/** A positional cleared for argv: never a flag in disguise (`--cwd=/etc`), bounded, NUL-free. */
function positionalArg(key: string, value: string): string {
  if (value.startsWith("-")) {
    throw new FieldError(key, `may not start with "-" — it would be read as a flag`);
  }
  return cleanText(key, value);
}

/**
 * The positionals, in declared order: a variadic one contributes every non-blank row, any other
 * its first non-blank value. A required one left blank is refused, and so is a value after an
 * optional one left blank — it would silently slide into that earlier slot.
 */
function positionalArgs(specs: readonly PositionalSpec[], read: Read): string[] {
  const out: string[] = [];
  let skipped: string | undefined;
  specs.forEach((spec, index) => {
    const key = posKey(index);
    const given = read(key).filter((value) => value !== "");
    const taken = spec.variadic ? given : given.slice(0, 1);
    if (taken.length === 0) {
      if (spec.required) throw new FieldError(key, `${spec.name} is required`);
      skipped ??= spec.name;
      return;
    }
    if (skipped !== undefined) throw new FieldError(key, `${spec.name} needs ${skipped} first`);
    for (const value of taken) out.push(positionalArg(key, value));
  });
  return out;
}

/**
 * A run's argv, from the REFRESHED listing's declaration of `info` — never from the browser's
 * idea of which flags exist: a field the verb does not declare is simply never read. Under
 * `offline` the child runs `--deny-net --cached-only`.
 */
function runArgv(info: UiCommandInfo, dir: string, read: Read, offline: boolean): string[] {
  const flags = info.flags.filter(settable).flatMap((flag) =>
    flagArgs(flag, read(flagKey(flag.name)))
  );
  const positionals = positionalArgs(info.positionals, read);
  return [...cliInvocation({ offline, dir }), info.name, "--cwd", dir, ...flags, ...positionals];
}

/** The run's argv, or the 422 that names the field it refused. */
function argvOrRefusal(
  ctx: UiContext,
  info: UiCommandInfo,
  list: UiCommandList,
  read: Read,
): string[] | Response {
  try {
    return runArgv(info, ctx.dir, read, ctx.offline === true);
  } catch (error) {
    if (!(error instanceof FieldError)) throw error;
    const body = { reason: error.message, field: error.field };
    return refusal(ctx, list, 422, body, { verb: info.name, read });
  }
}

/** Whether a JSON body value can stand for a form field's text. */
function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * The request's fields: form fields (no-JS and ui.js), or the same names as keys of a JSON body
 * (`{ "verb": "seed", "flag:rows": 5, "pos:0": "users" }`), where an array is several values.
 */
function readerOf(ctx: UiContext): Read {
  const form = ctx.form;
  if (form) {
    return (key) => form.getAll(key).filter((value): value is string => typeof value === "string");
  }
  const body = ctx.body !== null && typeof ctx.body === "object"
    ? ctx.body as Record<string, unknown>
    : {};
  return (key) => (Object.hasOwn(body, key) ? [body[key]].flat() : []).filter(isScalar).map(String);
}

// ── running a verb ───────────────────────────────────────────────────────────

/** Tell every open page a run finished, so a second tab's list is not stale. */
function announce(ctx: UiContext, verb: string, code: number): void {
  broadcast(ctx.events, { type: "command-done", command: verb, code });
}

/** The 400 for a verb the panel offers no run form: unknown, or a built-in. */
function refused(
  ctx: UiContext,
  verb: string,
  info: UiCommandInfo | undefined,
  list: UiCommandList,
): Response {
  return refusal(ctx, list, 400, {
    reason: info === undefined
      ? `unknown command "${verb}"`
      : `"${verb}" is a built-in verb — run it from your terminal`,
    runnable: list.commands.filter(offersRun).map((c) => c.name),
  });
}

/** Whether `list` names a variadic positional of `info` — the only lists a row button edits. */
function editsRows(info: UiCommandInfo, list: string): boolean {
  return info.positionals.some((spec, index) => spec.variadic === true && posKey(index) === list);
}

/** A row button (`+ Add`, `✕`): re-render the verb's form with the edit applied — nothing runs. */
function editRows(ctx: UiContext, info: UiCommandInfo, list: UiCommandList, read: Read): Response {
  const request = parseOp(read(OP_FIELD)[0] ?? "");
  if (request === undefined || !editsRows(info, request.list)) {
    return refusal(ctx, list, 400, { reason: "unknown row operation" }, { verb: info.name, read });
  }
  const rows = applyListOp(read(request.list), request.op, request.at, "");
  const held: Read = (key) => key === request.list ? rows : read(key);
  return panelResponse(ctx, list, [], { verb: info.name, read: held });
}

/**
 * Stream a verb's output to the browser as SSE `data:` frames, one per line, closing with the
 * exit frame. A page that navigated away simply drops what is still arriving.
 */
function streamRun(ctx: UiContext, verb: string, argv: string[]): Response {
  return sseProcess(
    (line, signal) => runner(argv, { cwd: ctx.dir, onLine: line, signal }),
    { settled: (code) => code !== null && announce(ctx, verb, code) },
  );
}

/** Run the verb the way this client can consume it: SSE, a JSON envelope, or a re-rendered page. */
async function runVerb(
  ctx: UiContext,
  info: UiCommandInfo,
  list: UiCommandList,
  argv: string[],
): Promise<Response> {
  if (ctx.fragment) return streamRun(ctx, info.name, argv);
  const output: string[] = [];
  const code = await runner(argv, {
    cwd: ctx.dir,
    onLine: (line) => output.push(line),
    signal: ctx.signal,
  });
  announce(ctx, info.name, code);
  if (ctx.json) return jsonResponse({ ok: code === 0, verb: info.name, code, output });
  return panelResponse(ctx, list, [...output, exitLine(code)]);
}

/**
 * The POST half: refuse read-only, refuse a verb with no run form, apply a row edit, else build
 * the argv from the verb's declared flags and positionals and run it.
 */
async function handleRun(ctx: UiContext): Promise<Response> {
  const read = readerOf(ctx);
  const list = await listCommands(ctx.dir, ctx.offline === true);
  if (ctx.readOnly) {
    return refusal(ctx, list, 403, { reason: "read-only — running a verb may write" });
  }
  const verb = read("verb")[0] ?? "";
  const info = list.commands.find((candidate) => candidate.name === verb);
  if (info === undefined || !offersRun(info)) return refused(ctx, verb, info, list);
  if (read(OP_FIELD).length > 0) return editRows(ctx, info, list, read);
  const argv = argvOrRefusal(ctx, info, list, read);
  if (argv instanceof Response) return argv;
  return await runVerb(ctx, info, list, argv);
}

/** Serve the project-commands panel. */
export const commandsPanel: UiHandler = async (
  _request: Request,
  ctx: UiContext,
): Promise<Response> => {
  if (ctx.method === "POST") return await handleRun(ctx);
  const list = await listCommands(ctx.dir, ctx.offline === true);
  if (!ctx.json) return panelResponse(ctx, list, []);
  return jsonResponse({
    ok: true,
    timedOut: list.timedOut,
    ...(list.error === undefined ? {} : { error: list.error }),
    commands: list.commands,
  });
};
