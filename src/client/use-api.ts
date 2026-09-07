// `useApi` — the typed API client as a hook.
//
//   const { data, error, pending, refetch } = useApi("/api/user/[id]", "GET", { params: { id } });
//
// Typed end to end against the registered `.denext/api.ts` schema (path, method, params, query,
// body, response, error codes). Two modes:
// - **Default:** `useSyncExternalStore` over a small entry store; the fetch starts in an effect
//   on the client, so SSR renders `pending: true` and never fetches (Next's `useEffect` data
//   fetching, but typed and deduped).
// - **`suspense: true`:** `use()` on the entry's promise. On the server the call runs IN-PROCESS
//   (the typed client's dispatcher) inside the nearest `<Suspense>`, and the fulfilled value is
//   recorded under the hook's `useId()` into the `#__denext_state` island (Flight routes, where
//   signal collection runs); the client adopts it before its first render, so it hydrates with
//   the data and never refetches. On an isomorphic route (no signal island) it fetches on mount.
//
// Where entries live is the security-relevant part: in the browser one module-level table,
// ref-counted by mounted hooks (an entry is dropped when its last hook unmounts and it is not
// in flight); during SSR the current request's own memo — two renders never share an entry.
//
// Tag invalidation: pass `tags` and, when a Live transport is present (`useApiLive` from
// `denext/live`, or any Live feature configured), the server pushes an `invalidate` frame when
// one of the tags is revalidated and the hook refetches. Without a transport the option is a
// no-op with a one-time dev warning — this module never imports the socket, so an app that
// doesn't use Live bundles none of it.

import { useEffect, useId, useSyncExternalStore } from "../runtime/hooks.ts";
import { use } from "../runtime/suspense.ts";
import { adoptedSignal, recordSignal } from "../runtime/signal-state.ts";
import {
  type ApiClient,
  type ApiClientError,
  type ApiSchema,
  createApiClient,
  type ErrorsOf,
  type HttpMethod,
  isApiClientError,
  type RegisteredSchema,
  type RequestOf,
  type ResponseOf,
} from "../runtime/api-client.ts";
import { decodeWire, prepareWire, stableKey } from "../runtime/wire-codec.ts";

/** Options for {@link useApi}. */
export interface UseApiOptions {
  /** Cache tags: a Live `invalidate` for any of them refetches (needs a Live transport). */
  tags?: string[];
  /** Suspend (`use()`) instead of returning `pending`; SSR runs the call in-process. */
  suspense?: boolean;
  /**
   * `false` skips fetching: the result stays idle, which reads as `pending: true` with no
   * data — gate rendering on your own `enabled` condition, not on `pending`. Default true.
   */
  enabled?: boolean;
  /** The client to call through (default: a shared `createApiClient()`). */
  client?: ApiClient<ApiSchema>;
}

/** What {@link useApi} returns. */
export interface UseApiResult<T, E extends string> {
  /** The last successful response body, or `undefined`. */
  data: T | undefined;
  /** The last failure, or `undefined`. */
  error: ApiClientError<E> | undefined;
  /** True until the first result arrives (and during a refetch with no prior data). */
  pending: boolean;
  /** Fetch again (dedupe applies); resolves when settled, never rejects. */
  refetch: () => Promise<void>;
  /** Mark stale and refetch if any hook is mounted on this entry. */
  invalidate: () => void;
}

/** Subscribes to tag invalidations; installed by the Live transport. Returns an unsubscribe. */
export type ApiInvalidationSource = (tags: string[], onInvalidate: () => void) => () => void;

let invalidationSource: ApiInvalidationSource | null = null;

/**
 * Install the transport that delivers tag invalidations to `useApi({ tags })` (the Live
 * client does this in `configureLive` / `useApiLive`).
 *
 * @param source The subscriber, or `null` to remove it.
 */
export function setApiInvalidationSource(source: ApiInvalidationSource | null): void {
  invalidationSource = source;
}

// ── Entry store ──────────────────────────────────────────────────────────────

type Status = "idle" | "pending" | "fulfilled" | "rejected";

interface Entry {
  status: Status;
  promise: Promise<unknown> | null;
  value: unknown;
  error: ApiClientError | undefined;
  version: number;
  refs: number;
  listeners: Set<() => void>;
  snapshot: Snapshot | null;
  /** The store key (so a fetch that settles after the last hook unmounted can drop the entry). */
  key: string;
  /** Set when the last hook unmounted while a fetch was in flight. */
  orphan: boolean;
}

interface Snapshot {
  data: unknown;
  error: ApiClientError | undefined;
  pending: boolean;
}

const browserStore = new Map<string, Entry>();
const STORE_KEY = Symbol.for("denext.useApi.store");

interface ContextBridge {
  __denextCurrentRequestContext?: () => { memo?: Map<unknown, Map<string, unknown>> } | undefined;
}

/** True on the server (the bridge is installed there and never in a browser bundle). */
function isServer(): boolean {
  return !!(globalThis as ContextBridge).__denextCurrentRequestContext;
}

/** The browser's table, or the current request's own table during SSR. */
function storeFor(): Map<string, Entry> {
  const memo = (globalThis as ContextBridge).__denextCurrentRequestContext?.()?.memo;
  if (!memo) return browserStore;
  let table = memo.get(STORE_KEY) as unknown as Map<string, Entry> | undefined;
  if (!table) memo.set(STORE_KEY, (table = new Map()) as unknown as Map<string, unknown>);
  return table;
}

function entryFor(store: Map<string, Entry>, key: string): Entry {
  let e = store.get(key);
  if (!e) {
    e = {
      status: "idle",
      promise: null,
      value: undefined,
      error: undefined,
      version: 0,
      refs: 0,
      listeners: new Set(),
      snapshot: null,
      key,
      orphan: false,
    };
    store.set(key, e);
  }
  return e;
}

function bump(e: Entry): void {
  e.version++;
  e.snapshot = null;
  for (const l of e.listeners) l();
}

/** Start (or join) the fetch for an entry. */
function startFetch(e: Entry, run: () => Promise<unknown>): Promise<unknown> {
  if (e.status === "pending" && e.promise) return e.promise;
  e.status = "pending";
  e.snapshot = null;
  // Only the LATEST fetch may settle the entry: an `invalidate()` that raced an in-flight
  // request must not be overwritten by the older (stale) response landing later.
  const settle = (apply: () => void) => {
    if (e.promise !== p) return;
    apply();
    bump(e);
    if (e.orphan && e.refs <= 0) storeFor().delete(e.key);
  };
  const p: Promise<unknown> = run().then(
    (value) => {
      settle(() => {
        e.status = "fulfilled";
        e.value = value;
        e.error = undefined;
      });
      return value;
    },
    (err: unknown) => {
      settle(() => {
        e.status = "rejected";
        e.error = isApiClientError(err) ? err : wrapUnknown(err);
      });
      throw err;
    },
  );
  e.promise = p;
  p.catch(() => {}); // the rejection is observed through `error` / `use()`, not here
  bump(e);
  return p;
}

function wrapUnknown(err: unknown): ApiClientError {
  const e = err instanceof Error ? err : new Error(String(err));
  return Object.assign(e, { name: "ApiClientError", status: 0, code: "http_error" }) as never;
}

function snapshotOf(e: Entry): Snapshot {
  if (!e.snapshot) {
    e.snapshot = {
      data: e.value,
      error: e.error,
      pending: e.status === "idle" || (e.status === "pending" && e.value === undefined),
    };
  }
  return e.snapshot;
}

let sharedClient: ApiClient<ApiSchema> | null = null;
function defaultClient(): ApiClient<ApiSchema> {
  return sharedClient ??= createApiClient<ApiSchema>();
}

let warnedNoTransport = false;
function warnNoTransport(): void {
  if (warnedNoTransport) return;
  warnedNoTransport = true;
  console.warn(
    "denext: useApi({ tags }) needs the Live transport to receive invalidations — use " +
      '`useApiLive` from "denext/live" for that call. Tags are ignored.',
  );
}

// ── The hook ─────────────────────────────────────────────────────────────────

/** The registered schema's entry for one route + method (what `useApi` is typed against). */
export type ApiEndpointOf<
  P extends keyof RegisteredSchema & string,
  M extends keyof RegisteredSchema[P],
> = NonNullable<RegisteredSchema[P][M]>;

/**
 * Call one of the app's own route handlers from a component, typed end to end.
 *
 * @param path The route pattern (`"/api/user/[id]"`).
 * @param method The HTTP method the route exports.
 * @param opts Params / query / body for the call (typed by the schema).
 * @param options Tags, suspense, enabled, client.
 * @returns The typed data / error / pending state plus `refetch` and `invalidate`.
 */
export function useApi<
  P extends keyof RegisteredSchema & string,
  M extends keyof RegisteredSchema[P] & HttpMethod,
>(
  path: P,
  method: M,
  opts?: RequestOf<ApiEndpointOf<P, M>>,
  options: UseApiOptions = {},
): UseApiResult<ResponseOf<ApiEndpointOf<P, M>>, ErrorsOf<ApiEndpointOf<P, M>>> {
  const id = useId();
  const enabled = options.enabled ?? true;
  const o = (opts ?? {}) as { params?: unknown; query?: unknown; body?: unknown };
  const key = stableKey([path, method, o.params, o.query, o.body]);
  const store = storeFor();
  const entry = entryFor(store, key);
  const client = options.client ?? defaultClient();
  const run = () => (client as (...a: unknown[]) => Promise<unknown>)(path, method, opts);
  const start = () => startFetch(entry, run);

  // Ref count: the entry lives while a hook is mounted on it (or a fetch is in flight).
  useEffect(() => {
    entry.refs++;
    entry.orphan = false;
    return () => {
      entry.refs--;
      if (entry.refs > 0) return;
      if (entry.status !== "pending") store.delete(key);
      else entry.orphan = true; // dropped when the in-flight fetch settles
    };
  }, [entry]);

  // Tag invalidation through the installed transport.
  const tagsKey = options.tags?.join(" ") ?? "";
  useEffect(() => {
    if (!tagsKey) return;
    if (!invalidationSource) return warnNoTransport();
    return invalidationSource(options.tags!, () => {
      entry.status = "idle";
      if (entry.refs > 0) void start();
    });
  }, [entry, tagsKey]);

  // Default mode: fetch on the client after mount.
  useEffect(() => {
    if (!options.suspense && enabled && entry.status === "idle") void start();
  }, [entry, enabled, options.suspense]);

  const snap = useSyncExternalStore(
    (onChange) => {
      entry.listeners.add(onChange);
      return () => entry.listeners.delete(onChange);
    },
    () => snapshotOf(entry),
    () => snapshotOf(entry),
  );

  const refetch = () => start().then(() => {}, () => {});
  const invalidate = () => {
    entry.status = "idle";
    entry.promise = null; // an in-flight response may no longer settle the entry
    if (entry.refs > 0) void start();
  };

  if (options.suspense && enabled) {
    const data = suspend(entry, id, start) as ResponseOf<ApiEndpointOf<P, M>>;
    return { data, error: undefined, pending: false, refetch, invalidate };
  }
  return {
    data: snap.data as ResponseOf<ApiEndpointOf<P, M>> | undefined,
    error: snap.error as ApiClientError<ErrorsOf<ApiEndpointOf<P, M>>> | undefined,
    pending: snap.pending,
    refetch,
    invalidate,
  };
}

/**
 * Suspense mode. Server: run in-process (the dispatcher), record the value under `id` for the
 * client. Client: adopt the recorded value on the first render (no refetch), else fetch.
 */
function suspend(entry: Entry, id: string, start: () => Promise<unknown>): unknown {
  if (entry.status === "idle" && !adoptSeed(entry, id)) void start();
  if (entry.status === "idle") return use(entry.promise!);
  if (entry.status === "fulfilled") {
    if (isServer()) recordForClient(entry, id);
    return entry.value;
  }
  if (entry.status === "rejected") throw entry.error;
  return use(entry.promise!);
}

/**
 * Client first render: adopt the value the server recorded under `id` — but only for the SAME
 * call. `useId()` is position-derived, so after a param change (state, a soft navigation) the
 * same id would otherwise hand a new entry the previous call's data, and never fetch.
 */
function adoptSeed(entry: Entry, id: string): boolean {
  if (isServer()) return false;
  const seeded = adoptedSignal(id);
  if (!seeded) return false;
  const boxed = seeded.value as { v: unknown; enc?: 1; k?: string } | null;
  if (!boxed || boxed.k !== entry.key) return false;
  entry.status = "fulfilled";
  entry.value = boxed.enc === 1 ? decodeWire(boxed.v) : boxed.v;
  entry.snapshot = null;
  return true;
}

/** Server: record the fulfilled value under `id` (codec-encoded when needed), keyed to its call. */
function recordForClient(entry: Entry, id: string): void {
  const p = prepareWire(entry.value);
  recordSignal(id, p.tagged ? { v: p.value, enc: 1, k: entry.key } : { v: p.value, k: entry.key });
}
