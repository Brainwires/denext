// `/config` and `/config/next` — the schema-driven configuration editor.
//
// `/config` renders `denext.config.ts` as type-appropriate widgets built from the generated
// `denext.config.schema.json` (never a raw text box) and writes changes back through the
// comment-preserving AST splicer; `/config/next` reads a compat app's `next.config.*` and offers
// to translate it. STUB — J5 replaces this module (its widgets come from J4c).

import { jsonResponse, stubHandler, type UiContext, type UiHandler } from "../html.ts";
import { readWidget } from "../form/render.ts";
import type { SchemaNode } from "../form/schema.ts";

const panel = stubHandler({
  title: "Config",
  lead:
    "Edit denext.config.ts through widgets generated from the config schema — enums as selects, " +
    "lists as typed row editors, records as key/value maps.",
  job: "J5",
});

/**
 * Decode a posted config form into `{ path: value }`. J5 splices the result into the config
 * source; today every field throws out of `src/ui/form/**` and the caller answers `501`.
 *
 * @param form The submitted fields.
 * @param schema The root config schema.
 * @returns The decoded patch.
 */
export function decodePatch(form: FormData, schema: SchemaNode): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith("_") || typeof value !== "string") continue;
    patch[key] = readWidget(schema, key, value);
  }
  return patch;
}

/** Serve the configuration editor (and, on `/config/next`, the next.config panel). */
export const configPanel: UiHandler = (request: Request, ctx: UiContext): Promise<Response> => {
  if (ctx.method !== "POST") return panel(request, ctx);
  try {
    decodePatch(ctx.form ?? new FormData(), {});
  } catch { /* J5: until the widget codec lands there is nothing to apply */ }
  return Promise.resolve(jsonResponse({ ok: false, reason: "not implemented", job: "J5" }, 501));
};
