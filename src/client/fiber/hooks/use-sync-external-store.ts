// useSyncExternalStore on the client fiber dispatcher, in its own module so an app that never
// calls it ships none of it (see ../hooks-dispatcher.ts). Linked by the public hook,
// src/runtime/hooks/use-sync-external-store.ts.

// It imports nothing of the reconciler: what it needs is the client dispatcher's
// {@linkcode ClientHookHost} members, which the public hook hands it.

import type { DependencyList } from "../../../compat/react-types.ts";
import type { CommitEffect, HookCell } from "../fiber.ts";
import { HK_STORE } from "../hook-kinds.ts";
import type { ClientHookHost } from "../hooks-dispatcher.ts";

/**
 * Whether a store's snapshot differs from the last-rendered one. A `getSnapshot` that
 * THROWS here (e.g. a store read that asserts on a value transiently absent mid-notify,
 * as @effect/atom does) is treated as "changed" — exactly as React's
 * `checkIfSnapshotChanged` does — so the throw is NOT allowed to escape the store's
 * notify callback (where it is uncatchable and tears the tree down). Forcing a
 * re-render instead lets the throw (if it still occurs) surface during render, where an
 * error boundary can catch it; usually the store has settled by then and it does not.
 */
function snapshotChanged(cell: HookCell, getSnapshot: () => unknown): boolean {
  try {
    return !Object.is(getSnapshot(), cell.value);
  } catch {
    return true;
  }
}

/** `depsChanged(prev, [subscribe])` without allocating the one-element array every render. */
function subscribeChanged(prev: DependencyList | undefined, subscribe: unknown): boolean {
  return prev === undefined || prev.length !== 1 || !Object.is(prev[0], subscribe);
}

/**
 * The commit-phase entry that subscribes a `useSyncExternalStore` cell. Subscribe (and
 * re-subscribe on Offscreen reconnect) via one thunk so a hidden store subscription is
 * torn down and rebuilt like any other effect. Two-pass commit entry: the prior
 * subscription is torn down in the cleanup pass (before any setup), and this render's
 * subscribe runs in the setup pass.
 *
 * The subscription is marked satisfied (`cell.deps`) ONLY once it actually commits — NOT
 * during render. A render can be abandoned before commit (a transition interrupted by a
 * sync update, or superseded by a re-render while a subtree mounts). Because the hook
 * cell is shared across the fiber's two buffers, setting `cell.deps` at render time
 * would let the abandoned render mark the (stable) subscribe as already-scheduled, so
 * the committed re-render sees depsChanged=false and never subscribes — the store then
 * never notifies that consumer (Base UI's dialog popup/viewport, which re-render as
 * their contents mount, vs a leaf backdrop that commits its first render cleanly).
 * Setting it in the commit means an abandoned render leaves `cell.deps` untouched so
 * the committed one re-queues.
 *
 * After subscribing the snapshot is re-checked: a store mutation landing between this
 * render's snapshot read and the subscribe would otherwise be missed (React re-checks
 * here too). This also drives the post-hydration sync from the server snapshot to the
 * live client value (H3b).
 */
function storeSubscriptionEffect(
  host: ClientHookHost,
  cell: HookCell,
  subscribe: (onChange: () => void) => () => void,
  changed: () => boolean,
): CommitEffect {
  // Always SYNC, never the transition lane, even when the store's notify fires inside a
  // startTransition — React's `forceStoreRerender` does the same (see scheduleStoreUpdate).
  // Splitting one store mutation's subscribers across lanes tears the tree.
  const notify = () => {
    if (changed()) host.storeUpdate(cell.owner!);
  };
  const mount = () => {
    cell.cleanup = subscribe(notify);
  };
  const entry: CommitEffect = (() => {
    cell.reconnect = mount;
    cell.deps = [subscribe];
    // Inside a hidden <Activity>: subscribe on reveal, not now (see `parkingEffects`).
    if (host.parking()) {
      cell.disconnected = true;
      return;
    }
    mount();
    notify();
  }) as CommitEffect;
  entry.cleanup = () => {
    if (typeof cell.cleanup === "function") cell.cleanup();
  };
  return entry;
}

/** A store subscription's snapshot check, against `getSnapshot` as of this subscribe. */
function storeChangeCheck(cell: HookCell, getSnapshot: () => unknown): () => boolean {
  return () => snapshotChanged(cell, getSnapshot);
}

/**
 * `useSyncExternalStore` for the component the client reconciler is rendering.
 *
 * @param host The client dispatcher.
 * @param subscribe Registers a change listener; returns its unsubscribe.
 * @param getSnapshot Reads the store's current value.
 * @param getServerSnapshot The value the server rendered, read while hydrating.
 * @returns The snapshot this render shows.
 */
export function clientUseSyncExternalStore<T>(
  host: ClientHookHost,
  subscribe: (onChange: () => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot?: () => T,
): T {
  const inst = host.fiber();
  const cell = host.cell(HK_STORE);
  // The subscription's notify closure is created ONCE (only when `subscribe` changes —
  // a stable store keeps the same subscribe, so the closure never re-runs). It must
  // therefore NOT capture `inst`: after a double-buffer swap the render-time fiber is
  // the STALE buffer, and `scheduleUpdate` on it can no-op (its `.return` chain /
  // rootHandleOf is stale). Track the live fiber on the cell each render — exactly as
  // useState/useReducer do (see stateCell) — and read it at notify time so the update
  // always targets the current buffer.
  cell.owner = inst;
  // During hydration the client render must reproduce the server HTML, which was
  // built from getServerSnapshot — read it here too, or a store whose server and
  // client snapshots differ (matchMedia, cookie-seeded theme, Redux/Zustand SSR
  // state) causes a content flip / mismatch (H3). After hydration the subscription
  // effect reconciles to the live client snapshot.
  const value = host.hydrating() && getServerSnapshot ? getServerSnapshot() : getSnapshot();
  cell.value = value;
  if (subscribeChanged(cell.deps, subscribe)) {
    host.passive(
      inst,
      storeSubscriptionEffect(host, cell, subscribe, storeChangeCheck(cell, getSnapshot)),
    );
  }
  return value;
}
