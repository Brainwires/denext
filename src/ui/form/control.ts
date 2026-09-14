// The one input primitive every widget funnels through: label, help text, validation message
// and the control itself, in one place, so the form renderer stays a dispatch table rather than
// thirteen near-identical markup blocks.
//
// STUB — J4c implements {@linkcode control}.

import type { RawHtml } from "../html.ts";
import type { WidgetKind } from "./widget.ts";

/** One rendered field. */
export interface ControlOptions {
  /** The widget to render. */
  readonly kind: WidgetKind;
  /** The form field name (the dotted config path). */
  readonly name: string;
  /** The current value in wire form. */
  readonly value: string;
  /** The visible label (defaults to the last path segment). */
  readonly label?: string;
  /** Help text from the schema's `description`. */
  readonly help?: string;
  /** Allowed values for a select/segmented/multi-select. */
  readonly options?: readonly string[];
  /** A validation message to show against the field. */
  readonly error?: string;
  /** Render disabled (a non-serialisable value, or `--read-only`). */
  readonly readOnly?: boolean;
}

/**
 * Render one field.
 *
 * @param options The control description.
 * @returns The field markup.
 */
export function control(options: ControlOptions): RawHtml {
  void options;
  throw new Error("not implemented: J4c");
}
