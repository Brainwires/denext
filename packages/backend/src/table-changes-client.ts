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
  qualifiedTableName,
  REALTIME_CHANNEL_ID,
  type TableChange,
  type TableChangesFrame,
  type TableEvent,
  type TableFilter,
} from "./realtime-shared.ts";

/** Options for {@linkcode useTableChanges}. */
export interface UseTableChangesOptions<Row> {
  /**
   * A one-column filter: `{ list_id: 42 }`, `{ priority: { gte: 3 } }`,
   * `{ status: { in: ["open", "blocked"] } }`, or Supabase's `"list_id=eq.42"` /
   * `"priority=gte.3"` / `"status=in.(open,blocked)"` (`eq neq lt lte gt gte in`).
   */
  filter?: TableFilter;
  /**
   * The kinds of change to apply and report (default all): `insert` (a row entered this
   * viewer's view), `update`, `delete` (a row left it) and `truncate`.
   */
  events?: TableEvent[];
  /**
   * The rows to start from — typically read during SSR with `db()` (so under the same
   * policies). A new array (a re-read after `stale`) replaces the hook's rows.
   */
  initial?: Row[];
  /**
   * The table's schema (default `public`): a table opted in by the publication outside `public`,
   * or a configured table with a `schema`.
   */
  schema?: string;
  /** The rows' key column, as configured for the table (default `"id"`). */
  key?: string;
  /** `false` keeps the hook idle (no subscription). Default true. */
  enabled?: boolean;
  /** Called with each batch of changes, in commit order. */
  onChange?: (changes: TableChange<Row>[]) => void;
  /**
   * Called when changes may have been missed (a reconnect the server could not replay, a burst
   * too large, the server's database connection dropped): re-read the rows and pass them as
   * `initial`.
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

/**
 * How long a re-subscribe after a reconnect waits for the server's `resumed` (or `resync`)
 * before treating the subscription as lost: the server answers in the same flush as its
 * acknowledgement, so only a subscription it no longer holds (or a very slow link) reaches this.
 */
const RESUME_WAIT_MS = 10_000;

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
    if (change.op === "truncate") {
      byKey.clear();
      continue;
    }
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
 * After a reconnect the server replays what this viewer missed while the connection was down
 * (re-read under their policies), when it still holds the subscription and its journal covers
 * the gap (`realtime({ replay })`, 60 seconds by default). Otherwise — or after a lost frame —
 * `stale` turns true (and `onResync` runs): re-read and pass the rows as `initial`. Rows are kept
 * in arrival order; sort them when you render. A row too large for one frame arrives with
 * `truncated: true` and no `row`: re-read it.
 *
 * @param table A table from `realtime({ tables })`.
 * @param options `filter`, `events`, `schema`, `initial`, `key`, `enabled`, `onChange`, `onResync`.
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
  const eventsKey = options.events ? [...options.events].sort().join(",") : "";

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
        table: qualifiedTableName(table, options.schema),
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
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    const markStale = () => {
      setState((s) => ({ ...s, stale: true }));
      callbacks.current.onResync?.();
    };
    const settleResume = () => {
      clearTimeout(resumeTimer);
      resumeTimer = undefined;
    };
    const unsubscribe = subscribeChannel(
      REALTIME_CHANNEL_ID,
      key,
      (value) => {
        const frame = value as TableChangesFrame<Row>;
        const gap = lastSeq !== 0 && frame.seq !== lastSeq + 1;
        lastSeq = frame.seq;
        if (frame.resumed || frame.resync) settleResume();
        if (frame.resync || gap) markStale();
        const wanted = callbacks.current.events;
        const changes = (frame.changes ?? []).filter((change) =>
          !wanted || wanted.includes(change.op)
        );
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
        // A second acknowledgement is a re-subscribe after a reconnect: the server answers with
        // `resumed` (what was missed follows) or `resync`; silence means it lost the subscription.
        if (++readies > 1) {
          settleResume();
          resumeTimer = setTimeout(() => {
            resumeTimer = undefined;
            markStale();
          }, RESUME_WAIT_MS);
        }
        setState((s) => (s.status === "idle" ? { ...s, status: "subscribed" } : s));
      },
    );
    return () => {
      settleResume();
      unsubscribe();
    };
    // deno-lint-ignore no-explicit-any
  }, [table, options.schema, filterKey, eventsKey, enabled, column] as any);

  return state;
}
