// The codec between a widget tree and what a `<form>` posts (always flat `name=value` strings).
//
// `decode(spec, encode(spec, value))` deep-equals `value` for every widget kind — the invariant
// `tests/ui-form-value.test.ts` pins down, and the reason the editor can read a config, render
// it, take a submit back and splice only what actually changed.
//
// Names use a bracket path syntax (`redirects[2].permanent`) so a whole nested section survives
// one flat `FormData`. Two suffixes carry structure a path cannot: `~branch` (which alternative
// of a union is selected) and `~key` (the key side of a map row).

import { itemSchema, MAP_SEGMENT, mapValueSchema } from "./schema.ts";
import { selectedBranch, widgetFor, type WidgetKind, type WidgetSpec } from "./widget.ts";

/** One posted field. */
export interface FormEntry {
  /** The field name (a bracket path). */
  readonly name: string;
  /** The posted string. */
  readonly value: string;
}

/** The list mutations a row's buttons can request. */
export type ListOp = "add" | "remove" | "up" | "down";

/** The suffix of the hidden field naming a union's selected branch. */
export const BRANCH_SUFFIX = "~branch";

/** The suffix of the field holding the key side of a map row. */
export const KEY_SUFFIX = "~key";

/**
 * The suffix of the hidden field that marks a list, chip list or map as *present*. Without it an
 * empty list and an absent key would post identically, and clearing a list would be impossible.
 */
export const COUNT_SUFFIX = "~n";

/** A posted value that cannot become a config value — reported against its field, not clamped. */
export class FormValueError extends Error {
  /** The field name the message belongs to. */
  readonly field: string;

  /**
   * @param field The field name.
   * @param message What is wrong with the posted value.
   */
  constructor(field: string, message: string) {
    super(message);
    this.name = "FormValueError";
    this.field = field;
  }
}

/**
 * The form field name for a path: array indices become `[n]`, everything else a dotted segment.
 *
 * @param path The path segments.
 * @param prefix An optional prefix for every name the form emits.
 * @returns The field name.
 */
export function fieldName(path: readonly string[], prefix = ""): string {
  let name = "";
  for (const segment of path) {
    if (segment === MAP_SEGMENT) name += "[*]";
    else if (/^\d+$/.test(segment)) name += `[${segment}]`;
    else name += name === "" ? segment : `.${segment}`;
  }
  return prefix + name;
}

/**
 * The widget for row `index` of a list, chip list or map — the same spec the row was rendered
 * with, so encode, decode and render agree on every name.
 *
 * @param spec The list, chips, multi-select or map spec.
 * @param index The row index.
 * @returns The row's widget.
 */
export function rowSpec(spec: WidgetSpec, index: number): WidgetSpec {
  const node = spec.kind === "map" ? (mapValueSchema(spec.schema) ?? {}) : itemSchema(spec.schema);
  return widgetFor(node, [...spec.path, String(index)], true);
}

/** Every element of `value` as a row spec paired with its value. */
function rows(spec: WidgetSpec, value: unknown): { row: WidgetSpec; value: unknown }[] {
  const list = Array.isArray(value) ? value : [];
  return list.map((entry, index) => ({ row: rowSpec(spec, index), value: entry }));
}

/** One field, or nothing when the value is absent. */
function one(name: string, value: string | undefined): FormEntry[] {
  return value === undefined ? [] : [{ name, value }];
}

/** How each widget kind renders a config value as posted fields. */
type Encoder = (spec: WidgetSpec, value: unknown, prefix: string) => FormEntry[];

/** The encode table — one row per widget kind. */
const ENCODERS: Record<WidgetKind, Encoder> = {
  text: (spec, value, prefix) => one(fieldName(spec.path, prefix), scalarText(value)),
  textarea: (spec, value, prefix) => one(fieldName(spec.path, prefix), scalarText(value)),
  select: (spec, value, prefix) => one(fieldName(spec.path, prefix), scalarText(value)),
  segmented: (spec, value, prefix) => one(fieldName(spec.path, prefix), scalarText(value)),
  number: (spec, value, prefix) => one(fieldName(spec.path, prefix), scalarText(value)),
  toggle: (spec, value, prefix) =>
    one(fieldName(spec.path, prefix), value === undefined ? undefined : value ? "on" : "off"),
  code: (spec, value, prefix) =>
    one(fieldName(spec.path, prefix), value === undefined ? undefined : JSON.stringify(value)),
  chips: encodeList,
  "list-of-forms": encodeList,
  "multi-select": (spec, value, prefix) => encodeMultiSelect(spec, value, prefix),
  map: (spec, value, prefix) => encodeMap(spec, value, prefix),
  union: (spec, value, prefix) => encodeUnion(spec, value, prefix),
  group: (spec, value, prefix) => encodeGroup(spec, value, prefix),
};

/** The hidden presence marker of a list, chip list or map. */
function countEntry(spec: WidgetSpec, prefix: string, length: number): FormEntry {
  return { name: fieldName(spec.path, prefix) + COUNT_SUFFIX, value: String(length) };
}

/** Indexed rows behind a presence marker. */
function encodeList(spec: WidgetSpec, value: unknown, prefix: string): FormEntry[] {
  if (!Array.isArray(value)) return [];
  const encoded = rows(spec, value).flatMap((entry) => encode(entry.row, entry.value, prefix));
  return [countEntry(spec, prefix, value.length), ...encoded];
}

/** A scalar as its posted string (`undefined` means "the field is absent"). */
function scalarText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

/** Checked boxes, indexed by their position in the schema's `enum`. */
function encodeMultiSelect(spec: WidgetSpec, value: unknown, prefix: string): FormEntry[] {
  if (!Array.isArray(value)) return [];
  const selected = value.map(String);
  const entries: FormEntry[] = [countEntry(spec, prefix, selected.length)];
  (spec.options ?? []).forEach((option, index) => {
    if (!selected.includes(option.value)) return;
    entries.push({ name: fieldName([...spec.path, String(index)], prefix), value: option.value });
  });
  return entries;
}

/** Key/value rows, in the object's own key order. */
function encodeMap(spec: WidgetSpec, value: unknown, prefix: string): FormEntry[] {
  if (typeof value !== "object" || value === null) return [];
  const pairs = Object.entries(value as Record<string, unknown>);
  const entries: FormEntry[] = [countEntry(spec, prefix, pairs.length)];
  pairs.forEach(([key, entry], index) => {
    const row = rowSpec(spec, index);
    entries.push({ name: fieldName(row.path, prefix) + KEY_SUFFIX, value: key });
    entries.push(...encode(row, entry, prefix));
  });
  return entries;
}

/** The selected branch index, then the branch's own fields (at the same path). */
function encodeUnion(spec: WidgetSpec, value: unknown, prefix: string): FormEntry[] {
  if (value === undefined) return [];
  const { branch, index } = selectedBranch(spec, value);
  if (!branch) return [];
  const name = fieldName(spec.path, prefix) + BRANCH_SUFFIX;
  return [{ name, value: String(index) }, ...encode(branch.spec, value, prefix)];
}

/** Each present property, through its own child widget. */
function encodeGroup(spec: WidgetSpec, value: unknown, prefix: string): FormEntry[] {
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  return (spec.children ?? []).flatMap((child) => {
    const key = child.path[child.path.length - 1];
    return key !== undefined && record[key] !== undefined ? encode(child, record[key], prefix) : [];
  });
}

/**
 * Render a config value as the flat fields its widget posts.
 *
 * @param spec The widget the value is edited with.
 * @param value The config value (`undefined` renders no fields at all).
 * @param prefix An optional prefix shared by every name in the form.
 * @returns The fields, in render order.
 */
export function encode(spec: WidgetSpec, value: unknown, prefix = ""): FormEntry[] {
  return ENCODERS[spec.kind](spec, value, prefix);
}

// ── decode ───────────────────────────────────────────────────────────────────

/** Indexed access to a posted body: values by name, and the row indices under a name. */
interface Lookup {
  /** Every value posted under `name`, in order. */
  all(name: string): string[];
  /** The first value posted under `name`. */
  first(name: string): string | undefined;
  /** The row indices that exist directly under `base` (`base[0]`, `base[1]`, …). */
  rows(base: string): number[];
}

/** Index the posted fields once, so decoding a deep tree stays linear. */
function lookupOf(entries: readonly FormEntry[]): Lookup {
  const values = new Map<string, string[]>();
  const indices = new Map<string, Set<number>>();
  for (const entry of entries) {
    const bucket = values.get(entry.name);
    if (bucket) bucket.push(entry.value);
    else values.set(entry.name, [entry.value]);
    for (const match of entry.name.matchAll(/\[(\d+)\]/g)) {
      const base = entry.name.slice(0, match.index);
      const seen = indices.get(base) ?? new Set<number>();
      seen.add(Number(match[1]));
      indices.set(base, seen);
    }
  }
  return {
    all: (name) => values.get(name) ?? [],
    first: (name) => values.get(name)?.[0],
    rows: (base) => [...(indices.get(base) ?? [])].sort((a, b) => a - b),
  };
}

/** How each widget kind reads its config value back out of a posted body. */
type Decoder = (spec: WidgetSpec, lookup: Lookup, prefix: string) => unknown;

/**
 * A posted scalar: absent stays absent, and so does an empty optional field. A field with an
 * `enum` comes back as the declared member, so `hsts: false` does not round-trip to `"false"`.
 */
function decodeText(spec: WidgetSpec, lookup: Lookup, prefix: string): unknown {
  const posted = lookup.first(fieldName(spec.path, prefix));
  if (posted === undefined) return undefined;
  if (posted === "" && !spec.required) return undefined;
  // An option that declares the value it stands for wins: a union flattened into one choice
  // holds values its node does not list together, and they must keep their types.
  const option = spec.options?.find((entry) => entry.value === posted && entry.typed !== undefined);
  if (option) return option.typed;
  const member = spec.schema.enum?.find((choice) => String(choice) === posted);
  return member === undefined ? posted : member;
}

/** A posted number: out of range is a validation error, never a silent clamp. */
function decodeNumber(spec: WidgetSpec, lookup: Lookup, prefix: string): unknown {
  const name = fieldName(spec.path, prefix);
  const posted = lookup.first(name);
  if (posted === undefined || posted.trim() === "") return undefined;
  const parsed = Number(posted);
  if (!Number.isFinite(parsed)) throw new FormValueError(name, `\`${posted}\` is not a number`);
  if (spec.min !== undefined && parsed < spec.min) {
    throw new FormValueError(name, `must be at least ${spec.min}`);
  }
  if (spec.max !== undefined && parsed > spec.max) {
    throw new FormValueError(name, `must be at most ${spec.max}`);
  }
  return parsed;
}

/** A checkbox paired with its hidden `off` companion: the last value posted wins. */
function decodeToggle(spec: WidgetSpec, lookup: Lookup, prefix: string): unknown {
  const posted = lookup.all(fieldName(spec.path, prefix));
  return posted.length === 0 ? undefined : posted[posted.length - 1] === "on";
}

/** A read-only cell: absent (the control is disabled) means "leave the config as it is". */
function decodeCode(spec: WidgetSpec, lookup: Lookup, prefix: string): unknown {
  const name = fieldName(spec.path, prefix);
  const posted = lookup.first(name);
  if (posted === undefined) return undefined;
  try {
    return JSON.parse(posted);
  } catch {
    throw new FormValueError(name, "not valid JSON");
  }
}

/** Whether the form carried this list/map at all (see `COUNT_SUFFIX`). */
function present(spec: WidgetSpec, lookup: Lookup, prefix: string): boolean {
  return lookup.first(fieldName(spec.path, prefix) + COUNT_SUFFIX) !== undefined;
}

/** Indexed rows, reassembled in index order; a row that posted nothing is dropped. */
function decodeRows(spec: WidgetSpec, lookup: Lookup, prefix: string): unknown {
  if (!present(spec, lookup, prefix)) return undefined;
  return lookup.rows(fieldName(spec.path, prefix))
    .map((index) => decodeSpec(rowSpec(spec, index), lookup, prefix))
    .filter((value) => value !== undefined);
}

/** Checked boxes, in the order the schema's `enum` declares them. */
function decodeMultiSelect(spec: WidgetSpec, lookup: Lookup, prefix: string): unknown {
  if (!present(spec, lookup, prefix)) return undefined;
  return lookup.rows(fieldName(spec.path, prefix))
    .map((index) => lookup.first(fieldName([...spec.path, String(index)], prefix)))
    .filter((value): value is string => value !== undefined);
}

/** Key/value rows back into an object; a row with a blank key is dropped. */
function decodeMap(spec: WidgetSpec, lookup: Lookup, prefix: string): unknown {
  if (!present(spec, lookup, prefix)) return undefined;
  const indices = lookup.rows(fieldName(spec.path, prefix));
  const out: Record<string, unknown> = {};
  for (const index of indices) {
    const row = rowSpec(spec, index);
    const key = lookup.first(fieldName(row.path, prefix) + KEY_SUFFIX);
    if (!key) continue;
    out[key] = decodeSpec(row, lookup, prefix);
  }
  return out;
}

/** The branch the discriminator selected, decoded at the union's own path. */
function decodeUnion(spec: WidgetSpec, lookup: Lookup, prefix: string): unknown {
  const posted = lookup.first(fieldName(spec.path, prefix) + BRANCH_SUFFIX);
  if (posted === undefined) return undefined;
  const branch = (spec.branches ?? [])[Number(posted)];
  return branch ? decodeSpec(branch.spec, lookup, prefix) : undefined;
}

/** Each child that posted something; an object with no posted children stays absent. */
function decodeGroup(spec: WidgetSpec, lookup: Lookup, prefix: string): unknown {
  const out: Record<string, unknown> = {};
  for (const child of spec.children ?? []) {
    const key = child.path[child.path.length - 1];
    if (key === undefined) continue;
    const value = decodeSpec(child, lookup, prefix);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length === 0 && !spec.required ? undefined : out;
}

/** The decode table — one row per widget kind. */
const DECODERS: Record<WidgetKind, Decoder> = {
  text: decodeText,
  textarea: decodeText,
  select: decodeText,
  segmented: decodeText,
  number: decodeNumber,
  toggle: decodeToggle,
  code: decodeCode,
  chips: decodeRows,
  "list-of-forms": decodeRows,
  "multi-select": decodeMultiSelect,
  map: decodeMap,
  union: decodeUnion,
  group: decodeGroup,
};

/** Decode one spec against an already-built lookup (the recursive half of `decode`). */
function decodeSpec(spec: WidgetSpec, lookup: Lookup, prefix: string): unknown {
  return DECODERS[spec.kind](spec, lookup, prefix);
}

/**
 * Parse a posted body back into the config value its widget stands for.
 *
 * Type driven throughout: numbers are parsed (and range-checked), toggles become booleans, chip
 * and list rows are reassembled by index, map rows by their `~key` field, and a union by the
 * branch its discriminator names. A field nothing posted stays `undefined`, which the config
 * writer reads as "leave this key alone".
 *
 * @param spec The widget the fields were rendered from.
 * @param entries The posted fields.
 * @param prefix The prefix the form was rendered with.
 * @returns The config value.
 * @throws {FormValueError} If a posted value cannot become a value of the declared type.
 */
export function decode(spec: WidgetSpec, entries: readonly FormEntry[], prefix = ""): unknown {
  return decodeSpec(spec, lookupOf(entries), prefix);
}

/**
 * Apply one row button's operation to a list. Out-of-range indices are no-ops, so a stale form
 * (two tabs open on the same config) cannot corrupt the array.
 *
 * @param list The current list.
 * @param op The requested operation.
 * @param at The row the button belongs to (for `add`, where to insert).
 * @param blank The element `add` inserts (`null` when the caller has nothing better).
 * @returns A new list.
 */
export function applyListOp<T>(
  list: readonly T[],
  op: ListOp,
  at: number,
  blank?: T,
): T[] {
  const next = [...list];
  if (op === "add") {
    next.splice(at >= 0 && at <= next.length ? at : next.length, 0, (blank ?? null) as T);
    return next;
  }
  if (!Number.isInteger(at) || at < 0 || at >= next.length) return next;
  if (op === "remove") {
    next.splice(at, 1);
    return next;
  }
  const to = op === "up" ? at - 1 : at + 1;
  if (to < 0 || to >= next.length) return next;
  [next[at], next[to]] = [next[to], next[at]];
  return next;
}

// ── row operations posted by a button ────────────────────────────────────────

/** The form field a row-operation button posts under. */
export const OP_FIELD = "op";

/** One row operation, as read back out of a button's value. */
export interface ListOpRequest {
  /** What to do. */
  readonly op: ListOp;
  /** The row it acts on (for `add`, where to insert). */
  readonly at: number;
  /** The field name of the list it acts on. */
  readonly list: string;
}

/** The operations a button may name. */
const LIST_OPS: ReadonlySet<string> = new Set(["add", "remove", "up", "down"]);

/**
 * Read a row button's packed value (`"up:3:redirects"`) back into an operation. A button can
 * only post one name/value pair, so the operation, the row and the list travel together.
 *
 * @param packed The posted `op` value.
 * @returns The operation, or `undefined` when the value is not one.
 */
export function parseOp(packed: string): ListOpRequest | undefined {
  const first = packed.indexOf(":");
  const second = packed.indexOf(":", first + 1);
  if (first < 0 || second < 0) return undefined;
  const op = packed.slice(0, first);
  const at = Number(packed.slice(first + 1, second));
  const list = packed.slice(second + 1);
  if (!LIST_OPS.has(op) || !Number.isInteger(at) || at < 0 || list === "") return undefined;
  return { op: op as ListOp, at, list };
}

/**
 * Split a posted field name back into path segments — the inverse of `fieldName`. Any `~branch`
 * / `~key` / `~n` suffix is dropped, since those name a part of a field, not a path segment.
 *
 * @param name The posted field name.
 * @returns The path segments.
 */
export function parseFieldName(name: string): string[] {
  const bare = name.split("~")[0];
  const segments: string[] = [];
  for (const part of bare.split(".")) {
    const [head, ...indices] = part.split("[");
    if (head !== "") segments.push(head);
    for (const index of indices) segments.push(index.replace("]", ""));
  }
  return segments;
}
