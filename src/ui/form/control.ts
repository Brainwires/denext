// The one input primitive every widget funnels through, plus the label/help/error wrapper and
// the row-operation button — in one place, so the form renderer stays a dispatch table rather
// than thirteen near-identical markup blocks, and so "every value is escaped" is one claim to
// audit rather than thirteen.
//
// Each piece is a component (`Control`, `Field`, `OpButton`) built with `h()` — the renderer in
// `render.ts` composes them directly, so a nested widget never round-trips through a string —
// and each has a string twin (`control`, `field`, `opButton`) that renders the component at the
// boundary for the panels that embed the form renderer through `Raw`. The string renderer escapes
// every text child and attribute value, and writes attributes in prop order, so the markup is
// stable however `deno fmt` wraps the source.
//
// Layout uses inline `style=` attributes where `src/ui/styles.ts` has no class: the UI's CSP
// sets `style-src-attr 'unsafe-inline'` for exactly this (it still forbids inline `<style>`).

import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../../jsx/types.ts";
import { Raw, type RawHtml, renderView } from "../view.ts";
import { OP_FIELD } from "./value.ts";
import type { WidgetOption } from "./widget.ts";

/** One `<input>`, `<select>` or `<textarea>`. */
export interface ControlAttrs {
  /** Which element to render. */
  readonly tag: "input" | "select" | "textarea";
  /** The form field name. */
  readonly name: string;
  /** The element id (so a `<label for>` can point at it). */
  readonly id?: string;
  /** `<input type>` (default `"text"`). */
  readonly type?: string;
  /** The current value (the selected option for a `<select>`). */
  readonly value?: string;
  /** The choices, for a `<select>`. */
  readonly options?: readonly WidgetOption[];
  /** Whether a checkbox or radio is checked. */
  readonly checked?: boolean;
  /** Render disabled (a read-only cell, or `--read-only`). */
  readonly disabled?: boolean;
  /** Inclusive lower bound of a number input. */
  readonly min?: number;
  /** Inclusive upper bound of a number input. */
  readonly max?: number;
  /** Visible rows of a `<textarea>` (default 4). */
  readonly rows?: number;
  /** Placeholder text. */
  readonly placeholder?: string;
  /** An accessible name, when no visible `<label>` points at the control. */
  readonly ariaLabel?: string;
}

/** The attributes every control shares, in the order they render (`undefined`/`false` drop). */
function commonProps(attrs: ControlAttrs) {
  return {
    name: attrs.name,
    id: attrs.id,
    "aria-label": attrs.ariaLabel,
    disabled: attrs.disabled ?? false,
  };
}

/**
 * A `<textarea>`: the value is its text content, passed as the child so it round-trips byte
 * for byte (the renderer escapes it; a browser decodes it back to the same characters).
 *
 * The content always opens with one newline: the HTML parser drops exactly one newline directly
 * after a `<textarea>` start tag, so without it a value that itself begins with a newline (a
 * config file opening on a blank line, an `spa.head` snippet) would lose it on every submit.
 * This is the one place a textarea is emitted — the raw config editor renders through it too.
 */
function textareaElement(attrs: ControlAttrs): VNode {
  return h(
    "textarea",
    {
      ...commonProps(attrs),
      rows: attrs.rows ?? 4,
      placeholder: attrs.placeholder,
      style: "width:100%",
    },
    "\n" + (attrs.value ?? ""),
  );
}

/**
 * A `<select>`. Each option states `selected` itself rather than the `<select>` carrying a
 * `value`, so an absent value selects the `""` option ("— unset —") exactly as it always has.
 */
function selectElement(attrs: ControlAttrs): VNode {
  const current = attrs.value ?? "";
  const options = (attrs.options ?? []).map((option, index) =>
    h(
      "option",
      { key: index, value: option.value, selected: option.value === current },
      option.label,
    )
  );
  return h("select", commonProps(attrs), options);
}

/** An `<input>` of any type. */
function inputElement(attrs: ControlAttrs): VNode {
  return h("input", {
    ...commonProps(attrs),
    type: attrs.type ?? "text",
    value: attrs.value ?? "",
    min: attrs.min,
    max: attrs.max,
    placeholder: attrs.placeholder,
    checked: attrs.checked ?? false,
  });
}

/** The element vocabulary: one builder per control tag. */
const ELEMENTS: Record<ControlAttrs["tag"], (attrs: ControlAttrs) => VNode> = {
  input: inputElement,
  select: selectElement,
  textarea: textareaElement,
};

/**
 * One control. Every widget in `render.ts` bottoms out here, so escaping, the disabled flag and
 * the element vocabulary are decided exactly once.
 *
 * @param attrs The control description.
 * @returns The control element.
 */
export function Control(attrs: ControlAttrs): VNode {
  return ELEMENTS[attrs.tag](attrs);
}

/**
 * Render one control. The string twin of {@linkcode Control}, for panels that embed it through
 * `Raw`.
 *
 * @param spec The control description.
 * @returns The control markup.
 */
export function control(spec: ControlAttrs): RawHtml {
  return renderView(h(Control, { ...spec }));
}

/** The label, help text and validation message around one control. */
export interface FieldOptions {
  /** The id of the control the label points at. */
  readonly id: string;
  /** The visible label. */
  readonly label: string;
  /** Help text (the schema's `description`). */
  readonly help?: string;
  /** A validation message to show against the field. */
  readonly error?: string;
  /** A short badge after the label (`"read-only"`, `"required"`). */
  readonly badge?: string;
  /** The control (or group of controls). */
  readonly body: RawHtml;
}

/** {@linkcode Field}'s props: {@linkcode FieldOptions} with the control as children. */
type FieldProps = Omit<FieldOptions, "body"> & { readonly children?: VNodeChildren };

/**
 * A control wrapped in its label, help text and validation message.
 *
 * @param props The field description; `children` is the control (or group of controls).
 * @returns The field element.
 */
export function Field(props: FieldProps): VNode {
  return h(
    "div",
    { style: "margin:0 0 14px", id: `${props.id}--field` },
    h(
      "label",
      { for: props.id },
      props.label,
      props.badge ? h(Fragment, null, " ", h("span", { class: "badge" }, props.badge)) : null,
    ),
    props.children,
    props.help
      ? h("p", { class: "lead", style: "margin:4px 0 0;font-size:13px" }, props.help)
      : null,
    props.error
      ? h("p", { class: "note", role: "alert", style: "margin:6px 0 0" }, props.error)
      : null,
  );
}

/**
 * Wrap a control in its label, help text and validation message. The string twin of
 * {@linkcode Field}.
 *
 * @param options The field description.
 * @returns The field markup.
 */
export function field(options: FieldOptions): RawHtml {
  const { body, ...rest } = options;
  return renderView(h(Field, { ...rest }, h(Raw, { html: body })));
}

/** One row-operation button (`↑`, `↓`, `✕`, `+ Add`). */
export interface OpButtonOptions {
  /** The operation. */
  readonly op: string;
  /** The row it acts on (for `add`, where to insert). */
  readonly at: number;
  /** The field name of the list it acts on. */
  readonly list: string;
  /** The visible glyph or label. */
  readonly label: string;
  /** The accessible name. */
  readonly title: string;
  /** Render disabled. */
  readonly disabled?: boolean;
}

/**
 * A real submit button carrying one list operation — the whole list editor works with
 * JavaScript disabled, and `ui.js` upgrades the same submit to a fragment swap.
 *
 * The operation, the row and the list travel in the button's single `value` (a button can only
 * post one name/value pair); `parseOp` in `value.ts` reads them back.
 *
 * @param props The button description.
 * @returns The button element.
 */
export function OpButton(props: OpButtonOptions): VNode {
  return h("button", {
    type: "submit",
    class: "ghost",
    name: OP_FIELD,
    value: `${props.op}:${props.at}:${props.list}`,
    title: props.title,
    "aria-label": props.title,
    formnovalidate: true,
    disabled: props.disabled ?? false,
    style: "padding:2px 8px",
  }, props.label);
}

/**
 * One list-operation submit button. The string twin of {@linkcode OpButton}.
 *
 * @param options The button description.
 * @returns The button markup.
 */
export function opButton(options: OpButtonOptions): RawHtml {
  return renderView(h(OpButton, { ...options }));
}
