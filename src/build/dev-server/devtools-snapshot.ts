// Sanitizing the DevTools snapshot a browser POSTs to `/_denext/dev-inspect`.
//
// This is the one dev endpoint that stores browser-supplied STRUCTURED data, and what it
// stores is rendered verbatim into an MCP agent's context by `denext_component_tree`,
// `denext_why_render` and `denext_hook_state`. So a shape check is not enough: a body that
// merely *looks* like a snapshot could still carry a 60 000-character component name, a
// `badges` array of objects (whose `.join` would throw inside the formatter), or a
// `source.file` that is a number. Any same-origin script on a dev page can post one.
//
// So nothing that arrives is stored. Every stored node is BUILT here, field by field, from
// coerced and clamped values: a string that is not a string is dropped, a string that is
// too long is cut, an array that is too long is truncated, and an optional field that
// cannot be coerced simply does not exist on the stored node. The required skeleton
// (`id`/`name`/`props`/`hooks`/`contexts`/`children`) is still a hard gate — a body
// missing it is not a snapshot at all, and the caller drops it silently.

import type { RenderReason, SourceLocation } from "../../client/devtools-inspect.ts";
import type {
  InspectSnapshot,
  InspectSnapshotNode,
  SnapshotContext,
  SnapshotHook,
  SnapshotValue,
} from "../../client/devtools-inspect-sink.ts";

/** Server-side re-check of the page's node cap (this is browser-supplied data). */
const MAX_SNAPSHOT_NODES = 4000;

/** Server-side re-check of the page's depth cap. */
const MAX_SNAPSHOT_DEPTH = 60;

/** Longest page URL a snapshot may be keyed by. */
const MAX_SNAPSHOT_URL = 2048;

/** Longest component/hook/context/badge-bearing name kept. */
const MAX_NAME = 200;

/** Longest React key kept. */
const MAX_KEY = 200;

/** How many badges a node may carry, and how long each may be. */
const MAX_BADGES = 16;
const MAX_BADGE = 40;

/** Longest `source.file` kept (a module URL), and longest `source.export`. */
const MAX_FILE = 1024;
const MAX_EXPORT = 200;

/** Longest value preview kept (the page's own previews are ~80 characters). */
const MAX_PREVIEW = 512;

/** How many hook cells / contexts / deps / value entries a node may carry. */
const MAX_HOOKS = 64;
const MAX_CONTEXTS = 32;
const MAX_DEPS = 32;
const MAX_ENTRIES = 32;

/** How deep a serialized value's `entries` chain is followed. */
const MAX_VALUE_DEPTH = 4;

/** How many changed prop/context names (or hook indices) a render reason may list. */
const MAX_REASON_ITEMS = 32;

/** The value type tags the inspector emits; anything else is stored as `object`. */
const VALUE_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "null",
  "undefined",
  "bigint",
  "symbol",
  "function",
  "array",
  "object",
]);

/** The walk's remaining node allowance; `ok` goes false the moment the body is not one. */
interface Budget {
  nodes: number;
  ok: boolean;
}

/** `v` as a string clamped to `max` characters, or undefined when it is not a string. */
function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" ? v.slice(0, max) : undefined;
}

/** `v` as a finite integer, or undefined when it is not a finite number. */
function int(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : undefined;
}

/** `v` as a plain record (an empty one when it is not an object), for field-by-field reads. */
function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? v as Record<string, unknown> : {};
}

/** `v` as an array of at most `max` clamped strings; non-strings are dropped. */
function strList(v: unknown, max: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, max).flatMap((s) => typeof s === "string" ? [s.slice(0, maxLen)] : []);
}

/** `v` as an array of at most `max` elements (empty when it is not an array). */
function list(v: unknown, max: number): unknown[] {
  return Array.isArray(v) ? v.slice(0, max) : [];
}

/**
 * One serialized value, rebuilt from coerced fields.
 *
 * @param v The posted value.
 * @param depth How many `entries` levels have been followed.
 * @returns A well-formed {@link SnapshotValue}, whatever arrived.
 */
function cleanValue(v: unknown, depth = 0): SnapshotValue {
  const o = rec(v);
  const type = typeof o.type === "string" && VALUE_TYPES.has(o.type)
    ? o.type as SnapshotValue["type"]
    : "object";
  const out: SnapshotValue = { preview: str(o.preview, MAX_PREVIEW) ?? "", type };
  const size = int(o.size);
  if (size !== undefined) out.size = size;
  const length = int(o.length);
  if (length !== undefined) out.length = length;
  if (depth < MAX_VALUE_DEPTH && Array.isArray(o.entries)) {
    out.entries = list(o.entries, MAX_ENTRIES).map((e) => ({
      key: str(rec(e).key, MAX_KEY) ?? "",
      value: cleanValue(rec(e).value, depth + 1),
    }));
  }
  return out;
}

/**
 * One hook cell, rebuilt from coerced fields.
 *
 * @param h The posted cell.
 * @param index Its position, used when the posted `index` is not a number.
 * @returns A well-formed {@link SnapshotHook}.
 */
function cleanHook(h: unknown, index: number): SnapshotHook {
  const o = rec(h);
  const out: SnapshotHook = {
    index: int(o.index) ?? index,
    kind: str(o.kind, MAX_NAME) ?? "hook",
    value: cleanValue(o.value),
    editable: o.editable === true,
  };
  if (Array.isArray(o.deps)) out.deps = list(o.deps, MAX_DEPS).map((d) => cleanValue(d));
  if (o.hasCleanup === true) out.hasCleanup = true;
  const name = str(o.name, MAX_NAME);
  if (name !== undefined) out.name = name;
  const hook = str(o.hook, MAX_NAME);
  if (hook !== undefined) out.hook = hook;
  return out;
}

/** One context read, rebuilt from coerced fields. */
function cleanContext(c: unknown): SnapshotContext {
  const o = rec(c);
  return { name: str(o.name, MAX_NAME) ?? "Context", value: cleanValue(o.value) };
}

/** A source location, rebuilt from coerced fields — dropped entirely without a `file`. */
function cleanSource(s: unknown): SourceLocation | undefined {
  if (s === null || typeof s !== "object") return undefined;
  const o = s as Record<string, unknown>;
  const file = str(o.file, MAX_FILE);
  if (file === undefined) return undefined;
  const out: SourceLocation = { file };
  const line = int(o.line);
  if (line !== undefined) out.line = line;
  const column = int(o.column);
  if (column !== undefined) out.column = column;
  const exported = str(o.export, MAX_EXPORT);
  if (exported !== undefined) out.export = exported;
  return out;
}

/** A render reason, rebuilt from coerced fields — dropped when it is not an object. */
function cleanReason(r: unknown): RenderReason | undefined {
  if (r === null || typeof r !== "object") return undefined;
  const o = r as Record<string, unknown>;
  return {
    props: strList(o.props, MAX_REASON_ITEMS, MAX_NAME),
    hooks: list(o.hooks, MAX_REASON_ITEMS).flatMap((h) => {
      const i = int(h);
      return i === undefined ? [] : [i];
    }),
    contexts: strList(o.contexts, MAX_REASON_ITEMS, MAX_NAME),
    count: int(o.count) ?? 0,
  };
}

/** Whether `o` carries the required snapshot-node skeleton (the hard gate). */
function hasSkeleton(o: Record<string, unknown>): boolean {
  return o.props !== null && typeof o.props === "object" &&
    Array.isArray(o.hooks) && Array.isArray(o.contexts) && Array.isArray(o.children);
}

/** Record that the body is not a snapshot, and stop the walk. */
function fail(budget: Budget): null {
  budget.ok = false;
  return null;
}

/** Attach the optional fields that survived coercion (absent ones simply do not exist). */
function optionals(out: InspectSnapshotNode, o: Record<string, unknown>): void {
  const badges = strList(o.badges, MAX_BADGES, MAX_BADGE);
  if (badges.length > 0) out.badges = badges;
  const source = cleanSource(o.source);
  if (source) out.source = source;
  if (typeof o.hooksNamed === "boolean") out.hooksNamed = o.hooksNamed;
  const reason = cleanReason(o.reason);
  if (reason) out.reason = reason;
}

/**
 * One snapshot node, BUILT from coerced fields — never the posted object.
 *
 * @param node The posted node.
 * @param depth Its depth in the tree.
 * @param budget The remaining node allowance (and the body-is-a-snapshot flag).
 * @returns The node to store, or null when the body is not a snapshot / ran past a cap.
 */
function cleanNode(node: unknown, depth: number, budget: Budget): InspectSnapshotNode | null {
  if (depth > MAX_SNAPSHOT_DEPTH || --budget.nodes < 0) return fail(budget);
  if (node === null || typeof node !== "object") return fail(budget);
  const o = node as Record<string, unknown>;
  const id = int(o.id);
  const name = str(o.name, MAX_NAME);
  if (id === undefined || name === undefined || !hasSkeleton(o)) return fail(budget);
  const out: InspectSnapshotNode = {
    id,
    name,
    key: str(o.key, MAX_KEY) ?? null,
    props: cleanValue(o.props),
    hooks: list(o.hooks, MAX_HOOKS).map(cleanHook),
    contexts: list(o.contexts, MAX_CONTEXTS).map(cleanContext),
    children: cleanNodes(o.children, depth + 1, budget),
  };
  optionals(out, o);
  return out;
}

/** Every posted child, rebuilt; the walk stops the moment one is not a snapshot node. */
function cleanNodes(v: unknown, depth: number, budget: Budget): InspectSnapshotNode[] {
  const out: InspectSnapshotNode[] = [];
  for (const child of list(v, MAX_SNAPSHOT_NODES)) {
    const node = cleanNode(child, depth, budget);
    if (!budget.ok) return out;
    if (node) out.push(node);
  }
  return out;
}

/**
 * Parse a posted body and rebuild it as a snapshot. A body that is not a well-formed
 * snapshot is rejected (the caller drops it silently, as the dev-log sink does) rather
 * than stored; one that IS well-formed is stored as freshly built, clamped fields, so no
 * string a page posted can reach an agent's context unbounded or mis-typed.
 *
 * @param body The raw request body.
 * @returns The snapshot to store, or null when the body is malformed or over the caps.
 */
export function parseSnapshot(body: string): InspectSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.url !== "string" || !Array.isArray(s.nodes)) return null;
  const budget: Budget = { nodes: MAX_SNAPSHOT_NODES, ok: true };
  const nodes = cleanNodes(s.nodes, 0, budget);
  if (!budget.ok) return null;
  return {
    url: s.url.slice(0, MAX_SNAPSHOT_URL),
    at: int(s.at) ?? Date.now(),
    truncated: s.truncated === true,
    nodes,
  };
}
