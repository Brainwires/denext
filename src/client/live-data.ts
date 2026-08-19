/**
 * Live-data hooks — real-time server data and presence over the Live WebSocket.
 *
 * - {@link useLive} subscribes to a server function's result and re-renders whenever
 *   one of its cache tags is invalidated (from anywhere — a Server Action, a webhook,
 *   a cron), with no polling and no client data-fetching library.
 * - {@link usePresence} gives who's-online / cursors over the same socket.
 * - {@link useLiveOptimistic} pairs an optimistic overlay with a live value so a
 *   local update is reconciled when the authoritative value arrives.
 *
 * Exported from `@denext/denext/live` (opt-in), so apps that don't use them bundle
 * none of the transport. Client-only: during SSR they return their initial value.
 *
 * @module
 */

import { useCallback, useEffect, useOptimistic, useRef, useState } from "../runtime/hooks.ts";
import type { LivePeer } from "../runtime/live-protocol.ts";
import { joinPresence, subscribeLiveData } from "./live-client.ts";

/** A reference to a server function usable as a live query (a `serverAction`). */
export interface LiveActionRef<A extends unknown[], R> {
  (...args: A): Promise<R>;
  /** The stable id the hub re-invokes under the viewer's session. */
  readonly denextActionId: string;
}

/** Options for {@linkcode useLive}. */
export interface UseLiveOptions<R> {
  /** Cache tags whose invalidation should push a fresh value. */
  tags: string[];
  /** Initial value used during SSR and before the first push. */
  initial?: R;
}

/**
 * Subscribe to a server function's result, re-rendering whenever one of `options.tags`
 * is invalidated. The function runs on the server under the viewer's own session (it
 * must authorize its own access, like any server action). Pass a **read** action.
 *
 * @param action A `serverAction` used as a live query.
 * @param args Arguments for the action.
 * @param options `tags` to watch, and an optional SSR `initial` value.
 * @returns The latest value (or `initial` during SSR / before the first push).
 * @example
 * ```tsx
 * "use client";
 * import { useLive } from "@denext/denext/live";
 * import { recentOrders } from "./actions.ts"; // a serverAction
 *
 * export function Orders({ initial }: { initial: Order[] }) {
 *   const orders = useLive(recentOrders, [], { tags: ["orders"], initial });
 *   return <ul>{orders?.map((o) => <li key={o.id}>{o.total}</li>)}</ul>;
 * }
 * ```
 */
export function useLive<A extends unknown[], R>(
  action: LiveActionRef<A, R>,
  args: A,
  options: UseLiveOptions<R>,
): R | undefined {
  const [value, setValue] = useState<R | undefined>(options.initial);
  // Re-subscribe when the action, args, or tags change (compared structurally).
  const key = JSON.stringify([action.denextActionId, args, options.tags]);
  useEffect(() => {
    return subscribeLiveData(action.denextActionId, args, options.tags, (v, err) => {
      if (!err) setValue(v as R);
    });
    // deno-lint-ignore no-explicit-any
  }, [key] as any);
  return value;
}

/** Options for {@linkcode usePresence}. */
export interface UsePresenceOptions<S> {
  /** This peer's initial presence state. */
  initialState?: S;
}

/** The presence of the current room, from {@linkcode usePresence}. */
export interface Presence<S> {
  /** This peer, if present in the room yet. */
  self: { id: string; state: S } | undefined;
  /** Every other peer in the room. */
  others: { id: string; state: S }[];
  /** All peers, including self. */
  peers: { id: string; state: S }[];
  /** Publish a new presence state for this peer. */
  setState: (state: S) => void;
}

/**
 * Join a presence room and observe its members (who's-online, cursors, typing…).
 * Orthogonal to cache tags — updates push on join/update/leave.
 *
 * @param room The room id (e.g. a document id).
 * @param options This peer's `initialState`.
 * @returns `{ self, others, peers, setState }`.
 * @example
 * ```tsx
 * "use client";
 * import { usePresence } from "@denext/denext/live";
 *
 * export function Cursors({ docId }: { docId: string }) {
 *   const { others, setState } = usePresence<{ x: number; y: number }>(docId, {
 *     initialState: { x: 0, y: 0 },
 *   });
 *   return <div onPointerMove={(e) => setState({ x: e.clientX, y: e.clientY })}>
 *     {others.map((p) => <Cursor key={p.id} at={p.state} />)}
 *   </div>;
 * }
 * ```
 */
export function usePresence<S>(
  room: string,
  options: UsePresenceOptions<S> = {},
): Presence<S> {
  const [peers, setPeers] = useState<LivePeer[]>([]);
  const [selfId, setSelfId] = useState<string>("");
  const controls = useRef<{ update: (state: unknown) => void; leave: () => void } | null>(null);
  const initial = options.initialState;

  useEffect(() => {
    const handle = joinPresence(room, initial, (p, sid) => {
      setPeers(p);
      setSelfId(sid);
    });
    controls.current = handle;
    return () => {
      handle.leave();
      controls.current = null;
    };
    // deno-lint-ignore no-explicit-any
  }, [room] as any);

  const setState = useCallback((state: S) => controls.current?.update(state), []);
  const typed = peers as { id: string; state: S }[];
  return {
    self: typed.find((p) => p.id === selfId),
    others: typed.filter((p) => p.id !== selfId),
    peers: typed,
    setState,
  };
}

/**
 * Pair an optimistic overlay with a live value: apply a local update immediately,
 * and let it reconcile automatically when the authoritative value arrives over the
 * socket (the overlay resets whenever `liveValue`'s identity changes).
 *
 * @param liveValue The authoritative value (typically from {@link useLive}).
 * @param reducer Fold an optimistic action into the current value.
 * @returns `[optimisticValue, applyOptimistic]`.
 */
export function useLiveOptimistic<T, A>(
  liveValue: T,
  reducer: (current: T, action: A) => T,
): [T, (action: A) => void] {
  return useOptimistic(liveValue, reducer);
}
