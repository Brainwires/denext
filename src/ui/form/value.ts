// The codec between a widget's wire form (what a `<form>` posts: always strings) and the
// config value it stands for. `decode(encode(v), kind) === v` per widget kind is the invariant
// J4c's test pins down.
//
// STUB — J4c implements both halves.

import type { WidgetKind } from "./widget.ts";

/** The message every stub in `src/ui/form/**` throws until J4c lands. */
const TODO = "not implemented: J4c";

/**
 * Render a config value as the string its widget posts.
 *
 * @param value The config value.
 * @param kind The widget it is rendered as.
 * @returns The wire form.
 */
export function encode(value: unknown, kind: WidgetKind): string {
  void value, kind;
  throw new Error(TODO);
}

/**
 * Parse a posted field back into the config value its widget stands for.
 *
 * @param wire The posted string.
 * @param kind The widget it came from.
 * @returns The config value.
 */
export function decode(wire: string, kind: WidgetKind): unknown {
  void wire, kind;
  throw new Error(TODO);
}
