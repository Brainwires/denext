// `/config` — the schema-driven configuration editor (and `/config/next`, in `config-next.ts`).
//
// Two buckets, decided per top-level key by `readConfigModel`: a key whose value is a DATA
// literal is editable through the widgets `src/ui/form/**` derives from
// `denext.config.schema.json`; a key whose value is CODE (a call, a callback, an imported
// binding) is shown verbatim in a read-only cell, because regenerating it would destroy it.
// `plugins` is a third case — data, but owned by `/plugins`, which knows how to keep its
// imports in step. A `redirects`/`rewrites`/`headers` thunk is code by that rule, so its array
// literal is unwrapped separately: the rows edit, the `() => [ … ]` wrapper is left alone.
//
// Every write is two steps — the first POST computes the new source and answers with a unified
// diff, with nothing written, and a second POST carrying `confirm=1` applies it — and both run
// the whole PROPOSED config through `validateDenextConfig`, so a bad value is a `422` with the
// message against its field rather than a broken config on disk. When the writer cannot own an
// edit it bails: the reason plus a copyable diff, and the file is left exactly as it was.
//
// The rule this module inherits from the kernel: the project's config is never *evaluated*. It
// is read as text and spliced by `src/build/config-edit.ts`, which keeps every byte — comments
// included — that the edit did not touch.

import { join } from "@std/path";
import {
  applyArrayOps,
  type ArrayOp,
  type ConfigKeyInfo,
  deleteConfigValue,
  type EditResult,
  readConfigModel,
  setConfigValue,
} from "../../build/config-edit.ts";
import { createUnifiedDiff } from "../../build/patch-diff.ts";
import { CONFIG_FILES } from "../../build/paths.ts";
import type { DenextConfig } from "../../server/config.ts";
import { validateDenextConfig, warnUnknownConfigKeys } from "../../server/config-validate.ts";
import {
  diffHtml,
  esc,
  html,
  jsonResponse,
  panelResponder,
  raw,
  type RawHtml,
  type UiContext,
  type UiHandler,
} from "../html.ts";
import { UI_CSRF_FIELD } from "../security.ts";
import { control } from "../form/control.ts";
import { loadConfigSchema, resolveAt, type SchemaNode } from "../form/schema.ts";
import { widgetFor, type WidgetSpec } from "../form/widget.ts";
import { readWidget, renderWidget } from "../form/render.ts";
import {
  applyListOp,
  decode,
  encode,
  type FormEntry,
  FormValueError,
  type ListOpRequest,
  OP_FIELD,
  parseFieldName,
  parseOp,
} from "../form/value.ts";
import { nextConfigPanel } from "./config-next.ts";

/** The file the editor offers to create when the project has no denext config at all. */
const EMPTY_CONFIG = "export default {\n};\n";

/** The one top-level key this panel shows but never writes (the plugin manager owns it). */
const MANAGED_KEY = "plugins";

/** Fields the editor posts for its own bookkeeping, which are never config values. */
const CONTROL_FIELDS: ReadonlySet<string> = new Set([
  UI_CSRF_FIELD,
  OP_FIELD,
  "confirm",
  "clear",
  "section",
  "raw",
]);

// ── the project's current config ─────────────────────────────────────────────

/** How one top-level key is presented: an editable widget tree, a code cell, or a hand-off. */
type SectionKind = "editable" | "readonly" | "managed";

/** One top-level config key, as the panel renders (and writes) it. */
interface Section {
  /** The key. */
  readonly key: string;
  /** Which bucket it falls into. */
  readonly kind: SectionKind;
  /** The widget tree for an editable key (absent for a key the schema does not describe). */
  readonly spec?: WidgetSpec;
  /** The current value of an editable key. */
  readonly value?: unknown;
  /** The value's source text, for a read-only cell. */
  readonly text?: string;
  /** Whether the key is set in the file at all. */
  readonly present: boolean;
  /** The value is written as `() => [ … ]` (a `redirects`-style thunk). */
  readonly wrapper: boolean;
  /** The schema's description, shown under the section heading. */
  readonly description?: string;
}

/** Everything one request needs to know about the project's config. */
interface ConfigState {
  /** Absolute path of the config file (existing, or where one would be created). */
  readonly path: string;
  /** Its file name, used as the diff label. */
  readonly name: string;
  /** Whether that file exists. */
  readonly exists: boolean;
  /** Its source (empty when it does not exist). */
  readonly source: string;
  /** The module shape `readConfigModel` recognised. */
  readonly form: string;
  /** Every top-level key, schema order first. */
  readonly sections: readonly Section[];
}

/** The text of `path`, or `null` when it does not exist (or cannot be read). */
async function readText(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

/** Locate the project's config file: the first name that exists, else where one would go. */
async function locateConfig(dir: string): Promise<{ path: string; name: string; source: string }> {
  for (const name of CONFIG_FILES) {
    const path = join(dir, name);
    const source = await readText(path);
    if (source !== null) return { path, name, source };
  }
  return { path: join(dir, CONFIG_FILES[0]), name: CONFIG_FILES[0], source: "" };
}

/** The `x-denext.wrapper === "function"` marker: this key is written as a thunk. */
function isWrapped(node: SchemaNode | undefined): boolean {
  return node?.["x-denext"]?.wrapper === "function";
}

/**
 * Classify one top-level key into its bucket. A rule thunk (`key: () => [ … ]`) arrives from
 * {@linkcode readConfigModel} already unwrapped — editable rows plus a `wrapper` marker — so
 * the editor owns the rows while the `() => …` wrapper is left exactly where it is.
 */
function classify(
  key: string,
  node: SchemaNode | undefined,
  info: ConfigKeyInfo | undefined,
): Section {
  const present = info !== undefined;
  const wrapper = isWrapped(node) || info?.wrapper === "function";
  const base = { key, present, wrapper, description: node?.description };
  if (!node) return { ...base, kind: "readonly", text: info?.text };
  const spec = widgetFor(node, [key], false);
  if (key === MANAGED_KEY) return { ...base, kind: "managed", spec, text: info?.text };
  if (!info) return { ...base, kind: "editable", spec };
  if (info.kind === "editable") return { ...base, kind: "editable", spec, value: info.value };
  return { ...base, kind: "readonly", spec, text: info.text };
}

/**
 * Read the project's config into the panel's model: the file, its module shape, and one
 * {@linkcode Section} per top-level key — schema order first, then any key the file declares
 * that the schema does not describe (shown read-only, and warned about on save).
 *
 * @param dir The project directory.
 * @returns The config state.
 */
async function readState(dir: string): Promise<ConfigState> {
  const { path, name, source } = await locateConfig(dir);
  const model = await readConfigModel(source);
  const schema = loadConfigSchema();
  const properties = schema.properties ?? {};
  const extra = Object.keys(model.keys).filter((key) => !(key in properties));
  const sections = [...Object.keys(properties), ...extra].map((key) =>
    classify(key, properties[key], model.keys[key])
  );
  return { path, name, exists: source !== "", source, form: model.form, sections };
}

/** The section a key names, or `undefined` when the key is not one the panel knows. */
function sectionFor(state: ConfigState, key: string): Section | undefined {
  return state.sections.find((section) => section.key === key);
}

/** A value as the config holds it: a rule list goes back inside its `() => [ … ]` thunk. */
function held(section: Section, value: unknown): unknown {
  return section.wrapper && value !== undefined ? () => value : value;
}

/** The whole proposed config: every editable key that is set, with `key` replaced by `value`. */
function proposedConfig(state: ConfigState, key: string, value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const section of state.sections) {
    if (section.kind !== "editable" || !section.present || section.key === key) continue;
    out[section.key] = held(section, section.value);
  }
  const target = sectionFor(state, key);
  if (target && value !== undefined) out[key] = held(target, value);
  return out;
}

// ── validation ───────────────────────────────────────────────────────────────

/** A validation failure, already addressed to the form field it belongs to. */
interface FieldError {
  /** The posted field name (the validator's backticked path is one). */
  readonly field: string;
  /** The message to show. */
  readonly message: string;
}

/**
 * Run the proposed config past the loader's own validator. Its messages are field-scoped
 * (``invalid denext.config.ts: `i18n.defaultLocale` …``) and its field paths are spelled
 * exactly like the form's field names, so the message lands on the control that caused it.
 */
function validationError(
  config: Record<string, unknown>,
  name: string,
): FieldError | undefined {
  try {
    validateDenextConfig(config as DenextConfig, name);
    warnUnknownConfigKeys(config, name);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { field: message.match(/`([^`]+)`/)?.[1] ?? "", message };
  }
}

// ── list operations ──────────────────────────────────────────────────────────

/** The element `+ Add` inserts: an empty row for a sub-form, an empty value for a chip. */
function blankRow(spec: WidgetSpec | undefined): unknown {
  const row = spec?.items;
  if (!row) return null;
  if (row.kind === "group" || row.kind === "list-of-forms" || row.kind === "map") return {};
  if (row.kind === "number") return 0;
  if (row.kind === "toggle") return false;
  return "";
}

/** Apply a row operation to one list value (a map is operated on as its `[key, value]` rows). */
function runListOp(spec: WidgetSpec, current: unknown, request: ListOpRequest): unknown {
  if (spec.kind === "map") {
    const pairs = typeof current === "object" && current !== null
      ? Object.entries(current as Record<string, unknown>)
      : [];
    const next = applyListOp<[string, unknown]>(pairs, request.op, request.at, ["", null]);
    return Object.fromEntries(next.filter((pair) => Array.isArray(pair)));
  }
  const list = Array.isArray(current) ? current : [];
  return applyListOp(list, request.op, request.at, blankRow(spec));
}

/** Replace the value at `rest` inside `value`, rebuilding only the containers on the way. */
function updateAt(
  value: unknown,
  rest: readonly string[],
  change: (v: unknown) => unknown,
): unknown {
  const [head, ...tail] = rest;
  if (head === undefined) return change(value);
  if (/^\d+$/.test(head)) {
    const list = Array.isArray(value) ? [...value] : [];
    list[Number(head)] = updateAt(list[Number(head)], tail, change);
    return list;
  }
  const holder = typeof value === "object" && value !== null
    ? { ...(value as Record<string, unknown>) }
    : {};
  holder[head] = updateAt(holder[head], tail, change);
  return holder;
}

/**
 * Apply the row button's operation inside the decoded section value. The button names the list
 * by its field name, so a list nested inside the section (`i18n.locales`) is reached by path.
 */
function applyRowOp(schema: SchemaNode, value: unknown, request: ListOpRequest): unknown {
  const path = parseFieldName(request.list);
  const spec = widgetFor(resolveAt(schema, path), path, false);
  return updateAt(value, path.slice(1), (current) => runListOp(spec, current, request));
}

/** A value as a comparable string, with object keys sorted so field order is not a change. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, held: unknown) => {
    if (typeof held !== "object" || held === null || Array.isArray(held)) return held;
    const entries = Object.entries(held as Record<string, unknown>);
    return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1)));
  }) ?? "undefined";
}

/** The array operation one row button stands for (an out-of-range move is simply dropped). */
function rowOps(request: ListOpRequest, spec: WidgetSpec | undefined): ArrayOp[] {
  if (request.op === "add") return [{ op: "insert", at: request.at, value: blankRow(spec) }];
  if (request.op === "remove") return [{ op: "remove", at: request.at }];
  const to = request.op === "up" ? request.at - 1 : request.at + 1;
  return to < 0 ? [] : [{ op: "move", from: request.at, to }];
}

/**
 * The operations that turn the file's list into the posted one: an element whose value changed
 * is updated, a new element inserted, a vanished one removed — and the row button's own move or
 * insert is appended, so a reorder stays a move and its comments ride along with the element.
 */
function listOps(
  current: readonly unknown[],
  posted: readonly unknown[],
  section: Section,
  request?: ListOpRequest,
): ArrayOp[] {
  const ops: ArrayOp[] = [];
  for (let i = 0; i < posted.length; i++) {
    if (i >= current.length) ops.push({ op: "insert", at: i, value: posted[i] });
    else if (stable(current[i]) !== stable(posted[i])) {
      ops.push({ op: "update", at: i, value: posted[i] });
    }
  }
  for (let i = current.length - 1; i >= posted.length; i--) ops.push({ op: "remove", at: i });
  if (request) ops.push(...rowOps(request, section.spec));
  return ops;
}

// ── planning one write ───────────────────────────────────────────────────────

/** One proposed section write: what was posted, what it becomes, and the computed edit. */
interface Plan {
  /** The section being written. */
  readonly section: Section;
  /** The value decoded from the form *before* the row button's operation. */
  readonly posted: unknown;
  /** The value the config will hold. */
  readonly next: unknown;
  /** The row button's operation, when the submit carried one. */
  readonly request?: ListOpRequest;
  /** The edit — the new source and its diff, or the writer's refusal. */
  readonly result: EditResult;
}

/** An array value, or an empty list. */
function asList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Whether a widget edits a list of rows (the only widgets `applyArrayOps` writes). */
function isList(spec: WidgetSpec | undefined): boolean {
  return spec?.kind === "chips" || spec?.kind === "list-of-forms" ||
    spec?.kind === "multi-select";
}

/** Compute the source edit one section write needs. */
async function editFor(state: ConfigState, plan: Omit<Plan, "result">): Promise<EditResult> {
  const { section, posted, next, request } = plan;
  const base = state.exists ? state.source : EMPTY_CONFIG;
  if (next === undefined) return await deleteConfigValue(base, [section.key]);
  if (!isList(section.spec)) return await setConfigValue(base, [section.key], next);
  const atRoot = request?.list === section.key;
  const ops = listOps(
    asList(section.value),
    asList(atRoot ? posted : next),
    section,
    atRoot ? request : undefined,
  );
  const opts = section.wrapper ? { wrapper: "function" as const } : {};
  return await applyArrayOps(base, [section.key], ops, opts);
}

/**
 * Plan one section write: apply the row operation to the decoded value, then compute the edit.
 *
 * @param state The project's config.
 * @param section The section being written.
 * @param posted The value decoded from the form (before the row operation).
 * @param request The row button's operation, if the submit carried one.
 * @returns The plan, whose `result` is either the new source or an honest refusal.
 */
async function buildPlan(
  state: ConfigState,
  section: Section,
  posted: unknown,
  request?: ListOpRequest,
): Promise<Plan> {
  const next = request ? applyRowOp(loadConfigSchema(), posted, request) : posted;
  const draft = { section, posted, next, request };
  return { ...draft, result: await editFor(state, draft) };
}

// ── the views ────────────────────────────────────────────────────────────────

/** What a re-rendered section shows after a refused submit: the posted value and its errors. */
interface Feedback {
  /** The section that was posted. */
  readonly key: string;
  /** The value to render (the posted one, not the file's). */
  readonly value: unknown;
  /** Messages to show against fields, keyed by field name. */
  readonly errors: Record<string, string>;
}

/** One hidden input. */
function hidden(name: string, value: string): RawHtml {
  return control({ tag: "input", type: "hidden", name, value });
}

/** The URL a section's form posts to. */
function sectionAction(key: string): string {
  return `/config?section=${encodeURIComponent(key)}`;
}

/** A read-only cell: the value's own source text, and where to edit it by hand. */
function codeCell(state: ConfigState, section: Section): RawHtml {
  return html`<pre class="out">${section.text ?? "— not set —"}</pre>
<p class="lead">Read-only: this value is code, not data, so the editor never rewrites it.
Open <code class="mono">${state.path}</code> in your editor to change it.</p>`;
}

/** The form for an editable section: the widget tree, Save, and Clear when the key is set. */
function sectionForm(ctx: UiContext, section: Section, feedback?: Feedback): RawHtml {
  const value = feedback ? feedback.value : section.value;
  const spec = section.spec;
  if (!spec) return html``;
  return html`<form method="post" action="${sectionAction(section.key)}">
${renderWidget(spec, value, { csrf: ctx.csrf, readOnly: ctx.readOnly, errors: feedback?.errors })}
<button type="submit"${ctx.readOnly ? raw(" disabled") : ""}>Save</button>
${
    section.present
      ? html`
        <button type="submit" class="ghost" name="clear" value="1" ${ctx.readOnly
          ? raw(" disabled")
          : ""}>Clear</button>
      `
      : ""
  }
</form>`;
}

/** One top-level key: a collapsible section, open when the key is set. */
function sectionHtml(
  ctx: UiContext,
  state: ConfigState,
  section: Section,
  feedback?: Feedback,
): RawHtml {
  const mine = feedback?.key === section.key;
  const badge = section.kind === "editable" ? (section.present ? "set" : "unset") : section.kind;
  const open = section.present || mine ? " open" : "";
  return html`
    ${raw(`<details id="${esc(section.key)}"${open}>`)}
        <summary><strong>${section.key}</strong> <span class="badge">${badge}</span></summary>
        ${section.description ? html`<p class="lead">${section.description}</p>` : ""}
        ${section.kind === "managed"
          ? html`<p class="note">The <a href="/plugins">plugins panel</a> owns this key — it keeps
the config array and the import map in step.</p>${codeCell(state, section)}`
          : section.kind === "readonly"
          ? codeCell(state, section)
          : sectionForm(ctx, section, mine ? feedback : undefined)}
        </details>
  `;
}

/** The raw-file escape hatch: the whole file, saved only if it still parses as a config. */
function rawSection(ctx: UiContext, state: ConfigState): RawHtml {
  return html`
    <details id="raw-file">
      <summary><strong>Edit the file directly</strong></summary>
      <p class="lead">The escape hatch: the whole file, saved only when it still parses as a denext
    config. Everything above edits one key and preserves the rest byte for byte.</p>
      <form method="post" action="/config?raw=1">
    ${hidden(UI_CSRF_FIELD, ctx.csrf)}
    ${control({
      tag: "textarea",
      name: "raw",
      rows: 18,
      value: state.exists ? state.source : EMPTY_CONFIG,
      ariaLabel: `${state.name} source`,
      disabled: ctx.readOnly,
    })}
    <button type="submit"${ctx.readOnly ? raw(" disabled") : ""}>Save file</button>
      </form>
    </details>
  `;
}

/** The "this project has no denext config yet" header, with the offer to create one. */
function createOffer(ctx: UiContext, state: ConfigState): RawHtml {
  return html`<p class="note">This project has no denext config. Saving any section below
creates <code class="mono">${state.name}</code>; so does this:</p>
<form method="post" action="/config?create=1">
${hidden(UI_CSRF_FIELD, ctx.csrf)}
<button type="submit"${ctx.readOnly ? raw(" disabled") : ""}>Create ${state.name}</button>
</form>`;
}

/** The header a config whose module shape the writer cannot own gets instead of Save buttons. */
function unsupportedNote(state: ConfigState): RawHtml {
  return html`<p class="note"><code class="mono">${state.name}</code> cannot be edited key by key:
its default export is neither a config object, a <code>defineConfig(…)</code> call, a function
returning one, nor a set of named config exports. Use the file editor at the bottom of this page,
or rewrite the export in one of those shapes.</p>`;
}

/** What the panel page is rendered from. */
interface PanelOptions {
  /** A message to show above the sections. */
  readonly notice?: RawHtml;
  /** The posted value and errors of a refused submit. */
  readonly feedback?: Feedback;
}

/** The whole editor: one collapsible section per top-level key, then the escape hatch. */
function panelBody(ctx: UiContext, state: ConfigState, options: PanelOptions = {}): RawHtml {
  return html`<section id="panel" data-panel="Config">
<h1>Config</h1>
<p class="lead">Every key of <code class="mono">${state.path}</code>, rendered from the config
schema. A change is previewed as a diff before anything is written; comments and the values you
did not touch come through byte for byte.</p>
${ctx.readOnly ? html`<p class="note">Read-only mode — every change is refused.</p>` : ""}
${state.exists ? "" : createOffer(ctx, state)}
${state.exists && state.form === "unsupported" ? unsupportedNote(state) : ""}
${options.notice ?? ""}
${state.sections.map((section) => sectionHtml(ctx, state, section, options.feedback))}
${rawSection(ctx, state)}
</section>`;
}

/** A not-yet-applied write: the diff, the fields that re-post it, and the Confirm button. */
interface Pending {
  /** The panel heading. */
  readonly title: string;
  /** Where the confirm form posts. */
  readonly action: string;
  /** The hidden fields that re-post exactly this change. */
  readonly fields: RawHtml;
  /** The unified diff of what will be written. */
  readonly diff: string;
  /** A message shown above the diff (a bail's reason, a "no change" note). */
  readonly notes?: RawHtml;
  /** Whether there is anything to confirm. */
  readonly ok: boolean;
  /** The live section form, rendered under the diff so the change is visible, not just diffed. */
  readonly body?: RawHtml;
}

/** The preview page: nothing has been written yet, and this is exactly what will be. */
function previewBody(ctx: UiContext, pending: Pending): RawHtml {
  return html`<section id="panel" data-panel="Config">
<h1>${pending.title}</h1>
<p class="lead">Nothing has been written yet — review the change, then apply it.</p>
${pending.notes ?? ""}
${pending.diff ? diffHtml(pending.diff) : ""}
${
    pending.ok
      ? html`<form method="post" action="${pending.action}">
${hidden(UI_CSRF_FIELD, ctx.csrf)}${pending.fields}${hidden("confirm", "1")}
<button type="submit"${ctx.readOnly ? raw(" disabled") : ""}>Confirm</button>
</form>`
      : ""
  }
<p><a href="/config">Back to the editor</a></p>
${pending.body ? html`<h2>The section as it will read</h2>${pending.body}` : ""}
</section>`;
}

// ── responses ────────────────────────────────────────────────────────────────

/** Wrap a panel section as a fragment (the `ui.js` swap) or as the full document. */
const panelResponse = panelResponder("Config", "/config");

/** A refusal, in whichever shape the caller asked for. */
function refuse(ctx: UiContext, state: ConfigState, reason: string, status: number): Response {
  if (ctx.json) return jsonResponse({ ok: false, reason }, status);
  return panelResponse(
    ctx,
    panelBody(ctx, state, { notice: html`<p class="note">${reason}</p>` }),
    status,
  );
}

/** Write the new source, tell every open page, and send the browser back to the section. */
async function write(
  ctx: UiContext,
  state: ConfigState,
  source: string,
  anchor: string,
): Promise<Response> {
  await Deno.writeTextFile(state.path, source);
  const next = await readState(ctx.dir);
  if (ctx.json) return jsonResponse({ ok: true, applied: true, file: next.name });
  const notice = html`<p class="note">Wrote ${next.name}.</p>`;
  if (ctx.fragment) return panelResponse(ctx, panelBody(ctx, next, { notice }));
  return new Response(null, { status: 303, headers: { location: `/config#${anchor}` } });
}

// ── the section write ────────────────────────────────────────────────────────

/** The posted fields, minus the editor's own control fields. */
function formEntries(form: FormData): FormEntry[] {
  const out: FormEntry[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string" && !CONTROL_FIELDS.has(name)) out.push({ name, value });
  }
  return out;
}

/**
 * One posted field, whichever kind of body carried it. A JSON client may send a flag as a real
 * boolean, which reads here as the `"1"` a form would have posted.
 */
function postedField(ctx: UiContext, key: string): string {
  const fromForm = ctx.form?.get(key);
  if (typeof fromForm === "string") return fromForm;
  const value = (ctx.body as Record<string, unknown> | undefined)?.[key];
  if (value === true) return "1";
  return typeof value === "string" ? value : "";
}

/** Whether this POST is the second step (apply), not the first (preview). */
function confirmed(ctx: UiContext): boolean {
  return postedField(ctx, "confirm") === "1";
}

/** The value a section POST proposes: decoded from the form, or taken from a JSON body. */
function postedValue(
  ctx: UiContext,
  section: Section,
): { value: unknown } | { error: FieldError } {
  if (postedField(ctx, "clear") === "1") return { value: undefined };
  if (!ctx.form) return { value: (ctx.body as Record<string, unknown> | undefined)?.value };
  try {
    return { value: decode(section.spec as WidgetSpec, formEntries(ctx.form)) };
  } catch (error) {
    if (!(error instanceof FormValueError)) throw error;
    return { error: { field: error.field, message: error.message } };
  }
}

/** Re-render the posted section with its message, as a `422`. */
function invalid(
  ctx: UiContext,
  state: ConfigState,
  key: string,
  value: unknown,
  error: FieldError,
): Response {
  if (ctx.json) return jsonResponse({ ok: false, reason: error.message, field: error.field }, 422);
  const feedback: Feedback = { key, value, errors: { [error.field]: error.message } };
  const notice = html`<p class="note" role="alert">${error.message}</p>`;
  return panelResponse(ctx, panelBody(ctx, state, { notice, feedback }), 422);
}

/** The preview (or the writer's refusal) for one planned section write. */
function sectionPreview(ctx: UiContext, plan: Plan): Response {
  const { section, result } = plan;
  if (ctx.json) {
    return jsonResponse(
      result.ok ? { ok: true, applied: false, diff: result.diff } : {
        ok: false,
        applied: false,
        reason: result.reason,
        diff: result.diff,
        snippet: result.snippet,
      },
      result.ok ? 200 : 422,
    );
  }
  const fields = html`${hidden("section", section.key)}${
    encode(section.spec as WidgetSpec, plan.posted).map((entry) => hidden(entry.name, entry.value))
  }${plan.request ? hidden(OP_FIELD, postedField(ctx, OP_FIELD)) : ""}`;
  return panelResponse(
    ctx,
    previewBody(ctx, {
      title: `Config · ${section.key}`,
      action: sectionAction(section.key),
      fields,
      diff: result.ok ? result.diff : (result.diff ?? ""),
      notes: result.ok
        ? (result.diff
          ? undefined
          : html`<p class="note">No change — the file already says this.</p>`)
        : html`
          <p class="note" role="alert">${result.reason}</p>
          <pre class="out">${result.snippet}</pre>
        `,
      ok: result.ok && result.diff !== "",
      body: sectionForm(ctx, { ...section, present: true }, {
        key: section.key,
        value: plan.next,
        errors: {},
      }),
    }),
    result.ok ? 200 : 422,
  );
}

/** Decode, validate and plan one section write, then preview it or apply it. */
async function writeSection(
  ctx: UiContext,
  state: ConfigState,
  section: Section,
): Promise<Response> {
  const posted = postedValue(ctx, section);
  if ("error" in posted) return invalid(ctx, state, section.key, section.value, posted.error);
  const request = parseOp(postedField(ctx, OP_FIELD));
  const plan = await buildPlan(state, section, posted.value, request);
  const error = validationError(proposedConfig(state, section.key, plan.next), state.name);
  if (error) return invalid(ctx, state, section.key, plan.next, error);
  if (!plan.result.ok || plan.result.diff === "") return sectionPreview(ctx, plan);
  if (!confirmed(ctx)) return sectionPreview(ctx, plan);
  return await write(ctx, state, plan.result.source, section.key);
}

// ── the whole-file writes ────────────────────────────────────────────────────

/** The raw escape hatch: save the posted file, but only if it still parses as a config. */
async function writeRaw(ctx: UiContext, state: ConfigState): Promise<Response> {
  const source = postedField(ctx, "raw");
  const model = await readConfigModel(source);
  if (model.form === "unsupported") {
    return refuse(
      ctx,
      state,
      "the edited file has no editable config object — it must export a config object, a " +
        "defineConfig(…) call, a function returning one, or named config exports",
      422,
    );
  }
  const diff = createUnifiedDiff(state.source, source, state.name);
  if (confirmed(ctx)) return await write(ctx, state, source, "raw-file");
  if (ctx.json) return jsonResponse({ ok: true, applied: false, diff });
  return panelResponse(
    ctx,
    previewBody(ctx, {
      title: `Config · ${state.name}`,
      action: "/config?raw=1",
      fields: hidden("raw", source),
      diff,
      ok: diff !== "",
      notes: diff === ""
        ? html`<p class="note">No change — the file already says this.</p>`
        : undefined,
    }),
  );
}

/** Create the config file the project does not have yet. */
async function writeCreate(ctx: UiContext, state: ConfigState): Promise<Response> {
  if (state.exists) return refuse(ctx, state, `${state.name} already exists`, 400);
  const diff = createUnifiedDiff("", EMPTY_CONFIG, state.name);
  if (confirmed(ctx)) return await write(ctx, state, EMPTY_CONFIG, "raw-file");
  if (ctx.json) return jsonResponse({ ok: true, applied: false, diff });
  return panelResponse(
    ctx,
    previewBody(ctx, {
      title: `Create ${state.name}`,
      action: "/config?create=1",
      fields: html``,
      diff,
      ok: true,
    }),
  );
}

// ── the handler ──────────────────────────────────────────────────────────────

/** The machine view of the project's config (the `/api/config` payload). */
function payload(state: ConfigState, schema: boolean): Record<string, unknown> {
  const keys: Record<string, unknown> = {};
  for (const section of state.sections) {
    if (!section.present) continue;
    keys[section.key] = section.kind === "editable"
      ? { kind: "editable", value: section.value }
      : { kind: section.kind, text: section.text };
  }
  return {
    file: state.exists ? state.name : null,
    form: state.form,
    keys,
    ...(schema ? { schema: loadConfigSchema() } : {}),
  };
}

/** Dispatch one mutation: the raw file, the create offer, or one section. */
async function mutate(ctx: UiContext, state: ConfigState): Promise<Response> {
  if (ctx.readOnly) return refuse(ctx, state, "read-only", 403);
  const params = ctx.url.searchParams;
  if (params.get("raw") === "1") return await writeRaw(ctx, state);
  if (params.get("create") === "1") return await writeCreate(ctx, state);
  const key = params.get("section") ?? postedField(ctx, "section");
  const section = sectionFor(state, key);
  if (!section) return refuse(ctx, state, `unknown config section "${key}"`, 400);
  if (section.kind === "managed") {
    return refuse(ctx, state, `\`${key}\` is managed by the plugins panel`, 400);
  }
  if (section.kind === "readonly" || !section.spec) {
    return refuse(ctx, state, `\`${key}\` is code, not data — edit it in ${state.name}`, 400);
  }
  return await writeSection(ctx, state, section);
}

/**
 * Decode a posted config form into `{ path: value }` — the flat, field-by-field view of a
 * submit, for a caller that wants the posted values rather than one section's whole tree.
 *
 * @param form The submitted fields.
 * @param schema The root config schema.
 * @returns The decoded patch, keyed by field name.
 */
export function decodePatch(form: FormData, schema: SchemaNode): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith("_") || typeof value !== "string") continue;
    patch[key] = readWidget(schema, key, value);
  }
  return patch;
}

/**
 * Serve the configuration editor: every top-level key as a widget tree or a read-only code
 * cell on `GET`, a diff preview on the first `POST`, and the write on a `POST` carrying
 * `confirm=1`. `/config/next` is answered by {@linkcode nextConfigPanel}.
 *
 * @param request The incoming request (its `Accept` decides fragment vs document).
 * @param ctx The kernel's request context (already past the origin, CSRF and read-only gates).
 * @returns The panel, its JSON twin, a preview, or a `303` back to the section that changed.
 */
export const configPanel: UiHandler = async (
  request: Request,
  ctx: UiContext,
): Promise<Response> => {
  if (ctx.url.pathname.endsWith("/config/next")) return await nextConfigPanel(request, ctx);
  const state = await readState(ctx.dir);
  if (ctx.method === "GET" || ctx.method === "HEAD") {
    if (ctx.json) {
      return jsonResponse({ ok: true, ...payload(state, ctx.url.searchParams.has("schema")) });
    }
    return panelResponse(ctx, panelBody(ctx, state));
  }
  return await mutate(ctx, state);
};
