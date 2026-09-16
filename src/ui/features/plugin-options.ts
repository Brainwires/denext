// `/plugins/options?name=<catalog name>` — one wired first-party plugin's options, edited through
// the same schema-driven widgets as `/config`, over the options schema the catalog publishes for
// it (`src/plugin/catalog.json` → `optionsSchema`).
//
// The plugin's call in `denext.config.ts` is read with `readCallArguments` and written with
// `setCallArguments` (`src/build/call-args-edit.ts`): pure string surgery over the swc AST, so
// the config is never evaluated and every byte an edit does not touch — comments included — stays.
// An option whose value is code (a callback, a variable) is shown read-only and never written, as
// is any schema field a form cannot round-trip (`{}`, a function-wrapped list); a call shape the
// writer cannot own (spread arguments, a variable) is an honest refusal with the offending source.
//
// Every write is two steps: the first POST decodes the form, diffs it against the file's values
// and answers with the unified diff plus a confirm form carrying the exact option writes; the
// second POST (`confirm=1`) re-reads the file, re-applies those writes and writes only when they
// still apply. Both carry `_base`, a SHA-256 of the source the form was rendered from, so an edit
// made elsewhere in the meantime is a `409` rather than a lost update.

import { normalizeSpec } from "../../build/plugin-install.ts";
import { publishedOptionsSchema } from "./third-party-options.ts";
import { jsrClient } from "./plugin-search.ts";
import { isJsrSpec, jsrAvailable } from "../jsr.ts";
import { encodeHex } from "@std/encoding/hex";
import {
  type CallArgSet,
  type CallArgsRead,
  type CallTarget,
  readCallArguments,
  setCallArguments,
} from "../../build/call-args-edit.ts";
import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeChildren } from "../../jsx/types.ts";
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
import { jsonResponse, panelResponder, type UiContext, type UiHandler } from "../html.ts";
import { Raw, renderView } from "../view.ts";
import { broadcast } from "../events.ts";
import { StaleWriteError, writeFileAtomic } from "../security.ts";
import { renderWidget } from "../form/render.ts";
import { resolveAt, type SchemaNode } from "../form/schema.ts";
import { widgetFor, type WidgetSpec } from "../form/widget.ts";
import {
  applyListOp,
  decode,
  type FormEntry,
  FormValueError,
  type ListOpRequest,
  OP_FIELD,
  parseFieldName,
  parseOp,
} from "../form/value.ts";
import {
  CATALOG_ROWS,
  type CatalogRow,
  confirmed,
  optionsHref,
  postedField,
  type ProjectState,
  readProject,
  wiredAs,
} from "./plugins.ts";

/** Every option field's name prefix — keeps options apart from the panel's own fields. */
const PREFIX = "o.";

/** The optimistic-concurrency stamp every form carries (see the header comment). */
const BASE_FIELD = "_base";

/** The confirm form's hidden field: the option writes, as JSON. */
const SETS_FIELD = "sets";

/** A plain object value. */
type Bag = Record<string, unknown>;

/** A successful {@linkcode readCallArguments} result. */
type Reading = Extract<CallArgsRead, { ok: true }>;

/** A refusal from the reader or the writer. */
interface Failure {
  /** Why nothing can be written. */
  readonly reason: string;
  /** The offending source, when there is one. */
  readonly snippet?: string;
}

/** The wired plugin whose options this request edits. */
interface OptionsTarget {
  /** The catalogue row. */
  readonly entry: CatalogRow;
  /** Its published options schema. */
  readonly schema: SchemaNode;
  /** The call to read and write: the local identifier the config calls it by. */
  readonly call: CallTarget;
  /** The config file's name. */
  readonly configName: string;
  /** Its source. */
  readonly source: string;
  /** The SHA-256 of that source (the `_base` stamp). */
  readonly base: string;
}

/** A value an options form re-renders with: the draft, its field errors, a notice. */
interface Draft {
  /** The options to show. */
  readonly value: Bag;
  /** Messages against fields, keyed by field name. */
  readonly errors?: Readonly<Record<string, string>>;
  /** A message above the form. */
  readonly notice?: VNodeChild;
}

// ── locating the plugin ──────────────────────────────────────────────────────

/** The `_base` stamp of a source: its SHA-256, hex. */
async function stamp(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(source);
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** Where a request's plugin is, or why it has no options form (with the status to answer). */
type Located = { ok: true; target: OptionsTarget } | { ok: false; reason: string; status: number };

/** A refusal to locate. */
function missing(reason: string, status = 404): Located {
  return { ok: false, reason, status };
}

/** The refusal for a plugin that is not in the `plugins` array. */
function notWired(state: ProjectState, name: string): Located {
  return missing(
    `${name} is not wired into ${state.configName} — add it on the Plugins panel first`,
  );
}

/** The target over `schema`, calling the plugin by `callee` in `source`. */
async function targetFor(
  state: ProjectState,
  source: string,
  entry: CatalogRow,
  schema: SchemaNode,
  callee: string,
): Promise<Located> {
  const call = { arrayKey: "plugins" as const, callee };
  const base = await stamp(source);
  return { ok: true, target: { entry, schema, call, configName: state.configName, source, base } };
}

/**
 * The target for `name`: a catalogued plugin with an options schema, or a wired JSR plugin that
 * publishes one (`denext.catalog.optionsSchema`), called by whatever identifier the `plugins`
 * array uses — or why there is none.
 */
async function locate(ctx: UiContext, state: ProjectState, name: string): Promise<Located> {
  const entry = CATALOG_ROWS.find((row) => row.name === name);
  if (entry === undefined && isJsrSpec(name)) return await publishedTarget(ctx, state, name);
  if (!entry?.optionsSchema) {
    const shown = JSON.stringify(name.slice(0, 80));
    return missing(`no options schema for ${shown} — no catalogued plugin has that name`);
  }
  const wired = wiredAs(state, entry);
  if (!wired || state.source === null) return notWired(state, entry.name);
  return await targetFor(state, state.source, entry, entry.optionsSchema, wired.factory);
}

/** A wired JSR plugin the catalog doesn't know, over the options schema it publishes. */
async function publishedTarget(
  ctx: UiContext,
  state: ProjectState,
  spec: string,
): Promise<Located> {
  const wired = state.wired.find((plugin) =>
    plugin.importSpec !== null && normalizeSpec(plugin.importSpec) === spec
  );
  if (!wired || state.source === null) return notWired(state, spec);
  if (!await jsrAvailable(ctx, "registry")) {
    return missing(
      `${spec} publishes its options schema on jsr.io, which this UI cannot reach (--offline, ` +
        "or no net permission for jsr.io)",
      503,
    );
  }
  const published = await publishedOptionsSchema(ctx.dir, spec, jsrClient(), {
    signal: ctx.signal,
  });
  if (!published.ok) return missing(published.reason);
  const entry: CatalogRow = {
    name: spec,
    version: published.version,
    spec: `jsr:${spec}@^${published.version}`,
    kind: "plugin",
    factory: wired.imported,
    blurb: "",
  };
  return await targetFor(state, state.source, entry, published.schema, wired.factory);
}

/** Wired plugins imported from a JSR package the catalog doesn't know — each may publish a schema. */
function publishedCandidates(state: ProjectState): string[] {
  const specs = state.wired
    .map((plugin) => plugin.importSpec === null ? "" : normalizeSpec(plugin.importSpec))
    .filter((spec) => isJsrSpec(spec) && !CATALOG_ROWS.some((row) => row.name === spec));
  return [...new Set(specs)];
}

/** The wired JSR plugins the catalog doesn't know: each form comes from the schema it publishes. */
function PublishedList({ specs }: { readonly specs: readonly string[] }): VNode {
  if (specs.length === 0) return h(Fragment, null);
  return h(
    Fragment,
    null,
    h("h2", null, "Third-party"),
    h(
      "p",
      { class: "lead" },
      "Wired JSR plugins. A package that publishes ",
      h("code", null, "denext.catalog.optionsSchema"),
      " gets a form built from it, read from jsr.io.",
    ),
    h(
      "ul",
      null,
      specs.map((spec) => h("li", { key: spec }, h("a", { href: optionsHref(spec) }, spec))),
    ),
  );
}

// ── the form over the schema ─────────────────────────────────────────────────

/** The option key a widget edits (its last path segment). */
function keyOf(spec: WidgetSpec): string {
  return spec.path[spec.path.length - 1] ?? "";
}

/** Whether a widget, or anything under it, edits code or data the form cannot round-trip. */
function hasCode(spec: WidgetSpec): boolean {
  if (spec.kind === "code" || spec.schema["x-denext"]?.wrapper === "function") return true;
  const nested = [
    ...(spec.children ?? []),
    ...(spec.branches ?? []).map((branch) => branch.spec),
    ...(spec.items ? [spec.items] : []),
  ];
  return nested.some(hasCode);
}

/** A widget with every subtree that holds code turned into one read-only cell (groups recurse). */
function seal(spec: WidgetSpec): WidgetSpec {
  if (spec.kind === "group") return { ...spec, children: (spec.children ?? []).map(seal) };
  return hasCode(spec) ? { ...spec, kind: "code" } : spec;
}

/** The form over a plugin's options: the schema's properties, minus the code-valued ones. */
function formSpec(schema: SchemaNode, codeKeys: readonly string[]): WidgetSpec {
  const root = seal(widgetFor(schema, [], false));
  const children = (root.children ?? []).filter((child) => !codeKeys.includes(keyOf(child)));
  return { ...root, label: "options", children };
}

// ── from a posted form to option writes ──────────────────────────────────────

/** Whether `value` is a plain object. */
function isBag(value: unknown): value is Bag {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep equality over decoded data, where a key holding `undefined` counts as absent. */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => same(item, b[index]));
  }
  if (isBag(a) && isBag(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) =>
      same(a[key], b[key])
    );
  }
  return a === b;
}

/**
 * Whether `after` is what an untouched control posts over an option the file does not set — an
 * unticked toggle (`false`) or an empty list or map. Those stay absent rather than being written.
 */
function untouched(before: unknown, after: unknown): boolean {
  if (before !== undefined) return false;
  if (after === false) return true;
  return Array.isArray(after)
    ? after.length === 0
    : isBag(after) && Object.keys(after).length === 0;
}

/** Whether every key `value` holds is a data field of the group — so deleting it loses nothing. */
function ownsAll(spec: WidgetSpec, value: Bag): boolean {
  const fields = spec.children ?? [];
  return Object.keys(value).every((key) =>
    fields.some((child) => keyOf(child) === key && !hasCode(child))
  );
}

/**
 * The writes one group needs: per field (so values the form does not show — unknown keys, code —
 * are never touched), or one delete of the whole object when every field was cleared and the form
 * showed everything the object held.
 */
function groupSets(spec: WidgetSpec, before: Bag, after: unknown): CallArgSet[] {
  const next = isBag(after) ? after : {};
  const sets = (spec.children ?? []).flatMap((child) =>
    setsFor(child, before[keyOf(child)], next[keyOf(child)])
  );
  const whole = spec.path.length > 0 && !isBag(after) && ownsAll(spec, before);
  return whole ? [{ path: [...spec.path], value: undefined }] : sets;
}

/**
 * The option writes that turn `before` (the file) into `after` (the form), driven by the widget
 * tree: a read-only cell is never written, a group recurses, anything else is set (or, cleared,
 * deleted) as a whole.
 */
function setsFor(spec: WidgetSpec, before: unknown, after: unknown): CallArgSet[] {
  if (spec.kind === "code") return [];
  if (spec.kind === "group" && isBag(before)) return groupSets(spec, before, after);
  if (untouched(before, after) || same(before, after)) return [];
  return [{ path: [...spec.path], value: after }];
}

/** The posted option fields (the prefixed ones). */
function optionEntries(form: FormData): FormEntry[] {
  return [...form].flatMap(([name, value]) =>
    typeof value === "string" && name.startsWith(PREFIX) ? [{ name, value }] : []
  );
}

/** Decode a posted options form through its widgets, or the field error it carried. */
function decodeForm(
  form: FormData,
  spec: WidgetSpec,
): { value: Bag } | { error: { field: string; message: string } } {
  try {
    const value = decode(spec, optionEntries(form), PREFIX);
    return { value: isBag(value) ? value : {} };
  } catch (error) {
    if (!(error instanceof FormValueError)) throw error;
    return { error: { field: error.field, message: error.message } };
  }
}

/** The draft with every read-only cell's value taken from the file (disabled cells post nothing). */
function keepCode(spec: WidgetSpec, values: Bag, draft: Bag): Bag {
  const out = { ...draft };
  for (const child of spec.children ?? []) {
    if (child.kind === "code" && values[keyOf(child)] !== undefined) {
      out[keyOf(child)] = values[keyOf(child)];
    }
  }
  return out;
}

/** The element `+ Add` inserts into a list whose rows are `row`. */
function blankFor(row: WidgetSpec | undefined): unknown {
  switch (row?.kind) {
    case "group":
    case "list-of-forms":
    case "map":
      return {};
    case "number":
      return 0;
    case "toggle":
      return false;
    case undefined:
      return null;
    default:
      return "";
  }
}

/** One row operation applied to a list (or, as `[key, value]` rows, to a map). */
function rowOp(list: WidgetSpec, current: unknown, request: ListOpRequest): unknown {
  if (list.kind !== "map") {
    const rows = Array.isArray(current) ? current : [];
    return applyListOp(rows, request.op, request.at, blankFor(list.items));
  }
  const pairs = Object.entries(isBag(current) ? current : {});
  return Object.fromEntries(
    applyListOp<[string, unknown]>(pairs, request.op, request.at, ["", {}]),
  );
}

/**
 * Apply a row button (`+ Add`, `↑`, `↓`, `✕`) to the draft: the button names its list by field
 * name, which is resolved against the schema — an unknown name leaves the draft as it was.
 */
function withRowOp(schema: SchemaNode, draft: Bag, request: ListOpRequest): Bag {
  if (!request.list.startsWith(PREFIX)) return draft;
  const path = parseFieldName(request.list.slice(PREFIX.length));
  let list: WidgetSpec;
  try {
    list = widgetFor(resolveAt(schema, path), path, false);
  } catch {
    return draft;
  }
  const copy = structuredClone(draft);
  let holder: Bag = copy;
  for (const key of path.slice(0, -1)) {
    if (typeof holder[key] !== "object" || holder[key] === null) holder[key] = {};
    holder = holder[key] as Bag;
  }
  const last = path[path.length - 1] ?? "";
  holder[last] = rowOp(list, holder[last], request);
  return copy;
}

// ── the confirm form's carried writes ────────────────────────────────────────

/** The option writes as the confirm form carries them (a delete is a set with no `value`). */
function encodeSets(sets: readonly CallArgSet[]): string {
  return JSON.stringify(
    sets.map(({ path, value }) => value === undefined ? { path } : { path, value }),
  );
}

/** Whether `item` is one carried write to an option the form edits. */
function isCarriedSet(
  item: unknown,
  spec: WidgetSpec,
): item is { path: string[]; value?: unknown } {
  if (!isBag(item)) return false;
  const path = item.path;
  if (!Array.isArray(path) || path.length === 0) return false;
  if (!path.every((segment) => typeof segment === "string")) return false;
  return (spec.children ?? []).some((child) => keyOf(child) === path[0] && child.kind !== "code");
}

/** A JSON text, parsed — or `null` when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The option writes the request carries — the confirm form's `sets` field, or a JSON body's
 * `sets` array: `undefined` when it carries none, `null` when they are malformed or name an
 * option the form does not edit (a code-valued one, or one the schema does not declare).
 */
function carriedSets(ctx: UiContext, spec: WidgetSpec): CallArgSet[] | null | undefined {
  const posted = ctx.form ? ctx.form.get(SETS_FIELD) : (ctx.body as Bag | undefined)?.[SETS_FIELD];
  if (posted === undefined || posted === null) return undefined;
  const list = typeof posted === "string" ? parseJson(posted) : posted;
  if (!Array.isArray(list) || !list.every((item) => isCarriedSet(item, spec))) return null;
  return list.map((item) => ({ path: item.path, value: item.value }));
}

// ── the views ────────────────────────────────────────────────────────────────

/** Wrap a panel section as a fragment (the `ui.js` swap) or as the full document. */
const panelResponse = panelResponder("Plugins", "/plugins");

/** Render a view as the panel response. */
function page(ctx: UiContext, view: VNode, status = 200): Response {
  return panelResponse(ctx, renderView(view), status);
}

/** The frame every view of this panel shares: the section, its heading, the way back. */
function Frame({ title, children }: { readonly title: string; readonly children?: VNodeChildren }) {
  return h(
    Panel,
    { name: "Plugins", title },
    children,
    h("p", null, h("a", { href: "/plugins" }, "Back to the plugins")),
  );
}

/** The heading of a plugin's views. */
function titleOf(target: OptionsTarget): string {
  return `Options · ${target.entry.name}`;
}

/** Every catalogued plugin with an options schema, linked when it is wired. */
function IndexView({ state }: { readonly state: ProjectState }): VNode {
  const rows = CATALOG_ROWS.filter((entry) => entry.optionsSchema !== undefined);
  return h(
    Frame,
    { title: "Plugin options" },
    h(
      "p",
      { class: "lead" },
      "Each wired first-party plugin's options, edited through widgets derived from the options ",
      "schema it publishes. Wire a plugin on the Plugins panel to edit it here.",
    ),
    h(
      "ul",
      null,
      rows.map((entry) =>
        h(
          "li",
          { key: entry.name },
          wiredAs(state, entry)
            ? h("a", { href: optionsHref(entry.name) }, entry.name)
            : h(Fragment, null, entry.name, " ", h("span", { class: "badge" }, "not wired")),
        )
      ),
    ),
    h(PublishedList, { specs: publishedCandidates(state) }),
  );
}

/** The options the form cannot own: each one's source, read-only. */
function CodeOptions({ reading }: { readonly reading: Reading }): VNode {
  return h(
    Fragment,
    null,
    h("h2", null, "Code-valued options"),
    h(
      "p",
      { class: "lead" },
      "These are code, not data, so this panel never rewrites them — change them in your editor.",
    ),
    reading.codeKeys.map((key) =>
      h(
        Fragment,
        { key },
        h("h3", null, h("code", null, key), " ", h("span", { class: "badge" }, "read-only")),
        h(Out, null, reading.codeText[key] ?? ""),
      )
    ),
  );
}

/** The options form: the widget tree, the stamp, and Preview. */
function OptionsView(
  { ctx, target, reading, draft }: {
    readonly ctx: UiContext;
    readonly target: OptionsTarget;
    readonly reading: Reading;
    readonly draft: Draft;
  },
): VNode {
  const spec = formSpec(target.schema, reading.codeKeys);
  const form = renderWidget(spec, draft.value, {
    csrf: ctx.csrf,
    namePrefix: PREFIX,
    readOnly: ctx.readOnly,
    errors: draft.errors,
  });
  return h(
    Frame,
    { title: titleOf(target) },
    h(
      "p",
      { class: "lead" },
      "The options ",
      h("code", null, `${target.call.callee}(…)`),
      " is called with in ",
      h(Mono, null, target.configName),
      ", rendered from the plugin's options schema. A change is previewed as a diff before ",
      "anything is written.",
    ),
    ctx.readOnly ? h(Note, null, "Read-only mode — every change is refused.") : null,
    draft.notice ?? null,
    h(
      "form",
      // Dirty-tracked: Preview is inert until an option actually changes, so it cannot preview a
      // diff of nothing. `ui.js` finds the unnamed submit; with JavaScript off the button simply
      // works, which is why the server never renders it disabled.
      { method: "post", action: optionsHref(target.entry.name), "data-dirty-track": "1" },
      h(Raw, { html: form }),
      h(Hidden, { name: BASE_FIELD, value: target.base }),
      h("button", { type: "submit", disabled: ctx.readOnly }, "Preview"),
    ),
    reading.codeKeys.length > 0 ? h(CodeOptions, { reading }) : null,
  );
}

/** A call (or an edit) the writer cannot own: the reason, the source, and nothing written. */
function BailView(
  { target, failure }: { readonly target: OptionsTarget; readonly failure: Failure },
): VNode {
  return h(
    Frame,
    { title: titleOf(target) },
    h(Note, null, failure.reason),
    failure.snippet ? h(Out, null, failure.snippet) : null,
    h(
      "p",
      { class: "lead" },
      "Nothing was written. Pass the plugin one object literal — ",
      h("code", null, `${target.call.callee}({ … })`),
      " — to edit its options here, or edit ",
      h(Mono, null, target.configName),
      " by hand.",
    ),
  );
}

/** The preview: the diff, and the confirm form carrying exactly these writes. */
function PreviewView(
  { ctx, target, sets, diff }: {
    readonly ctx: UiContext;
    readonly target: OptionsTarget;
    readonly sets: readonly CallArgSet[];
    readonly diff: string;
  },
): VNode {
  return h(
    Frame,
    { title: titleOf(target) },
    h(PreviewLead, null),
    diff ? h(DiffBlock, { diff }) : h(NoChange, null),
    diff
      ? h(OpForm, {
        csrf: ctx.csrf,
        action: optionsHref(target.entry.name),
        label: "Apply",
        fields: { [SETS_FIELD]: encodeSets(sets), [BASE_FIELD]: target.base, confirm: "1" },
        disabled: ctx.readOnly,
      })
      : null,
  );
}

// ── responses ────────────────────────────────────────────────────────────────

/** A refusal, in whichever shape the caller asked for. */
function refuse(ctx: UiContext, title: string, reason: string, status: number): Response {
  if (ctx.json) return jsonResponse({ ok: false, reason }, status);
  return page(ctx, h(Frame, { title }, h(Note, null, reason)), status);
}

/** The reader's or the writer's refusal: the reason and the offending source, as a `422`. */
function bailed(ctx: UiContext, target: OptionsTarget, failure: Failure): Response {
  if (ctx.json) {
    return jsonResponse(
      { ok: false, applied: false, reason: failure.reason, snippet: failure.snippet ?? "" },
      422,
    );
  }
  return page(ctx, h(BailView, { target, failure }), 422);
}

/** The options form (or its JSON twin). */
function show(
  ctx: UiContext,
  target: OptionsTarget,
  reading: Reading,
  draft: Draft = { value: reading.values },
  status = 200,
): Response {
  if (ctx.json) {
    return jsonResponse({
      ok: true,
      name: target.entry.name,
      callee: target.call.callee,
      values: reading.values,
      codeKeys: reading.codeKeys,
      schema: target.schema,
    });
  }
  return page(ctx, h(OptionsView, { ctx, target, reading, draft }), status);
}

/** The decoded options of a source's call (`{}` when it no longer reads). */
async function valuesOf(source: string, call: CallTarget): Promise<Bag> {
  const reading = await readCallArguments(source, call);
  return reading.ok ? reading.values : {};
}

/** The first POST's answer: the diff and the confirm form (nothing written). */
async function previewed(
  ctx: UiContext,
  target: OptionsTarget,
  sets: readonly CallArgSet[],
  edit: { source: string; diff: string },
): Promise<Response> {
  if (ctx.json) {
    const values = await valuesOf(edit.source, target.call);
    return jsonResponse({ ok: true, applied: false, diff: edit.diff, values });
  }
  return page(ctx, h(PreviewView, { ctx, target, sets, diff: edit.diff }));
}

/**
 * The confirmed write — contained and atomic (`writeFileAtomic`: never through a symlink that
 * leaves the project, `.tmp` + rename) — then the refreshed form, or a `303` for no-JS.
 */
async function write(
  ctx: UiContext,
  target: OptionsTarget,
  edit: { source: string; diff: string },
): Promise<Response> {
  try {
    await writeFileAtomic(ctx.dir, target.configName, edit.source, {
      unchangedFrom: target.source,
    });
  } catch (error) {
    if (error instanceof StaleWriteError) {
      const reason = `${target.configName} changed on disk while this change was being ` +
        "applied — nothing was written. Reload the options and re-apply your change.";
      return refuse(ctx, titleOf(target), reason, 409);
    }
    const why = error instanceof Error ? error.message : String(error);
    return refuse(ctx, titleOf(target), `${target.configName} could not be written: ${why}`, 403);
  }
  broadcast(ctx.events, { type: "plugins-changed", name: target.entry.name });
  const reading = await readCallArguments(edit.source, target.call);
  const values = reading.ok ? reading.values : {};
  if (ctx.json) return jsonResponse({ ok: true, applied: true, diff: edit.diff, values });
  const location = optionsHref(target.entry.name);
  if (!ctx.fragment || !reading.ok) {
    return new Response(null, { status: 303, headers: { location } });
  }
  const next = { ...target, source: edit.source, base: await stamp(edit.source) };
  const notice = h(Note, null, `Wrote ${target.configName}.`);
  return show(ctx, next, reading, { value: values, notice });
}

// ── the handler ──────────────────────────────────────────────────────────────

/** What a POST proposes: option writes, or the response that answers it instead. */
type Proposal = { readonly sets: CallArgSet[] } | { readonly response: Response };

/**
 * Turn a POST into option writes: the carried `sets` (the confirm form, or a JSON client), else
 * the decoded form — whose row buttons re-render the draft instead, and whose bad values re-render
 * it with the message against the field (`422`).
 */
function propose(ctx: UiContext, target: OptionsTarget, reading: Reading): Proposal {
  const spec = formSpec(target.schema, reading.codeKeys);
  const carried = carriedSets(ctx, spec);
  if (carried === null) {
    const reason =
      "malformed `sets`: each write needs a non-empty `path` naming an editable option";
    return { response: refuse(ctx, titleOf(target), reason, 400) };
  }
  if (carried !== undefined) return { sets: carried };
  if (!ctx.form) {
    const reason = "post the option writes as `sets: [{ path, value }]`";
    return { response: refuse(ctx, titleOf(target), reason, 400) };
  }
  const decoded = decodeForm(ctx.form, spec);
  if ("error" in decoded) {
    const errors = { [decoded.error.field]: decoded.error.message };
    return { response: show(ctx, target, reading, { value: reading.values, errors }, 422) };
  }
  const request = parseOp(postedField(ctx, OP_FIELD));
  if (request) {
    const value = keepCode(spec, reading.values, withRowOp(target.schema, decoded.value, request));
    return { response: show(ctx, target, reading, { value }) };
  }
  return { sets: setsFor(spec, reading.values, decoded.value) };
}

/** A POST: check the stamp, compute the edit, then preview it or apply it. */
async function submit(ctx: UiContext, target: OptionsTarget, reading: Reading): Promise<Response> {
  if (ctx.readOnly) return refuse(ctx, titleOf(target), "read-only", 403);
  const posted = postedField(ctx, BASE_FIELD);
  if (posted !== "" && posted !== target.base) {
    const reason = `${target.configName} changed on disk since this form was rendered — ` +
      "nothing was written. Reload the options and re-apply your change.";
    return refuse(ctx, titleOf(target), reason, 409);
  }
  const proposal = propose(ctx, target, reading);
  if ("response" in proposal) return proposal.response;
  const edit = await setCallArguments(target.source, target.call, proposal.sets);
  if (!edit.ok) return bailed(ctx, target, edit);
  if (!confirmed(ctx) || edit.diff === "") return await previewed(ctx, target, proposal.sets, edit);
  return await write(ctx, target, edit);
}

/** The index: every catalogued plugin with options, and whether it is wired. */
function index(ctx: UiContext, state: ProjectState): Response {
  if (!ctx.json) return page(ctx, h(IndexView, { state }));
  const plugins = CATALOG_ROWS.filter((entry) => entry.optionsSchema !== undefined).map((
    entry,
  ) => ({
    name: entry.name,
    wired: wiredAs(state, entry) !== undefined,
    href: optionsHref(entry.name),
  }));
  const published = publishedCandidates(state).map((name) => ({
    name,
    wired: true,
    href: optionsHref(name),
    published: true,
  }));
  return jsonResponse({ ok: true, plugins: [...plugins, ...published] });
}

/** Whether the request only reads. */
function isRead(ctx: UiContext): boolean {
  return ctx.method === "GET" || ctx.method === "HEAD";
}

/**
 * Serve a plugin's options sub-panel: the index of editable plugins without `?name=`, the options
 * form on `GET`, a diff preview on the first `POST`, and the write on a `POST` carrying
 * `confirm=1`. A plugin that is not catalogued with an options schema, or not wired into the
 * config, is a `404`; a call the writer cannot own is a `422` with the reason.
 *
 * @param _request The incoming request (unused: `ctx` carries the decoded body).
 * @param ctx The kernel's request context (already past the origin, CSRF and read-only gates).
 * @returns The panel, its JSON twin, a preview, or a `303` back to the form.
 */
export const pluginOptionsPanel: UiHandler = async (
  _request: Request,
  ctx: UiContext,
): Promise<Response> => {
  const state = await readProject(ctx.dir);
  const name = ctx.url.searchParams.get("name") ?? "";
  if (name === "" && isRead(ctx)) return index(ctx, state);
  const located = await locate(ctx, state, name);
  if (!located.ok) return refuse(ctx, "Plugin options", located.reason, located.status);
  const { target } = located;
  const reading = await readCallArguments(target.source, target.call);
  if (!reading.ok) return bailed(ctx, target, reading);
  if (isRead(ctx)) return show(ctx, target, reading);
  return await submit(ctx, target, reading);
};
