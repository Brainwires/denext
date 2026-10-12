// `useTableChanges` — the browser side of realtime from the database: a subscription on the Live
// socket to the backend's realtime channel, keyed by the table, a fresh random nonce and the
// filter, and a row list kept up to date from `initial` by the changes the server sends (each
// row re-read under this viewer's row-level security). Imports no server code.

import { useEffect, useRef, useState } from "@denext/denext";
import { subscribeChannel } from "@denext/denext/live";
import {
  encodeSubscriptionKey,
  newNonce,
  parseFilter,
  REALTIME_CHANNEL_ID,
  type TableChange,
  type TableChangesFrame,
  type TableFilter,
} from "./realtime-shared.ts";

/** Options for {@linkcode useTableChanges}. */
export interface UseTableChangesOptions<Row> {
  /** A one-column equality filter: `{ list_id: 42 }` or Supabase's `"list_id=eq.42"`. */
  filter?: TableFilter;
  /**
   * The rows to start from — typically read during SSR with `db()` (so under the same
   * policies). A new array (a re-read after `stale`) replaces the hook's rows.
   */
  initial?: Row[];
  /** The rows' key column, as configured for the table (default `"id"`). */
  key?: string;
  /** `false` keeps the hook idle (no subscription). Default true. */
  enabled?: boolean;
  /** Called with each batch of changes, in commit order. */
  onChange?: (changes: TableChange<Row>[]) => void;
  /**
   * Called when changes may have been missed (a reconnect, a burst too large, the server's
   * database connection dropped): re-read the rows and pass them as `initial`.
   */
  onResync?: () => void;
}

/** Why the subscription is not delivering. */
export interface TableChangesError {
  /** `denied` (not authorized, the table is not configured, or realtime is unsupported on the
   * server), `limit`, `bad-filter`, … */
  code: string;
  /** A short explanation. */
  message: string;
}

/** What {@linkcode useTableChanges} returns. */
export interface TableChangesState<Row> {
  /** The rows: `initial` with every change applied (a new row is appended). */
  rows: Row[];
  /** The latest batch of changes. */
  changes: TableChange<Row>[];
  /** `idle`, `subscribed` (acknowledged), `live` (a change arrived), or `error`. */
  status: "idle" | "subscribed" | "live" | "error";
  /** Changes may have been missed since `initial`: re-read (cleared by a new `initial`). */
  stale: boolean;
  /** The failure, when `status` is `error`. */
  error?: TableChangesError;
}

/** The text key of a row. */
function keyOf(row: unknown, column: string): string {
  return String((row as Record<string, unknown> | null)?.[column]);
}

/**
 * Apply a batch of changes to rows (exported for tests and for apps keeping their own state).
 *
 * @param rows The current rows.
 * @param changes The changes.
 * @param column The key column.
 * @returns The new rows (the input is not modified).
 */
export function applyTableChanges<Row>(
  rows: readonly Row[],
  changes: readonly TableChange<Row>[],
  column = "id",
): Row[] {
  const byKey = new Map<string, Row>();
  for (const row of rows) byKey.set(keyOf(row, column), row);
  for (const change of changes) {
    if (change.op === "delete") {
      byKey.delete(change.key);
      continue;
    }
    if (change.op === "update" && change.oldKey !== undefined) byKey.delete(change.oldKey);
    if (change.row !== undefined) byKey.set(change.key, change.row);
  }
  return [...byKey.values()];
}

/**
 * Keep a list of a realtime table's rows live: start from `initial` (read during SSR) and apply
 * every insert, update and delete this viewer may see. The server re-reads each changed row as
 * this viewer, so only rows their SELECT policies (and the filter) return arrive; a row that
 * leaves their view arrives as a delete.
 *
 * ```tsx
 * "use client";
 * import { useTableChanges } from "@denext/backend/client";
 *
 * export function Notes({ initial }: { initial: Note[] }) {
 *   const { rows, stale } = useTableChanges<Note>("notes", { initial });
 *   return <ul>{rows.map((n) => <li key={n.id}>{n.body}</li>)}</ul>;
 * }
 * ```
 *
 * Delivery is at-most-once: after a reconnect or a lost frame `stale` turns true (and
 * `onResync` runs) — re-read and pass the rows as `initial`. Rows are kept in arrival order;
 * sort them when you render. A row too large for one frame arrives with `truncated: true` and no
 * `row`: re-read it.
 *
 * @param table A table from `realtime({ tables })`.
 * @param options `filter`, `initial`, `key`, `enabled`, `onChange`, `onResync`.
 * @returns `{ rows, changes, status, stale, error }`.
 */
export function useTableChanges<Row = Record<string, unknown>>(
  table: string,
  options: UseTableChangesOptions<Row> = {},
): TableChangesState<Row> {
  const column = options.key ?? "id";
  const [state, setState] = useState<TableChangesState<Row>>(() => ({
    rows: options.initial ? [...options.initial] : [],
    changes: [],
    status: "idle",
    stale: false,
  }));
  const callbacks = useRef(options);
  callbacks.current = options;
  const enabled = options.enabled ?? true;
  const filterKey = JSON.stringify(options.filter ?? null);

  // A new `initial` array (a re-read) replaces the rows and clears `stale`.
  const firstInitial = useRef(true);
  useEffect(() => {
    if (firstInitial.current) {
      firstInitial.current = false;
      return;
    }
    setState((s) => ({ ...s, rows: options.initial ? [...options.initial] : [], stale: false }));
    // deno-lint-ignore no-explicit-any
  }, [options.initial] as any);

  useEffect(() => {
    if (!enabled) return;
    let key: string;
    try {
      key = encodeSubscriptionKey({
        table,
        nonce: newNonce(),
        filter: parseFilter(options.filter),
      });
    } catch (error) {
      setState((s) => ({
        ...s,
        status: "error",
        error: { code: "bad-filter", message: (error as Error).message },
      }));
      return;
    }
    let lastSeq = 0;
    let readies = 0;
    const markStale = () => {
      setState((s) => ({ ...s, stale: true }));
      callbacks.current.onResync?.();
    };
    return subscribeChannel(
      REALTIME_CHANNEL_ID,
      key,
      (value) => {
        const frame = value as TableChangesFrame<Row>;
        const gap = lastSeq !== 0 && frame.seq !== lastSeq + 1;
        lastSeq = frame.seq;
        if (frame.resync || gap) markStale();
        const changes = frame.changes ?? [];
        if (changes.length === 0) return;
        setState((s) => ({
          ...s,
          rows: applyTableChanges(s.rows, changes, column),
          changes,
          status: "live",
          error: undefined,
        }));
        callbacks.current.onChange?.(changes);
      },
      (info) =>
        setState((s) => ({
          ...s,
          status: "error",
          error: { code: info.code, message: info.reason ?? info.code },
        })),
      () => {
        // A second acknowledgement is a re-subscribe after a reconnect: changes made while the
        // socket was down were not delivered.
        if (++readies > 1) markStale();
        setState((s) => (s.status === "idle" ? { ...s, status: "subscribed" } : s));
      },
    );
    // deno-lint-ignore no-explicit-any
  }, [table, filterKey, enabled, column] as any);

  return state;
}
