// Shared by the realtime server and `@denext/backend/client`: the change shapes, the frame a
// subscriber receives, and the subscription key — no server imports, so it is safe in a browser.
//
// A browser subscribes to the backend's one channel with a key naming the table, a random nonce
// that makes the subscription its own (the server binds it to the subscriber's identity), and an
// optional one-column filter: `notes|Q2xhdWRlIGlzIGhlcmU|list_id|42` (equality), or
// `notes|Q2xhdWRlIGlzIGhlcmU|list_id|lt|42` for another operator (`in` carries a JSON array).

/** The channel every `useTableChanges` subscription rides (one per app). */
export const REALTIME_CHANNEL_ID = "denext.backend.realtime";

/** The Postgres NOTIFY channel the triggers send on. */
export const REALTIME_NOTIFY_CHANNEL = "denext_realtime";

/** A change kind a table can be opted in for. */
export type TableEvent = "insert" | "update" | "delete" | "truncate";

/** A filter operator: Supabase Realtime's set (`eq neq lt lte gt gte in`). */
export type FilterOp = "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "in";

/** Every {@linkcode FilterOp}. */
const FILTER_OPS: readonly FilterOp[] = ["eq", "neq", "lt", "lte", "gt", "gte", "in"];

/** The most values an `in` filter takes (Supabase's limit). */
const MAX_IN_VALUES = 100;

/** One change to one row, as a subscriber receives it. */
export type TableChange<Row = Record<string, unknown>> =
  | {
    /**
     * A row entered this subscriber's view: inserted, or updated so that their policies (and
     * filter) now match it.
     */
    op: "insert";
    /** The row's key (its key column, as text). */
    key: string;
    /** The row as this subscriber's SELECT policies return it (absent when `truncated`). */
    row?: Row;
    /** The row was too large for one frame: re-read it yourself. */
    truncated?: true;
  }
  | {
    /** A row this subscriber already knew about was updated (and they can still see it). */
    op: "update";
    /** The row's key. */
    key: string;
    /** The key before the update, when the update changed it. */
    oldKey?: string;
    /** The row as this subscriber's SELECT policies return it (absent when `truncated`). */
    row?: Row;
    /**
     * The row before the update — only for a table configured with `old: "full"`, and only when
     * it fitted the notification (see the docs' size limits).
     */
    old?: Partial<Row>;
    /** The row was too large for one frame: re-read it yourself. */
    truncated?: true;
  }
  | {
    /**
     * A row this subscriber had been sent (or could see when it subscribed) was deleted, or
     * updated so that their policies or their filter no longer match it.
     */
    op: "delete";
    /** The row's key. */
    key: string;
    /** The deleted row — only for a table configured with `old: "full"` (see `update.old`). */
    old?: Partial<Row>;
  }
  | {
    /** The table was truncated: every row this subscriber had is gone. */
    op: "truncate";
    /** No key: every row went. */
    key?: undefined;
    /** No row. */
    row?: undefined;
  };

/** One frame on the realtime channel. */
export interface TableChangesFrame<Row = Record<string, unknown>> {
  /** Per-subscription sequence, from 1: a gap means frames were lost. */
  seq: number;
  /** The changes, in commit order (one entry per key per burst: the latest wins). */
  changes?: TableChange<Row>[];
  /** Changes were lost (a burst too large, the database connection dropped): re-read. */
  resync?: true;
}

/** A value a filter compares against. */
export type FilterValue = string | number | boolean | bigint;

/**
 * A one-column filter: `{ list_id: 42 }` (equality), `{ priority: { gte: 3 } }`,
 * `{ status: { in: ["open", "blocked"] } }`, or Supabase's string form — `"list_id=eq.42"`,
 * `"priority=gte.3"`, `"status=in.(open,blocked)"`.
 */
export type TableFilter =
  | Record<string, FilterValue | { [op in FilterOp]?: FilterValue | FilterValue[] }>
  | string;

/** A parsed filter. */
export interface ParsedFilter {
  /** The column. */
  column: string;
  /** The operator; absent means `eq`. */
  op?: Exclude<FilterOp, "eq">;
  /** The value, as text (cast to the column's type when compared). For `in`, its JSON list. */
  value: string;
  /** The values of an `in` filter. */
  values?: string[];
}

/** A plain, unquoted SQL identifier. */
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** The longest subscription key the Live hub accepts. */
const MAX_KEY = 128;

/** Build a parsed filter (validating the operator and an `in` list). */
function filterOf(column: string, op: FilterOp, value: string | string[]): ParsedFilter {
  if (op === "in") {
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0 || values.length > MAX_IN_VALUES) {
      throw new TypeError(`realtime filter: in takes 1 to ${MAX_IN_VALUES} values`);
    }
    return { column, op, value: JSON.stringify(values), values };
  }
  if (Array.isArray(value)) throw new TypeError(`realtime filter: ${op} takes one value`);
  return op === "eq" ? { column, value } : { column, op, value };
}

/**
 * The values of Supabase's `in.(a,b,"c,d")` list: comma-separated, a value may be double-quoted
 * (to hold a comma or a parenthesis; `\"` escapes a quote inside one).
 */
function inValues(list: string): string[] {
  const match = /^\((.*)\)$/s.exec(list);
  if (!match) throw new TypeError(`realtime filter: in takes a list, "in.(a,b)"`);
  // Each value: a quoted one (`\"` escapes a quote) or a bare run without a comma, then a comma
  // or the end. Anything else (a quote left open, text after a closing quote) is malformed.
  const item = /\s*(?:"((?:[^"\\]|\\.)*)"|([^,"]*))\s*(,|$)/sy;
  const values: string[] = [];
  const body = match[1];
  item.lastIndex = 0;
  while (item.lastIndex <= body.length) {
    const start = item.lastIndex;
    const part = item.exec(body);
    if (!part) throw new TypeError("realtime filter: malformed in list");
    values.push(part[1] !== undefined ? part[1].replace(/\\(.)/gs, "$1") : part[2].trim());
    if (part[3] === "" || item.lastIndex === start) break;
  }
  return values;
}

/** One filter value, checked. */
function filterText(column: string, value: unknown): string {
  if (!["string", "number", "boolean", "bigint"].includes(typeof value)) {
    throw new TypeError(
      `realtime filter: the value of ${column} must be a string, number or boolean`,
    );
  }
  return String(value);
}

/** The object form: `{ column: value }` or `{ column: { op: value } }`. */
function objectFilter(filter: Exclude<TableFilter, string>): ParsedFilter {
  const entries = Object.entries(filter ?? {});
  if (entries.length !== 1) {
    throw new TypeError(
      "realtime filter: one column ({ column: value } or { column: { op: value } })",
    );
  }
  const [column, spec] = entries[0];
  if (!IDENTIFIER.test(column)) {
    throw new TypeError(`realtime filter: ${JSON.stringify(column)} is not a plain column name`);
  }
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    return filterOf(column, "eq", filterText(column, spec));
  }
  const ops = Object.entries(spec);
  const [op, value] = ops[0] ?? [];
  if (ops.length !== 1 || !FILTER_OPS.includes(op as FilterOp)) {
    throw new TypeError(`realtime filter: one operator of ${FILTER_OPS.join(", ")} per filter`);
  }
  return filterOf(
    column,
    op as FilterOp,
    Array.isArray(value) ? value.map((v) => filterText(column, v)) : filterText(column, value),
  );
}

/**
 * Parse a filter.
 *
 * @param filter The filter, or `undefined`.
 * @returns The column, operator and value, or `undefined` for no filter.
 * @throws {TypeError} For anything but one column compared with one of {@linkcode FILTER_OPS}.
 */
export function parseFilter(filter: TableFilter | undefined): ParsedFilter | undefined {
  if (filter === undefined) return undefined;
  if (typeof filter !== "string") return objectFilter(filter);
  const match = /^([A-Za-z_][A-Za-z0-9_]{0,62})=([a-z]+)\.(.*)$/s.exec(filter);
  if (!match || !FILTER_OPS.includes(match[2] as FilterOp)) {
    throw new TypeError(
      `realtime filter ${JSON.stringify(filter)}: use "column=op.value" (op: ${
        FILTER_OPS.join(", ")
      })`,
    );
  }
  const op = match[2] as FilterOp;
  return filterOf(match[1], op, op === "in" ? inValues(match[3]) : match[3]);
}

/**
 * A filter in Supabase's string form (`column=op.value`; `in` quotes every value).
 *
 * @param filter The parsed filter.
 * @returns The string.
 */
export function formatFilter(filter: ParsedFilter): string {
  const op = filter.op ?? "eq";
  if (op !== "in") return `${filter.column}=${op}.${filter.value}`;
  const quoted = (filter.values ?? []).map((v) =>
    `"${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
  );
  return `${filter.column}=in.(${quoted.join(",")})`;
}

/** A subscription key's parts. */
export interface SubscriptionKey {
  /** The table, as configured in `realtime({ tables })`. */
  table: string;
  /** The subscriber's random nonce. */
  nonce: string;
  /** The filter, if any. */
  filter?: ParsedFilter;
}

/**
 * Build a subscription key.
 *
 * @param parts The table, the nonce and the filter.
 * @returns The key.
 * @throws {RangeError} When it is longer than the Live hub accepts (a very long filter value).
 */
export function encodeSubscriptionKey(parts: SubscriptionKey): string {
  const head = `${parts.table}|${parts.nonce}`;
  const filter = parts.filter;
  const key = !filter
    ? head
    : filter.op
    ? `${head}|${filter.column}|${filter.op}|${encodeURIComponent(filter.value)}`
    : `${head}|${filter.column}|${encodeURIComponent(filter.value)}`;
  if (key.length > MAX_KEY) {
    throw new RangeError(
      `realtime: the table, filter column and filter value must fit ${MAX_KEY} characters`,
    );
  }
  return key;
}

/**
 * Parse a subscription key (from the network: anything malformed is `null`).
 *
 * @param key The key.
 * @returns Its parts, or `null`.
 */
export function decodeSubscriptionKey(key: string): SubscriptionKey | null {
  if (typeof key !== "string" || key.length > MAX_KEY) return null;
  const parts = key.split("|");
  if (parts.length < 2 || parts.length > 5 || parts.length === 3) return null;
  const [table, nonce] = parts;
  if (!IDENTIFIER.test(table) || !/^[A-Za-z0-9_-]{16,43}$/.test(nonce)) return null;
  if (parts.length === 2) return { table, nonce };
  const filter = decodeFilter(parts.slice(2));
  return filter ? { table, nonce, filter } : null;
}

/** A key's filter parts — `column|value` (eq) or `column|op|value` — or `null` when malformed. */
function decodeFilter(parts: string[]): ParsedFilter | null {
  const [column] = parts;
  const op = (parts.length === 3 ? parts[1] : "eq") as FilterOp;
  if (!IDENTIFIER.test(column) || !FILTER_OPS.includes(op)) return null;
  if (op === "eq" && parts.length === 3) return null; // eq has the short form only
  try {
    const value = decodeURIComponent(parts[parts.length - 1]);
    if (op !== "in") return filterOf(column, op, value);
    const values = JSON.parse(value);
    if (!Array.isArray(values) || !values.every((v) => typeof v === "string")) return null;
    return filterOf(column, op, values);
  } catch {
    return null;
  }
}

/**
 * A fresh random nonce (128 bits, base64url): what makes a subscription key unguessable.
 *
 * @returns The nonce.
 */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
}
