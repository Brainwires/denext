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
// `--read-only`, and only project/plugin verbs that declare no required positional are offered
// a Run button — built-ins belong in the terminal, where their long-lived output does.

import type { FlagSpec, PositionalSpec } from "../../cli/command.ts";
import {
  html,
  jsonResponse,
  opForm,
  panelResponder,
  type RawHtml,
  type UiContext,
  type UiHandler,
} from "../html.ts";
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
   * Whether the panel offers a Run button: a project or plugin verb that needs no argument.
   * Built-ins are never runnable from here — `denext dev` would never exit.
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

/** The one-button form that runs a verb (a real POST, upgraded to fetch + SSE by ui.js). */
function runForm(name: string, csrf: string): RawHtml {
  return opForm(csrf, { action: PATH, label: "Run", fields: { verb: name } });
}

/** One verb: what it is, how it is invoked, and (when it needs no argument) how to run it. */
function renderVerb(info: UiCommandInfo, csrf: string): RawHtml {
  return html`<article class="verb">
<h3><code>denext ${info.name}</code> <span class="badge">${info.source}</span></h3>
<p>${info.summary}</p>
${info.usage ? html`<pre class="mono">${info.usage}</pre>` : ""}
${renderPositionals(info.positionals)}
${renderFlags(info.flags)}
${info.runnable ? runForm(info.name, csrf) : ""}</article>`;
}

/** One group: its verbs, or an honest "none" line. */
function renderGroup(group: Group, commands: readonly UiCommandInfo[], csrf: string): RawHtml {
  const verbs = commands.filter((info) => info.source === group.source);
  const body = html`<p class="lead">${group.lead}</p>${
    verbs.length === 0
      ? html`<p class="note">None — this project contributes no ${group.source} verbs.</p>`
      : verbs.map((info) => renderVerb(info, csrf))
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
  csrf: string,
  output: readonly string[],
): RawHtml {
  return html`<section id="panel" data-panel="Commands">
<h1>Commands</h1>
<p class="lead">The verbs this project adds to <code>denext</code> — from denext.config.ts or a
plugin's addCommand. <a href="${DOCS}">Project commands ↗</a></p>
${notices(list)}
${GROUPS.map((group) => renderGroup(group, list.commands, csrf))}
<h2>Output</h2>
<pre class="out">${output.join("\n")}</pre></section>`;
}

/** The panel's shell: a fragment for `ui.js`, the whole document for a plain navigation. */
const respond = panelResponder("Commands", PATH);

/** Answer with the panel: the bare section when ui.js asked for one, else the full document. */
function panelResponse(ctx: UiContext, list: UiCommandList, output: readonly string[]): Response {
  return respond(ctx, panelSection(list, ctx.csrf, output));
}

// ── running a verb ───────────────────────────────────────────────────────────

/** Tell every open page a run finished, so a second tab's list is not stale. */
function announce(ctx: UiContext, verb: string, code: number): void {
  broadcast(ctx.events, { type: "command-done", command: verb, code });
}

/** The verb the mutation asked for — a form field (no-JS and ui.js) or a JSON body. */
function requestedVerb(ctx: UiContext): string {
  const field = ctx.form?.get("verb");
  if (typeof field === "string") return field;
  const body = ctx.body as { verb?: unknown } | undefined;
  return typeof body?.verb === "string" ? body.verb : "";
}

/** Why a verb cannot be run from the browser, in the words the refusal carries. */
function refusal(verb: string, info: UiCommandInfo | undefined): string {
  if (!info) return `unknown command "${verb}"`;
  if (info.source === "core") return `"${verb}" is a built-in verb — run it from your terminal`;
  return `"${verb}" needs arguments the UI cannot supply — run it from your terminal`;
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
): Promise<Response> {
  const argv = [...cliInvocation(), info.name, "--cwd", ctx.dir];
  if (ctx.fragment) return streamRun(ctx, info.name, argv);
  const output: string[] = [];
  const code = await runner(argv, { cwd: ctx.dir, onLine: (line) => output.push(line) });
  announce(ctx, info.name, code);
  if (ctx.json) return jsonResponse({ ok: code === 0, verb: info.name, code, output });
  return panelResponse(ctx, list, [...output, exitLine(code)]);
}

/** The POST half: refuse read-only, refuse anything not offered a Run button, else run it. */
async function handleRun(ctx: UiContext): Promise<Response> {
  if (ctx.readOnly) {
    return jsonResponse({ ok: false, reason: "read-only — running a verb may write" }, 403);
  }
  const verb = requestedVerb(ctx);
  const list = await listCommands(ctx.dir);
  const info = list.commands.find((candidate) => candidate.name === verb);
  if (info === undefined || !info.runnable) {
    return jsonResponse({
      ok: false,
      reason: refusal(verb, info),
      runnable: list.commands.filter((c) => c.runnable).map((c) => c.name),
    }, 400);
  }
  return await runVerb(ctx, info, list);
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
