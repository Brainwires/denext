// The recursive half of the schema-driven form: walk a schema node, pick its widget, and render
// it through the one {@linkcode control} primitive — with arrays recursing into a typed sub-form
// per row and unions recursing into the selected branch.
//
// STUB — the shape below is what J4c fills in; every call still bottoms out in a
// `not implemented: J4c` throw today.

import type { RawHtml } from "../html.ts";
import { control } from "./control.ts";
import { branchFor, itemSchema, resolveAt, type SchemaNode } from "./schema.ts";
import { decode, encode } from "./value.ts";
import { widgetFor } from "./widget.ts";

/**
 * Render the field (or sub-form) at `path`.
 *
 * @param root The root config schema.
 * @param path The dotted path to render.
 * @param value The current value at that path.
 * @returns The field markup.
 */
export function renderWidget(root: SchemaNode, path: string, value: unknown): RawHtml {
  const node = resolveAt(root, path);
  const kind = widgetFor(node, path, false);
  if (kind === "list-of-forms") return renderWidget(itemSchema(node), `${path}.0`, value);
  if (kind === "union") return renderWidget(branchFor(node, value), path, value);
  return control({ kind, name: path, value: encode(value, kind) });
}

/**
 * Parse one posted field back into the config value it stands for — the inverse of
 * {@linkcode renderWidget} for a single field.
 *
 * @param root The root config schema.
 * @param path The dotted path that was posted.
 * @param wire The posted string.
 * @returns The config value.
 */
export function readWidget(root: SchemaNode, path: string, wire: string): unknown {
  return decode(wire, widgetFor(resolveAt(root, path), path, false));
}
