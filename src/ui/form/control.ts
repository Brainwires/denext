// The one input primitive every widget funnels through, plus the label/help/error wrapper and
// the row-operation button — in one place, so the form renderer stays a dispatch table rather
// than thirteen near-identical markup blocks, and so "every value is escaped" is one claim to
// audit rather than thirteen.
//
// Layout uses inline `style=` attributes where `src/ui/styles.ts` has no class: the UI's CSP
// sets `style-src-attr 'unsafe-inline'` for exactly this (it still forbids inline `<style>`).

import { esc, html, raw, type RawHtml } from "../html.ts";
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

/** One attribute pair: `undefined`/`false` drops it, `true` renders it bare. */
type Attr = readonly [string, string | number | boolean | undefined];

/** Serialise attribute pairs, escaping every value. */
function attrs(pairs: readonly Attr[]): string {
  let out = "";
  for (const [name, value] of pairs) {
    if (value === undefined || value === false) continue;
    out += value === true ? ` ${name}` : ` ${name}="${esc(value)}"`;
  }
  return out;
}

/**
 * One element, assembled by string concatenation rather than a tagged template, so the markup a
 * widget emits is stable: `deno fmt` reflows template literals, and a form field's attributes
 * must not acquire newlines because the source was wrapped.
 */
function tag(name: string, pairs: readonly Attr[], body?: string): string {
  const open = `<${name}${attrs(pairs)}>`;
  return body === undefined ? open : `${open}${body}</${name}>`;
}

/**
 * Render one control. Every widget in `render.ts` bottoms out here, so escaping, the disabled
 * flag and the element vocabulary are decided exactly once.
 *
 * @param spec The control description.
 * @returns The control markup.
 */
export function control(spec: ControlAttrs): RawHtml {
  const common: Attr[] = [
    ["name", spec.name],
    ["id", spec.id],
    ["aria-label", spec.ariaLabel],
    ["disabled", spec.disabled ?? false],
  ];
  if (spec.tag === "textarea") {
    const pairs = [...common, ["rows", spec.rows ?? 4], ["placeholder", spec.placeholder], [
      "style",
      "width:100%",
    ]] as Attr[];
    return raw(tag("textarea", pairs, esc(spec.value ?? "")));
  }
  if (spec.tag === "select") {
    const options = (spec.options ?? []).map((option) =>
      tag(
        "option",
        [["value", option.value], ["selected", option.value === (spec.value ?? "")]],
        esc(option.label),
      )
    );
    return raw(tag("select", common, options.join("")));
  }
  return raw(tag("input", [
    ...common,
    ["type", spec.type ?? "text"],
    ["value", spec.value ?? ""],
    ["min", spec.min],
    ["max", spec.max],
    ["placeholder", spec.placeholder],
    ["checked", spec.checked ?? false],
  ]));
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

/**
 * Wrap a control in its label, help text and validation message.
 *
 * @param options The field description.
 * @returns The field markup.
 */
export function field(options: FieldOptions): RawHtml {
  return html`
    <div style="margin:0 0 14px" id="${options.id}--field">
      <label for="${options.id}">${options.label}${options.badge
        ? html`
          <span class="badge">${options.badge}</span>
        `
        : ""}</label>
      ${options.body}
      ${options.help
        ? html`<p class="lead" style="margin:4px 0 0;font-size:13px">${options.help}</p>`
        : ""}
      ${options.error
        ? html`<p class="note" role="alert" style="margin:6px 0 0">${options.error}</p>`
        : ""}
    </div>
  `;
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
 * @param options The button description.
 * @returns The button markup.
 */
export function opButton(options: OpButtonOptions): RawHtml {
  return raw(tag("button", [
    ["type", "submit"],
    ["class", "ghost"],
    ["name", OP_FIELD],
    ["value", `${options.op}:${options.at}:${options.list}`],
    ["title", options.title],
    ["aria-label", options.title],
    ["formnovalidate", true],
    ["disabled", options.disabled ?? false],
    ["style", "padding:2px 8px"],
  ], esc(options.label)));
}
