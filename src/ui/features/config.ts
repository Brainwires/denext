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
//
// Two guarantees around the file itself. Containment: the config is located, read and written
// through `uiSafeJoin`/`writeFileAtomic`, so a `denext.config.ts` that is a symlink out of the
// project is neither shown nor overwritten, and every write is a `.tmp` + rename. Concurrency:
// every form carries `_base`, a SHA-256 of the source it was rendered from, and a POST whose
// stamp no longer matches the file on disk is a `409` — an edit made in a real editor (or a
// second tab) is never silently lost. A caller that posts no `_base` opts out.

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
import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode } from "../../jsx/types.ts";
import { jsonResponse, panelResponder, type UiContext, type UiHandler } from "../html.ts";
import {
  DiffBlock,
  Hidden,
  Mono,
  NoChange,
  Note,
  OpForm,
  Out,
  Panel,
  PreviewLead,
} from "../components.ts";
import { Raw, renderView } from "../view.ts";
import { StaleWriteError, UI_CSRF_FIELD, uiSafeJoin, writeFileAtomic } from "../security.ts";
import { loadConfigSchema, resolveAt, type SchemaNode } from "../form/schema.ts";
import { widgetFor, type WidgetSpec } from "../form/widget.ts";
import { readWidget, renderWidget } from "../form/render.ts";
import { control } from "../form/control.ts";
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

/**
 * The hidden field every form carries: a SHA-256 of the config source the form was rendered
 * from. A POST whose `_base` no longer matches the file on disk is refused with a `409` instead
 * of silently overwriting whatever an editor (or a second UI tab) wrote in the meantime.
 */
const BASE_FIELD = "_base";

/** Fields the editor posts for its own bookkeeping, which are never config values. */
const CONTROL_FIELDS: ReadonlySet<string> = new Set([
  UI_CSRF_FIELD,
  OP_FIELD,
  "confirm",
  "clear",
  "section",
  "raw",
  BASE_FIELD,
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
  /** The SHA-256 of that source, posted back as `_base` so a lost update is caught. */
  readonly base: string;
  /** The module shape `readConfigModel` recognised. */
  readonly form: string;
  /** Every top-level key, schema order first. */
  readonly sections: readonly Section[];
}

/**
 * The text of `dir/name`, or `null` when it does not exist, cannot be read, or is a symlink
 * pointing out of the project — {@linkcode uiSafeJoin} refuses that last case, so a
 * `denext.config.ts` linked at `~/.aws/credentials` never reaches the page (nor the writer).
 */
async function readText(dir: string, name: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(await uiSafeJoin(dir, name));
  } catch {
    return null;
  }
}

/**
 * The optimistic-concurrency stamp for one config source: a SHA-256, hex, of its bytes.
 *
 * @param source The file's text (`""` when there is no file yet).
 * @returns The hex digest.
 */
async function baseStamp(source: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source) as BufferSource,
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether a POST is writing against the file it was rendered from. A request that carries no
 * `_base` (the `/api/config` twin, or a script) opts out and is allowed through unchecked.
 *
 * @param ctx The request context.
 * @param state The config as it stands on disk right now.
 * @returns `true` when the write may proceed.
 */
async function baseMatches(ctx: UiContext, state: ConfigState): Promise<boolean> {
  const posted = postedField(ctx, BASE_FIELD);
  return posted === "" || posted === await baseStamp(state.source);
}

/** Locate the project's config file: the first name that exists, else where one would go. */
async function locateConfig(dir: string): Promise<{ path: string; name: string; source: string }> {
  for (const name of CONFIG_FILES) {
    const source = await readText(dir, name);
    if (source !== null) return { path: join(dir, name), name, source };
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
  return {
    path,
    name,
    exists: source !== "",
    source,
    base: await baseStamp(source),
    form: model.form,
    sections,
  };
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

/** One hidden input, keyed by its name (every list of them has unique names). */
function hidden(name: string, value: string): VNode {
  return h(Hidden, { key: name, name, value });
}

/** The URL a section's form posts to. */
function sectionAction(key: string): string {
  return `/config?section=${encodeURIComponent(key)}`;
}

/** A read-only cell: the value's own source text, and where to edit it by hand. */
function ReadOnlyCell(
  { state, section }: { readonly state: ConfigState; readonly section: Section },
): VNode {
  return h(
    Fragment,
    null,
    h(Out, null, section.text ?? "— not set —"),
    h(
      "p",
      { class: "lead" },
      "Read-only: this value is code, not data, so the editor never rewrites it. Open ",
      h(Mono, null, state.path),
      " in your editor to change it.",
    ),
  );
}

/** The `plugins` key: shown as code, with the pointer to the panel that owns it. */
function ManagedCell(
  { state, section }: { readonly state: ConfigState; readonly section: Section },
): VNode {
  return h(
    Fragment,
    null,
    h(
      Note,
      null,
      "The ",
      h("a", { href: "/plugins" }, "plugins panel"),
      " owns this key — it keeps the config array and the import map in step.",
    ),
    h(ReadOnlyCell, { state, section }),
  );
}

/** What {@linkcode EditableField} renders: one editable section's widget tree. */
interface EditableProps {
  /** The current request (its token and read-only flag). */
  readonly ctx: UiContext;
  /** The `_base` stamp the form carries. */
  readonly base: string;
  /** The section being edited. */
  readonly section: Section;
  /** Its widget tree. */
  readonly spec: WidgetSpec;
  /** The posted value and errors of a refused submit, when they belong to this section. */
  readonly feedback?: Feedback;
}

/** The form for an editable section: the widget tree, Save, and Clear when the key is set. */
function EditableField({ ctx, base, section, spec, feedback }: EditableProps): VNode {
  const value = feedback ? feedback.value : section.value;
  const widgets = renderWidget(spec, value, {
    csrf: ctx.csrf,
    readOnly: ctx.readOnly,
    errors: feedback?.errors,
  });
  const clear = h(
    "button",
    { type: "submit", class: "ghost", name: "clear", value: "1", disabled: ctx.readOnly },
    "Clear",
  );
  return h(
    "form",
    { method: "post", action: sectionAction(section.key) },
    hidden(BASE_FIELD, base),
    h(Raw, { html: widgets }),
    h("button", { type: "submit", disabled: ctx.readOnly }, "Save"),
    section.present ? h(Fragment, null, " ", clear) : null,
  );
}

/** What one section of the editor is rendered from. */
interface SectionProps {
  /** The current request. */
  readonly ctx: UiContext;
  /** The project's config. */
  readonly state: ConfigState;
  /** The section. */
  readonly section: Section;
  /** The posted value and errors of a refused submit (for whichever section was posted). */
  readonly feedback?: Feedback;
}

/** A section's body, by bucket: the plugins hand-off, a code cell, or the widget form. */
function SectionBody({ ctx, state, section, feedback }: SectionProps): VNode {
  if (section.kind === "managed") return h(ManagedCell, { state, section });
  if (section.kind === "readonly") return h(ReadOnlyCell, { state, section });
  if (!section.spec) return h(Fragment, null);
  return h(EditableField, { ctx, base: state.base, section, spec: section.spec, feedback });
}

/** One top-level key: a collapsible section, open when the key is set. */
function ConfigSection({ ctx, state, section, feedback }: SectionProps): VNode {
  const mine = feedback?.key === section.key;
  const badge = section.kind === "editable" ? (section.present ? "set" : "unset") : section.kind;
  return h(
    "details",
    { id: section.key, open: section.present || mine },
    h("summary", null, h("strong", null, section.key), " ", h("span", { class: "badge" }, badge)),
    section.description ? h("p", { class: "lead" }, section.description) : null,
    h(SectionBody, { ctx, state, section, feedback: mine ? feedback : undefined }),
  );
}

/** The request and the config state, which every page-level piece of the editor takes. */
interface StateProps {
  /** The current request. */
  readonly ctx: UiContext;
  /** The project's config. */
  readonly state: ConfigState;
}

/**
 * The raw-file escape hatch: the whole file, saved only if it still parses as a config. The
 * source is the text content of the form renderer's `<textarea>` control, so the renderer
 * escapes it and a browser posts back exactly the file's bytes.
 */
function RawFileEditor({ ctx, state }: StateProps): VNode {
  const editor = h(Raw, {
    html: control({
      tag: "textarea",
      name: "raw",
      ariaLabel: `${state.name} source`,
      disabled: ctx.readOnly,
      rows: 18,
      value: state.exists ? state.source : EMPTY_CONFIG,
    }),
  });
  return h(
    "details",
    { id: "raw-file" },
    h("summary", null, h("strong", null, "Edit the file directly")),
    h(
      "p",
      { class: "lead" },
      "The escape hatch: the whole file, saved only when it still parses as a denext config. " +
        "Everything above edits one key and preserves the rest byte for byte.",
    ),
    h(OpForm, {
      csrf: ctx.csrf,
      action: "/config?raw=1",
      label: "Save file",
      fields: { [BASE_FIELD]: state.base },
      extra: editor,
      disabled: ctx.readOnly,
    }),
  );
}

/** The "this project has no denext config yet" header, with the offer to create one. */
function CreateOffer({ ctx, state }: StateProps): VNode {
  return h(
    Fragment,
    null,
    h(
      Note,
      null,
      "This project has no denext config. Saving any section below creates ",
      h(Mono, null, state.name),
      "; so does this:",
    ),
    h(OpForm, {
      csrf: ctx.csrf,
      action: "/config?create=1",
      label: `Create ${state.name}`,
      disabled: ctx.readOnly,
    }),
  );
}

/** The header a config whose module shape the writer cannot own gets instead of Save buttons. */
function UnsupportedNote({ name }: { readonly name: string }): VNode {
  return h(
    Note,
    null,
    h(Mono, null, name),
    " cannot be edited key by key: its default export is neither a config object, a ",
    h("code", null, "defineConfig(…)"),
    " call, a function returning one, nor a set of named config exports. Use the file editor " +
      "at the bottom of this page, or rewrite the export in one of those shapes.",
  );
}

/** What the panel page is rendered from. */
interface PanelOptions {
  /** A message to show above the sections. */
  readonly notice?: VNode;
  /** The posted value and errors of a refused submit. */
  readonly feedback?: Feedback;
}

/** The whole editor: one collapsible section per top-level key, then the escape hatch. */
function ConfigPanel(
  { ctx, state, options }: StateProps & { readonly options: PanelOptions },
): VNode {
  const { notice, feedback } = options;
  return h(
    Panel,
    { name: "Config", title: "Config" },
    h(
      "p",
      { class: "lead" },
      "Every key of ",
      h(Mono, null, state.path),
      ", rendered from the config schema. A change is previewed as a diff before anything is " +
        "written; comments and the values you did not touch come through byte for byte.",
    ),
    ctx.readOnly ? h(Note, null, "Read-only mode — every change is refused.") : null,
    state.exists ? null : h(CreateOffer, { ctx, state }),
    state.exists && state.form === "unsupported" ? h(UnsupportedNote, { name: state.name }) : null,
    notice ?? null,
    state.sections.map((section) =>
      h(ConfigSection, { key: section.key, ctx, state, section, feedback })
    ),
    h(RawFileEditor, { ctx, state }),
  );
}

/** A not-yet-applied write: the diff, the fields that re-post it, and the Confirm button. */
interface Pending {
  /** The panel heading. */
  readonly title: string;
  /** Where the confirm form posts. */
  readonly action: string;
  /** The hidden fields that re-post exactly this change. */
  readonly fields: readonly VNode[];
  /** The SHA-256 of the source this change was computed against. */
  readonly base: string;
  /** The unified diff of what will be written. */
  readonly diff: string;
  /** A message shown above the diff (a bail's reason, a "no change" note). */
  readonly notes?: VNode;
  /** Whether there is anything to confirm. */
  readonly ok: boolean;
  /** The live section form, rendered under the diff so the change is visible, not just diffed. */
  readonly body?: VNode;
}

/** The Confirm form: the change's own fields again, plus `confirm=1`. */
function ConfirmForm(
  { ctx, pending }: { readonly ctx: UiContext; readonly pending: Pending },
): VNode {
  return h(OpForm, {
    csrf: ctx.csrf,
    action: pending.action,
    label: "Confirm",
    fields: { [BASE_FIELD]: pending.base },
    extra: [...pending.fields, hidden("confirm", "1")],
    disabled: ctx.readOnly,
  });
}

/** The preview page: nothing has been written yet, and this is exactly what will be. */
function PreviewPanel(
  { ctx, pending }: { readonly ctx: UiContext; readonly pending: Pending },
): VNode {
  return h(
    Panel,
    { name: "Config", title: pending.title },
    h(PreviewLead, null),
    pending.notes ?? null,
    pending.diff ? h(DiffBlock, { diff: pending.diff }) : null,
    pending.ok ? h(ConfirmForm, { ctx, pending }) : null,
    h("p", null, h("a", { href: "/config" }, "Back to the editor")),
    pending.body
      ? h(Fragment, null, h("h2", null, "The section as it will read"), pending.body)
      : null,
  );
}

// ── responses ────────────────────────────────────────────────────────────────

/** Wrap a panel section as a fragment (the `ui.js` swap) or as the full document. */
const panelResponse = panelResponder("Config", "/config");

/** The editor page, with an optional notice above the sections and a refused submit's feedback. */
function editorResponse(
  ctx: UiContext,
  state: ConfigState,
  options: PanelOptions = {},
  status?: number,
): Response {
  return panelResponse(ctx, renderView(h(ConfigPanel, { ctx, state, options })), status);
}

/** A preview page, as the fragment or the whole document. */
function previewResponse(ctx: UiContext, pending: Pending, status?: number): Response {
  return panelResponse(ctx, renderView(h(PreviewPanel, { ctx, pending })), status);
}

/** A refusal, in whichever shape the caller asked for. */
function refuse(ctx: UiContext, state: ConfigState, reason: string, status: number): Response {
  if (ctx.json) return jsonResponse({ ok: false, reason }, status);
  return editorResponse(ctx, state, { notice: h(Note, null, reason) }, status);
}

/**
 * Write the new source, tell every open page, and send the browser back to the section. The
 * write goes through {@linkcode writeFileAtomic}: contained (never through a symlink that leaves
 * the project) and a `.tmp` + rename, so a reader never sees a half-written config.
 */
async function write(
  ctx: UiContext,
  state: ConfigState,
  source: string,
  anchor: string,
): Promise<Response> {
  try {
    await writeFileAtomic(ctx.dir, state.name, source, { unchangedFrom: state.source });
  } catch (error) {
    if (error instanceof StaleWriteError) {
      const stale = `${state.name} changed on disk while this change was being applied — ` +
        "nothing was written. Review the current file below and re-apply your change.";
      return refuse(ctx, await readState(ctx.dir), stale, 409);
    }
    const reason = error instanceof Error ? error.message : String(error);
    return refuse(ctx, state, `${state.name} could not be written: ${reason}`, 403);
  }
  const next = await readState(ctx.dir);
  if (ctx.json) return jsonResponse({ ok: true, applied: true, file: next.name });
  const notice = h(Note, null, `Wrote ${next.name}.`);
  if (ctx.fragment) return editorResponse(ctx, next, { notice });
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
  const notice = h(Note, { role: "alert" }, error.message);
  return editorResponse(ctx, state, { notice, feedback }, 422);
}

/** The preview (or the writer's refusal) for one planned section write. */
function sectionPreview(ctx: UiContext, state: ConfigState, plan: Plan): Response {
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
  const spec = section.spec as WidgetSpec;
  const fields = [
    hidden("section", section.key),
    ...encode(spec, plan.posted).map((entry) => hidden(entry.name, entry.value)),
    ...(plan.request ? [hidden(OP_FIELD, postedField(ctx, OP_FIELD))] : []),
  ];
  const body = h(EditableField, {
    ctx,
    base: state.base,
    section: { ...section, present: true },
    spec,
    feedback: { key: section.key, value: plan.next, errors: {} },
  });
  const pending: Pending = {
    title: `Config · ${section.key}`,
    action: sectionAction(section.key),
    base: state.base,
    fields,
    diff: result.ok ? result.diff : (result.diff ?? ""),
    notes: previewNotes(result),
    ok: result.ok && result.diff !== "",
    body,
  };
  return previewResponse(ctx, pending, result.ok ? 200 : 422);
}

/** What a section preview says above its diff: nothing, "no change", or the writer's refusal. */
function previewNotes(result: EditResult): VNode | undefined {
  if (result.ok) return result.diff ? undefined : h(NoChange, null);
  return h(
    Fragment,
    null,
    h(Note, { role: "alert" }, result.reason),
    h(Out, null, result.snippet),
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
  if (!plan.result.ok || plan.result.diff === "") return sectionPreview(ctx, state, plan);
  if (!confirmed(ctx)) return sectionPreview(ctx, state, plan);
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
  return previewResponse(ctx, {
    title: `Config · ${state.name}`,
    action: "/config?raw=1",
    base: state.base,
    fields: [hidden("raw", source)],
    diff,
    ok: diff !== "",
    notes: diff === "" ? h(NoChange, null) : undefined,
  });
}

/** Create the config file the project does not have yet. */
async function writeCreate(ctx: UiContext, state: ConfigState): Promise<Response> {
  if (state.exists) return refuse(ctx, state, `${state.name} already exists`, 400);
  const diff = createUnifiedDiff("", EMPTY_CONFIG, state.name);
  if (confirmed(ctx)) return await write(ctx, state, EMPTY_CONFIG, "raw-file");
  if (ctx.json) return jsonResponse({ ok: true, applied: false, diff });
  return previewResponse(ctx, {
    title: `Create ${state.name}`,
    action: "/config?create=1",
    base: state.base,
    fields: [],
    diff,
    ok: true,
  });
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
  if (!await baseMatches(ctx, state)) {
    return refuse(
      ctx,
      state,
      `${state.name} changed on disk since this form was rendered — nothing was written. ` +
        "Review the current file below and re-apply your change.",
      409,
    );
  }
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
    return editorResponse(ctx, state);
  }
  return await mutate(ctx, state);
};
