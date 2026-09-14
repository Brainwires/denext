// The recursive half of the schema-driven form: walk a widget spec and render it through the one
// `control()` primitive — arrays recursing into a typed sub-form per row, unions into the
// selected branch, maps into key/value rows.
//
// Everything here is plain server-rendered HTML with real submit buttons, so the editor works
// with JavaScript disabled; `src/ui/client.ts` upgrades the same submits to a fragment swap. No
// inline `<script>`, no `on*` attribute — clean under the UI's `script-src 'self'`.

import { html, type RawHtml } from "../html.ts";
import { UI_CSRF_FIELD } from "../security.ts";
import { control, field, opButton } from "./control.ts";
import { resolveAt, type SchemaNode } from "./schema.ts";
import {
  BRANCH_SUFFIX,
  COUNT_SUFFIX,
  decode,
  fieldName,
  KEY_SUFFIX,
  parseFieldName,
  rowSpec,
} from "./value.ts";
import { selectedBranch, widgetFor, type WidgetKind, type WidgetSpec } from "./widget.ts";

/** What the renderer is told beyond the spec and the value. */
export interface RenderContext {
  /** The session CSRF token, emitted once per rendered field tree. */
  readonly csrf: string;
  /** A prefix shared by every field name (must match the one `decode` is given). */
  readonly namePrefix?: string;
  /** Render every control disabled (`denext ui --read-only`). */
  readonly readOnly?: boolean;
  /** Validation messages to show against fields, keyed by field name. */
  readonly errors?: Readonly<Record<string, string>>;
}

/** One widget's markup. */
type Renderer = (spec: WidgetSpec, value: unknown, ctx: RenderContext) => RawHtml;

/** The field name this spec posts under. */
function nameOf(spec: WidgetSpec, ctx: RenderContext): string {
  return fieldName(spec.path, ctx.namePrefix ?? "");
}

/** A field name as a DOM id (and therefore as a `#anchor` the editor can redirect back to). */
function idOf(name: string): string {
  return "f-" + name.replace(/[^A-Za-z0-9_-]+/g, "-");
}

/** A value as the string a control shows. */
function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** Wrap a control in its label, help and validation message. */
function wrap(spec: WidgetSpec, ctx: RenderContext, body: RawHtml, badge?: string): RawHtml {
  const name = nameOf(spec, ctx);
  return field({
    id: idOf(name),
    label: spec.label,
    help: spec.description,
    error: ctx.errors?.[name],
    badge: badge ?? (spec.required ? "required" : undefined),
    body,
  });
}

/** The hidden marker that tells `decode` a list or map was present in the form. */
function marker(name: string, length: number, ctx: RenderContext): RawHtml {
  return control({
    tag: "input",
    type: "hidden",
    name: name + COUNT_SUFFIX,
    value: String(length),
    disabled: ctx.readOnly,
  });
}

/** `↑ ↓ ✕` for one row. */
function rowButtons(list: string, at: number, last: number, ctx: RenderContext): RawHtml {
  const off = ctx.readOnly === true;
  return html`<span style="display:inline-flex;gap:4px">
    ${opButton({ op: "up", at, list, label: "↑", title: "Move up", disabled: off || at === 0 })}
    ${
    opButton({ op: "down", at, list, label: "↓", title: "Move down", disabled: off || at >= last })
  }
    ${opButton({ op: "remove", at, list, label: "✕", title: "Remove", disabled: off })}
  </span>`;
}

/** The `+ Add` button under a list or map. */
function addButton(list: string, at: number, ctx: RenderContext): RawHtml {
  return opButton({ op: "add", at, list, label: "+ Add", title: "Add", disabled: ctx.readOnly });
}

/** A scalar `<input>` / `<textarea>` widget. */
function scalar(tag: "input" | "textarea", type?: string): Renderer {
  return (spec, value, ctx) => {
    const name = nameOf(spec, ctx);
    return wrap(
      spec,
      ctx,
      control({
        tag,
        type,
        name,
        id: idOf(name),
        value: text(value),
        min: spec.min,
        max: spec.max,
        disabled: ctx.readOnly,
      }),
    );
  };
}

/** A checkbox with a hidden `off` companion, so "unchecked" posts a real `false`. */
const renderToggle: Renderer = (spec, value, ctx) => {
  const name = nameOf(spec, ctx);
  const common = { tag: "input", name, disabled: ctx.readOnly } as const;
  return wrap(
    spec,
    ctx,
    html`${control({ ...common, type: "hidden", value: "off" })}${
      control({ ...common, type: "checkbox", id: idOf(name), value: "on", checked: value === true })
    }`,
  );
};

/** Radios — one per allowed value — for a short closed set. */
const renderSegmented: Renderer = (spec, value, ctx) => {
  const name = nameOf(spec, ctx);
  const current = text(value);
  const radios = (spec.options ?? []).map((option, index) =>
    html`
      <label
        for="${idOf(name)}-${index}"
        style="display:inline-flex;align-items:center;gap:4px;margin:0 12px 0 0"
      >${control({
        tag: "input",
        type: "radio",
        name,
        id: `${idOf(name)}-${index}`,
        value: option.value,
        checked: option.value === current,
        disabled: ctx.readOnly,
      })}${option.label}</label>
    `
  );
  return wrap(spec, ctx, html`<div>${radios}</div>`);
};

/** A `<select>` for a closed set too long to sit on one line. */
const renderSelect: Renderer = (spec, value, ctx) => {
  const name = nameOf(spec, ctx);
  return wrap(
    spec,
    ctx,
    control({
      tag: "select",
      name,
      id: idOf(name),
      value: text(value),
      options: spec.options,
      disabled: ctx.readOnly,
    }),
  );
};

/** A checkbox group over an `enum`; the decoded order follows the schema's `enum`. */
const renderMultiSelect: Renderer = (spec, value, ctx) => {
  const name = nameOf(spec, ctx);
  const chosen = (Array.isArray(value) ? value : []).map(String);
  const boxes = (spec.options ?? []).map((option, index) =>
    html`
      <label
        style="display:inline-flex;align-items:center;gap:4px;margin:0 12px 0 0">${control({
          tag: "input",
          type: "checkbox",
          name: fieldName([...spec.path, String(index)], ctx.namePrefix ?? ""),
          value: option.value,
          checked: chosen.includes(option.value),
          disabled: ctx.readOnly,
        })}${option.label}</label>
    `
  );
  return wrap(spec, ctx, html`<div>${marker(name, chosen.length, ctx)}${boxes}</div>`);
};

/** Everything one row of a list, chip list or map is rendered from. */
interface RowContext {
  /** The list's own widget. */
  readonly spec: WidgetSpec;
  /** The widget for this row. */
  readonly row: WidgetSpec;
  /** The row's current value (a `[key, value]` pair for a map). */
  readonly entry: unknown;
  /** The row's index. */
  readonly index: number;
  /** The last index in the list (so the row knows it cannot move down). */
  readonly last: number;
  /** The render context. */
  readonly ctx: RenderContext;
  /** The list's field name, which the row's buttons act on. */
  readonly name: string;
}

/** The value of a list widget, as the rows it holds. */
type ToRows = (value: unknown) => readonly unknown[];

/** An array value (the default row source). */
const asArray: ToRows = (value) => Array.isArray(value) ? value : [];

/** A record value, as `[key, value]` rows. */
const asPairs: ToRows = (value) =>
  typeof value === "object" && value !== null ? Object.entries(value) : [];

/**
 * Build a row-editor renderer: the presence marker, the rows and `+ Add` are shared, and the
 * caller supplies only what one row looks like.
 */
function listRenderer(row: (context: RowContext) => RawHtml, toRows: ToRows = asArray): Renderer {
  return (spec, value, ctx) => {
    const name = nameOf(spec, ctx);
    const list = toRows(value);
    const rows = list.map((entry, index) =>
      row({ spec, row: rowSpec(spec, index), entry, index, last: list.length - 1, ctx, name })
    );
    const body = html`<div>${marker(name, rows.length, ctx)}${rows}${
      addButton(name, rows.length, ctx)
    }</div>`;
    return wrap(spec, ctx, body);
  };
}

/** Reorderable one-line rows for a list of scalars. */
const renderChips: Renderer = listRenderer((one) =>
  html`<div style="display:flex;gap:6px;align-items:center;margin:0 0 6px">${
    control({
      tag: "input",
      type: one.row.kind === "number" ? "number" : "text",
      name: fieldName(one.row.path, one.ctx.namePrefix ?? ""),
      value: text(one.entry),
      ariaLabel: `${one.spec.label} ${one.index + 1}`,
      disabled: one.ctx.readOnly,
    })
  }${rowButtons(one.name, one.index, one.last, one.ctx)}</div>`
);

/** A typed sub-form per row, each with its own reorder and remove buttons. */
const renderList: Renderer = listRenderer((one) =>
  html`
    <fieldset style="padding:10px 12px">
      <legend>${one.row.label} ${rowButtons(one.name, one.index, one.last, one.ctx)}</legend>
      ${(one.row.children ?? []).map((child) =>
        renderSpec(child, fieldOf(one.entry, child), one.ctx)
      )}
    </fieldset>
  `
);

/** Key/value rows for a record. */
const renderMap: Renderer = listRenderer((one) => {
  const [key, held] = one.entry as [string, unknown];
  return html`
    <div
      style="display:flex;gap:6px;align-items:flex-start;margin:0 0 6px">${control({
        tag: "input",
        name: fieldName(one.row.path, one.ctx.namePrefix ?? "") + KEY_SUFFIX,
        value: key,
        ariaLabel: `${one.spec.label} key ${one.index + 1}`,
        disabled: one.ctx.readOnly,
      })}<span style="flex:1">${renderSpec(one.row, held, one.ctx)}</span>${rowButtons(
        one.name,
        one.index,
        one.last,
        one.ctx,
      )}</div>
  `;
}, asPairs);

/** A discriminator picker plus the selected alternative. */
const renderUnion: Renderer = (spec, value, ctx) => {
  const name = nameOf(spec, ctx) + BRANCH_SUFFIX;
  const { branch, index } = selectedBranch(spec, value);
  const picker = (spec.branches ?? []).map((entry, position) =>
    html`
      <label
        style="display:inline-flex;align-items:center;gap:4px;margin:0 12px 0 0">${control({
          tag: "input",
          type: "radio",
          name,
          value: String(position),
          checked: position === index,
          disabled: ctx.readOnly,
        })}${entry.label}</label>
    `
  );
  const body = branch ? renderSpec(branch.spec, value, ctx) : html``;
  return wrap(spec, ctx, html`<div>${picker}</div>${body}`);
};

/** A collapsible group of fields. */
const renderGroup: Renderer = (spec, value, ctx) => {
  const children = (spec.children ?? []).map((child) =>
    renderSpec(child, fieldOf(value, child), ctx)
  );
  return html`
    <details open id="${idOf(nameOf(spec, ctx))}--group" style="margin:0 0 14px">
      <summary style="cursor:pointer;font-weight:600">${spec.label}</summary>
      ${spec.description
        ? html`<p class="lead" style="font-size:13px">${spec.description}</p>`
        : ""}
      <div style="padding:8px 0 0 12px">${children}</div>
    </details>
  `;
};

/** A value the editor will not own: shown, disabled, and left untouched on submit. */
const renderCode: Renderer = (spec, value, ctx) => {
  const name = nameOf(spec, ctx);
  return wrap(
    spec,
    ctx,
    control({
      tag: "textarea",
      name,
      id: idOf(name),
      rows: 3,
      value: value === undefined ? "" : JSON.stringify(value, null, 2),
      disabled: true,
    }),
    "read-only",
  );
};

/** The renderer table — one row per widget kind. */
const RENDERERS: Record<WidgetKind, Renderer> = {
  text: scalar("input"),
  textarea: scalar("textarea"),
  number: scalar("input", "number"),
  toggle: renderToggle,
  select: renderSelect,
  segmented: renderSegmented,
  "multi-select": renderMultiSelect,
  chips: renderChips,
  "list-of-forms": renderList,
  map: renderMap,
  union: renderUnion,
  group: renderGroup,
  code: renderCode,
};

/** The value of one child of `value`, by the child's last path segment. */
function fieldOf(value: unknown, child: WidgetSpec): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const key = child.path[child.path.length - 1];
  return key === undefined ? undefined : (value as Record<string, unknown>)[key];
}

/** Render one spec (the recursive half, without the CSRF field). */
function renderSpec(spec: WidgetSpec, value: unknown, ctx: RenderContext): RawHtml {
  return RENDERERS[spec.kind](spec, value, ctx);
}

/**
 * Render a widget and everything under it, with the CSRF field the row buttons need.
 *
 * @param spec The widget (from `widgetFor`).
 * @param value The current config value at that path.
 * @param ctx The CSRF token, the name prefix, read-only mode and any validation messages.
 * @returns The field markup.
 */
export function renderWidget(spec: WidgetSpec, value: unknown, ctx: RenderContext): RawHtml {
  const csrf = control({
    tag: "input",
    type: "hidden",
    name: UI_CSRF_FIELD,
    value: ctx.csrf,
    disabled: ctx.readOnly,
  });
  return html`${csrf}${renderSpec(spec, value, ctx)}`;
}

/**
 * Parse one posted field back into the config value it stands for — the single-field inverse of
 * {@linkcode renderWidget}, for callers that walk a `FormData` key by key.
 *
 * @param root The root config schema.
 * @param path The posted field name (`redirects[0].source`).
 * @param wire The posted string.
 * @returns The config value.
 */
export function readWidget(root: SchemaNode, path: string, wire: string): unknown {
  const segments = parseFieldName(path);
  const spec = widgetFor(resolveAt(root, segments), segments, false);
  return decode(spec, [{ name: path, value: wire }]);
}
