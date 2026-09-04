// The client hook dispatcher: the per-render hook cells behind useState/useReducer/
// useEffect/…/useSyncExternalStore, installed by renderComponent for the duration
// of one component render.

import { devHydrationActive } from "./fiber-utils.ts";
import { duringRender, renderLanes, scheduleUpdate, scheduleUpdateLane } from "./scheduler.ts";

import { nextId } from "../../jsx/tree-id.ts";
import type { DependencyList } from "../../compat/react-types.ts";
import {
  type Context,
  depsChanged,
  type Dispatcher,
  MEMO_CACHE_SENTINEL,
} from "../../runtime/hooks.ts";
import { type CommitEffect, type Fiber, type HookCell, NoLane, TransitionLane } from "./fiber.ts";
import { isHydrating } from "./hydration.ts";

/** The component fiber currently rendering (backs the hook dispatcher). */
export let currentFiber: Fiber | null = null;
/** Index of the next hook cell the rendering component will read. */
export let hookIndex = 0;
/**
 * Set true when the currently-rendering component updates its OWN state during its
 * OWN render (React's render-phase-update idiom — e.g. Base UI's dialog transition
 * adjusting derived state from a prop change). renderComponent converges the
 * component locally instead of scheduling a whole-tree re-render + commit.
 */
export let renderPhaseUpdateScheduled = false;

/** Point the dispatcher at `inst` (or restore a previous fiber + cursor after a render). */
export function enterComponentRender(inst: Fiber | null, index: number): void {
  currentFiber = inst;
  hookIndex = index;
}

/** Rewind the hook cursor for a (re-)render pass and clear the render-phase-update flag. */
export function resetHookCursor(): void {
  hookIndex = 0;
  renderPhaseUpdateScheduled = false;
}

// Hook kinds — a per-cell tag consumed only by the dev Fast Refresh signature guard
// (see renderComponent). Distinct constant per hook so a same-count reorder across an
// edit is detected, not just a changed count.
const HK_STATE = 1;
const HK_REDUCER = 2;
const HK_EFFECT = 3;
const HK_MEMO = 4;
const HK_REF = 5;
const HK_ID = 6;
const HK_STORE = 7;
const HK_MEMOCACHE = 8;
const HK_DEFERRED = 9;
const HK_LAYOUT = 10;
const HK_INSERTION = 11;

function getHook(kind: number): HookCell {
  const inst = currentFiber!;
  const hooks = inst.hooks!;
  if (hookIndex >= hooks.length) hooks.push({});
  const cell = hooks[hookIndex++];
  // Tag the cell's hook kind (one int write) so a refresh swap can compare the full
  // hook sequence, not just its length. Prod never refresh-swaps, so it's only ever
  // read in dev; the write is negligible.
  cell.kind = kind;
  return cell;
}

/**
 * Queue an effect for `cell` when its deps changed. Under a StrictMode subtree in
 * development, a mount effect is immediately unmounted and remounted (setup →
 * cleanup → setup) to surface missing cleanup, matching React.
 */
function scheduleEffect(
  inst: Fiber,
  queue: CommitEffect[],
  cell: HookCell,
  effect: () => (() => void) | void,
  deps?: DependencyList,
  offscreenAware = true,
): void {
  if (!depsChanged(cell.deps, deps)) return;
  const strictMount = cell.mounted !== true && inst.strict === true && devHydrationActive();
  cell.mounted = true;
  // A thunk that runs this render's setup and stores its cleanup — the unit both
  // the initial mount and an Offscreen reconnect re-run.
  const mount = () => {
    cell.cleanup = effect();
  };
  // The commit runs all effects' cleanups (below) BEFORE any of their setups —
  // React's ordering, so e.g. a sibling that releases a shared resource in cleanup
  // runs before the sibling that acquires it in setup. The setup pass captures the
  // Offscreen reconnect thunk and performs the StrictMode double-invoke.
  const entry: CommitEffect = (() => {
    mount();
    // Remember how to rebuild this effect after an Offscreen hide tore it down.
    // Insertion effects are excluded — they aren't part of the offscreen cycle.
    if (offscreenAware) cell.reconnect = mount;
    if (strictMount) {
      if (typeof cell.cleanup === "function") cell.cleanup();
      mount();
    }
  }) as CommitEffect;
  // Runs in the commit's cleanup pass: reads cell.cleanup, which at that point is
  // still the PREVIOUS render's teardown (the setup pass overwrites it).
  entry.cleanup = () => {
    if (typeof cell.cleanup === "function") cell.cleanup();
  };
  queue.push(entry);
  cell.deps = deps ? [...deps] : undefined;
}

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
  cell: HookCell,
  subscribe: (onChange: () => void) => () => void,
  changed: () => boolean,
): CommitEffect {
  const notify = () => {
    if (changed()) scheduleUpdate(cell.owner!);
  };
  const mount = () => {
    cell.cleanup = subscribe(notify);
  };
  const entry: CommitEffect = (() => {
    mount();
    cell.reconnect = mount;
    cell.deps = [subscribe];
    notify();
  }) as CommitEffect;
  entry.cleanup = () => {
    if (typeof cell.cleanup === "function") cell.cleanup();
  };
  return entry;
}

/**
 * The cell for a stateful hook (useState/useReducer): initialised once from `init`, and
 * re-pointed at the live fiber every render so its setter keeps targeting the live
 * buffer across the double-buffer swap.
 */
function stateCell(kind: number, init: () => unknown): HookCell {
  const cell = getHook(kind);
  if (!cell.inited) {
    cell.value = init();
    cell.inited = true;
  }
  cell.owner = currentFiber!;
  return cell;
}

/**
 * Commit a stateful hook's next value and schedule its owner. A render-phase update
 * (the owning component setting its own state while it renders) is converged locally
 * by re-invoking the render instead of scheduling. Setter identities are created ONCE
 * and reused every render — React guarantees a stable setter (Base UI and others put
 * it in effect/memo deps; a fresh closure per render would re-fire those effects and
 * loop) — so they read cell.value/cell.owner live at call time.
 */
function commitCellUpdate(cell: HookCell, next: unknown): void {
  if (Object.is(next, cell.value)) return;
  cell.value = next;
  const f = cell.owner!;
  if (duringRender && f === currentFiber) renderPhaseUpdateScheduled = true;
  else scheduleUpdate(f);
}

export const clientDispatcher: Dispatcher = {
  useState<S>(initial: S | (() => S)): [S, (v: S | ((p: S) => S)) => void] {
    const cell = stateCell(
      HK_STATE,
      () => typeof initial === "function" ? (initial as () => S)() : initial,
    );
    if (cell.updater === undefined) {
      cell.updater = (v: unknown) =>
        commitCellUpdate(cell, typeof v === "function" ? (v as (p: S) => S)(cell.value as S) : v);
    }
    return [cell.value as S, cell.updater as (v: S | ((p: S) => S)) => void];
  },

  useReducer<S, A, I>(reducer: (s: S, a: A) => S, initialArg: I, init?: (arg: I) => S) {
    const cell = stateCell(HK_REDUCER, () => init ? init(initialArg) : initialArg);
    cell.reducer = reducer as (s: unknown, a: unknown) => unknown; // always use the latest reducer
    if (cell.updater === undefined) {
      // Stable dispatch identity (React guarantee), created once; uses the latest reducer.
      cell.updater = (action: unknown) =>
        commitCellUpdate(cell, (cell.reducer as (s: S, a: A) => S)(cell.value as S, action as A));
    }
    return [cell.value as S, cell.updater as (a: A) => void];
  },

  useEffect(effect, deps?: DependencyList) {
    const inst = currentFiber!;
    scheduleEffect(inst, inst.passiveEffects!, getHook(HK_EFFECT), effect, deps);
  },

  useMemo<T>(factory: () => T, deps?: DependencyList): T {
    const cell = getHook(HK_MEMO);
    if (!("value" in cell) || depsChanged(cell.deps, deps)) {
      cell.value = factory();
      cell.deps = deps ? [...deps] : undefined;
    }
    return cell.value as T;
  },

  useRef<T>(initial: T) {
    const cell = getHook(HK_REF);
    if (!("value" in cell)) cell.value = { current: initial };
    return cell.value as { current: T };
  },

  useContext<T>(context: Context<T>): T {
    const inst = currentFiber!;
    // Record the dependency so the memo bailout re-renders this fiber only when a
    // context it reads changed value (tracked whether or not a provider is present —
    // a provider appearing/disappearing above flips get(id) between value and
    // undefined, which the bailout's value compare then catches).
    (inst.readContexts ??= new Set()).add(context._id);
    if (inst.inherited.has(context._id)) {
      return inst.inherited.get(context._id) as T;
    }
    return context._defaultValue;
  },

  useId(): string {
    const cell = getHook(HK_ID);
    if (!cell.inited) {
      // Derived from the fiber's tree position (set at its first render), so it
      // matches the server render / hole / island regardless of streaming order.
      cell.value = nextId(currentFiber!.idScope!);
      cell.inited = true;
    }
    return cell.value as string;
  },

  useSyncExternalStore<T>(
    subscribe: (onChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T {
    const inst = currentFiber!;
    const cell = getHook(HK_STORE);
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
    const value = isHydrating && getServerSnapshot ? getServerSnapshot() : getSnapshot();
    cell.value = value;
    if (depsChanged(cell.deps, [subscribe])) {
      inst.passiveEffects!.push(
        storeSubscriptionEffect(cell, subscribe, () => snapshotChanged(cell, getSnapshot)),
      );
    }
    return value;
  },

  useMemoCache(size: number): unknown[] {
    const cell = getHook(HK_MEMOCACHE);
    if (!cell.inited) {
      cell.value = new Array(size).fill(MEMO_CACHE_SENTINEL);
      cell.inited = true;
    }
    return cell.value as unknown[];
  },

  useDeferredValue<T>(value: T, initialValue?: T): T {
    const inst = currentFiber!;
    const cell = getHook(HK_DEFERRED);
    if (!cell.inited) {
      cell.inited = true;
      // First render: show initialValue (if given and different) and schedule a
      // transition to catch up to the real value; otherwise show value.
      if (initialValue !== undefined && !Object.is(initialValue, value)) {
        cell.value = initialValue;
        scheduleUpdateLane(inst, TransitionLane);
        return initialValue;
      }
      cell.value = value;
      return value;
    }
    // A transition render accepts the latest value; an urgent render where the
    // value changed returns the previous value and schedules the catch-up
    // transition (so the deferred update is time-sliced, not blocking).
    if ((renderLanes & TransitionLane) !== NoLane) {
      cell.value = value;
      return value;
    }
    if (!Object.is(value, cell.value)) {
      scheduleUpdateLane(inst, TransitionLane);
      return cell.value as T;
    }
    return cell.value as T;
  },

  // denext commits effects synchronously. useLayoutEffect runs in the post-mutation
  // layout phase; useInsertionEffect runs in its own pre-mutation phase (before any
  // DOM mutation), so CSS-in-JS style insertion precedes layout reads — matching React.
  useLayoutEffect(effect, deps?: DependencyList) {
    const inst = currentFiber!;
    scheduleEffect(inst, inst.pendingEffects!, getHook(HK_LAYOUT), effect, deps);
  },
  useInsertionEffect(effect, deps?: DependencyList) {
    const inst = currentFiber!;
    // Insertion effects sit outside the Offscreen connect/disconnect cycle.
    scheduleEffect(inst, inst.insertionEffects!, getHook(HK_INSERTION), effect, deps, false);
  },
};
