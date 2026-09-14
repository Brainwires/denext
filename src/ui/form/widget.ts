// Choosing a widget for a schema node: the `[predicate, build]` rule table that turns
// `denext.config.schema.json` into type-appropriate controls (enum → select, array of object →
// list-of-forms with typed rows, record → key/value map, …) instead of a raw text box.
//
// STUB — J4c implements {@linkcode widgetFor}; the widget vocabulary below is final.

import type { SchemaNode } from "./schema.ts";
import { OVERRIDES } from "./schema-overrides.ts";

/** Every control the config editor can render. */
export type WidgetKind =
  | "text"
  | "textarea"
  | "number"
  | "toggle"
  | "select"
  | "segmented"
  | "multi-select"
  | "chips"
  | "list-of-forms"
  | "map"
  | "union"
  | "group"
  | "code";

/**
 * The widget for one schema node — the first matching rule wins, with
 * {@linkcode OVERRIDES} consulted first.
 *
 * @param node The schema node.
 * @param path Its dotted config path.
 * @param required Whether the field is required (an optional enum gains "— unset —").
 * @returns The widget to render.
 */
export function widgetFor(node: SchemaNode, path: string, required: boolean): WidgetKind {
  const override = OVERRIDES[path];
  if (override) return override;
  void node, required;
  throw new Error("not implemented: J4c");
}
