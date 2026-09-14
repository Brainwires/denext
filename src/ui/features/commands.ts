// `/commands` — project command plug-ins: the verbs this project contributes through
// `commands:` in denext.config.ts or a plugin's `addCommand`, runnable from the browser with
// their output streamed back.
//
// Two discovery paths, deliberately different:
//
//   * PROJECT + PLUGIN verbs come from {@linkcode loadPluginCommands} in this process — the
//     seam J3 extracted so the `ui` verb could enumerate them — merged into a throwaway
//     {@linkcode CommandRegistry} and budgeted, so a plugin `setup` that hangs degrades to a
//     named notice instead of a dead page.
//   * BUILT-IN verbs come from one cached `denext --help` SUBPROCESS. The UI must never import
//     `src/cli/register.ts`: every serving verb pulls the dev server in, and with it esbuild —
//     which `tests/ui-server.test.ts` refuses for the whole `denext ui` module graph. Parsing
//     the CLI's own help table is the one source of built-in verbs that costs nothing here.
//
// Running a verb is a MUTATION (a verb may write anything), so it is refused under
// `--read-only`, and only project/plugin verbs that declare no required positional are offered
// a Run button — built-ins belong in the terminal, where their long-lived output does.

import { frameworkFileUrl } from "../../build/bundle.ts";
import { sseSend } from "../../build/sse.ts";
import {
  CommandRegistry,
  type CommandSpec,
  type FlagSpec,
  type PositionalSpec,
} from "../../cli/command.ts";
import { COMMAND_LOAD_BUDGET_MS, loadPluginCommands } from "../../cli/plugin-commands.ts";
import { resetPlugins } from "../../plugin/mod.ts";
import {
  html,
  htmlResponse,
  jsonResponse,
  layout,
  type RawHtml,
  renderPage,
  toHtml,
  UI_NAV,
  type UiContext,
  type UiHandler,
} from "../html.ts";
import { runDeno, type RunDenoOptions } from "../proc.ts";
import { UI_CSRF_FIELD } from "../security.ts";

/** The panel's own path — its form action, and the nav entry it marks current. */
const PATH = "/commands";

/** Where the two extension seams are documented. */
const DOCS = "https://denext.dev/docs/plugins#project-commands";

/** How long the `denext --help` enumeration may take before the panel gives up on it. */
const HELP_BUDGET_MS = 8000;

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
let budgetMs = COMMAND_LOAD_BUDGET_MS;

/** The built-in verb table per project directory (one `--help` spawn per UI process). */
const coreCache = new Map<string, Promise<CommandSpec[]>>();

/**
 * Swap the subprocess runner, clearing the built-in verb cache (a new runner answers `--help`
 * differently). Restore the returned value when done.
 *
 * @internal Test seam.
 * @param next The runner to install.
 * @returns The runner that was installed before.
 */
export function setCommandRunner(next: UiCommandRunner): UiCommandRunner {
  const previous = runner;
  runner = next;
  coreCache.clear();
  return previous;
}

/**
 * Shorten (or lengthen) the project-verb discovery budget.
 *
 * @internal Test seam.
 * @param ms The new budget in milliseconds.
 * @returns The budget that was in force before.
 */
export function setCommandBudget(ms: number): number {
  const previous = budgetMs;
  budgetMs = ms;
  return previous;
}

/** The argv prefix that runs this framework's own CLI in a child process. */
function cliInvocation(): string[] {
  return ["run", "-A", frameworkFileUrl("cli.ts")];
}

// ── discovery ────────────────────────────────────────────────────────────────

/** Built-in verbs are listed for reference only; the UI never dispatches one. */
function noRun(): void {}

/**
 * Parse the built-in verb table out of `denext --help`. Everything from the
 * "Project commands:" heading on is skipped: those verbs are discovered in-process, with their
 * full flag and positional schemas, which the help table does not carry.
 *
 * @internal Exported for its unit test (the default path spawns a subprocess).
 * @param help The CLI's help output.
 * @returns One name + summary spec per built-in verb, in help order.
 */
export function parseCoreVerbs(help: string): CommandSpec[] {
  const specs: CommandSpec[] = [];
  const seen = new Set<string>();
  for (const line of help.split("\n")) {
    if (line.startsWith("Project commands:")) break;
    const match = /^ {2}denext ([a-z][a-z0-9-]*) {2,}(\S.*?)\s*$/.exec(line);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    specs.push({ name: match[1], summary: match[2], run: noRun });
  }
  return specs;
}

/** Ask this framework's own CLI for its verb table. Never rejects — the panel degrades. */
async function loadCoreVerbs(dir: string): Promise<CommandSpec[]> {
  const lines: string[] = [];
  try {
    await runner([...cliInvocation(), "--help", `--cwd=${dir}`], {
      cwd: dir,
      onLine: (line) => lines.push(line),
      signal: AbortSignal.timeout(HELP_BUDGET_MS),
    });
  } catch { /* no deno on PATH, or the enumeration timed out — built-ins are simply absent */ }
  return parseCoreVerbs(lines.join("\n"));
}

/** The built-in verbs for `dir`, spawned at most once per UI process. */
function coreVerbs(dir: string): Promise<CommandSpec[]> {
  const cached = coreCache.get(dir);
  if (cached) return cached;
  const pending = loadCoreVerbs(dir);
  coreCache.set(dir, pending);
  return pending;
}

/** One registered spec as the panel describes it. */
function describe(spec: CommandSpec): UiCommandInfo {
  const positionals = spec.positionals ?? [];
  const source = spec.source ?? "core";
  return {
    name: spec.name,
    source,
    summary: spec.summary,
    ...(spec.usage === undefined ? {} : { usage: spec.usage }),
    flags: spec.flags ?? [],
    positionals,
    runnable: source !== "core" && positionals.every((p) => p.required !== true),
  };
}

/**
 * Every verb this project can run: the built-ins the CLI ships, plus the `commands:` entries and
 * plugin `addCommand` verbs the project itself contributes. Seeding the registry with the
 * built-ins first reproduces the CLI's own rule — a core verb always wins a name collision.
 *
 * @param dir The project directory.
 * @returns The verb list, plus whether discovery was cut short by the budget or a bad config.
 */
export async function listCommands(dir: string): Promise<UiCommandList> {
  // Plugin setup is idempotent by plugin NAME in a process-global registry, so a second panel
  // load would otherwise reuse whatever the first one left behind — including a `setup` that
  // hung and never finished. The UI process runs no app, so it owns that registry alone: clear
  // it, and every page load is an honest fresh discovery of the config as it stands now.
  resetPlugins();
  const registry = new CommandRegistry();
  for (const spec of await coreVerbs(dir)) registry.register(spec);
  const result = await loadPluginCommands(registry, dir, { timeoutMs: budgetMs });
  return {
    commands: registry.list().filter((spec) => spec.hidden !== true).map(describe),
    timedOut: result.timedOut,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
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
    <table class="flags">
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
  return html`<form method="post" action="${PATH}">
<input type="hidden" name="${UI_CSRF_FIELD}" value="${csrf}">
<input type="hidden" name="verb" value="${name}">
<button type="submit">Run</button></form>`;
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
      <p
        class="note">Plugin setup exceeded ${(budgetMs / 1000).toFixed(
          1,
        )} s — project verbs not listed. Built-in verbs are unaffected.</p>
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

/** Answer with the panel: the bare section when ui.js asked for one, else the full document. */
function panelResponse(ctx: UiContext, list: UiCommandList, output: readonly string[]): Response {
  const section = panelSection(list, ctx.csrf, output);
  if (ctx.fragment) return htmlResponse(toHtml(section));
  return htmlResponse(renderPage(layout, {
    title: "Commands",
    nav: UI_NAV,
    body: section,
    csrf: ctx.csrf,
    active: PATH,
  }));
}

// ── running a verb ───────────────────────────────────────────────────────────

/** The last line of every run, so a reader can tell "finished" from "still going". */
function exitLine(code: number): string {
  return `— exited ${code}`;
}

/** Tell every open page a run finished, so a second tab's list is not stale. */
function announce(ctx: UiContext, verb: string, code: number): void {
  sseSend(ctx.events, JSON.stringify({ type: "command-done", command: verb, code }));
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
 * exit frame. Writes are queued on a single writer, so lines arrive in the order they were
 * produced and a page that navigated away simply drops them.
 */
function streamRun(ctx: UiContext, verb: string, argv: string[]): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const frame = (line: string): void => {
    const data = `data: ${line.replace(/\r?\n/g, " ")}\n\n`;
    writer.write(encoder.encode(data)).catch(() => {/* the page navigated away mid-run */});
  };
  runner(argv, { cwd: ctx.dir, onLine: frame })
    .then((code) => {
      frame(exitLine(code));
      announce(ctx, verb, code);
    })
    .catch((error) => frame(`— failed: ${error instanceof Error ? error.message : error}`))
    .finally(() => {
      writer.close().catch(() => {/* already closed by the client */});
    });
  return new Response(readable, { headers: { "content-type": "text/event-stream" } });
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
