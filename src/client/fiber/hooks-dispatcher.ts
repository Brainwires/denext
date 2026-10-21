// The client hook dispatcher: the per-render hook cells behind useState/useEffect/useMemo/…,
// installed by renderComponent for the duration of one component render.
//
// Only the hooks every app reaches live on the dispatcher object. useReducer, useId,
// useSyncExternalStore, useDeferredValue, useMemoCache and useInsertionEffect each live in their
// own module under ./hooks/, imported by the public hook (src/runtime/hooks/) — so an app that
// never calls one ships none of its code: an object keeps every method it is given, a module's
// unused function is dropped. Those modules build on the {@linkcode ClientHookHost} members of
// this dispatcher, which the public hook hands them; they import nothing of the reconciler, so a
// lazily loaded chunk that calls one of those hooks reaches no reconciler file (one that did would
// split the startup chunks along that edge — see plans' "bundler places code by FILE").

import { devHydrationActive } from "./fiber-utils.ts";
import { ERR_MORE_HOOKS, reconcilerError } from "./errors.ts";
import { componentDisplayName } from "../../runtime/react-brands.ts";
import {
  duringRender,
  renderLanes,
  scheduleStoreUpdate,
  scheduleUpdate,
  scheduleUpdateLane,
} from "./scheduler.ts";
import { HK_EFFECT, HK_LAYOUT, HK_MEMO, HK_REF, HK_STATE } from "./hook-kinds.ts";

import type { DependencyList } from "../../compat/react-types.ts";
import { type Context, depsChanged, type Dispatcher } from "../../runtime/hooks.ts";
import {
  type CommitEffect,
  type Fiber,
  fiberExt,
  hasBit,
  HasEffect,
  type HookCell,
  NoLane,
  type QueuedEffect,
  StrictBit,
  TransitionLane,
} from "./fiber.ts";
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

/**
 * Rewind the hook cursor for a (re-)render pass and clear the render-phase-update flag.
 * The pass's dev `useDebugValue` records are dropped too, so a StrictMode second pass or a
 * render-phase re-run re-records them instead of appending duplicates (production never
 * sets the slot, so this is one read).
 */
export function resetHookCursor(): void {
  hookIndex = 0;
  renderPhaseUpdateScheduled = false;
  const x = currentFiber?.ext;
  if (x !== undefined && x.debugValues !== undefined) x.debugValues = undefined;
}

/**
 * Set for the StrictMode second render pass: hook cells are re-read, no NEW effect entries
 * are queued (the first pass's entries — which carry the StrictMode setup→cleanup→setup —
 * are the ones committed). Cleared when a render-phase update discards a pass.
 */
let suppressEffectQueue = false;
export function setSuppressEffectQueue(on: boolean): void {
  suppressEffectQueue = on;
}

/** Set while a Fast Refresh swap re-renders an edited component (its hook count may change). */
let refreshSwapRender = false;
export function setRefreshSwapRender(on: boolean): void {
  refreshSwapRender = on;
}

/**
 * The rendering component's next hook cell, tagged with its hook `kind`.
 *
 * @param kind The hook kind (one of hook-kinds.ts's `HK_*` constants).
 * @returns The cell (created on the component's first render).
 */
function getHook(kind: number): HookCell {
  const inst = currentFiber!;
  const hooks = inst.hooks!;
  if (hookIndex >= hooks.length) {
    // An already-mounted component (it has a current fiber) rendering MORE hooks than last
    // time is a Rules-of-Hooks violation (a hook inside a condition/loop): React throws here,
    // and so does denext — silently growing the cell list would pair states with the wrong
    // hooks. A Fast Refresh swap of an edited component is the one legitimate growth.
    if (hooks.length > 0 && inst.alternate !== null && !refreshSwapRender) {
      throw reconcilerError(ERR_MORE_HOOKS, componentDisplayName(inst.vnode.type));
    }
    hooks.push({});
  }
  const cell = hooks[hookIndex++];
  // Tag the cell's hook kind (one int write) so a refresh swap can compare the full
  // hook sequence, not just its length. Prod never refresh-swaps, so it's only ever
  // read in dev; the write is negligible.
  cell.kind = kind;
  return cell;
}

/**
 * Set while the commit PARKS the queued effects of a hidden `<Activity>` subtree (see
 * `parkEffects` in commit.ts): an entry run then records its setup as the cell's disconnected
 * `reconnect` thunk instead of running it, so the effect first mounts when the Activity is
 * revealed — React 19.2 mounts no effect inside a hidden Activity.
 */
let parking = false;

/** Turn effect parking on/off (commit.ts, around a hidden Activity's queued entries). */
export function setParkingEffects(on: boolean): void {
  parking = on;
}

/** The fiber field an effect is queued on; the insertion queue lives on its `FiberExt`. */
type EffectQueue = "passiveEffects" | "pendingEffects" | "insertionEffects";

/**
 * Run `cell`'s most recently committed setup and store its cleanup — the unit an effect's
 * mount, its StrictMode re-mount and an Offscreen reconnect all run.
 */
function mountEffect(cell: HookCell): void {
  cell.cleanup = cell.create!();
}

/**
 * A hook effect queued for the commit: plain data and two prototype methods, where a queued
 * effect used to be three closures plus a copy of its deps.
 *
 * The commit runs every entry's {@linkcode HookEffect.cleanup} (the PREVIOUS render's teardown,
 * still on the cell) before any entry's {@linkcode HookEffect.run} — React's ordering, so e.g. a
 * sibling that releases a shared resource in cleanup runs before the sibling that acquires it
 * in setup.
 */
class HookEffect implements QueuedEffect {
  constructor(
    readonly cell: HookCell,
    readonly create: () => (() => void) | void,
    readonly deps: DependencyList | undefined,
    readonly strictMount: boolean,
    readonly offscreenAware: boolean,
  ) {}

  cleanup(): void {
    const teardown = this.cell.cleanup;
    if (typeof teardown === "function") teardown();
  }

  run(): void {
    const cell = this.cell;
    // This render's deps, recorded on the cell when the effect COMMITS (React's semantics):
    // a render that is discarded (interrupted, or re-run by a render-phase update) must not
    // leave the cell believing its deps already match the values that never took effect.
    cell.deps = this.deps;
    cell.create = this.create;
    // Remember how to rebuild this effect after an Offscreen hide tore it down. Insertion
    // effects are excluded — they aren't part of the offscreen cycle.
    if (this.offscreenAware) {
      cell.reconnect = mountEffect;
      // Inside a hidden <Activity>: mount nothing now; the reveal reconnects it.
      if (parking) {
        cell.disconnected = true;
        return;
      }
    }
    mountEffect(cell);
    if (this.strictMount) {
      if (typeof cell.cleanup === "function") cell.cleanup();
      mountEffect(cell);
    }
  }
}

/**
 * Queue an effect for `cell` when its deps changed. Under a StrictMode subtree in
 * development, a mount effect is immediately unmounted and remounted (setup →
 * cleanup → setup) to surface missing cleanup, matching React.
 */
function scheduleEffect(
  inst: Fiber,
  queue: EffectQueue,
  cell: HookCell,
  effect: () => (() => void) | void,
  deps?: DependencyList,
  offscreenAware = true,
): void {
  if (suppressEffectQueue || !depsChanged(cell.deps, deps)) return;
  const strictMount = cell.mounted !== true && hasBit(inst, StrictBit) && devHydrationActive();
  cell.mounted = true;
  const entry = new HookEffect(cell, effect, deps, strictMount, offscreenAware);
  if (queue === "insertionEffects") (fiberExt(inst).insertionEffects ??= []).push(entry);
  else (inst[queue] ??= []).push(entry);
  // Mark the fiber as effect-bearing so the commit-phase collectors can prune to it
  // (bubbleFlags propagates this into ancestors' subtreeFlags at completeWork).
  inst.flags |= HasEffect;
}

/**
 * The cell for a stateful hook (useState/useReducer), initialised by the caller on its first
 * render (`inited`), re-pointed at the live fiber every render so its setter keeps targeting
 * the live buffer across the double-buffer swap.
 */
function stateCell(cell: HookCell): HookCell {
  cell.inited = true;
  cell.owner = currentFiber!;
  cell.rendered = cell.value; // what this render reads (see HookCell.rendered)
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
  else scheduleUpdate(f, true);
}

// The closures below are built in their own functions, never inline in a hook: a hook body
// with a capturing closure allocates its context on EVERY call, even when the closure itself
// is created only once (mount) or only when deps changed.

/** useState's setter for `cell` (created once per cell). */
function stateSetter(cell: HookCell): (v: unknown) => void {
  return (v) => commitCellUpdate(cell, typeof v === "function" ? v(cell.value) : v);
}

/**
 * What the per-hook client modules (./hooks/) build on: members of the client dispatcher, handed to
 * them by the public hook, so they import nothing of the reconciler. Short names: a property name
 * survives minification, and these ship in every app.
 */
export interface ClientHookHost extends Dispatcher {
  /** The rendering component's next hook cell, tagged with `kind` (hook-kinds.ts). */
  cell(kind: number): HookCell;
  /** The component fiber rendering now. */
  fiber(): Fiber;
  /** Re-point a stateful hook's cell at the live fiber for this render (useState's). */
  stateCell(cell: HookCell): HookCell;
  /** Commit a stateful hook's next value and schedule its owner (useState's). */
  commitCell(cell: HookCell, next: unknown): void;
  /** Queue an insertion effect for `cell` (outside the Offscreen connect/disconnect cycle). */
  insertion(cell: HookCell, effect: () => (() => void) | void, deps?: DependencyList): void;
  /** Whether this render is on the transition lane. */
  inTransition(): boolean;
  /** Schedule `fiber` on the transition lane. */
  deferUpdate(fiber: Fiber): void;
  /** Whether the reconciler is hydrating server HTML. */
  hydrating(): boolean;
  /** Whether the commit is parking a hidden `<Activity>` subtree's effects (see `parking`). */
  parking(): boolean;
  /** Schedule an external-store subscriber at sync priority. */
  storeUpdate(fiber: Fiber): void;
  /** Queue a commit-phase entry on `fiber`'s passive effects and flag it effect-bearing. */
  passive(fiber: Fiber, entry: CommitEffect): void;
}

export const clientDispatcher: ClientHookHost = {
  cell: getHook,
  fiber: () => currentFiber!,
  stateCell,
  commitCell: commitCellUpdate,
  insertion: (cell, effect, deps) =>
    scheduleEffect(currentFiber!, "insertionEffects", cell, effect, deps, false),
  inTransition: () => (renderLanes & TransitionLane) !== NoLane,
  deferUpdate: (fiber) => scheduleUpdateLane(fiber, TransitionLane),
  hydrating: () => isHydrating,
  parking: () => parking,
  storeUpdate: scheduleStoreUpdate,
  passive: (fiber, entry) => {
    (fiber.passiveEffects ??= []).push(entry);
    // This push bypasses scheduleEffect, so flag the effect-bearing fiber here too.
    fiber.flags |= HasEffect;
  },

  useState<S>(initial: S | (() => S)): [S, (v: S | ((p: S) => S)) => void] {
    const hook = getHook(HK_STATE);
    if (!hook.inited) {
      hook.value = typeof initial === "function" ? (initial as () => S)() : initial;
    }
    const cell = stateCell(hook);
    cell.updater ??= stateSetter(cell);
    return [cell.value as S, cell.updater as (v: S | ((p: S) => S)) => void];
  },

  useEffect(effect, deps?: DependencyList) {
    const inst = currentFiber!;
    scheduleEffect(inst, "passiveEffects", getHook(HK_EFFECT), effect, deps);
  },

  useMemo<T>(factory: () => T, deps?: DependencyList): T {
    const cell = getHook(HK_MEMO);
    if (!("value" in cell) || depsChanged(cell.deps, deps)) {
      cell.value = factory();
      cell.deps = deps; // by reference, as React keeps them (each render passes a fresh array)
    }
    return cell.value as T;
  },

  // useMemo's cell (same kind, so the Fast Refresh signature is unchanged) holding `fn` itself:
  // no `() => fn` factory closure per call.
  useCallback<T>(fn: T, deps?: DependencyList): T {
    const cell = getHook(HK_MEMO);
    if (!("value" in cell) || depsChanged(cell.deps, deps)) {
      cell.value = fn;
      cell.deps = deps;
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

  // denext commits effects synchronously. useLayoutEffect runs in the post-mutation
  // layout phase (useInsertionEffect, ./hooks/use-insertion-effect.ts, in its own
  // pre-mutation phase before it).
  useLayoutEffect(effect, deps?: DependencyList) {
    const inst = currentFiber!;
    scheduleEffect(inst, "pendingEffects", getHook(HK_LAYOUT), effect, deps);
  },
};

/**
 * `useDebugValue`'s recorder. Cell-free on purpose: no getHook, so adding/removing a call never
 * changes the hook signature the Fast Refresh guard compares. `format` is stored and applied
 * lazily by the inspector. Dev only: {@linkcode installDebugValues} puts it on the dispatcher,
 * and without it the public `useDebugValue` is a no-op (the dispatcher has no method).
 */
function recordDebugValue(value: unknown, format?: (value: unknown) => unknown): void {
  if (!devHydrationActive()) return;
  const inst = currentFiber;
  if (inst === null) return;
  (fiberExt(inst).debugValues ??= []).push({ index: hookIndex, value, format });
}

/**
 * Install (`true`) or remove (`false`) the client dispatcher's `useDebugValue` recorder. Called
 * from the dev path only (`installDevtools`, via `installStrictMode`), so a production bundle
 * never contains it.
 */
export function installDebugValues(on = true): void {
  const d = clientDispatcher as { useDebugValue?: typeof recordDebugValue };
  if (on) d.useDebugValue = recordDebugValue;
  else delete d.useDebugValue;
}
