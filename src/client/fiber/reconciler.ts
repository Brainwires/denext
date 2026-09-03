/// <reference path="../../globals.d.ts" />
// The fiber reconciler core: hook dispatcher, the render phase (beginWork /
// completeWork over a work-in-progress tree), the commit phase (atomic DOM
// mutation + effects), the work loop (sync now; time-sliced transitions in a
// later stage), scheduling, error/suspense unwinding, hydration, and the public
// createRoot/hydrateRoot API. The renderer-agnostic pieces (props/events/refs,
// vnode helpers, context maps) come from the shared modules extracted in Stage 0.

import {
  FRAGMENT,
  PORTAL,
  type VNode,
  type VNodeChild,
  type VNodeChildren,
} from "../../jsx/types.ts";
import { enterScope, ID_PATH_PROP, nextId, rootScope } from "../../jsx/tree-id.ts";
import type { DependencyList } from "../../compat/react-types.ts";
import {
  type Context,
  depsChanged,
  type Dispatcher,
  type ErrorBoundaryController,
  MEMO_CACHE_SENTINEL,
  setBoundaryControllerProvider,
  setDispatcher,
  setTransitionScheduler,
} from "../../runtime/hooks.ts";
import { isThenable, SUSPENSE, SUSPENSE_LIST_PROP } from "../../runtime/suspense.ts";
import { PROVIDER } from "../../runtime/context.ts";
import { createFormStatusSignal, FormStatusContext } from "../../runtime/form-status.ts";
import { STRICT_MODE_PROP } from "../../runtime/strict-mode.ts";
import {
  PROFILER_PROP,
  type ProfilerOnRender,
  type ProfilerPhase,
} from "../../runtime/profiler.ts";
import {
  ERROR_BOUNDARY,
  isControlSignal,
  isRedirect,
  toError,
} from "../../runtime/error-boundary.ts";
import { applyProps, detachRef } from "../dom-props.ts";
import { stampFiber } from "../dom-fiber-map.ts";
import { FOREIGN_PROP } from "../../runtime/lazy-directive.ts";
import { Variable } from "../../runtime/async-context.ts";
import { asyncContextScopingEnabled } from "../../runtime/async-context-mode.ts";
import { inEventDispatch } from "../event-priority.ts";
import {
  familyMatchActive,
  familyResolveActive,
  normalizeChildren,
  reportSignatureChange,
  resolveFamilyCurrent,
  sameType,
  setRootRefresh,
  TEXT_TYPE,
  textVNode,
} from "../vnode-utils.ts";
import { propsAndContextEqual, providerContexts } from "../context-map.ts";
import { commitToDevTools, type DevNode, injectDevTools } from "../devtools.ts";
import "../../runtime/class-flag.ts";
import { classComponentsDisabledError, isClassComponent } from "../../compat/class-detect.ts";
import {
  componentDisplayName,
  isComponentType,
  resolveComponentType,
} from "../../runtime/react-brands.ts";
import {
  captureSnapshot,
  handleClassError,
  hasErrorLifecycle,
  renderClassInstance,
  setClassScheduleUpdate,
  unmountClassInstance,
} from "../../compat/class-component.ts";
import {
  bubbleFlags,
  ChildDeletion,
  ChildrenChanged,
  childrenDom,
  collectDom,
  type CommitEffect,
  createFiber,
  createWorkInProgress,
  type Cursor,
  type Fiber,
  type FiberTag,
  type HookCell,
  NoFlags,
  NoLane,
  Placement,
  placePortalChildren,
  Snapshot,
  type SuspenseListState,
  syncChildren,
  SyncLane,
  TransitionLane,
  Update,
} from "./fiber.ts";

// ---- Module state ----------------------------------------------------------

let doc: Document = (globalThis as { document?: Document }).document!;

/** Override the document implementation (used by tests with a DOM shim). */
export function setDocument(d: Document): void {
  doc = d;
}

/** The component fiber currently rendering (backs the hook dispatcher). */
let currentFiber: Fiber | null = null;
let hookIndex = 0;
/**
 * Set true when the currently-rendering component updates its OWN state during its
 * OWN render (React's render-phase-update idiom — e.g. Base UI's dialog transition
 * adjusting derived state from a prop change). {@link renderComponent} converges the
 * component locally instead of scheduling a whole-tree re-render + commit.
 */
let renderPhaseUpdateScheduled = false;
/** Bound on render-phase re-invocations of one component (React's RE_RENDER_LIMIT). */
const MAX_RENDER_PHASE_PASSES = 25;

/** The unit of work in progress, or null between renders. */
let workInProgress: Fiber | null = null;
/** True while the render + commit is running (setState during render defers). */
let duringRender = false;

// Hydration state (a live cursor over server-rendered DOM during the first
// hydrateRoot render). `hydrationStack` mirrors the recursive reconciler's
// per-host child cursors; push on entering a host, pop on completing it.
let isHydrating = false;
let hydrationCursor: Cursor | null = null;
let hydrationStack: (Cursor | null)[] = [];

// ---- Root handles ----------------------------------------------------------

interface RootHandle {
  container: Element;
  /** The committed HostRoot fiber (double-buffered via its alternate). */
  current: Fiber;
  pendingElement: VNode | null;
  pendingLanes: number;
  /** True for the first render of a hydrateRoot (adopt server DOM). */
  hydrate: boolean;
  /** {@link RootOptions} error callbacks (React 19 parity), or undefined. */
  onCaughtError?: RootErrorCallback;
  onUncaughtError?: RootErrorCallback;
  onRecoverableError?: RootErrorCallback;
}

/** A {@link RootOptions} error callback. */
type RootErrorCallback = (error: unknown, errorInfo: { componentStack?: string }) => void;

const activeRoots = new Set<RootHandle>();
/** Maps each buffer of a root fiber to its handle (both alternates included). */
const fiberToRoot = new WeakMap<Fiber, RootHandle>();

// ---- Hook dispatcher -------------------------------------------------------

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

const clientDispatcher: Dispatcher = {
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

// ---- Component rendering ----------------------------------------------------

/** The error a client render throws when a component resolves to a Promise. */
function asyncClientComponentError(): Error {
  return new Error("denext: async components are server-only; cannot render on the client.");
}

/**
 * Reset a component's hooks to their render-start state before a render-phase
 * re-invocation (React's render-phase update — a component that calls its own
 * `setState`/`dispatch` while rendering itself). denext mutates `cell.deps` in place as
 * it queues effects and store subscriptions, so a naive re-render would compare a hook's
 * new deps against the deps the PREVIOUS (now discarded) sub-render just wrote —
 * suppressing effects that must still queue and dropping them when the effect queues are
 * cleared. Restoring the committed deps (captured in `depsBaseline`) makes each effect /
 * `useSyncExternalStore` subscription re-queue exactly when it changed vs the last
 * COMMITTED render, matching React. Cells created during a discarded sub-render (index
 * past the baseline) are reset to a fresh-mount state so their mount effect re-queues on
 * the final pass. The three effect queues are cleared so only the final sub-render's
 * effects reach the commit.
 */
function restoreForReRender(inst: Fiber, depsBaseline: Array<DependencyList | undefined>): void {
  const hooks = inst.hooks!;
  for (let i = 0; i < hooks.length; i++) {
    const c = hooks[i];
    if (i < depsBaseline.length) {
      c.deps = depsBaseline[i]; // committed deps: re-queue iff changed vs the last commit
    } else {
      c.deps = undefined; // created during a discarded sub-render — treat as a fresh mount
      c.mounted = false;
    }
  }
  inst.insertionEffects = [];
  inst.pendingEffects = [];
  inst.passiveEffects = [];
}

/**
 * Invoke a function component and converge any render-phase updates it makes to its OWN
 * state (Base UI's dialog/transition status, a `usePrevious`-style prop adjustment, and
 * other "adjust state while rendering" idioms). React re-renders just that component in
 * place — reading the updated state — until it stabilizes, with no commit in between;
 * denext does the same here rather than scheduling a whole-tree re-render + commit, which
 * never converges for this idiom (each pass commits, feeding the transition state back on
 * itself) and trips the render-pass guard, aborting the commit. `depsBaseline` is the
 * render-start deps snapshot used to restore hook state between sub-renders.
 */
function runRenderPhase(
  inst: Fiber,
  depsBaseline: Array<DependencyList | undefined>,
  type: (props: unknown, ref?: unknown) => VNode,
  props: unknown,
  ref: unknown,
  forwardsRef: boolean,
): VNode {
  renderPhaseUpdateScheduled = false;
  hookIndex = 0;
  let result = forwardsRef ? type(props, ref) : type(props);
  if (result instanceof Promise) throw asyncClientComponentError();
  let passes = 0;
  while (renderPhaseUpdateScheduled) {
    if (++passes > MAX_RENDER_PHASE_PASSES) {
      renderPhaseUpdateScheduled = false;
      throw new Error(
        "denext: Maximum update depth exceeded. A component repeatedly schedules an " +
          "update during its own render (e.g. calling setState unconditionally while rendering).",
      );
    }
    renderPhaseUpdateScheduled = false;
    restoreForReRender(inst, depsBaseline);
    hookIndex = 0;
    result = forwardsRef ? type(props, ref) : type(props);
    if (result instanceof Promise) throw asyncClientComponentError();
  }
  return result;
}

/** Run a component fiber's render, returning the single rendered vnode. */
/** How a component fiber's implementation resolved under dev Fast Refresh / per-module HMR. */
interface RefreshResolution {
  /** The impl to render: the family-current one under per-module HMR, else `vnode.type`. */
  rawType: unknown;
  /** A reused fiber whose implementation changed — dev-only, impossible in production. */
  refreshSwap: boolean;
  /** The pre-swap hook-kind sequence for the signature guard; null outside a swap. */
  oldKinds: Array<number | undefined> | null;
}

/**
 * Resolve what `inst` renders as, and whether this render is a Fast Refresh swap.
 *
 * Dev per-module HMR (unbundled dev server): the parent may still hold the pre-edit ref
 * in its vnode, so resolve the component to its family's CURRENT impl and render that
 * on the live fiber. Null resolver in production and on the whole-entry refresh path →
 * `rawType` is just `inst.vnode.type` (one function-pointer check).
 *
 * A reused fiber whose implementation changed (same family, different ref) is a refresh
 * swap. Whole-entry refresh sees the change on `vnode.type` (the tree is rebuilt from
 * fresh refs); per-module HMR sees it only via the impl the previous render recorded
 * (`alternate.lastImpl`), since the vnode ref is stale. The impl about to render is
 * recorded so the NEXT render can detect a per-module swap across the double-buffered
 * alternate (dev-only; skipped in prod). The pre-swap hook-kind sequence is snapshotted
 * so the signature guard can compare the WHOLE signature (count + order), not just the
 * count — a same-count reorder is unsafe too. Null outside a swap, so prod pays nothing.
 */
function resolveRefreshSwap(inst: Fiber): RefreshResolution {
  const resolveFR = familyResolveActive();
  const rawType = resolveFR ? resolveFamilyCurrent(inst.vnode.type) : inst.vnode.type;
  const refreshSwap = resolveFR
    ? (inst.alternate !== null && inst.alternate.lastImpl != null &&
      inst.alternate.lastImpl !== rawType)
    : (inst.alternate !== null && inst.vnode.type !== inst.alternate.vnode.type);
  if (resolveFR) inst.lastImpl = rawType;
  const oldKinds = refreshSwap && inst.hooks ? inst.hooks.map((c) => c.kind) : null;
  return { rawType, refreshSwap, oldKinds };
}

/**
 * Render a bare class component (raw type is a class) through the class runtime, which
 * reads `inst.vnode.type` as the constructor. (Per-module HMR does not substitute class
 * impls — an edited class module is reload-only — so the family-current impl equals
 * `inst.vnode.type` whenever this path is taken.) A shouldComponentUpdate/PureComponent
 * bail keeps the committed child.
 */
function renderClassFiber(inst: Fiber): VNode {
  if (!__DENEXT_CLASS_COMPONENTS__) throw classComponentsDisabledError();
  const { vnode, bailed } = renderClassInstance(inst as never);
  if (bailed) {
    inst.bailed = true;
    return (inst.child?.vnode as VNode) ?? textVNode("");
  }
  return (vnode as VNode) ?? textVNode("");
}

type RenderFn = (props: unknown, ref?: unknown) => VNode;

/**
 * Resolve memo/forwardRef object wrappers to the render function. The fast path (a plain
 * function type) returns it unchanged with a single typeof check. A wrapper hiding a
 * class (e.g. memo(Class)) can't go through the object path — the class runtime needs
 * the raw constructor — so it is rejected; the guard runs only in the wrapped case so
 * the plain-function hot path pays nothing.
 */
function resolveRenderTarget(rawType: unknown): { type: RenderFn; forwardsRef: boolean } {
  const resolved = resolveComponentType(rawType);
  const type = resolved.fn as RenderFn;
  if (type !== rawType && __DENEXT_CLASS_COMPONENTS__ && isClassComponent(type)) {
    throw new Error(
      "denext: memo() of a class component is unsupported; wrap the class in a " +
        "function component (or memo the function) instead.",
    );
  }
  return { type, forwardsRef: resolved.forwardsRef };
}

/**
 * The props this render sees, plus the fiber's id scope.
 *
 * A Flight island hydrates on its own, so it can't derive its position from an
 * enclosing tree — the server tags it with its tree-path prefix. Root the island's id
 * scope at that prefix so its ids match the server render. Dev DevTools prop overrides
 * are merged over the real props (gated to zero cost when nothing is overridden / in
 * production). On first render the component takes its slot in its enclosing scope (in
 * the same depth-first order the server assigns), so useId derives from its position;
 * reused fibers keep their mount-time scope (useId is cached per hook cell).
 */
function prepareRenderProps(inst: Fiber): unknown {
  let props: unknown = inst.vnode.props;
  const idPath = (props as Record<string, unknown>)[ID_PATH_PROP];
  if (typeof idPath === "string") {
    if (inst.idScope === undefined) inst.idScope = rootScope(idPath);
    const { [ID_PATH_PROP]: _drop, ...rest } = props as Record<string, unknown>;
    props = rest;
  }
  if (overridesActive) {
    const ov = fiberPropOverrides(inst);
    if (ov) props = { ...(props as Record<string, unknown>), ...ov };
  }
  if (inst.idScope === undefined) {
    inst.idScope = enterScope(inst.idParentScope ?? rootScope());
  }
  return props;
}

/**
 * Run the render phase, twice under StrictMode (dev) to surface impure render logic.
 * The first pass initialized hook cells and queued effects; the second reads the same
 * cells (no new effects, ids cached) and its result is the one used. The scope's local
 * id index is restored so an impure second pass that calls an extra useId can't shift
 * this component's ids. (Class components are not double-rendered — they are gated and
 * comparatively rare.)
 *
 * Each hook's render-start deps are snapshotted so a render-phase update (a component
 * that sets its own state while rendering) can re-invoke and converge locally — denext
 * mutates cell.deps in place, so the baseline is needed to re-queue effects correctly.
 * Cheap ref-copies; on the no-render-phase-update common path the snapshot is unused.
 */
function renderWithStrictMode(
  inst: Fiber,
  type: RenderFn,
  props: unknown,
  ref: unknown,
  forwardsRef: boolean,
): VNode {
  const depsBaseline = inst.hooks!.map((c) => c.deps);
  const result = runRenderPhase(inst, depsBaseline, type, props, ref, forwardsRef);
  if (inst.strict === true && devHydrationActive()) {
    const localAfterFirst = inst.idScope!.local;
    const second = runRenderPhase(
      inst,
      inst.hooks!.map((c) => c.deps),
      type,
      props,
      ref,
      forwardsRef,
    );
    inst.idScope!.local = localAfterFirst;
    return second ?? textVNode("");
  }
  return result ?? textVNode("");
}

/**
 * Post-render bookkeeping (runs whether the render returned or threw). The Fast Refresh
 * hook-signature guard: the edited component's hook sequence changed — a different
 * count OR a same-count reorder/kind change — so reusing its hook cells is unsafe;
 * signal a full reload (no-op unless the dev refresh runtime installed a handler).
 * Then the `<Profiler>` timing and the dev DevTools profiler callback.
 */
function finishComponentRender(
  inst: Fiber,
  t0: number,
  profT0: number,
  swap: RefreshResolution,
): void {
  if (swap.refreshSwap && hookSignatureChanged(swap.oldKinds, inst.hooks, hookIndex)) {
    reportSignatureChange();
  }
  if (inst.underProfiler === true) {
    const d = performance.now() - t0;
    inst.actualDuration = d;
    inst.selfBaseDuration = d;
  }
  if (renderProfiler !== null) renderProfiler(inst.vnode.type, performance.now() - profT0, inst);
}

function renderComponent(inst: Fiber): VNode {
  const prevInst = currentFiber;
  const prevIdx = hookIndex;
  const swap = resolveRefreshSwap(inst);
  currentFiber = inst;
  hookIndex = 0;
  inst.insertionEffects = [];
  inst.pendingEffects = [];
  inst.passiveEffects = [];
  // Rebuild the read-context set from this render's useContext calls (accumulated
  // across any render-phase / StrictMode re-invocations, which read the same set).
  inst.readContexts = undefined;
  if (__DENEXT_CLASS_COMPONENTS__) inst.bailed = false;
  // Time the render for an enclosing <Profiler> (a bailed component never reaches
  // here, so its actualDuration stays 0 while selfBaseDuration carries over).
  const t0 = inst.underProfiler === true ? performance.now() : 0;
  // Dev-only DevTools profiler: time every component render while recording (null
  // otherwise, so the hot path is one null check).
  const profT0 = renderProfiler !== null ? performance.now() : 0;
  const prevDispatcher = setDispatcher(clientDispatcher);
  try {
    if (isClassComponent(inst.vnode.type)) return renderClassFiber(inst);
    const { type, forwardsRef } = resolveRenderTarget(swap.rawType);
    const props = prepareRenderProps(inst);
    // forwardRef threads `ref` via props (denext convention); a plain component
    // ignores the second argument.
    const ref = forwardsRef ? ((props as { ref?: unknown }).ref ?? null) : undefined;
    return renderWithStrictMode(inst, type, props, ref, forwardsRef);
  } finally {
    finishComponentRender(inst, t0, profT0, swap);
    setDispatcher(prevDispatcher);
    currentFiber = prevInst;
    hookIndex = prevIdx;
  }
}

/**
 * Whether a Fast Refresh swap changed the component's hook signature: a different
 * number of hooks, or the same number in a different order/kind (both make reusing
 * the carried cells unsafe). `oldKinds` is the pre-swap kind sequence; `hooks` now
 * holds the post-render cells and `newCount` (the render's `hookIndex`) how many it
 * used. Returns false when not a swap (`oldKinds` null).
 */
function hookSignatureChanged(
  oldKinds: Array<number | undefined> | null,
  hooks: HookCell[] | undefined,
  newCount: number,
): boolean {
  if (oldKinds === null) return false;
  if (oldKinds.length !== newCount) return true; // count changed
  for (let i = 0; i < newCount; i++) {
    if (oldKinds[i] !== hooks![i].kind) return true; // reorder / kind change
  }
  return false;
}

// ---- Hydration diagnostics (dev-only) --------------------------------------

function devHydrationActive(): boolean {
  return (globalThis as { __denextDev?: boolean }).__denextDev === true;
}

function describeNode(node: Node | null): string {
  if (!node) return "nothing (the server markup ended early)";
  if (node.nodeType === 3) return `text ${JSON.stringify(node.nodeValue ?? "")}`;
  if (node.nodeType === 1) return `<${(node as Element).tagName.toLowerCase()}>`;
  return `a node of type ${node.nodeType}`;
}

function warnHydrationMismatch(detail: string): void {
  console.warn(
    `denext: hydration mismatch — ${detail}. The client render is used; ` +
      `check for output that differs between server and client (Date.now(), ` +
      `Math.random(), locale/timezone, or invalid HTML nesting).`,
  );
}

// ---- Fiber creation from vnodes --------------------------------------------

function tagOf(vnode: VNode): FiberTag {
  const t = vnode.type as unknown;
  if (t === TEXT_TYPE) return "text";
  if (t === SUSPENSE) return "suspense";
  if (t === ERROR_BOUNDARY) return "errorboundary";
  if (t === FRAGMENT) return "fragment";
  if (t === PORTAL) return "portal";
  if (typeof t === "function") return "component";
  // A non-callable memo/forwardRef object wrapper is also a component.
  if (typeof t === "object" && t !== null && isComponentType(t)) return "component";
  return "host";
}

function createFiberFromVNode(vnode: VNode): Fiber {
  const tag = tagOf(vnode);
  const fiber = createFiber(tag, vnode);
  if (tag === "component") fiber.hooks = [];
  return fiber;
}

// ---- Reconciliation (keyed) ------------------------------------------------

function onErrorFor(fiber: Fiber): (err: unknown) => void {
  return (err) => handleEventError(fiber, err);
}

/**
 * Dev Fast Refresh fallback for the unkeyed matcher: find and remove an unused old
 * unkeyed fiber whose type FAMILY-matches `nv` (an edit changed its type identity, so
 * it isn't in `nv`'s exact-type bucket). Each queue holds one type, so testing a
 * queue's head identifies the family; the head is popped to keep document order. Never
 * runs in production (the sole caller is guarded by `familyMatchActive()`).
 */
function takeUnkeyedFamilyMatch(
  unkeyedByType: Map<unknown, Fiber[]>,
  nv: VNode,
): Fiber | undefined {
  for (const q of unkeyedByType.values()) {
    if (q.length > 0 && sameType(q[0].vnode, nv)) return q.shift();
  }
  return undefined;
}

/**
 * Reconcile `returnFiber`'s existing child fibers against `childrenRaw`, linking
 * the resulting child/sibling chain and collecting unused fibers into
 * `returnFiber.deletions`. Sets each child's routing pointers (return/host/
 * boundary) and inherited context map. Flags the parent as ChildrenChanged when
 * membership or order changes so the commit re-syncs the nearest host.
 */
/**
 * Whether `v` is a plain, unkeyed Fragment element — an unkeyed `<>…</>` whose props are
 * nothing but `children`. Such a fragment is transparent and can be unwrapped (React's
 * `isUnkeyedTopLevelFragment`). A fragment carrying any marker prop (PROVIDER / STRICT_MODE
 * / SUSPENSE_LIST / PROFILER — all symbol-keyed) is NOT plain and must keep its own fiber,
 * or the behavior that prop encodes is lost. Symbol keys are checked via Reflect.ownKeys.
 */
function isPlainUnkeyedFragment(v: unknown): v is VNode {
  if (v == null || typeof v !== "object") return false;
  const vn = v as VNode;
  if (vn.type !== FRAGMENT || vn.key != null) return false;
  const props = vn.props as Record<string | symbol, unknown> | null;
  if (props == null) return true;
  for (const k of Reflect.ownKeys(props)) {
    if (k !== "children") return false;
  }
  return true;
}

/** The committed children of a fiber, indexed for matching against the new vnodes. */
interface OldChildIndex {
  oldChildren: Fiber[];
  keyed: Map<unknown, Fiber>;
  /** Unkeyed old children bucketed by element type, each queue kept in document order. */
  unkeyedByType: Map<unknown, Fiber[]>;
  oldIndexOf: Map<Fiber, number>;
}

/**
 * Index `returnFiber`'s committed children. Matching an unkeyed new child pops the
 * FIRST unused old child of the SAME type, so inserting or removing a child of one type
 * never strands the reusable same-type siblings that follow it. (A single forward
 * cursor instead CONSUMED candidates on a type mismatch: one front-insert would burn the
 * cursor past every real candidate and remount all trailing siblings — a whole-subtree
 * churn under any list that grows a differently-typed child at the front.)
 */
function indexOldChildren(returnFiber: Fiber): OldChildIndex {
  const oldChildren: Fiber[] = [];
  for (let c = returnFiber.child; c !== null; c = c.sibling) oldChildren.push(c);
  const keyed = new Map<unknown, Fiber>();
  const unkeyedByType = new Map<unknown, Fiber[]>();
  const oldIndexOf = new Map<Fiber, number>();
  oldChildren.forEach((c, i) => {
    oldIndexOf.set(c, i);
    if (c.vnode.key != null) {
      keyed.set(c.vnode.key, c);
    } else {
      let q = unkeyedByType.get(c.vnode.type);
      if (q === undefined) unkeyedByType.set(c.vnode.type, q = []);
      q.push(c);
    }
  });
  return { oldChildren, keyed, unkeyedByType, oldIndexOf };
}

/**
 * The old child a new vnode may reuse: by key, else the first unused unkeyed old child
 * of the exact same type (in order). Dev Fast Refresh only: an edited component's type
 * identity changed within its family, so it won't sit in the new type's bucket — scan
 * the remaining unkeyed queues for a family match (never runs in production).
 */
function matchOldChild(nv: VNode, index: OldChildIndex): Fiber | undefined {
  if (nv.key != null) return index.keyed.get(nv.key);
  const q = index.unkeyedByType.get(nv.type);
  if (q !== undefined && q.length > 0) return q.shift();
  return familyMatchActive() ? takeUnkeyedFamilyMatch(index.unkeyedByType, nv) : undefined;
}

/** Claim `match` for reuse when it is an unused old child of the same type. */
function claimReusable(match: Fiber | undefined, used: Set<Fiber>, nv: VNode): Fiber | null {
  if (match === undefined || used.has(match) || !sameType(match.vnode, nv)) return null;
  used.add(match);
  return match;
}

/** What every child fiber inherits from its parent during reconcile. */
interface ChildLinks {
  host: Fiber | null;
  boundary: Fiber | null;
  inherited: Map<symbol, unknown>;
  idParentScope: Fiber["idParentScope"];
}

function linkChildFiber(fiber: Fiber, returnFiber: Fiber, links: ChildLinks): void {
  fiber.return = returnFiber;
  fiber.host = links.host;
  fiber.boundary = links.boundary;
  fiber.idParentScope = links.idParentScope;
  fiber.inherited = links.inherited;
  fiber.strict = returnFiber.strict === true;
  fiber.underProfiler = returnFiber.underProfiler === true;
  // SuspenseList membership propagates from a list's direct child (the <Suspense>
  // wrapper) to the suspense fiber it renders.
  if (returnFiber.listOwnerState != null && fiber.tag === "suspense") {
    fiber.listState = returnFiber.listOwnerState;
    fiber.listIndex = returnFiber.listIndex;
  }
  fiber.sibling = null;
}

/** Queue every committed child no new vnode reused for deletion; true if any. */
function collectDeletions(returnFiber: Fiber, oldChildren: Fiber[], used: Set<Fiber>): boolean {
  let changed = false;
  for (const c of oldChildren) {
    if (!used.has(c)) {
      (returnFiber.deletions ??= []).push(c);
      changed = true;
    }
  }
  if (returnFiber.deletions) returnFiber.flags |= ChildDeletion;
  return changed;
}

function reconcileChildren(
  returnFiber: Fiber,
  childrenRaw: VNodeChildren,
  childHost: Fiber | null,
  childBoundary: Fiber | null,
  childInherited: Map<symbol, unknown>,
): void {
  const newVNodes = normalizeChildren(childrenRaw);
  const links: ChildLinks = {
    host: childHost,
    boundary: childBoundary,
    inherited: childInherited,
    // The id scope the children's components slot into: a component parent exposes
    // its own scope; host/fragment/suspense/… levels pass their enclosing one through.
    idParentScope: returnFiber.idScope ?? returnFiber.idParentScope,
  };
  const index = indexOldChildren(returnFiber);
  const used = new Set<Fiber>();
  let changed = false;
  let lastMatchedOldIndex = -1;
  let firstChild: Fiber | null = null;
  let prev: Fiber | null = null;

  for (const nv of newVNodes) {
    const match = claimReusable(matchOldChild(nv, index), used, nv);
    let fiber: Fiber;
    if (match !== null) {
      fiber = createWorkInProgress(match, nv);
      // A reuse that lands before the previous one moved (an out-of-order match).
      const oi = index.oldIndexOf.get(match)!;
      changed ||= oi < lastMatchedOldIndex;
      lastMatchedOldIndex = Math.max(lastMatchedOldIndex, oi);
    } else {
      fiber = createFiberFromVNode(nv);
      fiber.flags |= Placement;
      changed = true;
    }
    linkChildFiber(fiber, returnFiber, links);
    if (prev) prev.sibling = fiber;
    else firstChild = fiber;
    prev = fiber;
  }

  if (collectDeletions(returnFiber, index.oldChildren, used)) changed = true;
  returnFiber.child = firstChild;
  if (changed) returnFiber.flags |= ChildrenChanged;
}

/** Clone a bailed-out fiber's current children into fresh work-in-progress. */
function cloneChildFibers(wip: Fiber): void {
  let currentChild = wip.child; // === current.child (shared by createWorkInProgress)
  if (currentChild === null) return;
  // A bailing component passes its own (possibly context-refreshed) inherited map down
  // to its children — otherwise a consumer cloned under a bailed non-consumer would keep
  // the stale map and read an old context value. `wip.inherited` was set by this render's
  // reconcile; equal to the children's old map when nothing changed, so this is a no-op
  // in the common bail.
  const childInherited = wip.inherited;
  const newChild = createWorkInProgress(currentChild, currentChild.vnode);
  newChild.return = wip;
  newChild.inherited = childInherited;
  wip.child = newChild;
  let prev = newChild;
  currentChild = currentChild.sibling;
  while (currentChild !== null) {
    const c = createWorkInProgress(currentChild, currentChild.vnode);
    c.return = wip;
    c.inherited = childInherited;
    prev.sibling = c;
    prev = c;
    currentChild = currentChild.sibling;
  }
  prev.sibling = null;
}

// ---- Render phase: beginWork -----------------------------------------------

function isClassBoundary(fiber: Fiber): boolean {
  return __DENEXT_CLASS_COMPONENTS__ && fiber.tag === "component" &&
    fiber.classInstance != null && hasErrorLifecycle(fiber.vnode.type);
}

/** Whether `fiber` (a provider fragment) re-provides `contextId`, shadowing it below. */
function reprovidesContext(fiber: Fiber, contextId: symbol): boolean {
  const info = (fiber.vnode.props as Record<string, unknown> | null)
    ?.[PROVIDER as unknown as string] as { id: symbol } | undefined;
  return info !== undefined && info.id === contextId;
}

/**
 * A provider's value changed: force every descendant that READS `contextId` to render,
 * so a consumer isn't left stale when the memo bailout skips a non-consumer ancestor
 * between it and the provider. Walks the provider's committed subtree (its child links
 * before this render's reconcile), marks each consumer's lane, and threads `childLanes`
 * up to the provider so bailing ancestors still descend to reach it. Stops at a nested
 * provider that re-provides the same context (it shadows the value below). Mirrors
 * React's `propagateContextChange`; runs only on an actual value change of a mounted
 * provider, so a stable-value provider costs nothing.
 */
/** Whether `node` is a component that read `contextId` during its last render. */
function readsContext(node: Fiber, contextId: symbol): boolean {
  return node.tag === "component" && node.readContexts !== undefined &&
    node.readContexts.has(contextId);
}

/**
 * Mark a consumer for re-render on `lane` and thread `childLanes` from it up to (and
 * including) the provider, so bailing ancestors still descend to reach it. Both buffers
 * are marked so the update survives whichever one the next render starts from.
 */
function markConsumerDirty(node: Fiber, provider: Fiber, lane: number): void {
  node.lanes |= lane;
  if (node.alternate) node.alternate.lanes |= lane;
  for (let p: Fiber | null = node.return; p !== null; p = p.return) {
    p.childLanes |= lane;
    if (p.alternate) p.alternate.childLanes |= lane;
    if (p === provider) return;
  }
}

/** Depth-first advance bounded to the provider's subtree; null once it is exhausted. */
function nextInSubtree(node: Fiber, provider: Fiber, descend: boolean): Fiber | null {
  if (descend && node.child !== null) return node.child;
  while (node.sibling === null) {
    if (node.return === null || node.return === provider) return null;
    node = node.return;
  }
  return node.sibling;
}

function propagateContextChange(provider: Fiber, contextId: symbol, lane: number): void {
  let node: Fiber | null = provider.child;
  while (node !== null) {
    let descend = true;
    if (readsContext(node, contextId)) {
      markConsumerDirty(node, provider, lane);
    } else if (node.tag === "fragment" && reprovidesContext(node, contextId)) {
      descend = false; // a nested same-context provider shadows the value below
    }
    node = nextInSubtree(node, provider, descend);
  }
}

/** The lanes being processed by the current render (sync and/or transition). */
let renderLanes = NoLane;

/** Perform one unit of work; return the next unit (first child) or null. */
// A "component" fiber: bail out when nothing changed, else render it and reconcile
// its output. Split out of {@linkcode beginWork}; `hasOwnUpdate` is the fiber's own
// pending-lane flag, computed in beginWork's preamble.
// May a "component" fiber skip re-rendering this pass? True only when it has a prior
// render, no own pending work, isn't a class (those decide via sCU/PureComponent
// inside renderComponent), keeps the SAME function ref (a Fast Refresh swap must run),
// and its props + read contexts are unchanged. Split out of {@linkcode beginComponent}.
function canSkipComponentRender(
  wip: Fiber,
  current: Fiber | null,
  hasOwnUpdate: boolean,
  isClass: boolean,
): boolean {
  return current !== null && !hasOwnUpdate && !isClass &&
    // A Fast Refresh swap keeps the fiber but changes the function ref (same
    // family, different type). Never bail then — the new implementation must
    // run. In production the type ref is always identical here, so this is a
    // no-op guard (zero behavior change).
    wip.vnode.type === current.vnode.type &&
    propsAndContextEqual(
      wip.vnode.type,
      current.vnode.props,
      wip.vnode.props,
      current.inherited,
      wip.inherited,
      current.readContexts,
    );
}

function beginComponent(wip: Fiber, hasOwnUpdate: boolean): Fiber | null {
  const current = wip.alternate;
  const isClass = __DENEXT_CLASS_COMPONENTS__ && isClassComponent(wip.vnode.type);
  if (canSkipComponentRender(wip, current, hasOwnUpdate, isClass)) {
    if ((wip.childLanes & renderLanes) === NoLane) return null; // bail whole subtree
    cloneChildFibers(wip);
    return wip.child;
  }
  // The class runtime resolves legacy `contextType` from `.contexts`; a
  // component's visible context is its inherited map. (Fragments override
  // `.contexts` with their derived map; components never expose via it.)
  wip.contexts = wip.inherited;
  const rendered = renderComponent(wip);
  if (__DENEXT_CLASS_COMPONENTS__ && wip.bailed) {
    // shouldComponentUpdate/PureComponent bailed. Like the function bailout,
    // still descend into children that have their own pending work, so a
    // descendant's update isn't dropped just because this class didn't change.
    if ((wip.childLanes & renderLanes) === NoLane) return null;
    cloneChildFibers(wip);
    return wip.child;
  }
  const childBoundary = isClassBoundary(wip) ? wip : wip.boundary;
  // React parity (`isUnkeyedTopLevelFragment`): a component that returns an UNKEYED
  // top-level Fragment is transparent — reconcile the Fragment's own children against
  // this component's children rather than nesting a Fragment fiber. A KEYED fragment is
  // NOT unwrapped (its key is meaningful). This lets a keyed element INSIDE the returned
  // fragment be matched by key even when the surrounding structure changes between
  // renders. Base UI's MenuTrigger depends on exactly this: it wraps its <button> in
  // `<Fragment key={triggerId}>` and, when open, returns that keyed wrapper alongside
  // focus-guard siblings inside an outer UNKEYED fragment. Without unwrapping, denext
  // compares the new outer unkeyed fragment against the old keyed one, fails to match,
  // and remounts the whole subtree — recreating the trigger's DOM node and detaching
  // floating-ui's positioning anchor, so the popup renders unpositioned at opacity:0.
  //
  // Only a PLAIN fragment (no props other than `children`) is unwrapped: denext overloads
  // Fragment to carry marker props for context Providers, SuspenseList, StrictMode and
  // Profiler (symbol-keyed), and unwrapping those would drop their behavior (e.g. a
  // Provider's value would stop reaching descendants). React never puts props on a
  // Fragment, so restricting to plain fragments costs no React parity.
  const childrenToReconcile: VNodeChildren = isPlainUnkeyedFragment(rendered)
    ? ((rendered as VNode).props?.children ?? null) as VNodeChildren
    : [rendered];
  reconcileChildren(wip, childrenToReconcile, wip.host, childBoundary, wip.inherited);
  return wip.child;
}

interface FragmentMarkers {
  strict: boolean;
  profiler: { id: string; onRender?: ProfilerOnRender } | undefined;
  provInfo: { id: symbol; value: unknown } | undefined;
  listPolicy:
    | { revealOrder?: SuspenseListState["revealOrder"]; tail?: SuspenseListState["tail"] }
    | undefined;
}

// A Fragment is denext's overloaded carrier for four symbol-keyed marker props:
// StrictMode, <Profiler>, a context Provider, and SuspenseList. Read them all off the
// vnode's props in one place. Split out of {@linkcode beginFragment}.
function readFragmentMarkers(wip: Fiber): FragmentMarkers {
  const props = wip.vnode.props as Record<string, unknown> | null;
  return {
    strict: props?.[STRICT_MODE_PROP] === true,
    profiler: props?.[PROFILER_PROP] as FragmentMarkers["profiler"],
    provInfo: props?.[PROVIDER as unknown as string] as FragmentMarkers["provInfo"],
    listPolicy: props?.[SUSPENSE_LIST_PROP] as FragmentMarkers["listPolicy"],
  };
}

// A "fragment" fiber: the overloaded carrier for context Providers, StrictMode,
// Profiler, and SuspenseList (all symbol-keyed marker props). Applies any active
// marker, reconciles children under the derived context, then wires SuspenseList
// membership. Split out of {@linkcode beginWork}.
function beginFragment(wip: Fiber): Fiber | null {
  const { strict, profiler, provInfo, listPolicy } = readFragmentMarkers(wip);
  // A StrictMode boundary makes its whole subtree strict in development — enabling
  // render/effect double-invoke.
  if (wip.strict !== true && devHydrationActive() && strict) {
    wip.strict = true;
  }
  // A <Profiler> boundary times its subtree's component renders.
  if (profiler) {
    wip.profiler = profiler;
    wip.underProfiler = true;
    anyProfiler = true;
  }
  const prevProvValue = wip.provValue;
  const exposed = providerContexts(wip, wip.vnode, wip.inherited);
  wip.contexts = exposed;
  // A provider whose value CHANGED must force every descendant that reads this
  // context to re-render, even if an intermediate parent bails (denext's memo
  // bailout now skips non-consumers). Mark those consumers' lanes so beginWork
  // renders them and bailing ancestors still descend. Skipped on mount (no prior
  // consumers) and when the value is unchanged (providerContexts reused the map).
  if (
    provInfo !== undefined && wip.alternate !== null &&
    !Object.is(prevProvValue, provInfo.value)
  ) {
    propagateContextChange(wip, provInfo.id, renderLanes);
  }
  reconcileChildren(
    wip,
    (wip.vnode.props?.children ?? null) as VNodeChildren,
    wip.host,
    wip.boundary,
    exposed,
  );
  // A SuspenseList (a Fragment carrying the reveal-policy marker) coordinates its
  // direct <Suspense> children's reveal order.
  if (listPolicy) applySuspenseListPolicy(wip, listPolicy);
  return wip.child;
}

// Wire a SuspenseList's shared reveal state onto a Fragment carrying the reveal-policy
// marker, and tag its direct children with their membership + index (propagated one
// level to the <Suspense> each renders). Split out of {@linkcode beginFragment}.
function applySuspenseListPolicy(
  wip: Fiber,
  listPolicy: {
    revealOrder?: SuspenseListState["revealOrder"];
    tail?: SuspenseListState["tail"];
  },
): void {
  // One shared state object across all buffers (created once, carried by
  // reference) so a bailed/cloned member always reads fresh reveal state.
  const st: SuspenseListState = wip.listState ?? { members: [], ready: [], snapshot: [] };
  wip.listState = st;
  st.revealOrder = listPolicy.revealOrder;
  st.tail = listPolicy.tail;
  // Freeze the persistent readiness so every member this render decides against
  // one consistent state, then start a fresh roster of scheduling targets.
  st.snapshot = [...st.ready];
  st.members = [];
  // Tag the list's direct children; membership propagates one level to the
  // <Suspense> each renders (see reconcileChildren).
  let i = 0;
  for (let c = wip.child; c !== null; c = c.sibling) {
    c.listOwnerState = st;
    c.listIndex = i++;
  }
  // Record the child count so the collapsed/hidden tail can locate the leading
  // boundary on the first render (when `snapshot` is still empty).
  st.count = i;
}

// Offscreen re-suspend of an already-revealed boundary: reconcile [primary…, fallback…]
// as one child list — the primary vnodes match the committed primary fibers (reused →
// state kept), the fallback mounts fresh — then hide the primary portion so it isn't
// re-rendered. Split out of {@linkcode beginSuspense}.
function beginSuspenseOffscreen(wip: Fiber): Fiber | null {
  const primary = normalizeChildren(wip.vnode.props.children as VNodeChildren);
  const combined = primary.concat(
    normalizeChildren(wip.vnode.props.fallback as VNodeChildren),
  );
  reconcileChildren(wip, combined, wip.host, wip.boundary, wip.inherited);
  wip.primaryCount = primary.length;
  let i = 0;
  for (let c = wip.child; c !== null; c = c.sibling, i++) {
    c.hidden = i < wip.primaryCount;
  }
  anyOffscreen = true;
  return wip.child;
}

// Decide what a <Suspense> boundary shows this pass — content, its fallback, or
// nothing (hidden, under a SuspenseList tail policy) — and the child list for that
// choice. Under a list the reveal order decides; otherwise its own showingFallback
// flag does. Split out of {@linkcode beginSuspense}.
function resolveSuspenseDisplay(
  wip: Fiber,
  inList: boolean,
): { display: "content" | "fallback" | "hidden"; children: VNodeChildren } {
  const display = inList ? suspenseListDisplay(wip) : wip.showingFallback ? "fallback" : "content";
  const children = display === "content"
    ? (wip.vnode.props.children as VNodeChildren)
    : display === "fallback"
    ? (wip.vnode.props.fallback as VNodeChildren)
    : null; // hidden
  return { display, children };
}

// A "suspense" fiber: own id-scope fork point; picks content/fallback/hidden per
// SuspenseList reveal order (or its own showingFallback), and handles the Offscreen
// keep-mounted-but-hidden reveal dance. Split out of {@linkcode beginWork}.
function beginSuspense(wip: Fiber): Fiber | null {
  // A Suspense boundary is its own id scope (a fork point, like React): it takes
  // one slot in its parent, and its content's ids are rooted at that position —
  // so a streamed/isolated hole reproduces exactly the ids the client computes.
  if (wip.idScope === undefined) {
    wip.idScope = enterScope(wip.idParentScope ?? rootScope());
  }
  // Under a SuspenseList, reveal order decides whether this boundary may show
  // content yet, show its fallback, or stay hidden (tail policy).
  const st = wip.listState;
  const inList = st != null && st.revealOrder != null;
  if (inList) st!.members[wip.listIndex!] = wip;

  // Offscreen: an URGENT re-suspend of an already-revealed boundary. Keep the
  // primary subtree mounted-but-hidden and show the fallback alongside, so a
  // later reveal restores the SAME instances (state preserved) instead of
  // remounting.
  if (!inList && wip.offscreen === true && wip.showingFallback === true) {
    return beginSuspenseOffscreen(wip);
  }

  const { display, children } = resolveSuspenseDisplay(wip, inList);
  // A list member rendering content is (tentatively) ready; if its children then
  // suspend, handleThrow resets its slot to false for the ordering above.
  if (inList && display === "content") st!.ready[wip.listIndex!] = true;
  reconcileChildren(wip, children, wip.host, wip.boundary, wip.inherited);
  // Leaving Offscreen (revealing content): un-hide the reused primary fibers so
  // they render, and mark the boundary for the commit pass to restore their DOM.
  if (!inList && display === "content" && wip.primaryCount != null) {
    for (let c = wip.child; c !== null; c = c.sibling) c.hidden = false;
    wip.offscreen = false;
    wip.primaryCount = undefined;
    anyOffscreen = true; // so the commit pass restores hiddenEls visibility
  }
  return wip.child;
}

// A "host" fiber (a DOM element): claim its server node during hydration, and — for a
// `<form action={fn}>` — establish a form-scoped pending signal seeded into descendant
// context so useFormStatus reads the nearest form. Split out of {@linkcode beginWork}.
function beginHost(wip: Fiber): Fiber | null {
  if (isHydrating) claimHost(wip);
  let childInherited = wip.inherited;
  if (wip.vnode.type === "form") {
    const props = wip.vnode.props ?? {};
    const act = props.action ?? props.formAction;
    if (typeof act === "function") {
      wip.formStatus ??= createFormStatusSignal();
      childInherited = new Map(wip.inherited);
      childInherited.set(FormStatusContext._id, wip.formStatus);
    }
  }
  reconcileChildren(
    wip,
    (wip.vnode.props?.children ?? null) as VNodeChildren,
    wip,
    wip.boundary,
    childInherited,
  );
  return wip.child;
}

// An "errorboundary" fiber: when it has caught an error, render the fallback (reporting
// to the PARENT boundary so an error in the fallback doesn't loop back here); otherwise
// render its children with itself as their boundary. Split out of {@linkcode beginWork}.
function beginErrorBoundary(wip: Fiber): Fiber | null {
  if (wip.__error != null) {
    const Fallback = wip.vnode.props.fallback as (p: {
      error: Error;
      reset: () => void;
    }) => VNode;
    const fallbackVNode: VNode = {
      type: Fallback as unknown as VNode["type"],
      props: { error: toError(wip.__error), reset: () => resetBoundary(wip) },
      key: null,
    };
    reconcileChildren(wip, [fallbackVNode], wip.host, wip.boundary, wip.inherited);
  } else {
    reconcileChildren(
      wip,
      (wip.vnode.props?.children ?? null) as VNodeChildren,
      wip.host,
      wip,
      wip.inherited,
    );
  }
  return wip.child;
}

function beginWork(wip: Fiber): Fiber | null {
  // Offscreen-hidden (a re-suspended boundary's preserved primary): do NOT render or
  // descend — keep the committed subtree mounted-as-is (a suspended child inside must
  // not re-throw) and DO NOT consume its lanes, so revealing it later re-renders with
  // the resolved data. Its DOM is hidden by the commit visibility pass.
  if (wip.hidden === true) return null;
  const hasOwnUpdate = (wip.lanes & renderLanes) !== 0;
  wip.lanes &= ~renderLanes; // consume only the lanes this render is processing

  switch (wip.tag) {
    case "root": {
      reconcileChildren(
        wip,
        wip.pendingElement != null ? [wip.pendingElement] : [],
        wip,
        null,
        wip.inherited,
      );
      return wip.child;
    }

    case "component":
      return beginComponent(wip, hasOwnUpdate);

    case "host":
      return beginHost(wip);

    case "fragment":
      return beginFragment(wip);

    case "portal": {
      wip.stateNode = wip.vnode.props.target as Element;
      reconcileChildren(
        wip,
        (wip.vnode.props?.children ?? null) as VNodeChildren,
        wip,
        wip.boundary,
        wip.inherited,
      );
      return wip.child;
    }

    case "suspense":
      return beginSuspense(wip);

    case "errorboundary":
      return beginErrorBoundary(wip);

    case "text":
      return null;
  }
}

// ---- Hydration: claim server nodes -----------------------------------------

function claimHost(wip: Fiber): void {
  const tag = wip.vnode.type as string;
  const existing = hydrationCursor
    ? (hydrationCursor.parent.childNodes[hydrationCursor.index] ?? null)
    : null;
  const matches = existing !== null && existing.nodeType === 1 &&
    (existing as Element).tagName.toLowerCase() === tag.toLowerCase();
  if (matches) {
    wip.stateNode = existing as Element;
    hydrationCursor!.index++;
    hydrationStack.push(hydrationCursor);
    hydrationCursor = { parent: existing as Element, index: 0 };
  } else {
    if (hydrationCursor) {
      reportHydrationMismatch(
        wip,
        `expected <${tag.toLowerCase()}>, but the server rendered ${describeNode(existing)}`,
      );
    }
    hydrationStack.push(hydrationCursor);
    hydrationCursor = null; // subtree mounts fresh
  }
}

/**
 * Adopt the server text node at the hydration cursor for `wip`'s text vnode. A server
 * value that merely STARTS with this vnode's value is adjacent-text coalescing: adopt
 * this vnode's slice and split the remainder into a new node for the next text vnode to
 * adopt — not a mismatch. Anything else that differs is a mismatch, reported and
 * overwritten.
 */
function adoptServerText(wip: Fiber, node: Text, value: string): void {
  const serverValue = node.nodeValue ?? "";
  if (serverValue !== value) {
    if (value !== "" && serverValue.length > value.length && serverValue.startsWith(value)) {
      node.nodeValue = value;
      const remainder = doc.createTextNode(serverValue.slice(value.length));
      hydrationCursor!.parent.insertBefore(
        remainder,
        hydrationCursor!.parent.childNodes[hydrationCursor!.index + 1] ?? null,
      );
    } else {
      reportHydrationMismatch(
        wip,
        `server text ${JSON.stringify(serverValue)} became ${JSON.stringify(value)}`,
      );
      node.nodeValue = value;
    }
  }
  hydrationCursor!.index++;
  wip.stateNode = node;
}

/** No adoptable text at the cursor: report the mismatch (when hydrating) and create a fresh node. */
function placeFreshText(wip: Fiber, value: string, existing: Node | null): void {
  if (hydrationCursor) {
    reportHydrationMismatch(
      wip,
      `expected text ${JSON.stringify(value)}, but the server rendered ${describeNode(existing)}`,
    );
  }
  wip.stateNode = doc.createTextNode(value);
  wip.flags |= Placement;
}

function claimText(wip: Fiber): void {
  const value = String(wip.vnode.props.nodeValue ?? "");
  const existing = hydrationCursor
    ? (hydrationCursor.parent.childNodes[hydrationCursor.index] ?? null)
    : null;
  if (existing && existing.nodeType === 3) adoptServerText(wip, existing as Text, value);
  else placeFreshText(wip, value, existing);
}

// ---- Render phase: completeWork --------------------------------------------

/** XML namespaces for non-HTML host elements. */
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";

/**
 * The namespace a host element must be created in, or `null` for plain HTML.
 * `<svg>`/`<math>` open a namespace that their descendants inherit; a `<foreignObject>`
 * inside SVG switches its own children back to HTML. Walks host ancestors to inherit the
 * enclosing namespace (a nested `<svg>` re-enters SVG regardless of context).
 */
function hostNamespace(wip: Fiber, type: string): string | null {
  if (type === "svg") return SVG_NAMESPACE;
  if (type === "math") return MATHML_NAMESPACE;
  for (let p = wip.return; p !== null; p = p.return) {
    if (p.tag !== "host") continue;
    const t = p.vnode.type as string;
    if (t === "foreignObject") return null; // HTML content embedded in SVG
    if (t === "svg") return SVG_NAMESPACE;
    if (t === "math") return MATHML_NAMESPACE;
  }
  return null;
}

/**
 * Create the DOM node for a fresh host fiber. SVG/MathML elements must be created in
 * their own namespace (createElementNS) — a plain createElement puts `<svg>`/`<path>`/…
 * in the HTML namespace, where they occupy layout space but draw nothing (the classic
 * "icon takes up room but is invisible"). The namespace is inherited down the subtree
 * until a `<foreignObject>` switches back to HTML.
 */
function createHostInstance(wip: Fiber): Element {
  const hType = wip.vnode.type as string;
  const ns = hostNamespace(wip, hType);
  return ns !== null ? doc.createElementNS(ns, hType) : doc.createElement(hType);
}

function completeHost(wip: Fiber): void {
  if (isHydrating) hydrationCursor = hydrationStack.pop() ?? null;
  if (!wip.listeners) wip.listeners = wip.alternate?.listeners ?? new Map();
  if (wip.alternate !== null) {
    // Update: applyProps + re-sync deferred to the commit (mutation) phase.
    stampFiber(wip.stateNode, wip); // keep the reverse map on the live buffer
    wip.flags |= Update;
    return;
  }
  // Fresh mount (or a hydration-adopted node): build off-DOM.
  if (wip.stateNode == null) wip.stateNode = createHostInstance(wip);
  applyProps(wip.stateNode as Element, wip, {}, wip.vnode.props ?? {}, onErrorFor(wip));
  // A foreign host (a lazy island's wrapper) is adopted but its subtree is left
  // untouched, so a separate per-island hydrateRoot can own that DOM.
  if (wip.vnode.props?.[FOREIGN_PROP] !== true) {
    syncChildren(wip.stateNode as Element, childrenDom(wip));
  }
  stampFiber(wip.stateNode, wip); // index node → fiber for delegated dispatch
  wip.flags |= Placement;
}

function completeText(wip: Fiber): void {
  if (wip.alternate !== null) {
    const value = String(wip.vnode.props.nodeValue ?? "");
    if ((wip.stateNode as Text).nodeValue !== value) wip.flags |= Update;
  } else if (isHydrating) {
    claimText(wip);
  } else {
    wip.stateNode = doc.createTextNode(String(wip.vnode.props.nodeValue ?? ""));
    wip.flags |= Placement;
  }
}

function completeComponent(wip: Fiber): void {
  // getSnapshotBeforeUpdate runs before a class update's DOM mutation — but
  // not when shouldComponentUpdate/PureComponent bailed this render.
  if (__DENEXT_CLASS_COMPONENTS__ && wip.classInstance && wip.alternate && !wip.bailed) {
    wip.flags |= Snapshot;
  }
}

function completeWork(wip: Fiber): void {
  switch (wip.tag) {
    case "host":
      completeHost(wip);
      break;
    case "text":
      completeText(wip);
      break;
    case "component":
      completeComponent(wip);
      break;
      // root / fragment / portal / suspense / errorboundary: no own DOM.
  }
  bubbleFlags(wip);
  bubbleLanes(wip);
}

function bubbleLanes(fiber: Fiber): void {
  let lanes = NoLane;
  for (let child = fiber.child; child !== null; child = child.sibling) {
    lanes |= child.lanes | child.childLanes;
  }
  fiber.childLanes = lanes;
}

// ---- Work loop -------------------------------------------------------------

function performUnitOfWork(unit: Fiber): Fiber | null {
  let next: Fiber | null;
  try {
    next = beginWork(unit);
  } catch (thrown) {
    return handleThrow(unit, thrown);
  }
  if (next === null) {
    try {
      return completeUnitOfWork(unit);
    } catch (thrown) {
      return handleThrow(unit, thrown);
    }
  }
  return next;
}

function completeUnitOfWork(unit: Fiber): Fiber | null {
  let node: Fiber | null = unit;
  do {
    completeWork(node);
    if (node.sibling !== null) return node.sibling;
    node = node.return;
  } while (node !== null);
  return null;
}

// ---- Error / suspense unwinding --------------------------------------------

/**
 * Thrown by {@link handleThrow} to abandon a *transition* render that re-suspended
 * an already-revealed boundary — so denext keeps the currently-committed content
 * (no fallback flash) instead of committing the fallback, matching React's
 * recommended `startTransition`/`useDeferredValue` behavior. Caught in
 * {@link resumeConcurrent}; the transition stays pending (isPending true) until the
 * promise settles and the retry commits. Distinct object identity so it is never
 * confused with a user throw.
 */
const SUSPENDED_TRANSITION: { readonly denextSuspendedTransition: true } = {
  denextSuspendedTransition: true,
};

function findSuspense(fiber: Fiber): Fiber | null {
  for (let n = fiber.return; n !== null; n = n.return) {
    if (n.tag === "suspense") return n;
  }
  return null;
}

function findErrorBoundary(fiber: Fiber): Fiber | null {
  for (let n = fiber.return; n !== null; n = n.return) {
    if (n.tag === "errorboundary" || isClassBoundary(n)) return n;
  }
  return null;
}

function componentErrorInfo(fiber: Fiber): { componentStack: string } {
  return { componentStack: `\n    in ${componentDisplayName(fiber.vnode.type)}` };
}

// ---- RootOptions error callbacks (React 19 parity) -------------------------
// The three callbacks observe error handling without changing denext's defaults:
// when a callback is absent, behavior is exactly as before (a boundary handles a
// caught error; an uncaught error surfaces by throwing; a hydration mismatch
// dev-warns). When present, the callback is invoked at the corresponding point — and
// for onRecoverableError it replaces the dev-only hydration warning (React fires it
// in production too). A callback that itself throws must not corrupt the reconciler,
// so each invocation is guarded.

/** Report an error a boundary caught (`onCaughtError`), keyed to the boundary's root. */
function reportCaught(boundary: Fiber, error: unknown): void {
  const cb = rootHandleOf(boundary)?.onCaughtError;
  if (cb) safeCallback(cb, error, componentErrorInfo(boundary));
}

/** Report an error no boundary caught (`onUncaughtError`), keyed to the source's root. */
function reportUncaught(source: Fiber, error: unknown): void {
  const cb = rootHandleOf(source)?.onUncaughtError;
  if (cb) safeCallback(cb, error, componentErrorInfo(source));
}

/**
 * Report a recovered error (`onRecoverableError`) — currently a hydration mismatch,
 * where denext keeps the client render. Fires the callback if registered (any env),
 * else falls back to the dev-only console warning.
 */
function reportHydrationMismatch(fiber: Fiber, detail: string): void {
  const cb = rootHandleOf(fiber)?.onRecoverableError;
  if (cb) safeCallback(cb, new Error(`Hydration failed: ${detail}`), componentErrorInfo(fiber));
  else if (devHydrationActive()) warnHydrationMismatch(detail);
}

/** Invoke a user error callback, swallowing (and logging) a throw from it. */
function safeCallback(
  cb: RootErrorCallback,
  error: unknown,
  info: { componentStack?: string },
): void {
  try {
    cb(error, info);
  } catch (err) {
    console.error("denext: a Root error callback threw", err);
  }
}

/**
 * Handle a throw during begin/completeWork: a thenable suspends the nearest
 * Suspense (commit its fallback, retry when it settles); a genuine error routes
 * to the nearest error boundary (function fallback, or class error lifecycle);
 * control signals and unhandled throws re-throw to abort the render.
 */
/**
 * Decide what a `<Suspense>` inside a `<SuspenseList>` shows this render: its
 * content, its fallback, or nothing (`tail`). A boundary is "revealed" only when
 * its own content is ready AND the boundaries before it (per `revealOrder`) are
 * too. Not-yet-ready boundaries render their content to drive their promise (and
 * suspend to a fallback); a resolved-but-order-gated boundary shows its fallback.
 * With `tail` collapsed/hidden only the leading edge renders (a serial tail).
 */
function suspenseListDisplay(member: Fiber): "content" | "fallback" | "hidden" {
  const st = member.listState!;
  const order = st.revealOrder!;
  // The frozen readiness snapshot for this render, so every member decides against
  // one consistent state.
  const ready = st.snapshot;
  const idx = member.listIndex!;
  const revealed = (i: number): boolean => {
    if (!ready[i]) return false;
    if (order === "together") return ready.length > 0 && ready.every(Boolean);
    if (order === "backwards") return ready.slice(i + 1).every(Boolean);
    return ready.slice(0, i).every(Boolean); // forwards
  };
  if (revealed(idx)) return "content";
  // A boundary not yet revealed shows its fallback. If it hasn't started/finished
  // its promise (not ready and not already suspended) it renders content once to
  // drive the promise — which then suspends back to its fallback.
  const gated = (): "content" | "fallback" =>
    !ready[idx] && member.showingFallback !== true ? "content" : "fallback";
  if (st.tail === "collapsed" || st.tail === "hidden") {
    // Only the leading not-yet-revealed boundary renders; the rest wait, hidden.
    // Length comes from the child count (not `ready.length`, which is empty on the
    // first render before any member reports readiness).
    const n = st.count ?? ready.length;
    const order2 = Array.from({ length: n }, (_, i) => i);
    const seq = order === "backwards" ? order2.reverse() : order2;
    const leading = seq.find((i) => !revealed(i));
    if (idx !== leading) return "hidden";
    // Drive the leading boundary's promise. `"collapsed"` shows its fallback while
    // pending; `"hidden"` shows NO fallback (React parity) — it hides instead, so the
    // fetch still starts (the initial content-drive throws synchronously) but nothing
    // is painted for the pending tail.
    const g = gated();
    return g === "fallback" && st.tail === "hidden" ? "hidden" : g;
  }
  // Default tail: boundaries fetch in parallel.
  return gated();
}

/**
 * Re-seed a boundary's children from its committed alternate so its next beginWork
 * reconciles the fallback / error UI against the committed list.
 */
function reseedBoundary(boundary: Fiber): void {
  boundary.child = boundary.alternate ? boundary.alternate.child : null;
  boundary.deletions = null;
}

/**
 * Transition-aware Suspense: when a transition (startTransition / useDeferredValue)
 * re-suspends a boundary that is CURRENTLY revealed (its committed state shows content,
 * not a fallback), keep showing that content instead of flashing the fallback —
 * React's recommended pattern. This also preserves the subtree's state (it is never
 * unmounted). Excludes SuspenseList members (their reveal ordering owns the fallback
 * decision) and the initial reveal (no committed content to keep). Only ever true on
 * the concurrent render path, so the sentinel it leads to is caught by resumeConcurrent.
 */
function keepsRevealedContent(suspense: Fiber): boolean {
  const revealed = suspense.alternate != null && suspense.alternate.showingFallback !== true;
  const inList = suspense.listState != null && suspense.listState.revealOrder != null;
  return (renderLanes & TransitionLane) !== NoLane && concurrentWipRoot !== null &&
    revealed && !inList;
}

/**
 * Switch `suspense` to its fallback. Offscreen (urgent re-suspend of a boundary that
 * has committed primary content): keep that primary mounted-but-hidden and show the
 * fallback alongside, so the reveal restores the same instances (state preserved)
 * instead of remounting. Not for a SuspenseList member (its reveal ordering owns the
 * fallback) nor during hydration (the fallback must mount fresh, adopting no server
 * DOM). The committed primary is either shown content (revealed) or an already-hidden
 * Offscreen primary. Rendering restarts from the committed child list: Offscreen
 * beginWork reconciles [primary…, fallback…] against it (primary preserved + hidden);
 * the plain path reconciles the fallback against it (remount).
 */
function prepareFallbackRender(suspense: Fiber): void {
  suspense.showingFallback = true;
  const inList = suspense.listState != null && suspense.listState.revealOrder != null;
  const hasCommittedPrimary = suspense.alternate != null &&
    (suspense.alternate.showingFallback !== true || suspense.alternate.offscreen === true);
  suspense.offscreen = hasCommittedPrimary && !inList && !isHydrating;
  // Suspended → not ready, for SuspenseList ordering (indexed on the shared state).
  if (suspense.listState && suspense.listIndex != null) {
    suspense.listState.ready[suspense.listIndex] = false;
  }
  reseedBoundary(suspense);
  if (isHydrating) hydrationCursor = null;
}

/** A component suspended: hand the render to its nearest Suspense boundary. */
function handleSuspend(sourceFiber: Fiber, thenable: Promise<unknown>): Fiber {
  const suspense = findSuspense(sourceFiber);
  if (!suspense) throw thenable;
  if (keepsRevealedContent(suspense)) {
    thenable.then(
      () => retrySuspendedTransition(suspense),
      () => retrySuspendedTransition(suspense),
    );
    throw SUSPENDED_TRANSITION;
  }
  prepareFallbackRender(suspense);
  thenable.then(() => retrySuspense(suspense), () => retrySuspense(suspense));
  return suspense;
}

/**
 * A component threw: capture the error in the nearest boundary (class
 * `componentDidCatch`/`getDerivedStateFromError`, or a function `<ErrorBoundary>`) and
 * hand the render to it; with no boundary — or a class boundary that declined — report
 * it as uncaught and surface it.
 */
function handleRenderError(sourceFiber: Fiber, thrown: unknown): Fiber {
  const boundary = findErrorBoundary(sourceFiber);
  if (!boundary) {
    reportUncaught(sourceFiber, thrown); // no boundary → onUncaughtError, then surface
    throw thrown;
  }
  if (isClassBoundary(boundary)) {
    if (!handleClassError(boundary as never, thrown, componentErrorInfo(boundary))) {
      reportUncaught(sourceFiber, thrown); // the class boundary declined → uncaught
      throw thrown;
    }
    reportCaught(boundary, thrown);
    boundary.lanes = NoLane; // drop the self-scheduled update; we re-render inline
  } else {
    reportCaught(boundary, thrown);
    boundary.__error = thrown;
  }
  reseedBoundary(boundary);
  return boundary;
}

function handleThrow(sourceFiber: Fiber, thrown: unknown): Fiber | null {
  if (isThenable(thrown)) return handleSuspend(sourceFiber, thrown);
  if (isControlSignal(thrown)) throw thrown;
  return handleRenderError(sourceFiber, thrown);
}

// ---- Scheduling ------------------------------------------------------------

function rootHandleOf(fiber: Fiber): RootHandle | null {
  let n: Fiber | null = fiber;
  while (n !== null) {
    if (n.tag === "root") return fiberToRoot.get(n) ?? null;
    n = n.return;
  }
  return null;
}

/**
 * Mark `fiber` (and both its buffers) as having a pending update, propagate the
 * child-lane hint up to the root (marking both buffers so whichever is current
 * sees it), and schedule the appropriate flush.
 */
export function scheduleUpdate(fiber: Fiber): void {
  // With AsyncContext scoping enabled (experimental.asyncContext + the build
  // transform), priority is decided by transition IDENTITY: an update belongs to a
  // transition iff it is enqueued inside that transition's context — which the
  // transform propagates across the user's `await`s. An unrelated urgent update in
  // the pending window carries no transition id, so it stays urgent (the fix).
  // Without scoping, fall back to the time-window depth counters — but an update
  // enqueued synchronously in a DOM event handler is a discrete user interaction
  // and stays urgent even while an async transition is pending (React's model: a
  // click/keydown is never demoted to transition priority). The coarse async window
  // then only entangles updates OUTSIDE any event handler — i.e. the transition's
  // own post-`await` continuations. `transitionDepth > 0` (a synchronous
  // startTransition callback) still wins, so wrapping in startTransition inside a
  // handler is honored.
  const isTransition = asyncCtxScoping
    ? transitionVar.get() != null
    : transitionDepth > 0 || (asyncTransitionDepth > 0 && !inEventDispatch());
  scheduleUpdateLane(fiber, isTransition ? TransitionLane : SyncLane);
}

/** Like {@link scheduleUpdate} but with an explicit lane (e.g. a self-scheduled deferral). */
function scheduleUpdateLane(fiber: Fiber, lane: number): void {
  if (fiber == null) return; // an SSR class setState has no reconciler fiber
  fiber.lanes |= lane;
  if (fiber.alternate) fiber.alternate.lanes |= lane;
  let node = fiber.return;
  while (node !== null) {
    node.childLanes |= lane;
    if (node.alternate) node.alternate.childLanes |= lane;
    node = node.return;
  }
  const handle = rootHandleOf(fiber);
  if (!handle) return;
  handle.pendingLanes |= lane;
  if (duringRender) return; // picked up by the render-again loop
  if (lane & TransitionLane) scheduleTransitionFlush();
  else scheduleSyncFlush();
}

let syncScheduled = false;
function scheduleSyncFlush(): void {
  if (syncScheduled) return;
  syncScheduled = true;
  queueMicrotask(() => {
    syncScheduled = false;
    // An urgent (sync) update interrupts any in-flight transition render: abandon
    // its off-DOM work-in-progress (nothing committed, nothing to roll back) and
    // reschedule the transition to restart from the committed sync state.
    abandonConcurrent();
    flushRoots(SyncLane);
    for (const handle of activeRoots) ensureScheduled(handle);
  });
}

/** Render every root with pending work in `lanes`, to completion (never yields). */
function flushRoots(lanes: number): void {
  for (const handle of activeRoots) {
    if ((handle.pendingLanes & lanes) !== NoLane) renderRoot(handle, lanes);
  }
}

/** Re-arm the sync/transition schedulers if `handle` still has pending work. */
function ensureScheduled(handle: RootHandle): void {
  if ((handle.pendingLanes & SyncLane) !== NoLane) scheduleSyncFlush();
  if ((handle.pendingLanes & TransitionLane) !== NoLane) scheduleTransitionFlush();
}

// ---- Time-sliced transition scheduling -------------------------------------
// Transition-lane updates render on the concurrent path: the work loop checks a
// frame budget between units of work and yields via MessageChannel, resuming on
// the next slice, so a heavy transition never blocks paint/input. The tree is
// built off-DOM and committed only when the render drains — and a sync update can
// interrupt and restart it (see abandonConcurrent). The sync lane, by contrast,
// always runs to completion in renderRoot.

const FRAME_BUDGET_MS = 5;
let sliceStart = 0;
let unitsThisSlice = 0;
/** Test seam: when > 0, yield after every N units (deterministic multi-slice). */
let yieldEvery = 0;

/** Test-only: force the transition loop to yield after every `n` units of work. */
export function __setYieldEveryForTests(n: number): void {
  yieldEvery = n;
}

// Manual slicing: when on, the transition kick and slice continuations are not
// auto-scheduled (no setTimeout / MessageChannel) but recorded, so a test can
// drive them one at a time via __pumpForTests() for deterministic interruption.
let manualSlicing = false;
let pendingKick = false;

/** Test-only: drive transition slices manually instead of via the event loop. */
export function __setManualSlicingForTests(on: boolean): void {
  manualSlicing = on;
  pendingKick = false;
}

/** Test-only: run one pending transition step (kick or slice). Returns did-work. */
export function __pumpForTests(): boolean {
  if (pendingKick) {
    pendingKick = false;
    beginConcurrentRender();
    return true;
  }
  if (continuationScheduled) {
    continuationScheduled = false;
    resumeConcurrent();
    return true;
  }
  return false;
}

function shouldYield(): boolean {
  if (yieldEvery > 0) return ++unitsThisSlice >= yieldEvery;
  return (performance.now() - sliceStart) >= FRAME_BUDGET_MS;
}

let transitionDepth = 0;
// Async transitions in flight: `startTransition(async () => …)` whose returned
// promise has not yet settled. Without AsyncContext scoping denext cannot instrument
// the user's `await`, so while any async transition is pending its window entangles
// updates at transition priority (see scheduleUpdate) — this is how a post-`await`
// `setState` still lands on TransitionLane and how `isPending` is held until the async
// work settles. With scoping enabled this window no longer governs PRIORITY (identity
// does — see transitionVar); it only tracks the pending async work for the watchdog.
let asyncTransitionDepth = 0;

// The current transition's identity, propagated across the user's `await`s by the
// build transform when `experimental.asyncContext` is on. `scheduleUpdate` reads it
// (in scoping mode) so only updates enqueued inside a transition's context are
// deferred; unrelated urgent updates in the pending window keep their priority.
const transitionVar = new Variable<object | null>();

// Seeded from the build-swapped `const` (false by default; the build redirects the
// module to `true` under experimental.asyncContext). A mutable so tests can drive the
// scoping path without the build; production reads the seed and never calls the setter.
let asyncCtxScoping = asyncContextScopingEnabled;

/** Test-only: toggle AsyncContext transition scoping (production uses the build seed). */
export function __setAsyncContextScoping(on: boolean): void {
  asyncCtxScoping = on;
}

// Dev-only: how long an async transition may stay pending before we warn it looks
// wedged (a never-settling `await` in `startTransition(async …)`). Overridable for
// tests via __setAsyncTransitionWarnMs.
let asyncTransitionWarnMs = 10_000;

/** Test-only: set the async-transition watchdog threshold (ms). */
export function __setAsyncTransitionWarnMs(ms: number): void {
  asyncTransitionWarnMs = ms;
}

/**
 * Arm a dev-only timer that warns if an async transition is still pending after
 * {@link asyncTransitionWarnMs}. No-op (returns undefined) outside dev, so prod pays
 * nothing. The timer is unref'd so it never keeps a process alive on its own.
 */
function armAsyncTransitionWatchdog(): ReturnType<typeof setTimeout> | undefined {
  if (!devHydrationActive()) return undefined;
  const timer = setTimeout(() => {
    console.warn(
      "denext: an async transition has been pending for over " +
        `${Math.round(asyncTransitionWarnMs / 1000)}s. A never-settling await inside ` +
        "startTransition(async () => …) holds isPending true and keeps entangling " +
        "updates at transition priority. Ensure the async work resolves or rejects.",
    );
  }, asyncTransitionWarnMs);
  // Under Deno a pending timer keeps the loop alive; unref so the watchdog alone
  // can't. Guarded: `Deno` is undefined in the browser bundle.
  if (typeof Deno !== "undefined") {
    (Deno as { unrefTimer?: (id: number) => void }).unrefTimer?.(timer as unknown as number);
  }
  return timer;
}

/** Disarm the watchdog once the async transition settles. */
function clearAsyncTransitionWatchdog(timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer !== undefined) clearTimeout(timer);
}

let transitionScheduled = false;
let transitionTimer: ReturnType<typeof setTimeout> | undefined;
const transitionDoneCallbacks: Array<() => void> = [];

// The in-flight concurrent (transition) render, or null when none is running.
let concurrentHandle: RootHandle | null = null;
let concurrentWipRoot: Fiber | null = null;

// The time-slicing continuation scheduler (browser-hydration equivalent of React's
// MessageChannel scheduler). The channel is created lazily on first real use — a
// MessageChannel with a live `onmessage` listener is a ref'd handle that keeps
// Deno's event loop alive forever, so constructing it at module scope would hang
// any non-browser process (CLI, SSR, tests) that merely imports this module. It is
// only ever pumped in the browser via scheduleContinuation(); manual-slicing tests
// pump through __pumpForTests() and must never construct it.
let yieldChannel: MessageChannel | undefined;
let continuationScheduled = false;
function scheduleContinuation(): void {
  if (continuationScheduled) return;
  continuationScheduled = true;
  if (manualSlicing) return; // pumped via __pumpForTests()
  if (!yieldChannel) {
    yieldChannel = new MessageChannel();
    yieldChannel.port1.onmessage = () => {
      continuationScheduled = false;
      resumeConcurrent();
    };
  }
  yieldChannel.port2.postMessage(null);
}

function scheduleTransitionFlush(): void {
  if (transitionScheduled || concurrentHandle !== null || pendingKick) return;
  if (manualSlicing) {
    pendingKick = true;
    return;
  }
  transitionScheduled = true;
  transitionTimer = setTimeout(() => {
    transitionTimer = undefined;
    transitionScheduled = false;
    beginConcurrentRender();
  }, 0);
}

function beginConcurrentRender(): void {
  let handle: RootHandle | null = null;
  for (const h of activeRoots) {
    if ((h.pendingLanes & TransitionLane) !== NoLane) {
      handle = h;
      break;
    }
  }
  if (!handle) {
    runTransitionDone();
    return;
  }
  flushPassiveEffects();
  handle.pendingLanes &= ~TransitionLane;
  renderLanes = TransitionLane;
  concurrentHandle = handle;
  const wipRoot = createWorkInProgress(handle.current, null);
  fiberToRoot.set(wipRoot, handle);
  wipRoot.pendingElement = handle.pendingElement;
  wipRoot.host = wipRoot;
  concurrentWipRoot = wipRoot;
  workInProgress = wipRoot;
  sliceStart = performance.now();
  unitsThisSlice = 0;
  resumeConcurrent();
}

/** Whether any active root (optionally excluding one) has `lane` pending. */
function anyRootHasLane(lane: number, except: RootHandle | null = null): boolean {
  for (const h of activeRoots) {
    if (h !== except && (h.pendingLanes & lane) !== NoLane) return true;
  }
  return false;
}

/**
 * Re-arm across ALL roots: a transition update on another root that arrived mid-flight
 * was skipped by scheduleTransitionFlush's in-flight guard and must be picked up now.
 * The transition done-callbacks are held until no root has transition work left, so one
 * root finishing doesn't clear another's pending indicator early.
 */
function settleTransitions(): void {
  if (anyRootHasLane(TransitionLane)) scheduleTransitionFlush();
  else runTransitionDone();
}

/** Drop the in-flight concurrent render: no work-in-progress, no owning root, not rendering. */
function resetConcurrentState(): void {
  workInProgress = null;
  concurrentWipRoot = null;
  concurrentHandle = null;
  duringRender = false;
}

/**
 * A transition re-suspended a revealed boundary: discard this render and keep the
 * current tree (old content stays on screen — no fallback flash). The transition
 * remains pending (do NOT run transition-done, so useTransition's isPending stays true)
 * until retrySuspendedTransition re-arms it once the promise settles. The committed
 * fibers keep their transition lanes, so the retry re-renders the right subtrees.
 * (useId values are cached per hook cell on the persistent fibers, so the retry reuses
 * them automatically.) Only OTHER roots that still have queued transition work are
 * re-armed — this root's lane was consumed and is intentionally left pending.
 */
function discardSuspendedTransition(rootHandle: RootHandle): void {
  resetConcurrentState();
  if (anyRootHasLane(TransitionLane, rootHandle)) scheduleTransitionFlush();
}

/**
 * A render/commit that escaped without an error boundary must not wedge the scheduler:
 * reset the concurrent WIP state, clear the (broken) transition lane so it is not
 * retried into an infinite flap, and settle pending transitions before the caller
 * surfaces the error (as an uncaught render error, like React).
 */
function recoverFromConcurrentError(rootHandle: RootHandle): void {
  rootHandle.pendingLanes &= ~TransitionLane;
  resetConcurrentState();
  settleTransitions();
}

function resumeConcurrent(): void {
  if (workInProgress === null || concurrentWipRoot === null) return; // abandoned
  const rootHandle = concurrentHandle!;
  try {
    resumeConcurrentInner();
  } catch (thrown) {
    if (thrown === SUSPENDED_TRANSITION) {
      discardSuspendedTransition(rootHandle);
      return;
    }
    recoverFromConcurrentError(rootHandle);
    throw thrown;
  }
}

/**
 * Render units of the concurrent tree until it is drained or the slice budget is spent.
 * do/while so each slice makes at least one unit of progress (a shouldYield that fires
 * on the first check would otherwise spin forever).
 */
function renderSlice(): void {
  renderLanes = TransitionLane;
  sliceStart = performance.now();
  unitsThisSlice = 0;
  duringRender = true;
  try {
    do {
      workInProgress = performUnitOfWork(workInProgress!);
    } while (workInProgress !== null && !shouldYield());
  } finally {
    duringRender = false;
  }
}

/** The concurrent tree is fully rendered: commit it and re-arm whatever is queued. */
function finishConcurrentRender(): void {
  const handle = concurrentHandle!;
  const wipRoot = concurrentWipRoot!;
  concurrentHandle = null;
  concurrentWipRoot = null;
  duringRender = true;
  try {
    commitRoot(handle, wipRoot);
  } finally {
    duringRender = false;
  }
  if (anyRootHasLane(SyncLane)) scheduleSyncFlush();
  settleTransitions();
}

function resumeConcurrentInner(): void {
  if (workInProgress === null || concurrentWipRoot === null) return;
  renderSlice();
  if (workInProgress === null) {
    finishConcurrentRender();
    return;
  }
  // An urgent (sync) update born during this slice (a render-phase setState)
  // interrupts the transition instead of waiting for it to finish.
  if ((concurrentHandle!.pendingLanes & SyncLane) !== NoLane) {
    abandonConcurrent();
    scheduleSyncFlush();
    return;
  }
  scheduleContinuation(); // yielded mid-tree; resume on the next slice
}

function abandonConcurrent(): void {
  if (concurrentWipRoot === null) return;
  const handle = concurrentHandle!;
  handle.pendingLanes |= TransitionLane;
  resetConcurrentState();
  scheduleTransitionFlush();
}

function runTransitionDone(): void {
  const dones = transitionDoneCallbacks.splice(0);
  for (const d of dones) d();
}

/** True if any root still has transition-lane work pending or in flight. */
function transitionPending(): boolean {
  if (transitionScheduled || concurrentHandle !== null) return true;
  for (const h of activeRoots) {
    if ((h.pendingLanes & TransitionLane) !== NoLane) return true;
  }
  return false;
}

/**
 * Defer `onComplete` (e.g. useTransition's `setPending(false)`) until the current
 * transition flush lands; if nothing is pending, clear it on a microtask.
 */
function scheduleTransitionComplete(onComplete: () => void): void {
  if (transitionPending()) {
    transitionDoneCallbacks.push(onComplete);
    scheduleTransitionFlush();
  } else {
    queueMicrotask(onComplete);
  }
}

setTransitionScheduler((cb, onComplete) => {
  transitionDepth++;
  let result: unknown;
  try {
    // In scoping mode, run the callback inside a fresh transition identity so its
    // updates — including those after an instrumented `await` — are attributable to
    // THIS transition (see scheduleUpdate + transitionVar). Off, this DCEs to `cb()`.
    result = asyncCtxScoping ? transitionVar.run({}, cb) : cb();
  } catch (err) {
    // A synchronous throw in the transition callback must still clear `isPending`
    // — otherwise the transition wedges "pending" forever. Schedule onComplete
    // (after any updates already queued before the throw settle), then rethrow so
    // the error still surfaces, as React does.
    scheduleTransitionComplete(onComplete);
    throw err;
  } finally {
    transitionDepth--;
  }
  // Async transition: the callback returned a thenable. Hold onComplete until the
  // promise settles AND the resulting transition flush lands. Without scoping, the
  // in-flight window keeps ALL updates at transition priority across the await(s)
  // (coarse — see KNOWN-LIMITATIONS); with scoping, priority is governed by identity
  // (transitionVar, propagated across the user's awaits) and the window here only
  // tracks the pending async work for the watchdog.
  if (result != null && typeof (result as { then?: unknown }).then === "function") {
    asyncTransitionDepth++;
    // Dev-only watchdog: an async transition whose promise never settles holds
    // `isPending` true forever (and, without scoping, keeps entangling updates).
    // Warn (once per stuck transition) so the footgun is visible in development;
    // never force-settle — that would mask the real never-resolving await in prod.
    const watchdog = armAsyncTransitionWatchdog();
    const settle = () => {
      asyncTransitionDepth--;
      clearAsyncTransitionWatchdog(watchdog);
      scheduleTransitionComplete(onComplete);
    };
    (result as Promise<unknown>).then(settle, (err) => {
      settle();
      // The async transition has no render boundary to catch a rejection; keep it
      // visible (unhandled) rather than swallowing it, as React does.
      throw err;
    });
    return;
  }
  if (transitionScheduled || concurrentHandle !== null) transitionDoneCallbacks.push(onComplete);
  else queueMicrotask(onComplete);
});

// ---- Render + commit -------------------------------------------------------

const MAX_RENDER_PASSES = 50;

function renderRoot(handle: RootHandle, lanes: number): void {
  let guard = 0;
  do {
    // Flush pending passive effects before EACH render+commit iteration, not just once
    // before the loop. This loop renders AND commits every iteration; the next
    // iteration's `createWorkInProgress` reuses a fiber's alternate buffer and clears
    // its `passiveEffects`, so a passive effect scheduled + committed in an earlier
    // iteration (already queued in `pendingPassive`) would be stranded — its buffer
    // wiped before the deferred flush ran it. React flushes passive effects before any
    // new unit of work for exactly this reason (it manifested as a Base UI dialog never
    // unmounting on close: the root's unmount-watcher effect was stranded, so the exit
    // never completed and the dialog could not reopen).
    flushPassiveEffects();
    if (++guard > MAX_RENDER_PASSES) {
      // A component is scheduling updates during render in a loop. Clear the lane
      // so we don't hang, then surface it (React throws the same way).
      handle.pendingLanes &= ~lanes;
      throw new Error(
        "denext: Maximum update depth exceeded. A component repeatedly schedules " +
          "an update during render (e.g. calling setState unconditionally while rendering).",
      );
    }
    handle.pendingLanes &= ~lanes; // clear the lanes we're about to process
    renderLanes = lanes;
    const wipRoot = createWorkInProgress(handle.current, null);
    fiberToRoot.set(wipRoot, handle);
    wipRoot.pendingElement = handle.pendingElement;
    wipRoot.host = wipRoot;
    duringRender = true;
    const hydrate = handle.hydrate;
    if (hydrate) {
      isHydrating = true;
      hydrationCursor = { parent: handle.container, index: 0 };
      hydrationStack = [];
    }
    try {
      workInProgress = wipRoot;
      while (workInProgress !== null) workInProgress = performUnitOfWork(workInProgress);
    } finally {
      duringRender = false;
      if (hydrate) {
        isHydrating = false;
        hydrationCursor = null;
        handle.hydrate = false;
      }
    }
    commitRoot(handle, wipRoot);
  } while ((handle.pendingLanes & lanes) !== NoLane);
  // A lower-priority lane (e.g. a transition scheduled by useDeferredValue during
  // this synchronous render) won't be re-entered by the loop above — arm its flush.
  ensureScheduled(handle);
}

/** 1. Before mutation: class getSnapshotBeforeUpdate. */
function commitBeforeMutation(wipRoot: Fiber): void {
  if (!__DENEXT_CLASS_COMPONENTS__) return;
  walk(wipRoot, (f) => {
    if ((f.flags & Snapshot) !== 0) captureSnapshot(f as never);
  });
}

/**
 * 1a. Deletions first — an unmounting fiber runs its effect cleanups (including any
 *     useInsertionEffect cleanup) here, BEFORE the new fibers' insertion-effect setups.
 *     This is React's cleanup-before-setup ordering: on a sibling swap, the old
 *     sibling's insertion cleanup precedes the new sibling's insertion setup (e.g. a
 *     CSS-in-JS library removes the old <style> before inserting the replacement).
 */
function commitDeletions(wipRoot: Fiber): void {
  walk(wipRoot, (f) => {
    if (f.deletions) { for (const d of f.deletions) commitDeletion(d); }
  });
}

/**
 * 1b. Insertion effects (useInsertionEffect) run before the DOM host mutations and
 *     layout reads that follow — React's guarantee that a CSS-in-JS library's style
 *     insertion precedes any layout read. Collected over the work-in-progress tree (its
 *     child / sibling links are already built by render), which excludes any fiber
 *     discarded by a suspense/error unwind, exactly like the layout collection.
 */
function commitInsertionEffects(wipRoot: Fiber): void {
  const insertionFibers: Fiber[] = [];
  collectInsertionEffects(wipRoot, insertionFibers);
  runCommitEffects(insertionFibers, (f) => {
    const es = f.insertionEffects;
    f.insertionEffects = [];
    return es;
  });
}

/** 2. Mutation: host/text property updates. */
function commitMutation(wipRoot: Fiber): void {
  walk(wipRoot, (f) => {
    if ((f.flags & Update) === 0) return;
    if (f.tag === "host") {
      applyProps(
        f.stateNode as Element,
        f,
        (f.alternate?.vnode.props ?? {}) as Record<string, unknown>,
        (f.vnode.props ?? {}) as Record<string, unknown>,
        onErrorFor(f),
      );
    } else if (f.tag === "text") {
      (f.stateNode as Text).nodeValue = String(f.vnode.props.nodeValue ?? "");
    }
  });
}

/** 4. Placement: arrange DOM children of the root and any changed host/portal. */
function commitPlacement(handle: RootHandle, wipRoot: Fiber): void {
  syncChildren(handle.container, childrenDom(wipRoot));
  walk(wipRoot, (f) => {
    if (f.tag === "host" && f.alternate !== null && needsSync(f)) {
      syncChildren(f.stateNode as Element, childrenDom(f));
    } else if (f.tag === "portal" && needsSync(f)) {
      // A portal target (e.g. document.body) is shared with foreign nodes (#root, the
      // entry script, other portals), so place only this portal's own nodes — never
      // prune siblings the reconciler didn't insert.
      placePortalChildren(f.stateNode as Element, childrenDom(f));
    }
  });
}

/**
 * 4b. Clear committed effect flags across the whole tree. A fully-bailed subtree on a
 *     later render keeps its *current* fibers (not cloned via createWorkInProgress), so
 *     leftover flags/deletions here would be re-processed by that later commit's walk —
 *     double-running deletions (double cleanup / willUnmount) or re-applying props.
 *     Reset so the next commit starts clean.
 */
function clearCommittedFlags(wipRoot: Fiber): void {
  walk(wipRoot, (f) => {
    f.flags = NoFlags;
    f.subtreeFlags = NoFlags;
    f.deletions = null;
  });
}

/**
 * 5. Layout effects (useLayoutEffect / class didMount + didUpdate) run synchronously
 *    now, after mutation and before paint, in mount DFS order. Passive effects
 *    (useEffect) are deferred to a scheduled task after the commit. Effects are
 *    collected by walking the COMMITTED tree (post-order, so children run before
 *    parents), which excludes any fiber discarded by a suspense/error unwind — its
 *    effects must not run for content never placed.
 */
function commitLayoutEffects(wipRoot: Fiber): void {
  const effects: Fiber[] = [];
  collectEffects(wipRoot, effects);
  runCommitEffects(effects, (f) => {
    const es = f.pendingEffects;
    f.pendingEffects = [];
    return es;
  });
  for (const f of effects) {
    if (f.passiveEffects && f.passiveEffects.length > 0) pendingPassive.push(f);
  }
  if (pendingPassive.length > 0) schedulePassiveFlush();
}

/** Commit a fully rendered work-in-progress tree, in React's phase order. */
function commitRoot(handle: RootHandle, wipRoot: Fiber): void {
  commitBeforeMutation(wipRoot);
  commitDeletions(wipRoot);
  commitInsertionEffects(wipRoot);
  commitMutation(wipRoot);
  // 3. Atomic swap: the work-in-progress tree becomes current.
  handle.current = wipRoot;
  commitPlacement(handle, wipRoot);
  clearCommittedFlags(wipRoot);
  // 4c. Offscreen visibility: hide the primary portion of a boundary that re-suspended
  //     urgently (display:none, kept mounted so its state survives), and restore it on
  //     reveal. Skipped entirely unless a boundary changed Offscreen state this commit.
  if (anyOffscreen) {
    anyOffscreen = false;
    walk(wipRoot, applyOffscreenVisibility);
  }
  commitLayoutEffects(wipRoot);
  // 5b. Profiler onRender.
  if (anyProfiler) fireProfilers(wipRoot);
  // 6. DevTools.
  reportCommit(handle);
}

/** Whether any <Profiler> boundary exists (skips the commit-time walk otherwise). */
let anyProfiler = false;

/** Set when a boundary entered or left Offscreen this render (gates the commit pass). */
let anyOffscreen = false;

/**
 * Prior `style` attribute of each element hidden by Offscreen, so reveal restores it
 * exactly (an element may carry its own inline `style`, e.g. `display:flex`). `null`
 * means the element had no `style` attribute before it was hidden.
 */
const offscreenPrevStyle = new WeakMap<Element, string | null>();

/**
 * Commit-time visibility for an Offscreen Suspense boundary. On its first Offscreen
 * commit, hide the DOM of its primary portion (the first `primaryCount` children) with
 * an inline `display:none !important` (matching React, which overrides author CSS —
 * unlike the `hidden` attribute, which `[hidden]{display:…}` rules can defeat); on
 * reveal, restore each element's prior inline style. The subtree stays mounted
 * throughout, so its state lives.
 */
/**
 * Hide one element with inline `display:none !important`, remembering its prior style.
 * Appended at the end so the declaration wins over any prior `display` in the element's
 * own inline style (later + `!important` declaration wins).
 */
function hideElement(el: Element): void {
  const prev = el.getAttribute("style");
  offscreenPrevStyle.set(el, prev);
  const trimmed = prev?.trim() ?? "";
  const base = trimmed === "" ? "" : (trimmed.endsWith(";") ? trimmed : trimmed + ";");
  el.setAttribute("style", base + "display:none !important");
}

/** Undo {@linkcode hideElement}: restore the prior inline style (or remove it). */
function restoreElement(el: Element): void {
  const prev = offscreenPrevStyle.get(el);
  if (prev == null) el.removeAttribute("style");
  else el.setAttribute("style", prev);
  offscreenPrevStyle.delete(el);
}

/**
 * First hide: hide the primary DOM AND disconnect its effects — a timer or subscription
 * registered in the hidden subtree must stop while it's offscreen (state in
 * useState/useRef cells is untouched, so it survives the reveal).
 */
function hideOffscreenPrimary(f: Fiber): void {
  const dom: (Element | Text)[] = [];
  let c = f.child;
  for (let i = 0; c !== null && i < f.primaryCount!; c = c.sibling, i++) {
    collectDom(c, dom);
    disconnectEffects(c);
  }
  const els: Element[] = [];
  for (const n of dom) {
    if (n.nodeType !== 1) continue;
    hideElement(n as Element);
    els.push(n as Element);
  }
  f.hiddenEls = els;
}

/**
 * Reveal: restore the DOM and reconnect the effects torn down on hide. By now beginWork
 * has cleared primaryCount and reconciled just the primary content, so every child of
 * `f` is a revealed primary fiber.
 */
function revealOffscreenPrimary(f: Fiber): void {
  for (const el of f.hiddenEls!) restoreElement(el);
  f.hiddenEls = undefined;
  for (let c = f.child; c !== null; c = c.sibling) reconnectEffects(c);
}

function applyOffscreenVisibility(f: Fiber): void {
  if (f.tag !== "suspense") return;
  const shouldHide = f.offscreen === true && f.showingFallback === true &&
    f.primaryCount != null;
  if (shouldHide && f.hiddenEls == null) hideOffscreenPrimary(f);
  else if (!shouldHide && f.hiddenEls != null) revealOffscreenPrimary(f);
}

/**
 * Visit every hook cell of every component fiber in an Offscreen subtree, children
 * before parents (unmount order). A nested boundary that is itself offscreen owns its
 * own effect state — it (and its subtree) is left alone so an outer hide/reveal doesn't
 * fight its lifecycle.
 */
function forEachOffscreenCell(fiber: Fiber, visit: (fiber: Fiber, cell: HookCell) => void): void {
  if (fiber.tag === "suspense" && fiber.hiddenEls != null) return;
  for (let c = fiber.child; c !== null; c = c.sibling) forEachOffscreenCell(c, visit);
  if (fiber.tag !== "component" || !fiber.hooks) return;
  for (const cell of fiber.hooks) visit(fiber, cell);
}

/** Run an effect cell's cleanup and mark it disconnected; a throwing cleanup is routed to a boundary. */
function disconnectCell(fiber: Fiber, cell: HookCell): void {
  if (!cell.reconnect || cell.disconnected === true) return;
  if (typeof cell.cleanup === "function") {
    try {
      cell.cleanup();
    } catch (err) {
      scheduleEffectError(fiber, err);
    }
  }
  cell.cleanup = undefined;
  cell.disconnected = true;
}

/** Re-run a disconnected effect cell's setup. */
function reconnectCell(fiber: Fiber, cell: HookCell): void {
  if (cell.disconnected !== true) return;
  cell.disconnected = false;
  try {
    cell.reconnect!();
  } catch (err) {
    scheduleEffectError(fiber, err);
  }
}

/**
 * Tear down every passive/layout effect in an Offscreen subtree (children before
 * parents, unmount order), leaving state cells intact. Each effect cell keeps a
 * `reconnect` thunk so {@linkcode reconnectEffects} can rebuild it on reveal.
 */
function disconnectEffects(fiber: Fiber): void {
  forEachOffscreenCell(fiber, disconnectCell);
}

/** Re-run the setup of every effect a prior {@linkcode disconnectEffects} tore down. */
function reconnectEffects(fiber: Fiber): void {
  forEachOffscreenCell(fiber, reconnectCell);
}

/**
 * For each committed `<Profiler>` boundary, fire its `onRender` with the subtree's
 * `actualDuration` (components that rendered this commit) and `baseDuration` (every
 * component's most-recent render time, so a fully-memoized commit has actual ≪ base).
 */
function fireProfilers(root: Fiber): void {
  const commitTime = performance.now();
  walk(root, (f) => {
    if (f.profiler == null) return;
    let actual = 0;
    let base = 0;
    walk(f, (d) => {
      actual += d.actualDuration ?? 0;
      base += d.selfBaseDuration ?? 0;
    });
    const phase: ProfilerPhase = f.profilerMounted ? "update" : "mount";
    f.profilerMounted = true;
    f.profiler.onRender?.(f.profiler.id, phase, actual, base, commitTime - actual, commitTime);
  });
}

/** Collect component fibers with queued insertion effects, children before parents. */
function collectInsertionEffects(fiber: Fiber, out: Fiber[]): void {
  if (fiber.hidden === true) return; // Offscreen-hidden subtree: effects are gated.
  for (let c = fiber.child; c !== null; c = c.sibling) collectInsertionEffects(c, out);
  if (fiber.tag !== "component") return;
  if (fiber.insertionEffects && fiber.insertionEffects.length > 0) out.push(fiber);
}

/** Collect component fibers with pending effects, children before parents. */
function collectEffects(fiber: Fiber, out: Fiber[]): void {
  if (fiber.hidden === true) return; // Offscreen-hidden subtree: effects are gated.
  for (let c = fiber.child; c !== null; c = c.sibling) collectEffects(c, out);
  if (fiber.tag !== "component") return;
  if (
    (fiber.pendingEffects && fiber.pendingEffects.length > 0) ||
    (fiber.passiveEffects && fiber.passiveEffects.length > 0)
  ) {
    out.push(fiber);
  }
}

function needsSync(fiber: Fiber): boolean {
  return ((fiber.flags | fiber.subtreeFlags) & (Placement | ChildDeletion | ChildrenChanged)) !== 0;
}

/** Pre-order DFS over the work-in-progress tree. */
function walk(fiber: Fiber, visit: (f: Fiber) => void): void {
  visit(fiber);
  for (let c = fiber.child; c !== null; c = c.sibling) walk(c, visit);
}

/**
 * Run one commit phase's effects across `fibers` in React's two-pass order: EVERY
 * effect's cleanup first, then EVERY effect's setup. `take` drains a fiber's queue
 * so it isn't re-run. A plain thunk (a class-lifecycle entry with no `.cleanup`)
 * only participates in the setup pass. An error routes to a boundary without
 * skipping the rest of the pass.
 *
 * This all-cleanups-before-all-setups ordering is the key fix (M8): bundling a
 * cleanup with its own setup would let sibling B's setup run before sibling A's
 * cleanup, breaking a shared-resource handoff.
 */
function runCommitEffects(
  fibers: Fiber[],
  take: (f: Fiber) => CommitEffect[] | undefined,
): void {
  const pairs: Array<[Fiber, CommitEffect]> = [];
  for (const f of fibers) {
    const es = take(f);
    if (es) { for (const e of es) pairs.push([f, e]); }
  }
  for (const [f, e] of pairs) {
    if (typeof e.cleanup === "function") {
      try {
        e.cleanup();
      } catch (err) {
        scheduleEffectError(f, err); // route to a boundary; don't skip the pass
      }
    }
  }
  for (const [f, e] of pairs) {
    try {
      e();
    } catch (err) {
      scheduleEffectError(f, err); // route to a boundary; don't skip the pass
    }
  }
}

// ---- Passive effects (useEffect): scheduled after commit -------------------
// React runs passive effects on a task after paint, separate from the synchronous
// layout phase. denext schedules them on a macrotask and flushes them
// synchronously at the points React does: before starting the next render, and
// inside flushSync/act. Class lifecycle and useLayoutEffect stay in the layout
// phase (synchronous), so their observable timing is unchanged.

const pendingPassive: Fiber[] = [];
let passiveScheduled = false;
let flushingPassive = false;

function schedulePassiveFlush(): void {
  if (passiveScheduled) return;
  passiveScheduled = true;
  setTimeout(() => {
    passiveScheduled = false;
    flushPassiveEffects();
  }, 0);
}

/** Run all queued passive effects (useEffect). Safe to call repeatedly. */
function flushPassiveEffects(): void {
  if (flushingPassive || pendingPassive.length === 0) return;
  flushingPassive = true;
  try {
    const batch = pendingPassive.splice(0);
    // All passive cleanups across the batch run before any passive setup — React's
    // two-pass order (commitPassiveUnmount then commitPassiveMount).
    runCommitEffects(batch, (f) => {
      const es = f.passiveEffects;
      f.passiveEffects = [];
      return es;
    });
  } finally {
    flushingPassive = false;
  }
}

/** Unmount a fiber subtree: lifecycle cleanups, ref detach, DOM removal. */
/**
 * Run a fiber's own unmount cleanups: the class lifecycle, then every hook cleanup. A
 * throwing cleanup must not strand the rest of the unmount (sibling cleanups, ref
 * detach, DOM removal). The subtree is being destroyed, so report rather than route to
 * a boundary within it.
 */
function runUnmountCleanups(fiber: Fiber): void {
  if (__DENEXT_CLASS_COMPONENTS__ && fiber.classInstance) unmountClassInstance(fiber as never);
  if (!fiber.hooks) return;
  for (const cell of fiber.hooks) {
    if (typeof cell.cleanup !== "function") continue;
    try {
      cell.cleanup();
    } catch (err) {
      console.error("denext: a cleanup threw during unmount", err);
    }
  }
}

/** Remove a host/text fiber's node from the DOM, if it is attached. */
function removeHostNode(fiber: Fiber): void {
  const dom = fiber.stateNode;
  if (dom && (fiber.tag === "host" || fiber.tag === "text") && dom.parentNode) {
    dom.parentNode.removeChild(dom);
  }
}

/**
 * Mark unmounted and sever tree links so that if anything outside the tree still
 * references this fiber (a pending Suspense retry promise), it can't pin the rest of
 * the detached subtree or the root in memory.
 */
function severFiber(fiber: Fiber): void {
  fiber.unmounted = true;
  if (fiber.alternate) fiber.alternate.unmounted = true;
  fiber.child = null;
  fiber.sibling = null;
  fiber.return = null;
  fiber.stateNode = null;
}

function commitDeletion(fiber: Fiber): void {
  fiber.lanes = NoLane;
  if (fiber.alternate) fiber.alternate.lanes = NoLane;
  // Drop any not-yet-run passive effects so the scheduled flush never runs an
  // effect for an unmounted component (its cleanups run below via the hook cells).
  fiber.passiveEffects = undefined;
  // Destroy children BEFORE this fiber's own cleanups — React's unmount order is
  // child-before-parent, so a parent effect's cleanup can rely on its children's
  // having already run. Capture the next sibling before recursing, since we sever
  // links below, which would otherwise cut the traversal short.
  for (let c = fiber.child; c !== null;) {
    const next = c.sibling;
    commitDeletion(c);
    c = next;
  }
  if (fiber.tag === "component") runUnmountCleanups(fiber);
  if (fiber.attachedRef != null) detachRef(fiber);
  removeHostNode(fiber);
  severFiber(fiber);
}

// ---- Suspense + error-boundary runtime helpers -----------------------------

/**
 * Re-run a transition that was kept pending because it re-suspended a revealed
 * boundary (see {@link SUSPENDED_TRANSITION}). The committed fibers still carry the
 * original transition's lanes (only the discarded work-in-progress had them
 * cleared), so re-arming the root's transition lane re-renders exactly the
 * subtrees the transition touched — now that the promise has settled.
 */
function retrySuspendedTransition(inst: Fiber): void {
  if (inst.unmounted) return; // boundary was unmounted before the promise settled
  const handle = rootHandleOf(inst);
  if (!handle) return;
  handle.pendingLanes |= TransitionLane;
  scheduleTransitionFlush();
}

function retrySuspense(inst: Fiber): void {
  if (inst.unmounted) return; // boundary was unmounted before the promise settled
  inst.showingFallback = false;
  const st = inst.listState;
  if (st && inst.listIndex != null) {
    // Mark this member ready on the shared state (indexed — the captured fiber may
    // be stale) and re-render every member so they re-evaluate reveal order.
    st.ready[inst.listIndex] = true;
    for (const m of st.members) if (m) scheduleUpdate(m);
  } else {
    scheduleUpdate(inst);
  }
}

function resetBoundary(inst: Fiber): void {
  inst.__error = undefined;
  scheduleUpdate(inst);
  flushRoots(SyncLane); // event-time (fallback's reset button): commit synchronously
}

function triggerBoundary(inst: Fiber, error: unknown): void {
  if (isControlSignal(error)) throw error;
  if (__DENEXT_CLASS_COMPONENTS__ && isClassBoundary(inst)) {
    if (!handleClassError(inst as never, error, componentErrorInfo(inst))) {
      reportUncaught(inst, error); // the class boundary declined → uncaught
      throw error;
    }
    reportCaught(inst, error);
    scheduleUpdate(inst);
    flushRoots(SyncLane);
    return;
  }
  reportCaught(inst, error);
  inst.__error = error;
  scheduleUpdate(inst);
  // Event-handler / async errors are caught outside render; commit the fallback
  // synchronously so the DOM reflects it immediately (React can't do this).
  flushRoots(SyncLane);
}

function routeToBoundary(inst: Fiber, error: unknown): void {
  const boundary = findErrorBoundary(inst);
  if (!boundary) {
    reportUncaught(inst, error); // no boundary → onUncaughtError, then surface
    throw error;
  }
  triggerBoundary(boundary, error);
}

function handleEventError(inst: Fiber, error: unknown): void {
  if (isRedirect(error)) {
    if (typeof location !== "undefined") location.href = error.url;
    return;
  }
  if (isControlSignal(error)) throw error;
  routeToBoundary(inst, error);
}

/**
 * Route an error thrown by a layout/passive effect to the nearest error boundary.
 * Deferred to a microtask because effects run inside `commitRoot`: routing does a
 * synchronous fallback commit (`flushRoots`), which must not re-enter the current
 * commit. An error with no boundary surfaces as an uncaught microtask (React parity).
 */
function scheduleEffectError(inst: Fiber, error: unknown): void {
  queueMicrotask(() => handleEventError(inst, error));
}

function makeBoundaryController(inst: Fiber | null): ErrorBoundaryController {
  const boundary = inst ? findErrorBoundary(inst) : null;
  return {
    reset() {
      if (boundary) resetBoundary(boundary);
    },
    captureError(error: unknown) {
      if (boundary) triggerBoundary(boundary, error);
      else if (isControlSignal(error)) throw error;
    },
  };
}

setBoundaryControllerProvider(() => makeBoundaryController(currentFiber));

// Wire the client re-render scheduler into the class runtime (which injects it
// rather than importing this module, keeping the SSR/CLI graph client-free).
setClassScheduleUpdate(scheduleUpdate);

// Dev per-module HMR: let the Fast Refresh runtime re-render every mounted root
// after an edited module re-imports (family-current substitution takes effect on
// the live tree). A plain function-pointer handoff; only invoked in dev.
setRootRefresh(refreshAllRoots);

// ---- DevTools bridge -------------------------------------------------------

let devToolsActive: boolean | undefined;

// A single observer the first-party denext inspector (src/client/devtools-inspect.ts)
// registers to learn a commit happened; it then lazily re-reads the tree on its own.
// Distinct from the React-extension bridge below and fired UNCONDITIONALLY — even when
// that extension is absent — so the native panel updates regardless. Never installed in
// production: the inspector module is imported only by dev route/Flight entries.
let commitObserver: (() => void) | null = null;

/** Register (or clear, with `null`) the dev inspector's per-commit observer. */
export function setCommitObserver(fn: (() => void) | null): void {
  commitObserver = fn;
}

// Dev-only: the first-party inspector supplies its stable fiber-id function so the React
// DevTools bridge's synthetic nodes can carry the SAME id the native inspector uses —
// letting the stock extension's prop/state edits route back to the right denext fiber.
// Null in production (and until installInspector runs), where DevNode.id is just -1.
let devIdForFiber: ((fiber: Fiber) => number) | null = null;

/** Register (or clear, with `null`) the inspector's fiber-id function for the RD bridge. */
export function setDevIdForFiber(fn: ((fiber: Fiber) => number) | null): void {
  devIdForFiber = fn;
}

// Dev-only DevTools profiler sink: when set, every component render is timed and
// reported (component type + duration ms + the fiber, for per-commit flamegraph
// capture). Null in production and when the panel's profiler is off, so the render hot
// path pays only a single null check.
let renderProfiler: ((type: unknown, ms: number, fiber: Fiber) => void) | null = null;

/** Register (or clear, with `null`) the dev DevTools render profiler. */
export function setRenderProfiler(
  fn: ((type: unknown, ms: number, fiber: Fiber) => void) | null,
): void {
  renderProfiler = fn;
}

// Dev-only DevTools prop overrides: the panel can pin a component's prop to a value
// (the live companion to editing useState). Overrides are merged over the fiber's
// real props at render time. `overridesActive` gates the per-render lookup to zero
// cost in production and whenever nothing is overridden.
const fiberOverrides = new WeakMap<Fiber, Record<string, unknown>>();
// `overridesActive` gates the per-render override lookup — it tracks a live count of
// overridden fibers so it flips back to false once the last override is cleared
// (not stuck true for the rest of the session after any override).
let overrideCount = 0;
let overridesActive = false;

/** Pin `fiber`'s prop `key` to `value` and re-render it (dev DevTools). Overrides are
 * shared across both buffers (a fiber and its `alternate`), which the reconciler swaps
 * between renders. */
export function overrideFiberProp(fiber: Fiber, key: string, value: unknown): void {
  const existing = fiberPropOverrides(fiber);
  const ov = existing ?? {};
  ov[key] = value;
  fiberOverrides.set(fiber, ov);
  if (fiber.alternate) fiberOverrides.set(fiber.alternate, ov);
  if (!existing) overrideCount++;
  overridesActive = overrideCount > 0;
  scheduleUpdate(fiber);
}

/** Drop all prop overrides on `fiber` and re-render it (dev DevTools). */
export function clearFiberProps(fiber: Fiber): void {
  const had = fiberPropOverrides(fiber) !== undefined;
  fiberOverrides.delete(fiber);
  if (fiber.alternate) fiberOverrides.delete(fiber.alternate);
  if (had) {
    overrideCount = Math.max(0, overrideCount - 1);
    overridesActive = overrideCount > 0;
    scheduleUpdate(fiber);
  }
}

/** The prop overrides pinned on `fiber` or its alternate (dev DevTools), or undefined. */
export function fiberPropOverrides(fiber: Fiber): Record<string, unknown> | undefined {
  return fiberOverrides.get(fiber) ??
    (fiber.alternate ? fiberOverrides.get(fiber.alternate) : undefined);
}

/** A snapshot of the committed root fibers, for the dev inspector's tree walk. */
export function devRootFibers(): Fiber[] {
  const out: Fiber[] = [];
  for (const h of activeRoots) out.push(h.current);
  return out;
}

function reportCommit(handle: RootHandle): void {
  const obs = commitObserver;
  if (obs !== null) {
    try {
      obs();
    } catch {
      // The inspector observer must never affect rendering.
    }
  }
  try {
    if (devToolsActive === undefined) devToolsActive = injectDevTools();
    if (!devToolsActive) return;
    const child = handle.current.child;
    commitToDevTools(child ? fiberToDevNode(child) : null);
  } catch {
    // The DevTools bridge must never affect rendering.
  }
}

function fiberChildrenDevNodes(fiber: Fiber): DevNode[] {
  const out: DevNode[] = [];
  for (let c = fiber.child; c !== null; c = c.sibling) out.push(fiberToDevNode(c));
  return out;
}

/**
 * Per-tag overrides on the default (host) DevNode shape. Text carries its content and
 * no children; a component's single rendered child is its subtree; boundaries,
 * fragments and portals are synthetic named nodes without DOM of their own.
 */
const DEV_NODE_BY_TAG: Partial<Record<FiberTag, (fiber: Fiber) => Partial<DevNode>>> = {
  text: (f) => ({
    kind: "text",
    name: "text",
    key: null,
    props: {},
    text: String((f.vnode.props as { nodeValue?: unknown })?.nodeValue ?? ""),
    children: [],
  }),
  component: (f) => ({
    kind: "component",
    name: componentDisplayName(f.vnode.type),
    dom: null,
    children: f.child ? [fiberToDevNode(f.child)] : [],
  }),
  suspense: () => ({ kind: "component", name: "Suspense", dom: null }),
  errorboundary: () => ({ kind: "component", name: "ErrorBoundary", dom: null }),
  fragment: () => ({ kind: "fragment", name: "Fragment", dom: null }),
  portal: () => ({ kind: "fragment", name: "Portal", props: {}, dom: null }),
};

function fiberToDevNode(fiber: Fiber): DevNode {
  const vtype = fiber.vnode.type;
  const override = DEV_NODE_BY_TAG[fiber.tag]?.(fiber) ?? {};
  const node: DevNode = {
    // The inspector's stable id (dev-only), so the RD bridge can route edits back.
    id: devIdForFiber ? devIdForFiber(fiber) : -1,
    kind: "host",
    name: typeof vtype === "string" ? vtype : "host",
    key: fiber.vnode.key == null ? null : String(fiber.vnode.key),
    props: fiber.vnode.props,
    dom: fiber.stateNode,
    children: [],
    ...override,
  };
  if (override.children === undefined) node.children = fiberChildrenDevNodes(fiber);
  return node;
}

// ---- Public API ------------------------------------------------------------

/**
 * Render `children` into a different DOM `container` while keeping their place in
 * the component and context tree. Backs `react-dom`'s `createPortal`.
 */
export function createPortal(
  children: VNodeChild,
  container: Element,
  key?: string | null,
): VNode {
  return {
    type: PORTAL as unknown as VNode["type"],
    props: { target: container, children },
    key: key ?? null,
  };
}

/**
 * Options accepted by {@link createRoot}/{@link hydrateRoot} for React parity.
 * `identifierPrefix` is wired into the root's `useId` scope; the three error callbacks
 * observe error handling without changing denext's default behavior (a boundary still
 * catches, an uncaught error still surfaces, a hydration mismatch still keeps the
 * client render).
 */
export interface RootOptions {
  /** Invoked when an error boundary catches an error (render, effect, or event). */
  onCaughtError?: (error: unknown, errorInfo: { componentStack?: string }) => void;
  /** Invoked when an error reaches the root uncaught (it still surfaces afterward). */
  onUncaughtError?: (error: unknown, errorInfo: { componentStack?: string }) => void;
  /**
   * Invoked when denext recovers from an error — currently a hydration mismatch,
   * where the client render is kept. Replaces the dev-only mismatch console warning.
   */
  onRecoverableError?: (error: unknown, errorInfo: { componentStack?: string }) => void;
  /**
   * Prefix seeded into this root's `useId` scope so ids don't collide across multiple
   * roots on one page. On hydration it must match the server render's `identifierPrefix`.
   */
  identifierPrefix?: string;
}

/** A mounted (or hydrated) render root that can be re-rendered or torn down. */
export interface Root {
  /** Render (or re-render) `vnode` into this root's container. */
  render(vnode: VNode): void;
  /** Unmount the tree and remove its DOM nodes from the container. */
  unmount(): void;
}

function makeRootFiber(container: Element, identifierPrefix = ""): Fiber {
  const fiber = createFiber("root", { type: "#root", props: {}, key: null });
  fiber.stateNode = container;
  fiber.host = fiber;
  fiber.listeners = new Map();
  // The root's children slot into a fresh root id scope seeded with `identifierPrefix`
  // (default "" — byte-identical to before). Two roots on one page with distinct
  // prefixes yield non-colliding `useId` values; on hydration the prefix must match the
  // server render's `identifierPrefix` so ids align.
  fiber.idParentScope = rootScope(identifierPrefix);
  return fiber;
}

// Dev Fast Refresh (SPA mode): the retained root per container. A foreign SPA's
// `main.tsx` calls `createRoot(el).render(app)` itself, so a refresh re-imports the
// whole entry — which would call `createRoot(el)` a SECOND time. In production that
// must make a fresh root; under Fast Refresh (the only time `familyMatchActive()` is
// true) we instead hand back the container's existing root, so the re-import's
// fresh component refs reconcile onto the live fiber tree (family-matched) and hook
// state survives — exactly what a route entry gets from `startClient`'s retained
// root. Keyed weakly so a container that leaves the DOM is collectable.
const retainedRootByContainer = new WeakMap<Element, Root>();

/**
 * Dev per-module HMR: the edited module has already re-imported and updated its
 * component family's `current` impl; this marks exactly the live fibers whose family
 * changed dirty so they re-render, and `renderComponent`'s family substitution then
 * runs the fresh code on those existing fibers with hook state intact. Installed via
 * `setRootRefresh` and invoked by the Fast Refresh runtime; never called in production.
 */
function refreshAllRoots(): void {
  if (!familyResolveActive()) return;
  // Mark exactly the fibers whose component family changed (its `current` impl now
  // differs from the ref the fiber committed with) dirty, then let the scheduler flush.
  // A plain root re-render would bail — the root element is referentially unchanged, so
  // nothing is dirty — whereas `scheduleUpdate` forces those fibers to re-render, and
  // `renderComponent`'s family-current substitution then renders the edited code on the
  // live fiber with hook state intact. Targeting only changed families keeps unaffected
  // subtrees from re-rendering (true per-module HMR, not a whole-tree refresh).
  for (const handle of activeRoots) {
    walk(handle.current, (f) => {
      if (resolveFamilyCurrent(f.vnode.type) !== f.vnode.type) scheduleUpdate(f);
    });
  }
}

/** Register a new root over `container` with the scheduler and return its handle. */
function registerRoot(
  container: Element,
  options: RootOptions | undefined,
  hydrate: boolean,
  pendingElement: VNode | null,
): RootHandle {
  const rootFiber = makeRootFiber(container, options?.identifierPrefix);
  const handle: RootHandle = {
    container,
    current: rootFiber,
    pendingElement,
    pendingLanes: NoLane,
    hydrate,
    onCaughtError: options?.onCaughtError,
    onUncaughtError: options?.onUncaughtError,
    onRecoverableError: options?.onRecoverableError,
  };
  fiberToRoot.set(rootFiber, handle);
  activeRoots.add(handle);
  return handle;
}

/** Render `vnode` into a root synchronously. */
function renderInto(handle: RootHandle, vnode: VNode): void {
  handle.pendingElement = vnode;
  renderRoot(handle, SyncLane);
}

/** Unmount a root's whole tree, then drop the root from scheduling and DevTools. */
function unmountRoot(handle: RootHandle): void {
  for (let c = handle.current.child; c !== null; c = c.sibling) commitDeletion(c);
  handle.current.child = null;
  activeRoots.delete(handle);
  reportCommit(handle);
}

/** Mount `vnode` into `container`, creating fresh DOM. */
export function createRoot(container: Element, options?: RootOptions): Root {
  // Fast Refresh: a second createRoot on a live container reconciles in place.
  if (familyMatchActive()) {
    const existing = retainedRootByContainer.get(container);
    if (existing) return existing;
  }
  const handle = registerRoot(container, options, false, null);
  const root: Root = {
    render: (vnode) => renderInto(handle, vnode),
    unmount() {
      retainedRootByContainer.delete(container);
      unmountRoot(handle);
    },
  };
  if (familyMatchActive()) retainedRootByContainer.set(container, root);
  return root;
}

/** Hydrate `vnode` against server-rendered markup already in `container`. */
export function hydrateRoot(container: Element, vnode: VNode, options?: RootOptions): Root {
  const handle = registerRoot(container, options, true, vnode);
  renderRoot(handle, SyncLane);
  return {
    render: (next) => renderInto(handle, next),
    unmount: () => unmountRoot(handle),
  };
}

// ---- flushSync / act -------------------------------------------------------

/**
 * Run `fn` (if given) and then synchronously flush all pending state updates —
 * including any pending transition work — before returning. Matches React's
 * `flushSync(fn)`.
 */
export function flushSync<T>(fn?: () => T): T | undefined {
  const result = fn ? fn() : undefined;
  // Cancel any scheduled transition macrotask and reclaim an in-flight slice, so
  // everything (sync + transition) is rendered to completion synchronously below.
  if (transitionTimer !== undefined) {
    clearTimeout(transitionTimer);
    transitionTimer = undefined;
  }
  transitionScheduled = false;
  if (concurrentWipRoot !== null) {
    const handle = concurrentHandle!;
    handle.pendingLanes |= TransitionLane;
    workInProgress = null;
    concurrentWipRoot = null;
    concurrentHandle = null;
    duringRender = false;
  }
  try {
    flushRoots(SyncLane | TransitionLane);
  } finally {
    runTransitionDone();
  }
  // A transition done-callback (e.g. clearing isPending) may schedule sync work.
  flushRoots(SyncLane);
  // flushSync also drains passive effects synchronously (as React's does), and any
  // sync work they schedule, so the caller sees a fully settled tree.
  flushPassiveEffects();
  flushRoots(SyncLane);
  return result;
}

/**
 * `act(callback)` — the React test helper. Runs `callback`, flushes all pending
 * state updates and effects synchronously, and returns a thenable so both sync
 * and async usage work.
 */
export function act<T>(callback: () => T | Promise<T>): Promise<T> {
  const result = callback();
  flushSync();
  return Promise.resolve(result).then((value) => {
    flushSync();
    return value;
  });
}
