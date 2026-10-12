// Shared by the realtime server and `@denext/backend/client`: the change shapes, the frame a
// subscriber receives, and the subscription key — no server imports, so it is safe in a browser.
//
// A browser subscribes to the backend's one channel with a key naming the table, a random nonce
// that makes the subscription its own (the server binds it to the subscriber's identity), and an
// optional one-column equality filter: `notes|Q2xhdWRlIGlzIGhlcmU|list_id|42`.

/** The channel every `useTableChanges` subscription rides (one per app). */
export const REALTIME_CHANNEL_ID = "denext.backend.realtime";

/** The Postgres NOTIFY channel the triggers send on. */
export const REALTIME_NOTIFY_CHANNEL = "denext_realtime";

/** A change kind a table can be opted in for. */
export type TableEvent = "insert" | "update" | "delete";

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

/** A one-column equality filter: `{ list_id: 42 }`, or Supabase's `"list_id=eq.42"`. */
export type TableFilter = Record<string, string | number | boolean | bigint> | string;

/** A parsed filter. */
export interface ParsedFilter {
  /** The column. */
  column: string;
  /** The value, compared as text (`column::text = value`). */
  value: string;
}

/** A plain, unquoted SQL identifier. */
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** The longest subscription key the Live hub accepts. */
const MAX_KEY = 128;

/**
 * Parse a filter.
 *
 * @param filter The filter, or `undefined`.
 * @returns The column and value, or `undefined` for no filter.
 * @throws {TypeError} For anything but one column compared for equality.
 */
export function parseFilter(filter: TableFilter | undefined): ParsedFilter | undefined {
  if (filter === undefined) return undefined;
  if (typeof filter === "string") {
    const match = /^([A-Za-z_][A-Za-z0-9_]{0,62})=eq\.(.*)$/s.exec(filter);
    if (!match) {
      throw new TypeError(`realtime filter ${JSON.stringify(filter)}: use "column=eq.value"`);
    }
    return { column: match[1], value: match[2] };
  }
  const entries = Object.entries(filter ?? {});
  if (entries.length !== 1) {
    throw new TypeError("realtime filter: one column, compared for equality ({ column: value })");
  }
  const [column, value] = entries[0];
  if (!IDENTIFIER.test(column)) {
    throw new TypeError(`realtime filter: ${JSON.stringify(column)} is not a plain column name`);
  }
  if (!["string", "number", "boolean", "bigint"].includes(typeof value)) {
    throw new TypeError(
      `realtime filter: the value of ${column} must be a string, number or boolean`,
    );
  }
  return { column, value: String(value) };
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
  const key = parts.filter
    ? `${head}|${parts.filter.column}|${encodeURIComponent(parts.filter.value)}`
    : head;
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
  if (parts.length !== 2 && parts.length !== 4) return null;
  const [table, nonce, column, encoded] = parts;
  if (!IDENTIFIER.test(table) || !/^[A-Za-z0-9_-]{16,43}$/.test(nonce)) return null;
  if (parts.length === 2) return { table, nonce };
  if (!IDENTIFIER.test(column)) return null;
  try {
    return { table, nonce, filter: { column, value: decodeURIComponent(encoded) } };
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
