// `/plugins` — the plugin manager: the first-party catalog (`src/plugin/catalog.json`), what this
// project already has wired into `denext.config.ts` and pinned in `deno.json`, and add/remove over
// `deno add`/`deno remove` + `injectPlugin`/`ejectPlugin`. The UI twin of `denext plugin`. A wired
// plugin with a published options schema links to its options sub-panel (`plugin-options.ts`),
// and third-party plugins are found on JSR and added through the same path (`plugin-search.ts`).
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
// catalog's own names (or, for `op=add-jsr`, a package name JSR's own rules accept, at the version
// the registry reports), and the argv is an array. Under `denext ui --offline` every add and
// remove is refused with a `503` before anything runs (`../offline.ts`).

import { isJsrSpec } from "../jsr.ts";
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
  normalizeSpec,
  type PluginNames,
  resolvePluginNames,
} from "../../build/plugin-install.ts";
import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild } from "../../jsx/types.ts";
import { jsonResponse, panelResponder, type UiContext, type UiHandler } from "../html.ts";
import { DiffBlock, Mono, Note, OpForm, Out, Panel, PreviewLead } from "../components.ts";
import { renderView } from "../view.ts";
import { broadcast, sseProcess } from "../events.ts";
import { runDeno } from "../proc.ts";
import { OFFLINE_REFUSALS, OFFLINE_STATUS } from "../offline.ts";
import { readContained, StaleWriteError, writeFileAtomic } from "../security.ts";
import type { SchemaNode } from "../form/schema.ts";
import {
  discover,
  type Discovery,
  discoveryPayload,
  JsrDiscovery,
  resolveJsrAdd,
} from "./plugin-search.ts";

/** The fields of a `src/plugin/catalog.json` row the plugin panels read. */
export interface CatalogRow {
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
  /** The JSON Schema of the factory's options (a plugin row only). */
  readonly optionsSchema?: SchemaNode;
}

/** The catalogued first-party packages, in catalog order. */
export const CATALOG_ROWS: readonly CatalogRow[] = CATALOG
  .plugins as unknown as readonly CatalogRow[];

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
export interface ProjectState {
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

/** The bare specifiers declared in the project's `deno.json` / `deno.jsonc` import map. */
async function readDeps(dir: string): Promise<string[]> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const text = await readContained(dir, name);
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
export async function readProject(dir: string): Promise<ProjectState> {
  const deps = await readDeps(dir);
  for (const name of CONFIG_FILES) {
    const source = await readContained(dir, name);
    if (source === null) continue;
    const configPath = join(dir, name);
    return { configPath, configName: name, source, wired: listPlugins(source), deps };
  }
  const configName = CONFIG_FILES[0];
  return { configPath: join(dir, configName), configName, source: null, wired: [], deps };
}

/** Whether a wired `plugins` entry is this catalogue row's factory. */
function matches(plugin: ConfiguredPlugin, entry: CatalogRow): boolean {
  // An aliased binding (`openapi as oa`) or a `jsr:` specifier names the same package.
  if (plugin.importSpec !== null) return normalizeSpec(plugin.importSpec) === entry.name;
  return entry.factory !== undefined && plugin.imported === entry.factory;
}

/**
 * The `plugins` entry a catalogue row is wired in as — its `factory` is the local identifier the
 * config calls it by.
 *
 * @param state The project's plugin state.
 * @param entry The catalogue row.
 * @returns The wired entry, or `undefined` when the row is not in the `plugins` array.
 */
export function wiredAs(state: ProjectState, entry: CatalogRow): ConfiguredPlugin | undefined {
  return state.wired.find((plugin) => matches(plugin, entry));
}

/**
 * Where a catalogued plugin's options sub-panel lives.
 *
 * @param name The catalogue name.
 * @returns `/plugins/options?name=<name>`.
 */
export function optionsHref(name: string): string {
  return `/plugins/options?name=${encodeURIComponent(name)}`;
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
    wired: wiredAs(state, entry) !== undefined,
  }));
}

/** Whether a row counts as installed (wired, or at least pinned). */
function isInstalled(row: PluginRow): boolean {
  return row.wired || row.dependency;
}

/** The wired plugins no catalogue row accounts for — the third-party ones. */
function thirdParty(state: ProjectState): ConfiguredPlugin[] {
  return state.wired.filter((plugin) => !CATALOG_ROWS.some((entry) => matches(plugin, entry)));
}

// ── the two operations ───────────────────────────────────────────────────────

/** What this panel can do to a package. */
type Op = "add" | "remove";

/** What a plan acts on: a catalogue row, or a JSR package resolved in this request. */
interface Target {
  /** The package name (the row anchor and the event payload). */
  readonly name: string;
  /** A `plugins: []` entry, or a plain library. */
  readonly kind: string;
  /** The resolved import/factory names. */
  readonly names: PluginNames;
  /** The hidden fields that identify it on the confirm form (besides `op`). */
  readonly fields: Readonly<Record<string, string>>;
  /** The `op` field value an add of it posts (`add`, or `add-jsr`). */
  readonly addOp: string;
}

/** A computed, not-yet-applied change: the argv to run and the config text to write. */
interface Plan {
  /** Which operation this is. */
  readonly op: Op;
  /** The `op` field value that re-posts it. */
  readonly post: string;
  /** What it acts on. */
  readonly target: Target;
  /** The `deno` argv (array form, never shell-interpreted). */
  readonly command: readonly string[];
  /** The config file to write. */
  readonly configPath: string;
  /** Its name, for the preview heading. */
  readonly configName: string;
  /** The config text to write, or `null` when this plan changes no config. */
  readonly nextSource: string | null;
  /**
   * The config text the plan was computed from (`null`: no config yet). The write refuses
   * when the file no longer holds it — `deno add` can take minutes, and an edit made
   * meanwhile must not be overwritten.
   */
  readonly baseSource: string | null;
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

/** A catalogue row as a plan target (the factory is declared, never guessed). */
function catalogTarget(entry: CatalogRow): Target {
  const names = resolvePluginNames(entry.spec, entry.factory ? { export: entry.factory } : {});
  return { name: entry.name, kind: entry.kind, names, fields: { name: entry.name }, addOp: "add" };
}

/** Plan an install: `deno add <spec>`, then wire the factory into the config. */
function planAdd(target: Target, state: ProjectState): Plan {
  const { names } = target;
  const base = {
    op: "add" as const,
    post: target.addOp,
    target,
    command: ["add", names.addSpec],
    configPath: state.configPath,
    configName: state.configName,
    baseSource: state.source,
  };
  if (target.kind !== "plugin") {
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
function planRemove(target: Target, state: ProjectState): Plan {
  const { names } = target;
  const base = {
    op: "remove" as const,
    post: "remove",
    target,
    command: ["remove", names.importSpec],
    configPath: state.configPath,
    configName: state.configName,
    baseSource: state.source,
  };
  if (state.source === null) {
    return {
      ...base,
      ...NO_CONFIG,
      note: "No denext config in this project — only the pin is dropped.",
    };
  }
  if (target.kind !== "plugin") {
    return { ...base, ...NO_CONFIG, note: "A library: only the dependency is removed." };
  }
  const result = ejectPlugin(state.source, names);
  if (result.notPresent) {
    return { ...base, ...NO_CONFIG, note: "Not wired into the config — only the pin is dropped." };
  }
  return { ...base, ...rewrite(state.configName, state.source, result.source) };
}

/** The operation table (dispatch, never an if-chain). */
const OPS: Record<Op, (target: Target, state: ProjectState) => Plan> = {
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

/**
 * Write the plan's config text, if it has any — contained and atomically (`.tmp` + rename), so a
 * symlinked config is never followed out of the project and a crash cannot truncate the file.
 */
async function writeConfig(dir: string, plan: Plan): Promise<boolean> {
  if (plan.nextSource === null) return false;
  const guard = plan.baseSource === null ? {} : { unchangedFrom: plan.baseSource };
  await writeFileAtomic(dir, plan.configName, plan.nextSource, guard);
  return true;
}

/** How long `deno add` / `deno remove` gets before the child is killed. */
const DEPENDENCY_TIMEOUT_MS = 300_000;

/**
 * Apply a plan. `remove` unwires first, so a failed dependency removal still leaves a consistent
 * config; `add` wires only once `deno add` has succeeded — the same order `denext plugin` uses.
 *
 * @param plan The computed change.
 * @param dir The project directory (the child's cwd).
 * @param signal Aborts the `deno` child (the UI shutting down, or the page disconnecting); it is
 *   combined with a five-minute deadline, so a registry that never answers is not a wedged child.
 * @param onLine Called per output line; enables the streaming mode.
 * @returns The child's exit code, whether the config was written, and the captured output.
 */
async function applyPlan(
  plan: Plan,
  dir: string,
  signal?: AbortSignal,
  onLine?: (line: string) => void,
): Promise<ApplyOutcome> {
  const unwireFirst = plan.op === "remove";
  let wrote = unwireFirst ? await writeConfig(dir, plan) : false;
  const result = await proc([...plan.command], { cwd: dir, onLine, signal: deadline(signal) });
  if (!unwireFirst && result.code === 0) wrote = await writeConfig(dir, plan);
  return { code: result.code, wrote, output: (result.stdout + result.stderr).trim() };
}

/** The dependency child's abort signal: the caller's, bounded by the five-minute deadline. */
function deadline(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(DEPENDENCY_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// ── the views ────────────────────────────────────────────────────────────────

/** The absolute docs URL for a catalogue row. */
function docsUrl(entry: CatalogRow): string {
  return DOCS_ORIGIN + (entry.docs ?? "/docs/plugins");
}

/** Wrap a panel section as a fragment (the `ui.js` swap) or as the full document. */
const panelResponse = panelResponder("Plugins", "/plugins");

/** Render a view as the panel response. */
function page(ctx: UiContext, view: VNode, status = 200): Response {
  return panelResponse(ctx, renderView(view), status);
}

/** One add/remove/confirm form — a real POST, upgraded by `ui.js` when it is running. */
function PluginForm(
  { ctx, fields, label }: {
    readonly ctx: UiContext;
    readonly fields: Readonly<Record<string, string>>;
    readonly label: string;
  },
): VNode {
  const disabled = ctx.readOnly || ctx.offline === true;
  return h(OpForm, { csrf: ctx.csrf, action: "/plugins", label, fields, disabled });
}

/** The docs link, the spec and — for a wired plugin with an options schema — the options link. */
function CardLinks({ row }: { readonly row: PluginRow }): VNode {
  const { entry } = row;
  const options = row.wired && entry.optionsSchema !== undefined;
  return h(
    "p",
    null,
    h("a", { href: docsUrl(entry) }, "Docs"),
    " · ",
    h(Mono, null, entry.spec),
    options ? h(Fragment, null, " · ", h("a", { href: optionsHref(entry.name) }, "Options")) : null,
  );
}

/** One catalogue row: what it is, what this project has done with it, and the one thing to do. */
function Card({ ctx, row }: { readonly ctx: UiContext; readonly row: PluginRow }): VNode {
  const { entry } = row;
  const state = row.wired ? "wired" : row.dependency ? "pinned" : "available";
  const op = isInstalled(row) ? "remove" : "add";
  return h(
    "article",
    { class: "card", id: entry.name },
    h("strong", null, entry.name),
    " ",
    h("span", { class: "badge" }, entry.version),
    " ",
    h("span", { class: "badge" }, state),
    " ",
    entry.verb ? h("span", { class: "badge" }, `denext ${entry.verb}`) : null,
    " ",
    h("span", null, entry.blurb),
    h(CardLinks, { row }),
    h(PluginForm, {
      ctx,
      fields: { name: entry.name, op },
      label: op === "add" ? "Add" : "Remove",
    }),
  );
}

/** One group of catalogue cards. */
function Cards({ ctx, rows }: { readonly ctx: UiContext; readonly rows: readonly PluginRow[] }) {
  return h(
    "div",
    { class: "cards" },
    rows.map((row) => h(Card, { key: row.entry.name, ctx, row })),
  );
}

/** The options link for a wired plugin imported from a JSR package (it may publish a schema). */
function publishedOptionsHref(plugin: ConfiguredPlugin): string | null {
  const spec = plugin.importSpec === null ? "" : normalizeSpec(plugin.importSpec);
  return isJsrSpec(spec) ? optionsHref(spec) : null;
}

/** The wired plugins the catalogue does not know, and where their options live. */
function ThirdParty({ plugins }: { readonly plugins: readonly ConfiguredPlugin[] }): VNode {
  return h(
    Fragment,
    null,
    h("h2", null, "Third-party"),
    h(
      "ul",
      null,
      plugins.map((plugin) =>
        h(
          "li",
          { key: plugin.factory },
          h("code", null, plugin.call),
          plugin.importSpec
            ? h(Fragment, null, " from ", h("code", null, plugin.importSpec))
            : null,
          publishedOptionsHref(plugin)
            ? h(Fragment, null, " · ", h("a", { href: publishedOptionsHref(plugin)! }, "Options"))
            : null,
        )
      ),
    ),
    h(
      Note,
      null,
      "A JSR plugin that publishes denext.catalog.optionsSchema in its deno.json gets an ",
      "options form, read from jsr.io; set any other plugin's options in denext.config.ts.",
    ),
  );
}

/** What the panel says under `--offline`, where every add and remove renders disabled. */
const OFFLINE_NOTE = "Offline — add and remove are refused: deno add needs the registry, and " +
  "deno remove can re-resolve the remaining dependencies over the network.";

/** The whole catalogue panel: the two groups, the third-party plugins and JSR discovery. */
function PluginsPanel(
  { ctx, state, discovery, notice }: {
    readonly ctx: UiContext;
    readonly state: ProjectState;
    readonly discovery: Discovery;
    readonly notice?: VNodeChild;
  },
): VNode {
  const rows = rowsFor(state);
  const others = thirdParty(state);
  const group = (kind: string) =>
    h(Cards, { ctx, rows: rows.filter((r) => r.entry.kind === kind) });
  return h(
    Panel,
    { name: "Plugins", title: "Plugins" },
    h(
      "p",
      { class: "lead" },
      "The first-party plugins, and any JSR package you search for below. Adding or removing one ",
      "previews the exact ",
      h("code", null, "deno"),
      " command and a diff of your config before anything is written. ",
      h("a", { href: "https://denext.dev/docs/ui#plugins" }, "Plugins ↗"),
    ),
    ctx.readOnly ? h(Note, null, "Read-only mode — add and remove are refused.") : null,
    ctx.offline === true ? h(Note, null, OFFLINE_NOTE) : null,
    notice ?? null,
    h("h2", null, "Plugins"),
    group("plugin"),
    h("h2", null, "Libraries"),
    group("library"),
    others.length > 0 ? h(ThirdParty, { plugins: others }) : null,
    h(JsrDiscovery, { ctx, discovery }),
  );
}

/** The honest outcome when the config's default export cannot be spliced safely. */
function ManualNote({ names }: { readonly names: PluginNames }): VNode {
  return h(
    Fragment,
    null,
    h(
      Note,
      null,
      "This config's default export is not an object literal, so the ",
      h("code", null, "plugins"),
      " entry cannot be spliced in safely. Add it by hand:",
    ),
    h(
      Out,
      null,
      `import { ${names.factory} } from "${names.importSpec}";\n`,
      `// …then add ${names.call} to the default export's plugins array.`,
    ),
  );
}

/** The diff preview: nothing has been written yet, and this is exactly what will be. */
function PreviewSection({ ctx, plan }: { readonly ctx: UiContext; readonly plan: Plan }): VNode {
  return h(
    Panel,
    { name: "Plugins", title: `${plan.op === "add" ? "Add" : "Remove"} ${plan.target.name}` },
    h(PreviewLead, null),
    h("h2", null, "Command"),
    h(Out, null, `deno ${plan.command.join(" ")}`),
    plan.bailed ? h(ManualNote, { names: plan.target.names }) : null,
    plan.note ? h(Note, null, plan.note) : null,
    plan.diff
      ? h(Fragment, null, h("h2", null, plan.configName), h(DiffBlock, { diff: plan.diff }))
      : null,
    h(PluginForm, {
      ctx,
      fields: { ...plan.target.fields, op: plan.post, confirm: "1" },
      label: "Apply",
    }),
    h("p", null, h("a", { href: "/plugins" }, "Cancel")),
  );
}

/** The one-line summary of a finished plan: what changed, or the failed command. */
function outcomeHead(plan: Plan, outcome: ApplyOutcome): string {
  if (outcome.code !== 0) return `deno ${plan.command.join(" ")} exited ${outcome.code}.`;
  const what = plan.op === "add" ? "Added" : "Removed";
  const wrote = outcome.wrote ? ` and updated ${plan.configName}` : "";
  return `${what} ${plan.target.name}${wrote}.`;
}

/** What the panel says after a plan ran. */
function OutcomeNotice(
  { plan, outcome }: { readonly plan: Plan; readonly outcome: ApplyOutcome },
): VNode {
  return h(
    Fragment,
    null,
    h(Note, null, outcomeHead(plan, outcome)),
    outcome.output ? h(Out, null, outcome.output) : null,
  );
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
      options: row.wired && row.entry.optionsSchema ? optionsHref(row.entry.name) : null,
    })),
    config: state.source === null ? null : state.configName,
  };
}

/** The machine view of a computed plan. */
function planPayload(plan: Plan): Record<string, unknown> {
  return {
    name: plan.target.name,
    op: plan.post,
    command: ["deno", ...plan.command].join(" "),
    diff: plan.diff,
    bailed: plan.bailed,
    note: plan.note,
  };
}

// ── the handler ──────────────────────────────────────────────────────────────

/**
 * One posted field, from a form body or a JSON body.
 *
 * @param ctx The request context.
 * @param key The field name.
 * @returns The posted string, or `""` when the field is absent or not a string.
 */
export function postedField(ctx: UiContext, key: string): string {
  const posted = ctx.form?.get(key);
  if (typeof posted === "string") return posted;
  const value = (ctx.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : "";
}

/**
 * Whether this POST is the second step (apply), not the first (preview): `confirm=1` from a
 * form, or `confirm: true` from a JSON body.
 *
 * @param ctx The request context.
 * @returns `true` for the confirmed step.
 */
export function confirmed(ctx: UiContext): boolean {
  return postedField(ctx, "confirm") === "1" ||
    (ctx.body as Record<string, unknown> | undefined)?.confirm === true;
}

/** The requested operation: `DELETE` means remove, otherwise the posted `op` field. */
function opFor(ctx: UiContext): Op | null {
  if (ctx.method === "DELETE") return "remove";
  const op = postedField(ctx, "op");
  return op === "add" || op === "remove" ? op : null;
}

/** Whether the caller can consume a streamed `deno` log. */
function wantsStream(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/event-stream");
}

/** A refusal, in whichever shape the caller asked for. */
async function refusal(
  ctx: UiContext,
  state: ProjectState,
  reason: string,
  status: number,
): Promise<Response> {
  if (ctx.json) return jsonResponse({ ok: false, reason, ...payload(state) }, status);
  const discovery = await discover(ctx);
  const notice = h(Note, null, reason);
  return page(ctx, h(PluginsPanel, { ctx, state, discovery, notice }), status);
}

/** The catalogue view (with a JSR search when the `GET` carries `?q=`). */
async function view(ctx: UiContext, state: ProjectState): Promise<Response> {
  const discovery = await discover(ctx);
  if (ctx.json) {
    return jsonResponse({ ok: true, ...payload(state), ...discoveryPayload(discovery) });
  }
  return page(ctx, h(PluginsPanel, { ctx, state, discovery }));
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
  return page(ctx, h(PreviewSection, { ctx, plan }));
}

/** The confirmed POST: run it, then answer with the refreshed catalogue (or a `303` for no-JS). */
async function apply(ctx: UiContext, plan: Plan, before: ProjectState): Promise<Response> {
  let outcome: ApplyOutcome;
  try {
    outcome = await applyPlan(plan, ctx.dir, ctx.signal);
  } catch (error) {
    if (error instanceof StaleWriteError) {
      const stale = `${plan.configName} changed on disk since this plan was made — it was not ` +
        "rewritten. Review the current file and apply again.";
      return await refusal(ctx, await readProject(ctx.dir), stale, 409);
    }
    const why = error instanceof Error ? error.message : String(error);
    return await refusal(ctx, before, `${plan.op} failed: ${why}`, 403);
  }
  broadcast(ctx.events, { type: "plugins-changed", name: plan.target.name });
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
      headers: { location: `/plugins#${plan.target.name}` },
    });
  }
  const discovery = await discover(ctx);
  const notice = h(OutcomeNotice, { plan, outcome });
  return page(ctx, h(PluginsPanel, { ctx, state, discovery, notice }));
}

/** The confirmed POST, streamed: the `deno` child's output as it arrives. */
function streamApply(ctx: UiContext, plan: Plan): Response {
  return sseProcess(
    async (line, signal) => {
      const outcome = await applyPlan(plan, ctx.dir, signal, line);
      return { code: outcome.code, note: outcome.wrote ? `wrote ${plan.configName}` : undefined };
    },
    {
      prelude: [`$ deno ${plan.command.join(" ")}`],
      signal: ctx.signal,
      settled: () => broadcast(ctx.events, { type: "plugins-changed", name: plan.target.name }),
    },
  );
}

/** Preview a plan, or — confirmed and not bailed — apply it (streamed when asked). */
async function run(
  request: Request,
  ctx: UiContext,
  plan: Plan,
  state: ProjectState,
): Promise<Response> {
  if (!confirmed(ctx) || plan.bailed) return preview(ctx, plan, state);
  return wantsStream(request) ? streamApply(ctx, plan) : await apply(ctx, plan, state);
}

/**
 * `op=add-jsr`: a third-party package, validated (name, export) before anything runs, its version
 * read from JSR in this request, then the same add path — and diff discipline — as the catalogue.
 */
async function mutateJsr(request: Request, ctx: UiContext, state: ProjectState) {
  const resolved = await resolveJsrAdd(ctx, postedField(ctx, "spec"), postedField(ctx, "export"));
  if (!resolved.ok) return await refusal(ctx, state, resolved.reason, resolved.status);
  const { spec, names, fields } = resolved.add;
  const target: Target = { name: spec, kind: "plugin", names, fields, addOp: "add-jsr" };
  return await run(request, ctx, planAdd(target, state), state);
}

/**
 * A mutation: validate the name against the catalogue, plan it, then preview or apply it. Under
 * `--offline` a valid add or remove is refused with a `503` — preview included — before anything
 * runs: `deno add` needs the registry, and `deno remove` can re-resolve the rest over the network.
 */
async function mutate(request: Request, ctx: UiContext, state: ProjectState): Promise<Response> {
  if (ctx.readOnly) return await refusal(ctx, state, "read-only", 403);
  if (postedField(ctx, "op") === "add-jsr") return await mutateJsr(request, ctx, state);
  const name = postedField(ctx, "name");
  const entry = CATALOG_ROWS.find((row) => row.name === name);
  if (!entry) return await refusal(ctx, state, `unknown plugin "${name}"`, 400);
  const op = opFor(ctx);
  if (op === null) {
    return await refusal(ctx, state, `unknown operation "${postedField(ctx, "op")}"`, 400);
  }
  if (ctx.offline === true) return await refusal(ctx, state, OFFLINE_REFUSALS[op], OFFLINE_STATUS);
  return await run(request, ctx, OPS[op](catalogTarget(entry), state), state);
}

/**
 * Serve the plugin-manager panel: the catalogue (and a JSR search for `?q=`) on `GET`, a diff
 * preview on the first `POST`, and the `deno add`/`deno remove` + config write on a `POST`
 * carrying `confirm=1`.
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
  if (ctx.method === "GET" || ctx.method === "HEAD") return await view(ctx, state);
  return await mutate(request, ctx, state);
};
