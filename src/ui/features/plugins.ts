// `/plugins` — the plugin manager: the first-party catalog (`src/plugin/catalog.json`), what this
// project already has wired into `denext.config.ts` and pinned in `deno.json`, and add/remove over
// `deno add`/`deno remove` + `injectPlugin`/`ejectPlugin`. The UI twin of `denext plugin`.
//
// Every mutation is two steps: the first POST computes the new config text and answers with a
// unified diff plus the exact `deno` argv — nothing has touched disk — and a second POST carrying
// `confirm=1` applies it. It all works with JavaScript disabled (real `<form method="post">`s; the
// applied mutation answers `303 /plugins#<name>`), and `ui.js` upgrades the same forms to a panel
// swap, or to a streamed `deno` log when it asks for `text/event-stream`.
//
// Two rules this module inherits from the kernel: the UI process never imports project code (the
// dependency step is a `src/ui/proc.ts` subprocess, the config edit is pure string surgery), and a
// name that came from the browser is never interpolated into a command — it must be one of the
// catalog's own names, and the argv is an array.

import { parse as parseJsonc } from "@std/jsonc";
import { join } from "@std/path";
import { CONFIG_FILES } from "../../build/paths.ts";
import CATALOG from "../../plugin/catalog.json" with { type: "json" };
import { createUnifiedDiff } from "../../build/patch-diff.ts";
import {
  type ConfiguredPlugin,
  createConfigSource,
  ejectPlugin,
  injectPlugin,
  listPlugins,
  type PluginNames,
  resolvePluginNames,
} from "../../build/plugin-install.ts";
import {
  diffHtml,
  html,
  jsonResponse,
  opForm,
  panelResponder,
  type RawHtml,
  type UiContext,
  type UiHandler,
} from "../html.ts";
import { broadcast, sseProcess } from "../events.ts";
import { runDeno } from "../proc.ts";

/** The fields of a `src/plugin/catalog.json` row this panel reads. */
interface CatalogRow {
  /** The JSR package name — the row's anchor id, and the only accepted `name` field value. */
  readonly name: string;
  /** The catalogued version. */
  readonly version: string;
  /** The `deno add` specifier, caret-pinned (`jsr:@denext/openapi@^0.3.0`). */
  readonly spec: string;
  /** A `plugins: []` entry, or a plain library you import. */
  readonly kind: string;
  /** The factory export a plugin is wired in as. */
  readonly factory?: string;
  /** The CLI verb the plugin contributes, when it has one. */
  readonly verb?: string;
  /** The docs-site path documenting it. */
  readonly docs?: string;
  /** One sentence from the package's README. */
  readonly blurb: string;
}

/** The catalogued first-party packages, in catalog order. */
const CATALOG_ROWS: readonly CatalogRow[] = CATALOG.plugins as readonly CatalogRow[];

/** Where a catalogued package's documentation lives (always absolute — the UI is not the site). */
const DOCS_ORIGIN = "https://denext.dev";

/** The subprocess runner every `deno add`/`deno remove` goes through. */
let proc: typeof runDeno = runDeno;

/**
 * Swap the subprocess runner this panel uses.
 *
 * @internal Test seam only: the suite stubs `deno add`/`deno remove` so it never installs
 * anything or touches the network. Passing nothing restores {@linkcode runDeno}.
 * @param runner The replacement runner, or `undefined` to restore the default.
 */
export function setProcRunner(runner?: typeof runDeno): void {
  proc = runner ?? runDeno;
}

// ── the project's current state ──────────────────────────────────────────────

/** What the project says about plugins right now (read-only; no module is ever evaluated). */
interface ProjectState {
  /** The config file that exists, or where one would be created. */
  readonly configPath: string;
  /** That file's name, for diff headers. */
  readonly configName: string;
  /** Its source, or `null` when the project has no denext config yet. */
  readonly source: string | null;
  /** The plugins wired into the config's `plugins` array. */
  readonly wired: readonly ConfiguredPlugin[];
  /** The bare specifiers the project's `deno.json` import map declares. */
  readonly deps: readonly string[];
}

/** The text of `path`, or `null` when it does not exist (or cannot be read). */
async function readText(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

/** The bare specifiers declared in the project's `deno.json` / `deno.jsonc` import map. */
async function readDeps(dir: string): Promise<string[]> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const text = await readText(join(dir, name));
    if (text === null) continue;
    try {
      const imports = (parseJsonc(text) as { imports?: Record<string, unknown> } | null)?.imports;
      if (imports && typeof imports === "object") return Object.keys(imports);
    } catch { /* malformed — try the next name */ }
  }
  return [];
}

/**
 * Read the project's plugin state: its config source (if any) and its import map.
 *
 * @param dir The project directory.
 * @returns The config location, its plugins array and the declared dependencies.
 */
async function readProject(dir: string): Promise<ProjectState> {
  const deps = await readDeps(dir);
  for (const name of CONFIG_FILES) {
    const configPath = join(dir, name);
    const source = await readText(configPath);
    if (source === null) continue;
    return { configPath, configName: name, source, wired: listPlugins(source), deps };
  }
  const configName = CONFIG_FILES[0];
  return { configPath: join(dir, configName), configName, source: null, wired: [], deps };
}

/** One catalogue row plus this project's state for it. */
interface PluginRow {
  /** The catalogue entry. */
  readonly entry: CatalogRow;
  /** The package is in the project's import map. */
  readonly dependency: boolean;
  /** The factory is in the config's `plugins` array. */
  readonly wired: boolean;
}

/** Pair every catalogue row with what this project has done with it. */
function rowsFor(state: ProjectState): PluginRow[] {
  return CATALOG_ROWS.map((entry) => ({
    entry,
    dependency: state.deps.some((dep) => dep === entry.name || dep.startsWith(entry.name + "/")),
    wired: state.wired.some((plugin) =>
      plugin.importSpec === entry.name ||
      (plugin.importSpec === null && entry.factory !== undefined &&
        plugin.factory === entry.factory)
    ),
  }));
}

/** Whether a row counts as installed (wired, or at least pinned). */
function isInstalled(row: PluginRow): boolean {
  return row.wired || row.dependency;
}

// ── the two operations ───────────────────────────────────────────────────────

/** What this panel can do to a catalogued package. */
type Op = "add" | "remove";

/** A computed, not-yet-applied change: the argv to run and the config text to write. */
interface Plan {
  /** Which operation this is. */
  readonly op: Op;
  /** The catalogue row it acts on. */
  readonly entry: CatalogRow;
  /** The resolved import/factory names. */
  readonly names: PluginNames;
  /** The `deno` argv (array form, never shell-interpreted). */
  readonly command: readonly string[];
  /** The config file to write. */
  readonly configPath: string;
  /** Its name, for the preview heading. */
  readonly configName: string;
  /** The config text to write, or `null` when this plan changes no config. */
  readonly nextSource: string | null;
  /** The unified diff of that change (empty when there is none). */
  readonly diff: string;
  /** The default export is not an object literal — the user must wire it by hand. */
  readonly bailed: boolean;
  /** Why there is nothing to write, when there is nothing to write. */
  readonly note: string;
}

/** The "this plan writes no config" half of a {@linkcode Plan}. */
const NO_CONFIG = { nextSource: null, diff: "", bailed: false, note: "" };

/** The "this plan rewrites the config" half of a {@linkcode Plan}. */
function rewrite(name: string, before: string, after: string) {
  return {
    nextSource: after,
    diff: createUnifiedDiff(before, after, name),
    bailed: false,
    note: "",
  };
}

/** The import/factory names for a catalogue row (the factory is declared, never guessed). */
function namesFor(entry: CatalogRow): PluginNames {
  return resolvePluginNames(entry.spec, entry.factory ? { export: entry.factory } : {});
}

/** Plan an install: `deno add <spec>`, then wire the factory into the config. */
function planAdd(entry: CatalogRow, state: ProjectState): Plan {
  const names = namesFor(entry);
  const base = {
    op: "add" as const,
    entry,
    names,
    command: ["add", names.addSpec],
    configPath: state.configPath,
    configName: state.configName,
  };
  if (entry.kind !== "plugin") {
    return { ...base, ...NO_CONFIG, note: "A library: only the dependency is added." };
  }
  if (state.source === null) {
    return { ...base, ...rewrite(state.configName, "", createConfigSource(names)) };
  }
  const result = injectPlugin(state.source, names);
  if (result.bailed) return { ...base, ...NO_CONFIG, bailed: true };
  if (result.alreadyPresent) {
    return {
      ...base,
      ...NO_CONFIG,
      note: "Already wired into the config — only the pin is checked.",
    };
  }
  return { ...base, ...rewrite(state.configName, state.source, result.source) };
}

/** Plan a removal: unwire the factory, then `deno remove <spec>`. */
function planRemove(entry: CatalogRow, state: ProjectState): Plan {
  const names = namesFor(entry);
  const base = {
    op: "remove" as const,
    entry,
    names,
    command: ["remove", names.importSpec],
    configPath: state.configPath,
    configName: state.configName,
  };
  if (state.source === null) {
    return {
      ...base,
      ...NO_CONFIG,
      note: "No denext config in this project — only the pin is dropped.",
    };
  }
  if (entry.kind !== "plugin") {
    return { ...base, ...NO_CONFIG, note: "A library: only the dependency is removed." };
  }
  const result = ejectPlugin(state.source, names);
  if (result.notPresent) {
    return { ...base, ...NO_CONFIG, note: "Not wired into the config — only the pin is dropped." };
  }
  return { ...base, ...rewrite(state.configName, state.source, result.source) };
}

/** The operation table (dispatch, never an if-chain). */
const OPS: Record<Op, (entry: CatalogRow, state: ProjectState) => Plan> = {
  add: planAdd,
  remove: planRemove,
};

/** What applying a plan did. */
interface ApplyOutcome {
  /** The `deno` child's exit code. */
  readonly code: number;
  /** The config file was rewritten. */
  readonly wrote: boolean;
  /** Everything the child printed. */
  readonly output: string;
}

/** Write the plan's config text, if it has any. */
async function writeConfig(plan: Plan): Promise<boolean> {
  if (plan.nextSource === null) return false;
  await Deno.writeTextFile(plan.configPath, plan.nextSource);
  return true;
}

/**
 * Apply a plan. `remove` unwires first, so a failed dependency removal still leaves a consistent
 * config; `add` wires only once `deno add` has succeeded — the same order `denext plugin` uses.
 *
 * @param plan The computed change.
 * @param dir The project directory (the child's cwd).
 * @param onLine Called per output line; enables the streaming mode.
 * @returns The child's exit code, whether the config was written, and the captured output.
 */
async function applyPlan(
  plan: Plan,
  dir: string,
  onLine?: (line: string) => void,
): Promise<ApplyOutcome> {
  const unwireFirst = plan.op === "remove";
  let wrote = unwireFirst ? await writeConfig(plan) : false;
  const result = await proc([...plan.command], { cwd: dir, onLine });
  if (!unwireFirst && result.code === 0) wrote = await writeConfig(plan);
  return { code: result.code, wrote, output: (result.stdout + result.stderr).trim() };
}

// ── the views ────────────────────────────────────────────────────────────────

/** The absolute docs URL for a catalogue row. */
function docsUrl(entry: CatalogRow): string {
  return DOCS_ORIGIN + (entry.docs ?? "/docs/plugins");
}

/** Wrap a panel section as a fragment (the `ui.js` swap) or as the full document. */
const panelResponse = panelResponder("Plugins", "/plugins");

/** One add/remove/confirm form — a real POST, upgraded by `ui.js` when it is running. */
function pluginForm(ctx: UiContext, entry: CatalogRow, op: Op, confirm = false): RawHtml {
  return opForm(ctx.csrf, {
    action: "/plugins",
    label: confirm ? "Apply" : op === "add" ? "Add" : "Remove",
    fields: { name: entry.name, op, ...(confirm ? { confirm: "1" } : {}) },
    disabled: ctx.readOnly,
  });
}

/** One catalogue row: what it is, what this project has done with it, and the one thing to do. */
function card(ctx: UiContext, row: PluginRow): RawHtml {
  const state = row.wired ? "wired" : row.dependency ? "pinned" : "available";
  return html`<article class="card" id="${row.entry.name}">
<strong>${row.entry.name}</strong>
<span class="badge">${row.entry.version}</span>
<span class="badge">${state}</span>
${row.entry.verb ? html`<span class="badge">denext ${row.entry.verb}</span>` : ""}
<span>${row.entry.blurb}</span>
<p><a href="${docsUrl(row.entry)}">Docs</a> · <code class="mono">${row.entry.spec}</code></p>
${pluginForm(ctx, row.entry, isInstalled(row) ? "remove" : "add")}
</article>`;
}

/** The catalogue, in its two groups. */
function catalogSection(ctx: UiContext, rows: readonly PluginRow[], notice?: RawHtml): RawHtml {
  const group = (kind: string) =>
    html`<div class="cards">${
      rows.filter((row) => row.entry.kind === kind).map((row) => card(ctx, row))
    }</div>`;
  return html`<section id="panel" data-panel="Plugins">
<h1>Plugins</h1>
<p class="lead">The first-party catalog. Adding or removing one previews the exact
<code>deno</code> command and a diff of your config before anything is written.</p>
${ctx.readOnly ? html`<p class="note">Read-only mode — add and remove are refused.</p>` : ""}
${notice ?? ""}
<h2>Plugins</h2>
${group("plugin")}
<h2>Libraries</h2>
${group("library")}
</section>`;
}

/** The honest outcome when the config's default export cannot be spliced safely. */
function manualNote(names: PluginNames): RawHtml {
  return html`<p class="note">This config's default export is not an object literal, so the
<code>plugins</code> entry cannot be spliced in safely. Add it by hand:</p>
<pre class="out">import { ${names.factory} } from "${names.importSpec}";
// …then add ${names.call} to the default export's plugins array.</pre>`;
}

/** The diff preview: nothing has been written yet, and this is exactly what will be. */
function previewSection(ctx: UiContext, plan: Plan): RawHtml {
  return html`<section id="panel" data-panel="Plugins">
<h1>${plan.op === "add" ? "Add" : "Remove"} ${plan.entry.name}</h1>
<p class="lead">Nothing has been written yet — review the change, then apply it.</p>
<h2>Command</h2>
<pre class="out">deno ${plan.command.join(" ")}</pre>
${plan.bailed ? manualNote(plan.names) : ""}
${plan.note ? html`<p class="note">${plan.note}</p>` : ""}
${
    plan.diff
      ? html`
        <h2>${plan.configName}</h2>
        ${diffHtml(plan.diff)}
      `
      : ""
  }
${pluginForm(ctx, plan.entry, plan.op, true)}
<p><a href="/plugins">Cancel</a></p>
</section>`;
}

/** What the panel says after a plan ran. */
function outcomeNotice(plan: Plan, outcome: ApplyOutcome): RawHtml {
  const what = plan.op === "add" ? "Added" : "Removed";
  const head = outcome.code === 0
    ? `${what} ${plan.entry.name}${outcome.wrote ? ` and updated ${plan.configName}` : ""}.`
    : `deno ${plan.command.join(" ")} exited ${outcome.code}.`;
  return html`<p class="note">${head}</p>${
    outcome.output ? html`<pre class="out">${outcome.output}</pre>` : ""
  }`;
}

// ── the JSON twin ────────────────────────────────────────────────────────────

/** The machine view of the catalogue and this project's state (the `/api/plugins` payload). */
function payload(state: ProjectState): Record<string, unknown> {
  const rows = rowsFor(state);
  return {
    installed: rows.filter(isInstalled).map((row) => row.entry.name),
    catalog: rows.map((row) => ({
      name: row.entry.name,
      version: row.entry.version,
      spec: row.entry.spec,
      kind: row.entry.kind,
      factory: row.entry.factory,
      verb: row.entry.verb,
      docs: docsUrl(row.entry),
      blurb: row.entry.blurb,
      dependency: row.dependency,
      wired: row.wired,
    })),
    config: state.source === null ? null : state.configName,
  };
}

/** The machine view of a computed plan. */
function planPayload(plan: Plan): Record<string, unknown> {
  return {
    name: plan.entry.name,
    op: plan.op,
    command: ["deno", ...plan.command].join(" "),
    diff: plan.diff,
    bailed: plan.bailed,
    note: plan.note,
  };
}

// ── the handler ──────────────────────────────────────────────────────────────

/** One posted field, from a form body or a JSON body. */
function field(ctx: UiContext, key: string): string {
  const posted = ctx.form?.get(key);
  if (typeof posted === "string") return posted;
  const value = (ctx.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : "";
}

/** Whether this POST is the second step (apply), not the first (preview). */
function confirmed(ctx: UiContext): boolean {
  return field(ctx, "confirm") === "1" ||
    (ctx.body as Record<string, unknown> | undefined)?.confirm === true;
}

/** The requested operation: `DELETE` means remove, otherwise the posted `op` field. */
function opFor(ctx: UiContext): Op | null {
  if (ctx.method === "DELETE") return "remove";
  const op = field(ctx, "op");
  return op === "add" || op === "remove" ? op : null;
}

/** Whether the caller can consume a streamed `deno` log. */
function wantsStream(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/event-stream");
}

/** A refusal, in whichever shape the caller asked for. */
function refusal(ctx: UiContext, state: ProjectState, reason: string, status: number): Response {
  if (ctx.json) return jsonResponse({ ok: false, reason, ...payload(state) }, status);
  return panelResponse(
    ctx,
    catalogSection(ctx, rowsFor(state), html`<p class="note">${reason}</p>`),
    status,
  );
}

/** The catalogue view. */
function view(ctx: UiContext, state: ProjectState): Response {
  if (ctx.json) return jsonResponse({ ok: true, ...payload(state) });
  return panelResponse(ctx, catalogSection(ctx, rowsFor(state)));
}

/** The first POST: compute the change and show it. */
function preview(ctx: UiContext, plan: Plan, state: ProjectState): Response {
  if (ctx.json) {
    return jsonResponse({
      ok: !plan.bailed,
      applied: false,
      ...planPayload(plan),
      ...payload(state),
    });
  }
  return panelResponse(ctx, previewSection(ctx, plan));
}

/** The confirmed POST: run it, then answer with the refreshed catalogue (or a `303` for no-JS). */
async function apply(ctx: UiContext, plan: Plan): Promise<Response> {
  const outcome = await applyPlan(plan, ctx.dir);
  broadcast(ctx.events, { type: "plugins-changed", name: plan.entry.name });
  const state = await readProject(ctx.dir);
  if (ctx.json) {
    return jsonResponse({
      ok: outcome.code === 0,
      applied: true,
      wrote: outcome.wrote,
      code: outcome.code,
      output: outcome.output,
      ...planPayload(plan),
      ...payload(state),
    }, outcome.code === 0 ? 200 : 500);
  }
  if (!ctx.fragment) {
    return new Response(null, {
      status: 303,
      headers: { location: `/plugins#${plan.entry.name}` },
    });
  }
  return panelResponse(ctx, catalogSection(ctx, rowsFor(state), outcomeNotice(plan, outcome)));
}

/** The confirmed POST, streamed: the `deno` child's output as it arrives. */
function streamApply(ctx: UiContext, plan: Plan): Response {
  return sseProcess(
    async (line) => {
      const outcome = await applyPlan(plan, ctx.dir, line);
      return { code: outcome.code, note: outcome.wrote ? `wrote ${plan.configName}` : undefined };
    },
    {
      prelude: [`$ deno ${plan.command.join(" ")}`],
      settled: () => broadcast(ctx.events, { type: "plugins-changed", name: plan.entry.name }),
    },
  );
}

/** A mutation: validate the name against the catalogue, plan it, then preview or apply it. */
async function mutate(request: Request, ctx: UiContext, state: ProjectState): Promise<Response> {
  if (ctx.readOnly) return refusal(ctx, state, "read-only", 403);
  const name = field(ctx, "name");
  const entry = CATALOG_ROWS.find((row) => row.name === name);
  if (!entry) return refusal(ctx, state, `unknown plugin "${name}"`, 400);
  const op = opFor(ctx);
  if (op === null) return refusal(ctx, state, `unknown operation "${field(ctx, "op")}"`, 400);
  const plan = OPS[op](entry, state);
  if (!confirmed(ctx) || plan.bailed) return preview(ctx, plan, state);
  return wantsStream(request) ? streamApply(ctx, plan) : await apply(ctx, plan);
}

/**
 * Serve the plugin-manager panel: the catalogue on `GET`, a diff preview on the first `POST`,
 * and the `deno add`/`deno remove` + config write on a `POST` carrying `confirm=1`.
 *
 * @param request The incoming request (its `Accept` decides fragment vs streamed vs document).
 * @param ctx The kernel's request context (already past the origin, CSRF and read-only gates).
 * @returns The panel, its JSON twin, a `303` back to the row, or a streamed `deno` log.
 */
export const pluginsPanel: UiHandler = async (
  request: Request,
  ctx: UiContext,
): Promise<Response> => {
  const state = await readProject(ctx.dir);
  if (ctx.method === "GET" || ctx.method === "HEAD") return view(ctx, state);
  return await mutate(request, ctx, state);
};
