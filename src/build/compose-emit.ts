// Writing side of the compose editor (`compose-edit.ts`): the YAML text for values it inserts.
//
// Two jobs. A scalar is written plain only when every YAML reader keeps it the same string, and
// double-quoted otherwise. A whole value — a field that was an alias, one a service inherits
// through a merge key, a service written in flow style — is written out as block YAML when an
// edit has to give that service its own copy. The editor re-parses every splice and compares it
// with the intended change, so this module only has to be correct, not clever: it never tries to
// reproduce a style, and a value it renders wrongly is a refusal, never a write.
//
// Build-time only; never imported by a shipped bundle.

import { parse } from "@std/yaml";
import { isMapping } from "./compose-scan.ts";

/** Words a YAML 1.1 reader (older compose tooling) takes for a boolean or null. */
const YAML11_WORDS = /^(?:y|n|yes|no|on|off|true|false|null|~)$/i;
/** Text a YAML reader may take for a number (or, in YAML 1.1, a sexagesimal `5432:5432`). */
const NUMBER_LIKE = /^[-+.]?\d/;
/** A mapping key that can be written without quotes. */
const PLAIN_KEY = /^[A-Za-z_$./][\w$./-]*$/;

/** Whether `value` survives as itself when written as a plain (unquoted) YAML scalar. */
function plainReadsBack(value: string): boolean {
  if (value === "" || value !== value.trim() || /[\r\n\t]/.test(value)) return false;
  try {
    const back = parse(`k: ${value}`);
    return isMapping(back) && back.k === value;
  } catch {
    return false;
  }
}

/**
 * A string as a YAML scalar: plain when every YAML reader keeps it a string, else double-quoted
 * (JSON's escapes are valid YAML double-quoted escapes).
 *
 * @param value The string to write.
 * @returns Its YAML text.
 */
export function yamlScalar(value: string): string {
  const plain = !YAML11_WORDS.test(value) && !NUMBER_LIKE.test(value) && plainReadsBack(value);
  return plain ? value : JSON.stringify(value);
}

/** A mapping key: plain when it cannot be read as anything else, else double-quoted. */
function yamlKey(key: string): string {
  return PLAIN_KEY.test(key) && !YAML11_WORDS.test(key) ? key : JSON.stringify(key);
}

/** `n` spaces. */
function pad(n: number): string {
  return " ".repeat(n);
}

/** A parsed value that is a non-empty mapping or sequence (written over several lines). */
function isBlock(value: unknown): value is unknown[] | Record<string, unknown> {
  if (Array.isArray(value)) return value.length > 0;
  return isMapping(value) && Object.keys(value).length > 0;
}

/** A value written on its head line: a scalar, `null` as nothing, an empty collection. */
function inlineText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return " []";
  if (isMapping(value)) return " {}";
  if (typeof value === "string") return " " + yamlScalar(value);
  return " " + (value instanceof Date ? value.toISOString() : String(value));
}

/** The lines of a mapping's entries or a sequence's items at `indent`. */
function blockLines(value: unknown[] | Record<string, unknown>, indent: number): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => emitItem(item, indent))
    : Object.entries(value).flatMap(([key, item]) => emitEntry(key, item, indent));
}

/**
 * One mapping entry as block YAML: `key: scalar`, or `key:` with its value on the lines below.
 *
 * @param key The mapping key.
 * @param value Its parsed value.
 * @param indent The column the key starts at.
 * @param keep What to keep from a line being replaced: its `head` (indentation, key and `:`,
 * as written) and its `tail` (a trailing comment).
 * @returns The entry's lines, without line endings.
 */
export function emitEntry(
  key: string,
  value: unknown,
  indent: number,
  keep: { readonly head?: string; readonly tail?: string } = {},
): string[] {
  const head = keep.head ?? pad(indent) + yamlKey(key) + ":";
  const tail = keep.tail ?? "";
  if (!isBlock(value)) return [head + inlineText(value) + tail];
  return [head + tail, ...blockLines(value, indent + 2)];
}

/**
 * One sequence item as block YAML: `- scalar`, or `- ` followed by a collection's first line,
 * the rest of it indented under the item.
 *
 * @param value The item's parsed value.
 * @param indent The column the `-` sits at.
 * @returns The item's lines, without line endings.
 */
function emitItem(value: unknown, indent: number): string[] {
  const dash = pad(indent) + "-";
  if (!isBlock(value)) return [dash + (value === null ? " null" : inlineText(value))];
  const lines = blockLines(value, indent + 2);
  return [dash + " " + lines[0].slice(indent + 2), ...lines.slice(1)];
}
