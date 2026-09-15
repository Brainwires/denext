// Line-splice primitives of the compose editor (`compose-edit.ts`): how one field, list entry
// or flow item is located, rewritten, appended or dropped, and how a planned splice carries the
// change it must read back as. `compose-edit.ts` owns the operations and the read-back proof;
// this module only knows lines.
//
// Build-time only; never imported by a shipped bundle.

import { emitEntry, flowScalar, flowText, yamlKey, yamlScalar } from "./compose-emit.ts";
import { type Flow, readFlow } from "./compose-flow.ts";
import {
  type Entry,
  inlineValue,
  isInert,
  isMapping,
  itemHead,
  keyHead,
  restEmpty,
  scanBlock,
  type Service,
  type Span,
  type State,
} from "./compose-scan.ts";

type Raw = Record<string, unknown>;

/** Anchors an inline value starts with — kept when the value is rewritten. */
const LEADING_ANCHORS = /^(?:&\S+[ \t]+)*/;
/**
 * Where a missing field is created: after the last of these fields that is present (after the
 * `name:` line when none is); a field not listed goes after the service's last field.
 */
const ANCHORS: Readonly<Record<string, readonly string[]>> = {
  image: [],
  ports: ["image", "build"],
  environment: ["image", "build", "ports"],
};

/** Replace `remove` lines at `at` with `insert`. */
export interface Splice {
  at: number;
  remove: number;
  insert: string[];
}

/** What the file must read back as once an edit is applied. */
export interface Expected {
  raw: Raw;
  commented: Record<string, unknown>;
}

/** One operation, planned: its splice plus the same change applied to the parsed model. */
export type Change = Splice & { expect: (want: Expected) => void };

/** A service field's children (list items or mapping entries), located line by line. */
export interface Children {
  field?: Entry;
  items: Entry[];
  indent: number;
}

/**
 * A field whose value an alias (`ports: *shared`) or the service's merge key supplies: an edit
 * gives the service its own copy, written out whole.
 */
interface Whole {
  whole: true;
  /** The field's own line, when it has one (an alias); absent for an inherited field. */
  field?: Entry;
}

/** A field written as a flow collection: its lines joined with LF, and where its items sit. */
export interface FlowField {
  field: Entry;
  text: string;
  flow: Flow;
}

/**
 * A deep copy that shares nothing. The parser hands an alias the anchored node itself, so a
 * copy that kept that sharing would let an expectation "change" every alias of a node at once —
 * exactly what the read-back must catch.
 *
 * @param value A parsed YAML value.
 * @returns The same value, every mapping and sequence its own.
 */
export function detach<T>(value: T): T {
  if (Array.isArray(value)) return value.map(detach) as T;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (!isMapping(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, detach(v)])) as T;
}

/** A parsed document's services (none when `services:` is empty). */
export function servicesOf(raw: Raw): Raw {
  return isMapping(raw.services) ? raw.services : {};
}

/** Structural equality of parsed YAML values (mapping key order ignored). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && deepEqual((a as Raw)[k], (b as Raw)[k]));
}

/** `n` spaces. */
export function pad(n: number): string {
  return " ".repeat(n);
}

/** Delete a span. */
export function cut(span: Span): Splice {
  return { at: span.start, remove: span.end - span.start, insert: [] };
}

/** Attach the expected change to a splice (a refusal passes through). */
export function withExpect(splice: Splice | string, expect: Change["expect"]): Change | string {
  return typeof splice === "string" ? splice : { ...splice, expect };
}

/** Whether an entry's value continues on content lines below its head. */
function hasContent(lines: readonly string[], entry: Entry): boolean {
  return lines.slice(entry.start + 1, entry.end).some((l) => !isInert(l));
}

/** Where an inline scalar value ends: past a quoted scalar, or before a ` #` comment. */
function valueEnd(rest: string): number {
  const quoted = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/.exec(rest);
  if (quoted) return quoted[0].length;
  if (rest.startsWith("#")) return 0;
  const hash = rest.search(/[ \t]#/);
  return hash === -1 ? rest.length : hash;
}

/** The trailing comment an inline value carries (kept by a rewrite), or null for anything else. */
export function commentTail(rest: string): string | null {
  const tail = rest.slice(valueEnd(rest));
  if (tail.trim() === "") return "";
  if (!tail.trim().startsWith("#")) return null;
  return /^\s/.test(tail) ? tail : " " + tail;
}

/**
 * Replace an entry's value with the scalar `text`: in place on its head line when the value is
 * inline (an anchor it opens with and an inline comment are kept), else the whole entry becomes
 * `lead + text`.
 */
export function rewrite(
  lines: readonly string[],
  entry: Entry,
  text: string,
  lead: string,
): Splice | string {
  if (hasContent(lines, entry)) {
    return {
      at: entry.start,
      remove: entry.end - entry.start,
      insert: [lines[entry.start].slice(0, entry.indent) + lead + text],
    };
  }
  const line = lines[entry.start];
  const rest = line.slice(entry.valueCol);
  const anchors = LEADING_ANCHORS.exec(rest)![0];
  const tail = commentTail(rest.slice(anchors.length));
  if (tail === null) {
    return `line ${entry.start + 1} carries a value denext cannot rewrite in place`;
  }
  const head = line.slice(0, entry.headEnd) + " " + anchors;
  return { at: entry.start, remove: 1, insert: [head + text + tail] };
}

/** The line a missing `key` field is created at (see {@linkcode ANCHORS}). */
export function afterFields(svc: Service, key: string): number {
  const anchors = Object.hasOwn(ANCHORS, key) ? ANCHORS[key] : null;
  let at = svc.start + 1;
  for (const [k, f] of svc.fields) {
    if (anchors === null || anchors.includes(k)) at = Math.max(at, f.end);
  }
  return at;
}

/** The active service `name`, or why an edit cannot target it. */
export function serviceOf(state: State, name: string): Service | string {
  const svc = state.services.get(name);
  if (svc) return svc;
  return state.commented.some((c) => c.name === name)
    ? `service "${name}" is commented out — enable it first`
    : `no service named "${name}"`;
}

/** A service's mapping inside a parsed document. */
export function rawService(raw: Raw, name: string): Raw {
  return (raw.services as Raw)[name] as Raw;
}

/** How many children a parsed field value has. */
export function countOf(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  return isMapping(v) ? Object.keys(v).length : 0;
}

/** An expectation that mutates one field's value, dropping the field when it ends up empty. */
export function fieldExpect<T extends unknown[] | Raw>(
  service: string,
  key: string,
  empty: () => T,
  mutate: (value: T) => void,
): Change["expect"] {
  return (want) => {
    const s = rawService(want.raw, service);
    const value = (s[key] ?? empty()) as T;
    mutate(value);
    if (countOf(value)) s[key] = value;
    else delete s[key];
  };
}

/**
 * Locate a block list/mapping field's children, refusing flow style and the other form. A field
 * an alias or the merge key supplies is {@linkcode Whole}: the edit writes the service a copy.
 */
export function childrenOf(
  state: State,
  svc: Service,
  key: string,
  form: "list" | "map",
): Children | Whole | FlowField | string {
  const field = svc.fields.get(key);
  const value = rawService(state.raw, svc.key)[key];
  if (value !== undefined && value !== null && (form === "list") !== Array.isArray(value)) {
    return `${key} of "${svc.key}" is not written as a ${form} — edit it by hand`;
  }
  if (!field) {
    return value === undefined ? { items: [], indent: svc.fieldIndent + 2 } : { whole: true };
  }
  const lines = state.doc.lines;
  if (!restEmpty(lines[field.start], field)) {
    if (inlineValue(lines[field.start], field).startsWith("*")) return { whole: true, field };
    return flowField(lines, field, countOf(value)) ??
      `${key} of "${svc.key}" is written in a flow style denext cannot follow — edit it by hand`;
  }
  const head = form === "list" ? itemHead : keyHead;
  const items = scanBlock(lines, field.start + 1, field.end, head, form === "map");
  if (typeof items === "string") return items;
  if (items.length !== countOf(value)) {
    return `the entries of ${key} in "${svc.key}" could not be located line by line`;
  }
  return { field, items, indent: items.length ? items[0].indent : field.indent + 2 };
}

/** A flow-style field located: null when its collection does not close where the field ends. */
function flowField(lines: readonly string[], field: Entry, count: number): FlowField | null {
  const text = lines.slice(field.start, field.end).join("\n");
  const head = lines[field.start];
  const flow = readFlow(text, head.length - inlineValue(head, field).length);
  if (!flow || flow.items.length !== count) return null;
  return text.slice(flow.close + 1).split("\n").every(isInert) ? { field, text, flow } : null;
}

/** Replace `[from, to)` of a flow field's text and splice its lines back in. */
function flowSplice(ch: FlowField, from: number, to: number, insert: string): Splice {
  const text = ch.text.slice(0, from) + insert + ch.text.slice(to);
  return { at: ch.field.start, remove: ch.field.end - ch.field.start, insert: text.split("\n") };
}

/** Append an item after the last one, or into an empty collection. */
export function flowAdd(ch: FlowField, item: string): Splice {
  const { open, close, items } = ch.flow;
  const last = items.at(-1);
  if (last) return flowSplice(ch, last.end, last.end, ", " + item);
  const blank = ch.text.slice(open + 1, close).trim() === "";
  return flowSplice(ch, open + 1, blank ? close : open + 1, item);
}

/** Drop one item with the comma that separates it — the whole field when it is the only one. */
export function flowRemove(lines: readonly string[], ch: FlowField, index: number): Splice {
  const { items } = ch.flow;
  if (items.length === 1) return dropFlowField(lines, ch);
  return index < items.length - 1
    ? flowSplice(ch, items[index].start, items[index + 1].start, "")
    : flowSplice(ch, items[index - 1].end, items[index].end, "");
}

/** Replace one item's text. */
export function flowUpdate(ch: FlowField, index: number, item: string): Splice {
  const { start, end } = ch.flow.items[index];
  return flowSplice(ch, start, end, item);
}

/** Remove an emptied flow field, keeping the comment lines below its closing bracket. */
function dropFlowField(lines: readonly string[], ch: FlowField): Splice {
  const closeLine = ch.field.start + (ch.text.slice(0, ch.flow.close).match(/\n/g)?.length ?? 0);
  const kept = lines.slice(closeLine + 1, ch.field.end).filter((l) => l.trim().startsWith("#"));
  return { ...cut(ch.field), insert: kept };
}

/**
 * Give a service its own copy of a field an alias or its merge key supplied, holding `value`:
 * the alias line is replaced (its comment kept), an inherited field is written as an override.
 */
export function writeField(
  state: State,
  svc: Service,
  key: string,
  field: Entry | undefined,
  value: unknown,
): Change {
  const expect = (want: Expected) => {
    rawService(want.raw, svc.key)[key] = detach(value);
  };
  if (!field) {
    const insert = emitEntry(key, value, svc.fieldIndent);
    return { at: afterFields(svc, key), remove: 0, insert, expect };
  }
  const line = state.doc.lines[field.start];
  const tail = commentTail(line.slice(field.valueCol)) ?? "";
  const insert = emitEntry(key, value, field.indent, { head: line.slice(0, field.headEnd), tail });
  return { at: field.start, remove: field.end - field.start, insert, expect };
}

/** Append one child line (`body` is the line without its indentation), creating the field. */
export function append(
  svc: Service,
  key: string,
  ch: Children,
  body: string | readonly string[],
): Splice {
  const lines = (typeof body === "string" ? [body] : body).map((line) => pad(ch.indent) + line);
  if (!ch.field) {
    return {
      at: afterFields(svc, key),
      remove: 0,
      insert: [pad(svc.fieldIndent) + key + ":", ...lines],
    };
  }
  const last = ch.items[ch.items.length - 1];
  return { at: last ? last.end : ch.field.start + 1, remove: 0, insert: lines };
}

/**
 * Remove one child — or the whole field when it is the only one. Comment lines inside the
 * field's span (a commented-out sibling entry, a note) are the user's, not the entry's, so they
 * stay where they were when the emptied field goes.
 */
export function dropChild(lines: readonly string[], ch: Children, item: Entry): Splice {
  const field = ch.field;
  if (ch.items.length !== 1 || !field) return cut(item);
  const kept: string[] = [];
  for (let n = field.start + 1; n < field.end; n++) {
    const outside = n < item.start || n >= item.end;
    if (outside && lines[n].trim().startsWith("#")) kept.push(lines[n]);
  }
  return { ...cut(field), insert: kept };
}

// --- mapping nodes ----------------------------------------------------------

/** A scalar an edit writes into a mapping node. */
export type Scalar = string | number | boolean;

/**
 * A mapping value located in the file — a long-syntax list entry (`- target: 80`), one
 * dependency's settings, a mapping `build:` — whose keys an edit sets or deletes one at a time.
 * A block node knows each key's lines; a flow node (`{ target: 80 }`) its items.
 */
export type MapNode =
  | {
    kind: "block";
    keys: Map<string, Entry>;
    /** Column its keys start at. */
    indent: number;
    /** Line a new key is inserted at. */
    end: number;
    /** The line a list item's mapping opens on (`- target: 80`), or -1. */
    opener: number;
  }
  | { kind: "flow"; flow: FlowField; keys: string[] };

/** A block mapping's keys in `[from, to)`, or null when they are not exactly `count` of them. */
function blockNode(
  lines: readonly string[],
  span: Span,
  indent: number,
  opener: number,
  count: number,
): MapNode | null {
  const scanned = scanBlock(lines, span.start, span.end, keyHead, true);
  if (typeof scanned === "string" || scanned.length !== count) return null;
  const keys = new Map(scanned.map((e) => [e.key, e]));
  if (keys.size !== count) return null;
  const end = scanned.length ? Math.max(...scanned.map((e) => e.end)) : span.start;
  return { kind: "block", keys, indent: scanned[0]?.indent ?? indent, end, opener };
}

/**
 * Locate the mapping an entry holds: its keys below it, a flow mapping on its line, or — for a
 * list item — a mapping that opens on the item's own line (`- target: 80`). An entry with no
 * value (`db:`) is an empty node a key can be added to.
 *
 * @param lines The file's lines.
 * @param entry A mapping entry or a list item.
 * @param value Its parsed value (a mapping, or null).
 * @returns The node, or null when the value is not a mapping written in a way the editor follows.
 */
export function mapNode(lines: readonly string[], entry: Entry, value: unknown): MapNode | null {
  const count = isMapping(value) ? Object.keys(value).length : value === null ? 0 : -1;
  if (count === -1) return null;
  const line = lines[entry.start];
  if (restEmpty(line, entry)) {
    return blockNode(
      lines,
      { start: entry.start + 1, end: entry.end },
      entry.indent + 2,
      -1,
      count,
    );
  }
  if (inlineValue(line, entry).startsWith("{")) {
    const flow = flowField(lines, entry, count);
    return flow && { kind: "flow", flow, keys: Object.keys(value as Raw) };
  }
  if (entry.key !== "") return null;
  // Read the item's line with its `-` blanked, so the key it opens with scans like the others.
  const virtual = [...lines];
  virtual[entry.start] = line.slice(0, entry.headEnd - 1) + " " + line.slice(entry.headEnd);
  return blockNode(virtual, entry, entry.valueCol, entry.start, count);
}

/** A scalar as YAML text, in block or flow context. */
function scalarText(value: Scalar, flow: boolean): string {
  if (typeof value !== "string") return String(value);
  return flow ? flowScalar(value) : yamlScalar(value);
}

/**
 * Set one key of a mapping node to a scalar: in place when present, else appended.
 *
 * @param lines The file's lines.
 * @param node The mapping.
 * @param key The key.
 * @param value Its new value.
 * @returns The splice, or why the key's value cannot be rewritten in place.
 */
export function setKey(
  lines: readonly string[],
  node: MapNode,
  key: string,
  value: Scalar,
): Splice | string {
  const lead = `${yamlKey(key)}: `;
  if (node.kind === "flow") {
    const item = lead + scalarText(value, true);
    const at = node.keys.indexOf(key);
    return at === -1 ? flowAdd(node.flow, item) : flowUpdate(node.flow, at, item);
  }
  const text = scalarText(value, false);
  const entry = node.keys.get(key);
  if (entry) return rewrite(lines, entry, text, lead);
  return { at: node.end, remove: 0, insert: [pad(node.indent) + lead + text] };
}

/**
 * Delete one key of a mapping node. The key a list item's line opens with hands that line to
 * the next key; the last key is never deleted (the entry would stop being a mapping).
 *
 * @param lines The file's lines.
 * @param node The mapping.
 * @param key The key.
 * @param where What the node is, for a refusal.
 * @returns The splice, or why the key cannot be deleted.
 */
export function deleteKey(
  lines: readonly string[],
  node: MapNode,
  key: string,
  where: string,
): Splice | string {
  const size = node.kind === "flow" ? node.keys.length : node.keys.size;
  const has = node.kind === "flow" ? node.keys.includes(key) : node.keys.has(key);
  if (!has) return `${where} has no ${key}`;
  if (size === 1) return `${key} is the only key of ${where}`;
  if (node.kind === "flow") return flowRemove(lines, node.flow, node.keys.indexOf(key));
  const entry = node.keys.get(key)!;
  if (entry.start !== node.opener) return cut(entry);
  const next = [...node.keys.values()].find((e) => e.start === entry.end);
  if (!next) return `${key} of ${where} opens its line and cannot be removed in place`;
  const line = lines[entry.start].slice(0, entry.indent) + lines[next.start].slice(next.indent);
  return { at: entry.start, remove: next.start + 1 - entry.start, insert: [line] };
}

/**
 * Set one key of a mapping node to a whole value (a collection, or null): its lines replaced —
 * its head as written and its comment kept — or the key appended.
 *
 * @param lines The file's lines.
 * @param node The mapping.
 * @param key The key.
 * @param value Its new parsed value.
 * @returns The splice.
 */
export function setEntry(
  lines: readonly string[],
  node: MapNode,
  key: string,
  value: unknown,
): Splice {
  if (node.kind === "flow") {
    const item = `${yamlKey(key)}: ${flowText(value)}`;
    const at = node.keys.indexOf(key);
    return at === -1 ? flowAdd(node.flow, item) : flowUpdate(node.flow, at, item);
  }
  const entry = node.keys.get(key);
  if (!entry) return { at: node.end, remove: 0, insert: emitEntry(key, value, node.indent) };
  const line = lines[entry.start];
  const tail = commentTail(line.slice(entry.valueCol)) ?? "";
  const insert = emitEntry(key, value, entry.indent, { head: line.slice(0, entry.headEnd), tail });
  return { at: entry.start, remove: entry.end - entry.start, insert };
}
