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

import { type FlagSpec, GLOBAL_FLAGS, type PositionalSpec } from "../../cli/command.ts";
import {
  esc,
  html,
  jsonResponse,
  opForm,
  panelResponder,
  raw,
  type RawHtml,
  type UiContext,
  type UiHandler,
} from "../html.ts";
import { field, opButton } from "../form/control.ts";
import { applyListOp, OP_FIELD, parseOp } from "../form/value.ts";
import { broadcast, exitLine, sseProcess } from "../events.ts";
import { cliInvocation, runDeno, type RunDenoOptions } from "../proc.ts";

/** The panel's own path — its form action, and the nav entry it marks current. */
const PATH = "/commands";

/** Where the two extension seams are documented. */
const DOCS = "https://denext.dev/docs/plugins#project-commands";

/**
 * How long the whole discovery subprocess may take before the panel gives up on it. Generous
 * next to {@linkcode DEFAULT_BUDGET_MS}: the child pays Deno's own cold start before it even
 * begins importing the project's config.
 */
const DISCOVERY_BUDGET_MS = 8000;

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
  const lines = output.split("\n").map((line) => line.replace(/\r$/, ""));
  const open = lines.indexOf("{");
  const close = lines.lastIndexOf("}");
  if (open < 0 || close < open) return null;
  try {
    const parsed = JSON.parse(lines.slice(open, close + 1).join("\n"));
    return parsed !== null && typeof parsed === "object" ? parsed as CommandListing : null;
  } catch {
    return null;
  }
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
 * Spawn `denext commands --json` against `dir` and read its listing back. Never rejects: a
 * child that cannot start, times out, or prints nothing parsable degrades to an empty list
 * with an honest reason, which the panel renders as a notice.
 */
async function discover(dir: string): Promise<UiCommandList> {
  const lines: string[] = [];
  const argv = [
    ...cliInvocation(),
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
      signal: AbortSignal.timeout(DISCOVERY_BUDGET_MS),
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
 * @returns The verb list, plus whether discovery was cut short by the budget or a bad config.
 */
export function listCommands(dir: string): Promise<UiCommandList> {
  const cached = listCache.get(dir);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return Promise.resolve(cached.list);
  const pending = inFlight.get(dir);
  if (pending) return pending;
  const started = discover(dir).then((list) => {
    if (cacheable(list)) listCache.set(dir, { at: Date.now(), list });
    return list;
  }).finally(() => inFlight.delete(dir));
  inFlight.set(dir, started);
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
  /** The values to re-render one verb's form with, if any. */
  readonly held?: Held;
}

/** The values a re-rendered control shows, or `undefined` on a fresh page. */
function heldValues(view: View, info: UiCommandInfo, key: string): string[] | undefined {
  return view.held?.verb === info.name ? view.held.read(key) : undefined;
}

/** One `<input>` of the run form. */
interface InputAttrs {
  readonly type: "text" | "number" | "checkbox" | "hidden";
  readonly name: string;
  readonly value: string;
  readonly id?: string;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly checked?: boolean;
  readonly required?: boolean;
  readonly disabled?: boolean;
}

/**
 * Render one input by string concatenation, not a tagged template: `deno fmt` reflows `html`
 * templates as markup, and an input's attributes must not acquire newlines because the source
 * was wrapped. Every value is escaped; a `true` attribute renders bare, `false`/`undefined`
 * drops it. A text field carries the argv length cap, a number field any step.
 */
function input(a: InputAttrs): RawHtml {
  const pairs: readonly (readonly [string, string | boolean | undefined])[] = [
    ["type", a.type],
    ["name", a.name],
    ["value", a.value],
    ["maxlength", a.type === "text" ? String(MAX_ARG) : undefined],
    ["step", a.type === "number" ? "any" : undefined],
    ["id", a.id],
    ["placeholder", a.placeholder || undefined],
    ["aria-label", a.ariaLabel],
    ["checked", a.checked],
    ["required", a.required],
    ["disabled", a.disabled],
  ];
  const attrs = pairs
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([name, value]) => value === true ? ` ${name}` : ` ${name}="${esc(value)}"`);
  return raw(`<input${attrs.join("")}>`);
}

/** The label a flag's control carries: its long name, and its short alias when it has one. */
function flagLabel(flag: FlagSpec): string {
  return `--${flag.name}${flag.alias ? `, -${flag.alias}` : ""}`;
}

/**
 * A boolean flag as a checkbox, after a hidden `false` twin: an unchecked box still posts, so a
 * run can tell "switched off" from "not in the form" — which is what lets a default-on switch be
 * turned off at all.
 */
function switchControl(
  flag: FlagSpec,
  id: string,
  held: string | undefined,
  off: boolean,
): RawHtml {
  const key = flagKey(flag.name);
  const checked = held === undefined ? flag.default === true : held === "true";
  return html`${input({ type: "hidden", name: key, value: "false", disabled: off })}${
    input({ type: "checkbox", name: key, id, value: "true", checked, disabled: off })
  }`;
}

/** One declared flag as a typed control: a checkbox, a number input, or a text input. */
function flagControl(info: UiCommandInfo, flag: FlagSpec, view: View): RawHtml {
  const key = flagKey(flag.name);
  const id = `cmd-${info.name}-${key}`;
  const held = heldValues(view, info, key)?.at(-1);
  const body = flag.type === "boolean" ? switchControl(flag, id, held, view.readOnly) : input({
    type: flag.type === "number" ? "number" : "text",
    name: key,
    id,
    value: held ?? "",
    placeholder: flag.default === undefined ? undefined : String(flag.default),
    disabled: view.readOnly,
  });
  return field({ id, label: flagLabel(flag), help: flag.help, body });
}

/** A variadic positional as a row editor: one text input per argument, `✕` per row, `+ Add`. */
function rowEditor(key: string, id: string, rows: readonly string[], off: boolean): RawHtml {
  const lines = rows.map((value, at) =>
    html`<div class="row">${
      input({
        type: "text",
        name: key,
        id: at === 0 ? id : `${id}-${at}`,
        value,
        ariaLabel: `${key} ${at + 1}`,
        disabled: off,
      })
    }${opButton({ op: "remove", at, list: key, label: "✕", title: "Remove", disabled: off })}</div>`
  );
  const add = opButton({ op: "add", at: rows.length, list: key, label: "+ Add", title: "Add" });
  return html`<div>${lines}${off ? "" : add}</div>`;
}

/** One declared positional: a text input, or a row editor when it soaks up the rest. */
function positionalControl(
  info: UiCommandInfo,
  spec: PositionalSpec,
  index: number,
  view: View,
): RawHtml {
  const key = posKey(index);
  const id = `cmd-${info.name}-${key}`;
  const held = heldValues(view, info, key);
  const body = spec.variadic ? rowEditor(key, id, held ?? [""], view.readOnly) : input({
    type: "text",
    name: key,
    id,
    value: held?.[0] ?? "",
    required: spec.required,
    disabled: view.readOnly,
  });
  const label = spec.variadic ? `${spec.name}…` : spec.name;
  return field({ id, label, help: spec.help, badge: spec.required ? "required" : undefined, body });
}

/**
 * The implicit-submission target of a form that holds row buttons: Enter in a field activates
 * the form's FIRST submit button, which must be Run, not a row's `✕`.
 */
const DEFAULT_RUN = raw(
  '<button type="submit" hidden tabindex="-1" aria-hidden="true">Run</button>',
);

/** The run form of one verb (a real POST, upgraded to fetch + SSE by ui.js). */
function runForm(info: UiCommandInfo, view: View): RawHtml {
  const positionals = info.positionals.map((spec, index) =>
    positionalControl(info, spec, index, view)
  );
  const flags = info.flags.filter(settable).map((flag) => flagControl(info, flag, view));
  const rows = info.positionals.some((spec) => spec.variadic === true);
  return opForm(view.csrf, {
    action: PATH,
    label: "Run",
    fields: { verb: info.name },
    extra: html`${rows && DEFAULT_RUN}${positionals}${flags}`,
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

/** The flag table of one verb (nothing at all when it declares no flags). */
function renderFlags(flags: readonly FlagSpec[]): RawHtml {
  if (flags.length === 0) return html``;
  const rows = flags.map((flag) =>
    html`
      <tr>
        <td><code>--${flag.name}${flag.alias ? ", -" + flag.alias : ""}${flag.valueName
          ? " " + flag.valueName
          : ""}</code></td>
        <td>${flag.type}</td>
        <td>${flag.default === undefined ? "" : String(flag.default)}</td>
        <td>${flag.help}</td>
      </tr>
    `
  );
  return html`
    <table class="table">
      <thead>
        <tr>
          <th>Flag</th>
          <th>Type</th>
          <th>Default</th>
          <th>What it does</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/** The positional list of one verb (nothing at all when it declares none). */
function renderPositionals(positionals: readonly PositionalSpec[]): RawHtml {
  if (positionals.length === 0) return html``;
  return html`<ul class="args">${
    positionals.map((positional) =>
      html`<li><code>${positional.name}${positional.variadic ? "…" : ""}</code> — ${positional.help}
${positional.required ? html`<span class="badge">required</span>` : ""}</li>`
    )
  }</ul>`;
}

/**
 * One verb: what it is, and either its run form (a project or plugin verb — one control per
 * declared flag and positional) or, for a built-in, its flag table and argument list.
 */
function renderVerb(info: UiCommandInfo, view: View): RawHtml {
  const body = offersRun(info)
    ? runForm(info, view)
    : html`${renderPositionals(info.positionals)}${renderFlags(info.flags)}`;
  return html`<article class="verb">
<h3><code>denext ${info.name}</code> <span class="badge">${info.source}</span></h3>
<p>${info.summary}</p>
${info.usage ? html`<pre class="mono">${info.usage}</pre>` : ""}
${body}</article>`;
}

/** One group: its verbs, or an honest "none" line. */
function renderGroup(group: Group, commands: readonly UiCommandInfo[], view: View): RawHtml {
  const verbs = commands.filter((info) => info.source === group.source);
  const body = html`<p class="lead">${group.lead}</p>${
    verbs.length === 0
      ? html`<p class="note">None — this project contributes no ${group.source} verbs.</p>`
      : verbs.map((info) => renderVerb(info, view))
  }`;
  if (!group.collapsed) return html`<h2>${group.title}</h2>${body}`;
  return html`<details><summary>${group.title} (${verbs.length})</summary>${body}</details>`;
}

/** Whatever cut discovery short, said plainly — never an empty page. */
function notices(list: UiCommandList): RawHtml {
  const items: RawHtml[] = [];
  if (list.timedOut) {
    items.push(html`
      <p class="note">Plugin setup exceeded ${(budgetMs / 1000).toFixed(1)} s — project verbs not
      listed. ${list.commands.length === 0
        ? html`Discovery itself was cut short; run <code>denext commands</code> in a terminal to
see why.`
        : html`Built-in verbs are unaffected.`}</p>
    `);
  }
  if (list.error !== undefined) {
    items.push(
      html`<p class="note">denext.config.ts could not be read — project verbs not listed: ${list.error}</p>`,
    );
  }
  return html`${items}`;
}

/** The panel `<section>` — the piece `ui.js` swaps on a fragment request. */
function panelSection(
  list: UiCommandList,
  view: View,
  output: readonly string[],
): RawHtml {
  return html`<section id="panel" data-panel="Commands">
<h1>Commands</h1>
<p class="lead">The verbs this project adds to <code>denext</code> — from denext.config.ts or a
plugin's addCommand. <a href="${DOCS}">Project commands ↗</a></p>
${notices(list)}
${GROUPS.map((group) => renderGroup(group, list.commands, view))}
<h2>Output</h2>
<pre class="out">${output.join("\n")}</pre></section>`;
}

/** The panel's shell: a fragment for `ui.js`, the whole document for a plain navigation. */
const respond = panelResponder("Commands", PATH);

/** Answer with the panel: the bare section when ui.js asked for one, else the full document. */
function panelResponse(
  ctx: UiContext,
  list: UiCommandList,
  output: readonly string[],
  held?: Held,
): Response {
  const view: View = { csrf: ctx.csrf, readOnly: ctx.readOnly, held };
  return respond(ctx, panelSection(list, view, output));
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
 * idea of which flags exist: a field the verb does not declare is simply never read.
 */
function runArgv(info: UiCommandInfo, dir: string, read: Read): string[] {
  const flags = info.flags.filter(settable).flatMap((flag) =>
    flagArgs(flag, read(flagKey(flag.name)))
  );
  const positionals = positionalArgs(info.positionals, read);
  return [...cliInvocation(), info.name, "--cwd", dir, ...flags, ...positionals];
}

/** The run's argv, or the 422 that names the field it refused. */
function argvOrRefusal(info: UiCommandInfo, dir: string, read: Read): string[] | Response {
  try {
    return runArgv(info, dir, read);
  } catch (error) {
    if (!(error instanceof FieldError)) throw error;
    return jsonResponse({ ok: false, reason: error.message, field: error.field }, 422);
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
function refused(verb: string, info: UiCommandInfo | undefined, list: UiCommandList): Response {
  return jsonResponse({
    ok: false,
    reason: info === undefined
      ? `unknown command "${verb}"`
      : `"${verb}" is a built-in verb — run it from your terminal`,
    runnable: list.commands.filter(offersRun).map((c) => c.name),
  }, 400);
}

/** Whether `list` names a variadic positional of `info` — the only lists a row button edits. */
function editsRows(info: UiCommandInfo, list: string): boolean {
  return info.positionals.some((spec, index) => spec.variadic === true && posKey(index) === list);
}

/** A row button (`+ Add`, `✕`): re-render the verb's form with the edit applied — nothing runs. */
function editRows(ctx: UiContext, info: UiCommandInfo, list: UiCommandList, read: Read): Response {
  const request = parseOp(read(OP_FIELD)[0] ?? "");
  if (request === undefined || !editsRows(info, request.list)) {
    return jsonResponse({ ok: false, reason: "unknown row operation" }, 400);
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
    (line) => runner(argv, { cwd: ctx.dir, onLine: line }),
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
  const code = await runner(argv, { cwd: ctx.dir, onLine: (line) => output.push(line) });
  announce(ctx, info.name, code);
  if (ctx.json) return jsonResponse({ ok: code === 0, verb: info.name, code, output });
  return panelResponse(ctx, list, [...output, exitLine(code)]);
}

/**
 * The POST half: refuse read-only, refuse a verb with no run form, apply a row edit, else build
 * the argv from the verb's declared flags and positionals and run it.
 */
async function handleRun(ctx: UiContext): Promise<Response> {
  if (ctx.readOnly) {
    return jsonResponse({ ok: false, reason: "read-only — running a verb may write" }, 403);
  }
  const read = readerOf(ctx);
  const verb = read("verb")[0] ?? "";
  const list = await listCommands(ctx.dir);
  const info = list.commands.find((candidate) => candidate.name === verb);
  if (info === undefined || !offersRun(info)) return refused(verb, info, list);
  if (read(OP_FIELD).length > 0) return editRows(ctx, info, list, read);
  const argv = argvOrRefusal(info, ctx.dir, read);
  if (argv instanceof Response) return argv;
  return await runVerb(ctx, info, list, argv);
}

/** Serve the project-commands panel. */
export const commandsPanel: UiHandler = async (
  _request: Request,
  ctx: UiContext,
): Promise<Response> => {
  if (ctx.method === "POST") return await handleRun(ctx);
  const list = await listCommands(ctx.dir);
  if (!ctx.json) return panelResponse(ctx, list, []);
  return jsonResponse({
    ok: true,
    timedOut: list.timedOut,
    ...(list.error === undefined ? {} : { error: list.error }),
    commands: list.commands,
  });
};
