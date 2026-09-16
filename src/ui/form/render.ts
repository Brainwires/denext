// The recursive half of the schema-driven form: walk a widget spec and render it through the one
// `Control` primitive — arrays recursing into a typed sub-form per row, unions into the
// selected branch, maps into key/value rows.
//
// Every widget kind is a component built with `h()`, and nested widgets compose as components
// (no string round-trips inside the renderer); `renderWidget` renders the tree once, at the
// boundary, back to the pre-escaped fragment its callers interpolate.
//
// Everything here is plain server-rendered HTML with real submit buttons, so the editor works
// with JavaScript disabled; `src/ui/client.ts` upgrades the same submits to a fragment swap. No
// inline `<script>`, no `on*` attribute — clean under the UI's `script-src 'self'`.

import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeChildren } from "../../jsx/types.ts";
import type { RawHtml } from "../html.ts";
import { UI_CSRF_FIELD } from "../security.ts";
import { renderView } from "../view.ts";
import { Control, Field, OpButton } from "./control.ts";
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

/** What every widget component is handed. */
type WidgetProps = {
  /** The widget. */
  readonly spec: WidgetSpec;
  /** The current value at its path. */
  readonly value: unknown;
  /** The render context. */
  readonly ctx: RenderContext;
};

/** One widget kind's component. */
type WidgetComponent = (props: WidgetProps) => VNode;

/** The inline layout of one radio or checkbox beside its label. */
const CHOICE_STYLE = "display:inline-flex;align-items:center;gap:4px;margin:0 12px 0 0";

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

/** Inline siblings separated by one space, as the whitespace between them used to render. */
function spaced(nodes: readonly VNode[]): VNodeChild[] {
  return nodes.flatMap((node, index) => index === 0 ? [node] : [" ", node]);
}

/** A control in its label, help and validation message. */
function Wrap(
  props: {
    readonly spec: WidgetSpec;
    readonly ctx: RenderContext;
    readonly badge?: string;
    readonly children?: VNodeChildren;
  },
): VNode {
  const { spec, ctx } = props;
  const name = nameOf(spec, ctx);
  return h(Field, {
    id: idOf(name),
    label: spec.label,
    help: spec.description,
    error: ctx.errors?.[name],
    badge: props.badge ?? (spec.required ? "required" : undefined),
  }, props.children);
}

/** One radio or checkbox beside its label (`for` only where the control carries an id). */
function Choice(
  props: { readonly for?: string; readonly label: string; readonly children?: VNodeChildren },
): VNode {
  return h("label", { for: props.for, style: CHOICE_STYLE }, props.children, props.label);
}

/** The hidden marker that tells `decode` a list or map was present in the form. */
function Marker(
  props: { readonly name: string; readonly length: number; readonly ctx: RenderContext },
): VNode {
  return h(Control, {
    tag: "input",
    type: "hidden",
    name: props.name + COUNT_SUFFIX,
    value: String(props.length),
    disabled: props.ctx.readOnly,
  });
}

/** `↑ ↓ ✕` for one row. */
function RowButtons(
  props: {
    readonly list: string;
    readonly at: number;
    readonly last: number;
    readonly ctx: RenderContext;
  },
): VNode {
  const { list, at } = props;
  const off = props.ctx.readOnly === true;
  return h(
    "span",
    { class: "op-group" },
    h(OpButton, { op: "up", at, list, label: "↑", title: "Move up", disabled: off || at === 0 }),
    h(OpButton, {
      op: "down",
      at,
      list,
      label: "↓",
      title: "Move down",
      disabled: off || at >= props.last,
    }),
    h(OpButton, { op: "remove", at, list, label: "✕", title: "Remove", disabled: off }),
  );
}

/** A scalar `<input>` / `<textarea>` widget. */
function scalar(tag: "input" | "textarea", type?: string): WidgetComponent {
  return ({ spec, value, ctx }) => {
    const name = nameOf(spec, ctx);
    return h(
      Wrap,
      { spec, ctx },
      h(Control, {
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

/** A one-line text input. */
const TextWidget = scalar("input");

/** A multi-line text area (`x-denext.widget: "textarea"`). */
const TextareaWidget = scalar("textarea");

/** A number input, carrying the schema's bounds. */
const NumberWidget = scalar("input", "number");

/** A checkbox with a hidden `off` companion, so "unchecked" posts a real `false`. */
function ToggleWidget({ spec, value, ctx }: WidgetProps): VNode {
  const name = nameOf(spec, ctx);
  const common = { tag: "input", name, disabled: ctx.readOnly } as const;
  return h(
    Wrap,
    { spec, ctx },
    h(Control, { ...common, type: "hidden", value: "off" }),
    h(Control, {
      ...common,
      type: "checkbox",
      id: idOf(name),
      value: "on",
      checked: value === true,
    }),
  );
}

/** Radios — one per allowed value — for a short closed set. */
function SegmentedWidget({ spec, value, ctx }: WidgetProps): VNode {
  const name = nameOf(spec, ctx);
  const current = text(value);
  const radios = (spec.options ?? []).map((option, index) => {
    const id = `${idOf(name)}-${index}`;
    return h(
      Choice,
      { key: index, for: id, label: option.label },
      h(Control, {
        tag: "input",
        type: "radio",
        name,
        id,
        value: option.value,
        checked: option.value === current,
        disabled: ctx.readOnly,
      }),
    );
  });
  return h(Wrap, { spec, ctx }, h("div", null, spaced(radios)));
}

/** A `<select>` for a closed set too long to sit on one line. */
function SelectWidget({ spec, value, ctx }: WidgetProps): VNode {
  const name = nameOf(spec, ctx);
  return h(
    Wrap,
    { spec, ctx },
    h(Control, {
      tag: "select",
      name,
      id: idOf(name),
      value: text(value),
      options: spec.options,
      disabled: ctx.readOnly,
    }),
  );
}

/** A checkbox group over an `enum`; the decoded order follows the schema's `enum`. */
function MultiSelectWidget({ spec, value, ctx }: WidgetProps): VNode {
  const name = nameOf(spec, ctx);
  const chosen = (Array.isArray(value) ? value : []).map(String);
  const boxes = (spec.options ?? []).map((option, index) =>
    h(
      Choice,
      { key: index, label: option.label },
      h(Control, {
        tag: "input",
        type: "checkbox",
        name: fieldName([...spec.path, String(index)], ctx.namePrefix ?? ""),
        value: option.value,
        checked: chosen.includes(option.value),
        disabled: ctx.readOnly,
      }),
    )
  );
  return h(
    Wrap,
    { spec, ctx },
    h("div", null, h(Marker, { name, length: chosen.length, ctx }), spaced(boxes)),
  );
}

/** Everything one row of a list, chip list or map is rendered from. */
type RowProps = {
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
};

/** The value of a list widget, as the rows it holds. */
type ToRows = (value: unknown) => readonly unknown[];

/** An array value (the default row source). */
const asArray: ToRows = (value) => Array.isArray(value) ? value : [];

/** A record value, as `[key, value]` rows. */
const asPairs: ToRows = (value) =>
  typeof value === "object" && value !== null ? Object.entries(value) : [];

/** A row's `↑ ↓ ✕` buttons. */
function rowButtonsOf(one: RowProps): VNode {
  return h(RowButtons, { list: one.name, at: one.index, last: one.last, ctx: one.ctx });
}

/**
 * Build a row-editor widget: the presence marker, the rows and `+ Add` are shared, and the
 * caller supplies only the component for one row.
 */
function listWidget(Row: (props: RowProps) => VNode, toRows: ToRows = asArray): WidgetComponent {
  return ({ spec, value, ctx }) => {
    const name = nameOf(spec, ctx);
    const list = toRows(value);
    const last = list.length - 1;
    const rows = list.map((entry, index) =>
      h(Row, { key: index, spec, row: rowSpec(spec, index), entry, index, last, ctx, name })
    );
    const add = h(OpButton, {
      op: "add",
      at: rows.length,
      list: name,
      label: "+ Add",
      title: "Add",
      disabled: ctx.readOnly,
    });
    return h(
      Wrap,
      { spec, ctx },
      h("div", null, h(Marker, { name, length: rows.length, ctx }), rows, add),
    );
  };
}

/** One reorderable one-line row of a list of scalars. */
function ChipRow(one: RowProps): VNode {
  return h(
    "div",
    { class: "row" },
    h(Control, {
      tag: "input",
      type: one.row.kind === "number" ? "number" : "text",
      name: fieldName(one.row.path, one.ctx.namePrefix ?? ""),
      value: text(one.entry),
      ariaLabel: `${one.spec.label} ${one.index + 1}`,
      disabled: one.ctx.readOnly,
    }),
    rowButtonsOf(one),
  );
}

/** One typed sub-form of a list of objects, with its own reorder and remove buttons. */
function FormRow(one: RowProps): VNode {
  return h(
    "fieldset",
    { class: "pad-box" },
    h("legend", null, one.row.label, " ", rowButtonsOf(one)),
    fieldsOf(one.row, one.entry, one.ctx),
  );
}

/** One key/value row of a record. */
function MapRow(one: RowProps): VNode {
  const [key, held] = one.entry as [string, unknown];
  return h(
    "div",
    { class: "row top" },
    h(Control, {
      tag: "input",
      name: fieldName(one.row.path, one.ctx.namePrefix ?? "") + KEY_SUFFIX,
      value: key,
      ariaLabel: `${one.spec.label} key ${one.index + 1}`,
      disabled: one.ctx.readOnly,
    }),
    h("span", { class: "grow" }, h(Widget, { spec: one.row, value: held, ctx: one.ctx })),
    rowButtonsOf(one),
  );
}

/** Reorderable one-line rows for a list of scalars. */
const ChipsWidget = listWidget(ChipRow);

/** A typed sub-form per row, each with its own reorder and remove buttons. */
const ListOfFormsWidget = listWidget(FormRow);

/** Key/value rows for a record. */
const MapWidget = listWidget(MapRow, asPairs);

/** A discriminator picker plus the selected alternative. */
function UnionWidget({ spec, value, ctx }: WidgetProps): VNode {
  const name = nameOf(spec, ctx) + BRANCH_SUFFIX;
  const { branch, index } = selectedBranch(spec, value);
  const picker = (spec.branches ?? []).map((entry, position) =>
    h(
      Choice,
      { key: position, label: entry.label },
      h(Control, {
        tag: "input",
        type: "radio",
        name,
        value: String(position),
        checked: position === index,
        disabled: ctx.readOnly,
      }),
    )
  );
  return h(
    Wrap,
    { spec, ctx },
    h("div", null, spaced(picker)),
    branch ? h(Widget, { spec: branch.spec, value, ctx }) : null,
  );
}

/** A collapsible group of fields. */
function GroupWidget({ spec, value, ctx }: WidgetProps): VNode {
  return h(
    "details",
    { open: true, id: `${idOf(nameOf(spec, ctx))}--group`, class: "field" },
    h("summary", { class: "group-summary" }, spec.label),
    spec.description ? h("p", { class: "lead group-note" }, spec.description) : null,
    h("div", { class: "group-body" }, fieldsOf(spec, value, ctx)),
  );
}

/** A value the editor will not own: shown, disabled, and left untouched on submit. */
function CodeCell({ spec, value, ctx }: WidgetProps): VNode {
  const name = nameOf(spec, ctx);
  return h(
    Wrap,
    { spec, ctx, badge: "read-only" },
    h(Control, {
      tag: "textarea",
      name,
      id: idOf(name),
      rows: 3,
      value: value === undefined ? "" : JSON.stringify(value, null, 2),
      disabled: true,
    }),
  );
}

/** The widget table — one component per widget kind. */
const WIDGETS: Record<WidgetKind, WidgetComponent> = {
  text: TextWidget,
  textarea: TextareaWidget,
  number: NumberWidget,
  toggle: ToggleWidget,
  select: SelectWidget,
  segmented: SegmentedWidget,
  "multi-select": MultiSelectWidget,
  chips: ChipsWidget,
  "list-of-forms": ListOfFormsWidget,
  map: MapWidget,
  union: UnionWidget,
  group: GroupWidget,
  code: CodeCell,
};

/** The value of one child of `value`, by the child's last path segment. */
function fieldOf(value: unknown, child: WidgetSpec): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const key = child.path[child.path.length - 1];
  return key === undefined ? undefined : (value as Record<string, unknown>)[key];
}

/** The widgets of a group's (or a form row's) children, each given its slice of `value`. */
function fieldsOf(spec: WidgetSpec, value: unknown, ctx: RenderContext): VNode[] {
  return (spec.children ?? []).map((child, index) =>
    h(Widget, { key: index, spec: child, value: fieldOf(value, child), ctx })
  );
}

/** One spec, dispatched to its kind's component (the recursive half, without the CSRF field). */
function Widget(props: WidgetProps): VNode {
  return h(WIDGETS[props.spec.kind], { spec: props.spec, value: props.value, ctx: props.ctx });
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
  const csrf = h(Control, {
    tag: "input",
    type: "hidden",
    name: UI_CSRF_FIELD,
    value: ctx.csrf,
    disabled: ctx.readOnly,
  });
  return renderView(h(Fragment, null, csrf, h(Widget, { spec, value, ctx })));
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
