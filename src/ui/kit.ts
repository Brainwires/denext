/**
 * `denext/ui-kit` — the form components `denext ui` builds its panels from, for plugin authors
 * who render a form of their own: a project verb's page, a plugin's options page, a docs page
 * that shows the form a schema produces.
 *
 * ```ts
 * import { h } from "denext/jsx-runtime";
 * import { Control, Field, FormField, renderView, widgetFor } from "denext/ui-kit";
 *
 * // One schema-driven field: the widget for a JSON Schema node, with the form's CSRF field.
 * const spec = widgetFor({ type: "string", description: "Where the app lives." }, ["basePath"], false);
 * const body = renderView(h(FormField, { spec, value: "/app", ctx: { csrf } }));
 *
 * // Or the primitives: a labelled control.
 * h(Field, { id: "name", label: "Name", help: "Shown in the header." },
 *   h(Control, { tag: "input", name: "name", id: "name", value: "" }));
 * ```
 *
 * Every component is built with `h()` and renders on the server: plain HTML with real submit
 * buttons, so a form works with JavaScript disabled, and every text child and attribute value
 * is escaped. {@linkcode decode} reads a posted form back into the value a widget stands for.
 *
 * @module
 */

export {
  Control,
  type ControlAttrs,
  Field,
  type FieldProps,
  OpButton,
  type OpButtonOptions,
} from "./form/control.ts";
export {
  FormField,
  type FormFieldProps,
  FormFields,
  type FormFieldsProps,
  type RenderContext,
  Widget,
  type WidgetField,
  type WidgetProps,
} from "./form/render.ts";
export {
  type WidgetBranch,
  widgetFor,
  type WidgetKind,
  type WidgetOption,
  type WidgetSpec,
} from "./form/widget.ts";
export { decode, encode, type FormEntry } from "./form/value.ts";
export type { SchemaNode } from "./form/schema.ts";
export type { BadgeTone } from "./components.ts";
export { renderView } from "./view.ts";
export type { RawHtml } from "./view.ts";
