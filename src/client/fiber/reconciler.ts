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
import {
  normalizeChildren,
  reportSignatureChange,
  sameType,
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
/** Deterministic id counter backing useId (aligns with the SSR sequence). */
let clientIdCounter = 0;

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
}

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
  deps?: unknown[],
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

const clientDispatcher: Dispatcher = {
  useState<S>(initial: S | (() => S)): [S, (v: S | ((p: S) => S)) => void] {
    const inst = currentFiber!;
    const cell = getHook(HK_STATE);
    if (!cell.inited) {
      cell.value = typeof initial === "function" ? (initial as () => S)() : initial;
      cell.inited = true;
    }
    const setter = (v: S | ((p: S) => S)) => {
      const next = typeof v === "function" ? (v as (p: S) => S)(cell.value as S) : v;
      if (Object.is(next, cell.value)) return;
      cell.value = next;
      scheduleUpdate(inst);
    };
    return [cell.value as S, setter];
  },

  useReducer<S, A, I>(reducer: (s: S, a: A) => S, initialArg: I, init?: (arg: I) => S) {
    const inst = currentFiber!;
    const cell = getHook(HK_REDUCER);
    if (!cell.inited) {
      cell.value = init ? init(initialArg) : initialArg;
      cell.inited = true;
    }
    const dispatch = (action: A) => {
      const next = reducer(cell.value as S, action);
      if (Object.is(next, cell.value)) return;
      cell.value = next;
      scheduleUpdate(inst);
    };
    return [cell.value as S, dispatch];
  },

  useEffect(effect, deps?: unknown[]) {
    const inst = currentFiber!;
    scheduleEffect(inst, inst.passiveEffects!, getHook(HK_EFFECT), effect, deps);
  },

  useMemo<T>(factory: () => T, deps?: unknown[]): T {
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
    if (inst.inherited.has(context._id)) {
      return inst.inherited.get(context._id) as T;
    }
    return context._defaultValue;
  },

  useId(): string {
    const cell = getHook(HK_ID);
    if (!cell.inited) {
      cell.value = `:d${clientIdCounter++}:`;
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
    // During hydration the client render must reproduce the server HTML, which was
    // built from getServerSnapshot — read it here too, or a store whose server and
    // client snapshots differ (matchMedia, cookie-seeded theme, Redux/Zustand SSR
    // state) causes a content flip / mismatch (H3). After hydration the effect
    // below reconciles to the live client snapshot.
    const value = isHydrating && getServerSnapshot ? getServerSnapshot() : getSnapshot();
    cell.value = value;
    if (depsChanged(cell.deps, [subscribe])) {
      // Subscribe (and re-subscribe on Offscreen reconnect) via one thunk so a
      // hidden store subscription is torn down and rebuilt like any other effect.
      const mount = () => {
        cell.cleanup = subscribe(() => {
          if (!Object.is(getSnapshot(), cell.value)) scheduleUpdate(inst);
        });
      };
      // Two-pass commit entry: the prior subscription is torn down in the cleanup
      // pass (before any setup), and this render's subscribe runs in the setup pass.
      const entry: CommitEffect = (() => {
        mount();
        cell.reconnect = mount;
        // Re-check after subscribing: a store mutation landing between this
        // render's snapshot read and the subscribe would otherwise be missed
        // (React re-checks here too). This also drives the post-hydration sync
        // from the server snapshot to the live client value (H3b).
        if (!Object.is(getSnapshot(), cell.value)) scheduleUpdate(inst);
      }) as CommitEffect;
      entry.cleanup = () => {
        if (typeof cell.cleanup === "function") cell.cleanup();
      };
      inst.passiveEffects!.push(entry);
      cell.deps = [subscribe];
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
  useLayoutEffect(effect, deps?: unknown[]) {
    const inst = currentFiber!;
    scheduleEffect(inst, inst.pendingEffects!, getHook(HK_LAYOUT), effect, deps);
  },
  useInsertionEffect(effect, deps?: unknown[]) {
    const inst = currentFiber!;
    // Insertion effects sit outside the Offscreen connect/disconnect cycle.
    scheduleEffect(inst, inst.insertionEffects!, getHook(HK_INSERTION), effect, deps, false);
  },
};

// ---- Component rendering ----------------------------------------------------

/** Internal prop carrying a Flight client island's `useId` base. */
const ID_BASE_PROP = "__dnxIdBase";

/** Run a component fiber's render, returning the single rendered vnode. */
function renderComponent(inst: Fiber): VNode {
  const prevInst = currentFiber;
  const prevIdx = hookIndex;
  // Dev Fast Refresh: a reused fiber whose function ref changed (same family,
  // different type) is a refresh swap — impossible in production, where a reused
  // fiber always keeps its exact type ref. Its carried hooks array must line up
  // with the new render; a changed hook count means the edit altered the hook
  // signature, so the reconcile is unsafe and the client must full-reload.
  const refreshSwap = inst.alternate !== null &&
    inst.vnode.type !== inst.alternate.vnode.type;
  // Snapshot the pre-swap hook-kind sequence so the finally can compare the WHOLE
  // signature (count + order), not just the count — a same-count reorder is unsafe
  // too. Null outside a refresh swap (prod never swaps), so prod pays nothing here.
  const oldKinds = refreshSwap && inst.hooks ? inst.hooks.map((c) => c.kind) : null;
  currentFiber = inst;
  hookIndex = 0;
  inst.insertionEffects = [];
  inst.pendingEffects = [];
  inst.passiveEffects = [];
  if (__DENEXT_CLASS_COMPONENTS__) inst.bailed = false;
  // Time the render for an enclosing <Profiler> (a bailed component never reaches
  // here, so its actualDuration stays 0 while selfBaseDuration carries over).
  const t0 = inst.underProfiler === true ? performance.now() : 0;
  const prevDispatcher = setDispatcher(clientDispatcher);
  try {
    // Bare class component (raw type is a class): unchanged path — the class runtime
    // reads `inst.vnode.type` as the constructor.
    if (isClassComponent(inst.vnode.type)) {
      if (__DENEXT_CLASS_COMPONENTS__) {
        const { vnode, bailed } = renderClassInstance(inst as never);
        if (bailed) {
          inst.bailed = true;
          return (inst.child?.vnode as VNode) ?? textVNode("");
        }
        return (vnode as VNode) ?? textVNode("");
      }
      throw classComponentsDisabledError();
    }
    // Resolve memo/forwardRef object wrappers to the render function. The fast path
    // (a plain function type) returns it unchanged with a single typeof check.
    const resolved = resolveComponentType(inst.vnode.type);
    const type = resolved.fn as (props: unknown, ref?: unknown) => VNode;
    const forwardsRef = resolved.forwardsRef;
    // A wrapper hiding a class (e.g. memo(Class)) can't go through the object path —
    // the class runtime needs the raw constructor. Guard only in the wrapped case so
    // the plain-function hot path pays nothing.
    if (type !== inst.vnode.type && __DENEXT_CLASS_COMPONENTS__ && isClassComponent(type)) {
      throw new Error(
        "denext: memo() of a class component is unsupported; wrap the class in a " +
          "function component (or memo the function) instead.",
      );
    }
    let props = inst.vnode.props;
    const base = (props as Record<string, unknown>)[ID_BASE_PROP];
    if (typeof base === "number") {
      clientIdCounter = base;
      const { [ID_BASE_PROP]: _drop, ...rest } = props as Record<string, unknown>;
      props = rest;
    }
    // forwardRef threads `ref` via props (denext convention); a plain component
    // ignores the second argument.
    const ref = forwardsRef ? ((props as { ref?: unknown }).ref ?? null) : undefined;
    const result = forwardsRef ? type(props, ref) : type(props);
    if (result instanceof Promise) {
      throw new Error("denext: async components are server-only; cannot render on the client.");
    }
    // StrictMode (dev): render a second time to surface impure render logic. The
    // first pass initialized hook cells and queued effects; the second reads the
    // same cells (no new effects, ids cached) and its result is the one used. The
    // id counter is restored so an impure second pass can't rewind it. (Class
    // components are not double-rendered — they are gated and comparatively rare.)
    if (inst.strict === true && devHydrationActive()) {
      const idAfterFirst = clientIdCounter;
      hookIndex = 0;
      const second = forwardsRef ? type(props, ref) : type(props);
      clientIdCounter = idAfterFirst;
      if (second instanceof Promise) {
        throw new Error("denext: async components are server-only; cannot render on the client.");
      }
      return second ?? textVNode("");
    }
    return result ?? textVNode("");
  } finally {
    // Fast Refresh hook-signature guard: the edited component's hook sequence
    // changed — a different count OR a same-count reorder/kind change — so reusing
    // its hook cells is unsafe; signal a full reload (no-op unless the dev refresh
    // runtime installed a handler).
    if (refreshSwap && hookSignatureChanged(oldKinds, inst.hooks, hookIndex)) {
      reportSignatureChange();
    }
    if (inst.underProfiler === true) {
      const d = performance.now() - t0;
      inst.actualDuration = d;
      inst.selfBaseDuration = d;
    }
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
 * Reconcile `returnFiber`'s existing child fibers against `childrenRaw`, linking
 * the resulting child/sibling chain and collecting unused fibers into
 * `returnFiber.deletions`. Sets each child's routing pointers (return/host/
 * boundary) and inherited context map. Flags the parent as ChildrenChanged when
 * membership or order changes so the commit re-syncs the nearest host.
 */
function reconcileChildren(
  returnFiber: Fiber,
  childrenRaw: VNodeChildren,
  childHost: Fiber | null,
  childBoundary: Fiber | null,
  childInherited: Map<symbol, unknown>,
): void {
  const newVNodes = normalizeChildren(childrenRaw);
  const oldChildren: Fiber[] = [];
  for (let c = returnFiber.child; c !== null; c = c.sibling) oldChildren.push(c);

  const keyed = new Map<unknown, Fiber>();
  const unkeyed: Fiber[] = [];
  const oldIndexOf = new Map<Fiber, number>();
  oldChildren.forEach((c, i) => {
    oldIndexOf.set(c, i);
    if (c.vnode.key != null) keyed.set(c.vnode.key, c);
    else unkeyed.push(c);
  });

  const used = new Set<Fiber>();
  let unkeyedIdx = 0;
  let changed = false;
  let lastMatchedOldIndex = -1;
  let firstChild: Fiber | null = null;
  let prev: Fiber | null = null;

  for (const nv of newVNodes) {
    let match: Fiber | undefined;
    if (nv.key != null) {
      match = keyed.get(nv.key);
    } else {
      while (unkeyedIdx < unkeyed.length) {
        const cand = unkeyed[unkeyedIdx++];
        if (sameType(cand.vnode, nv)) {
          match = cand;
          break;
        }
      }
    }
    let fiber: Fiber;
    if (match && !used.has(match) && sameType(match.vnode, nv)) {
      used.add(match);
      fiber = createWorkInProgress(match, nv);
      const oi = oldIndexOf.get(match)!;
      if (oi < lastMatchedOldIndex) changed = true;
      else lastMatchedOldIndex = oi;
    } else {
      fiber = createFiberFromVNode(nv);
      fiber.flags |= Placement;
      changed = true;
    }
    fiber.return = returnFiber;
    fiber.host = childHost;
    fiber.boundary = childBoundary;
    fiber.inherited = childInherited;
    fiber.strict = returnFiber.strict === true;
    fiber.underProfiler = returnFiber.underProfiler === true;
    // SuspenseList membership propagates from a list's direct child (the <Suspense>
    // wrapper) to the suspense fiber it renders.
    if (returnFiber.listOwnerState != null && fiber.tag === "suspense") {
      fiber.listState = returnFiber.listOwnerState;
      fiber.listIndex = returnFiber.listIndex;
    }
    fiber.sibling = null;
    if (prev) prev.sibling = fiber;
    else firstChild = fiber;
    prev = fiber;
  }

  for (const c of oldChildren) {
    if (!used.has(c)) {
      (returnFiber.deletions ??= []).push(c);
      changed = true;
    }
  }
  if (returnFiber.deletions) returnFiber.flags |= ChildDeletion;
  returnFiber.child = firstChild;
  if (changed) returnFiber.flags |= ChildrenChanged;
}

/** Clone a bailed-out fiber's current children into fresh work-in-progress. */
function cloneChildFibers(wip: Fiber): void {
  let currentChild = wip.child; // === current.child (shared by createWorkInProgress)
  if (currentChild === null) return;
  const newChild = createWorkInProgress(currentChild, currentChild.vnode);
  newChild.return = wip;
  wip.child = newChild;
  let prev = newChild;
  currentChild = currentChild.sibling;
  while (currentChild !== null) {
    const c = createWorkInProgress(currentChild, currentChild.vnode);
    c.return = wip;
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

/** The lanes being processed by the current render (sync and/or transition). */
let renderLanes = NoLane;

/** Perform one unit of work; return the next unit (first child) or null. */
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

    case "component": {
      const current = wip.alternate;
      const isClass = __DENEXT_CLASS_COMPONENTS__ && isClassComponent(wip.vnode.type);
      if (
        current !== null && !hasOwnUpdate && !isClass &&
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
        )
      ) {
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
      reconcileChildren(wip, [rendered], wip.host, childBoundary, wip.inherited);
      return wip.child;
    }

    case "host": {
      if (isHydrating) claimHost(wip);
      // A `<form action={fn}>` establishes a form-scoped pending signal, seeded
      // into its descendants' context so useFormStatus reads the nearest form.
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

    case "fragment": {
      // A StrictMode boundary (a Fragment carrying the marker prop) makes its
      // whole subtree strict in development — enabling render/effect double-invoke.
      if (
        wip.strict !== true && devHydrationActive() &&
        (wip.vnode.props as Record<string, unknown> | null)?.[STRICT_MODE_PROP] === true
      ) {
        wip.strict = true;
      }
      // A <Profiler> boundary times its subtree's component renders.
      const profilerCfg = (wip.vnode.props as Record<string, unknown> | null)
        ?.[PROFILER_PROP] as { id: string; onRender?: ProfilerOnRender } | undefined;
      if (profilerCfg) {
        wip.profiler = profilerCfg;
        wip.underProfiler = true;
        anyProfiler = true;
      }
      const exposed = providerContexts(wip, wip.vnode, wip.inherited);
      wip.contexts = exposed;
      // A SuspenseList (a Fragment carrying the reveal-policy marker) coordinates
      // its direct <Suspense> children's reveal order.
      const listPolicy = (wip.vnode.props as Record<string, unknown> | null)
        ?.[SUSPENSE_LIST_PROP] as
          | { revealOrder?: SuspenseListState["revealOrder"]; tail?: SuspenseListState["tail"] }
          | undefined;
      reconcileChildren(
        wip,
        (wip.vnode.props?.children ?? null) as VNodeChildren,
        wip.host,
        wip.boundary,
        exposed,
      );
      if (listPolicy) {
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
      return wip.child;
    }

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

    case "suspense": {
      // Under a SuspenseList, reveal order decides whether this boundary may show
      // content yet, show its fallback, or stay hidden (tail policy).
      const st = wip.listState;
      const inList = st != null && st.revealOrder != null;
      if (inList) st!.members[wip.listIndex!] = wip;

      // Offscreen: an URGENT re-suspend of an already-revealed boundary. Keep the
      // primary subtree mounted-but-hidden and show the fallback alongside, so a
      // later reveal restores the SAME instances (state preserved) instead of
      // remounting. Reconcile [primary…, fallback…] as one child list: the primary
      // vnodes match the committed primary fibers (reused → state kept), the fallback
      // mounts fresh; then hide the primary portion so it isn't re-rendered.
      if (!inList && wip.offscreen === true && wip.showingFallback === true) {
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

      const display = inList
        ? suspenseListDisplay(wip)
        : wip.showingFallback
        ? "fallback"
        : "content";
      // A list member rendering content is (tentatively) ready; if its children then
      // suspend, handleThrow resets its slot to false for the ordering above.
      if (inList && display === "content") st!.ready[wip.listIndex!] = true;
      const children = display === "content"
        ? (wip.vnode.props.children as VNodeChildren)
        : display === "fallback"
        ? (wip.vnode.props.fallback as VNodeChildren)
        : null; // hidden
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

    case "errorboundary": {
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
        // The fallback subtree reports to the PARENT boundary, so an error inside
        // the fallback doesn't loop back onto this boundary.
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
    if (hydrationCursor && devHydrationActive()) {
      warnHydrationMismatch(
        `expected <${tag.toLowerCase()}>, but the server rendered ${describeNode(existing)}`,
      );
    }
    hydrationStack.push(hydrationCursor);
    hydrationCursor = null; // subtree mounts fresh
  }
}

function claimText(wip: Fiber): void {
  const value = String(wip.vnode.props.nodeValue ?? "");
  const existing = hydrationCursor
    ? (hydrationCursor.parent.childNodes[hydrationCursor.index] ?? null)
    : null;
  if (existing && existing.nodeType === 3) {
    const node = existing as Text;
    const serverValue = node.nodeValue ?? "";
    if (serverValue !== value) {
      if (value !== "" && serverValue.length > value.length && serverValue.startsWith(value)) {
        // Adjacent-text coalescing: adopt this vnode's slice, split the remainder
        // into a new node for the next text vnode to adopt. Not a mismatch.
        node.nodeValue = value;
        const remainder = doc.createTextNode(serverValue.slice(value.length));
        hydrationCursor!.parent.insertBefore(
          remainder,
          hydrationCursor!.parent.childNodes[hydrationCursor!.index + 1] ?? null,
        );
      } else {
        if (devHydrationActive()) {
          warnHydrationMismatch(
            `server text ${JSON.stringify(serverValue)} became ${JSON.stringify(value)}`,
          );
        }
        node.nodeValue = value;
      }
    }
    hydrationCursor!.index++;
    wip.stateNode = node;
  } else {
    if (hydrationCursor && devHydrationActive()) {
      warnHydrationMismatch(
        `expected text ${JSON.stringify(value)}, but the server rendered ${describeNode(existing)}`,
      );
    }
    wip.stateNode = doc.createTextNode(value);
    wip.flags |= Placement;
  }
}

// ---- Render phase: completeWork --------------------------------------------

function completeWork(wip: Fiber): void {
  switch (wip.tag) {
    case "host": {
      if (isHydrating) hydrationCursor = hydrationStack.pop() ?? null;
      if (!wip.listeners) wip.listeners = wip.alternate?.listeners ?? new Map();
      if (wip.alternate !== null) {
        // Update: applyProps + re-sync deferred to the commit (mutation) phase.
        wip.flags |= Update;
        break;
      }
      // Fresh mount (or a hydration-adopted node): build off-DOM.
      if (wip.stateNode == null) wip.stateNode = doc.createElement(wip.vnode.type as string);
      applyProps(wip.stateNode as Element, wip, {}, wip.vnode.props ?? {}, onErrorFor(wip));
      syncChildren(wip.stateNode as Element, childrenDom(wip));
      wip.flags |= Placement;
      break;
    }
    case "text": {
      if (wip.alternate !== null) {
        const value = String(wip.vnode.props.nodeValue ?? "");
        if ((wip.stateNode as Text).nodeValue !== value) wip.flags |= Update;
      } else if (isHydrating) {
        claimText(wip);
      } else {
        wip.stateNode = doc.createTextNode(String(wip.vnode.props.nodeValue ?? ""));
        wip.flags |= Placement;
      }
      break;
    }
    case "component": {
      // getSnapshotBeforeUpdate runs before a class update's DOM mutation — but
      // not when shouldComponentUpdate/PureComponent bailed this render.
      if (__DENEXT_CLASS_COMPONENTS__ && wip.classInstance && wip.alternate && !wip.bailed) {
        wip.flags |= Snapshot;
      }
      break;
    }
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

function handleThrow(sourceFiber: Fiber, thrown: unknown): Fiber | null {
  if (isThenable(thrown)) {
    const suspense = findSuspense(sourceFiber);
    if (!suspense) throw thrown;
    // Transition-aware Suspense: when a transition (startTransition /
    // useDeferredValue) re-suspends a boundary that is CURRENTLY revealed (its
    // committed state shows content, not a fallback), keep showing that content
    // instead of flashing the fallback — React's recommended pattern. This also
    // preserves the subtree's state (it is never unmounted). Excludes SuspenseList
    // members (their reveal ordering owns the fallback decision) and the initial
    // reveal (no committed content to keep). Only ever reached from the concurrent
    // render path, so the sentinel is caught by resumeConcurrent.
    const revealed = suspense.alternate != null && suspense.alternate.showingFallback !== true;
    const inList = suspense.listState != null && suspense.listState.revealOrder != null;
    if (
      (renderLanes & TransitionLane) !== NoLane && concurrentWipRoot !== null &&
      revealed && !inList
    ) {
      thrown.then(
        () => retrySuspendedTransition(suspense),
        () => retrySuspendedTransition(suspense),
      );
      throw SUSPENDED_TRANSITION;
    }
    suspense.showingFallback = true;
    // Offscreen (urgent re-suspend of a boundary that has committed primary content):
    // keep that primary mounted-but-hidden and show the fallback alongside, so the
    // reveal restores the same instances (state preserved) instead of remounting. Not
    // for a SuspenseList member (its reveal ordering owns the fallback) nor during
    // hydration (the fallback must mount fresh, adopting no server DOM). The committed
    // primary is either shown content (revealed) or an already-hidden Offscreen primary.
    const hasCommittedPrimary = suspense.alternate != null &&
      (suspense.alternate.showingFallback !== true || suspense.alternate.offscreen === true);
    suspense.offscreen = hasCommittedPrimary && !inList && !isHydrating;
    // Suspended → not ready, for SuspenseList ordering (indexed on the shared state).
    if (suspense.listState && suspense.listIndex != null) {
      suspense.listState.ready[suspense.listIndex] = false;
    }
    // Start from the committed child list: Offscreen beginWork reconciles
    // [primary…, fallback…] against it (primary preserved + hidden); the plain path
    // reconciles the fallback against it (remount).
    suspense.child = suspense.alternate ? suspense.alternate.child : null;
    suspense.deletions = null;
    if (isHydrating) hydrationCursor = null;
    thrown.then(() => retrySuspense(suspense), () => retrySuspense(suspense));
    return suspense;
  }
  if (isControlSignal(thrown)) throw thrown;
  const boundary = findErrorBoundary(sourceFiber);
  if (!boundary) throw thrown;
  if (isClassBoundary(boundary)) {
    if (!handleClassError(boundary as never, thrown, componentErrorInfo(boundary))) throw thrown;
    boundary.lanes = NoLane; // drop the self-scheduled update; we re-render inline
    boundary.child = boundary.alternate ? boundary.alternate.child : null;
    boundary.deletions = null;
    return boundary;
  }
  boundary.__error = thrown;
  boundary.child = boundary.alternate ? boundary.alternate.child : null;
  boundary.deletions = null;
  return boundary;
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
  const isTransition = transitionDepth > 0 || asyncTransitionDepth > 0;
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
// promise has not yet settled. denext cannot instrument the user's `await`, so
// while any async transition is pending its window entangles updates at transition
// priority (see scheduleUpdate) — this is how a post-`await` `setState` still lands
// on TransitionLane and how `isPending` is held until the async work settles.
let asyncTransitionDepth = 0;

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
let concurrentIdBase = 0;

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
  concurrentIdBase = clientIdCounter;
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

function resumeConcurrent(): void {
  if (workInProgress === null || concurrentWipRoot === null) return; // abandoned
  const rootHandle = concurrentHandle!;
  try {
    resumeConcurrentInner();
  } catch (thrown) {
    if (thrown === SUSPENDED_TRANSITION) {
      // A transition re-suspended a revealed boundary: discard this render and keep
      // the current tree (old content stays on screen — no fallback flash). The
      // transition remains pending (do NOT run transition-done, so useTransition's
      // isPending stays true) until retrySuspendedTransition re-arms it once the
      // promise settles. The committed fibers keep their transition lanes, so the
      // retry re-renders the right subtrees.
      clientIdCounter = concurrentIdBase; // the retry reassigns identical useId values
      workInProgress = null;
      concurrentWipRoot = null;
      concurrentHandle = null;
      duringRender = false;
      // Re-arm only OTHER roots that still have queued transition work (this root's
      // lane was consumed and is intentionally left pending until the retry).
      for (const h of activeRoots) {
        if (h !== rootHandle && (h.pendingLanes & TransitionLane) !== NoLane) {
          scheduleTransitionFlush();
          break;
        }
      }
      return;
    }
    // A render/commit that escaped without an error boundary must not wedge the
    // scheduler: reset the concurrent WIP state, clear the (broken) transition lane
    // so it is not retried into an infinite flap, settle pending transitions, then
    // surface the error (as an uncaught render error, like React).
    rootHandle.pendingLanes &= ~TransitionLane;
    workInProgress = null;
    concurrentWipRoot = null;
    concurrentHandle = null;
    duringRender = false;
    let anyTransition = false;
    for (const h of activeRoots) {
      if ((h.pendingLanes & TransitionLane) !== NoLane) anyTransition = true;
    }
    if (anyTransition) scheduleTransitionFlush();
    else runTransitionDone();
    throw thrown;
  }
}

function resumeConcurrentInner(): void {
  if (workInProgress === null || concurrentWipRoot === null) return;
  renderLanes = TransitionLane;
  sliceStart = performance.now();
  unitsThisSlice = 0;
  duringRender = true;
  try {
    // do/while so each slice makes at least one unit of progress (a shouldYield
    // that fires on the first check would otherwise spin forever).
    do {
      workInProgress = performUnitOfWork(workInProgress);
    } while (workInProgress !== null && !shouldYield());
  } finally {
    duringRender = false;
  }
  if (workInProgress !== null) {
    // An urgent (sync) update born during this slice (a render-phase setState)
    // interrupts the transition instead of waiting for it to finish.
    if ((concurrentHandle!.pendingLanes & SyncLane) !== NoLane) {
      abandonConcurrent();
      scheduleSyncFlush();
      return;
    }
    scheduleContinuation(); // yielded mid-tree; resume on the next slice
    return;
  }
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
  // Re-arm across ALL roots (not just this one): a transition update on another
  // root that arrived mid-flight was skipped by scheduleTransitionFlush's
  // in-flight guard and must be picked up now. Hold the transition done-callbacks
  // until no root has transition work left, so one root finishing doesn't clear
  // another's pending indicator early.
  let anyTransition = false;
  for (const h of activeRoots) {
    if ((h.pendingLanes & TransitionLane) !== NoLane) anyTransition = true;
    if ((h.pendingLanes & SyncLane) !== NoLane) scheduleSyncFlush();
  }
  if (anyTransition) scheduleTransitionFlush();
  else runTransitionDone();
}

/** Abandon an in-flight transition render (off-DOM), rescheduling it to restart. */
function abandonConcurrent(): void {
  if (concurrentWipRoot === null) return;
  clientIdCounter = concurrentIdBase; // restart reassigns identical useId values
  const handle = concurrentHandle!;
  handle.pendingLanes |= TransitionLane;
  workInProgress = null;
  concurrentWipRoot = null;
  concurrentHandle = null;
  duringRender = false;
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
    result = cb();
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
  // Async transition: the callback returned a thenable. Keep transition priority
  // active across the await(s) via the in-flight window, and hold onComplete until
  // the promise settles AND the resulting transition flush lands. denext can't scope
  // the entanglement to just this transition's updates (no async-context / await
  // instrumentation), so the window entangles all updates scheduled while pending —
  // documented in KNOWN-LIMITATIONS.
  if (result != null && typeof (result as { then?: unknown }).then === "function") {
    asyncTransitionDepth++;
    // Dev-only watchdog: an async transition whose promise never settles pins ALL
    // updates to TransitionLane and holds `isPending` true forever (the entanglement
    // window can't be scoped without await instrumentation — see KNOWN-LIMITATIONS).
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
  flushPassiveEffects(); // React flushes pending passive effects before new work
  let guard = 0;
  do {
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

function commitRoot(handle: RootHandle, wipRoot: Fiber): void {
  // 1. Before mutation: class getSnapshotBeforeUpdate.
  if (__DENEXT_CLASS_COMPONENTS__) {
    walk(wipRoot, (f) => {
      if ((f.flags & Snapshot) !== 0) captureSnapshot(f as never);
    });
  }
  // 1a. Deletions first — an unmounting fiber runs its effect cleanups (including
  //     any useInsertionEffect cleanup) here, BEFORE step 1b runs the new fibers'
  //     insertion-effect setups. This is React's cleanup-before-setup ordering: on a
  //     sibling swap, the old sibling's insertion cleanup precedes the new sibling's
  //     insertion setup (e.g. a CSS-in-JS library removes the old <style> before
  //     inserting the replacement).
  walk(wipRoot, (f) => {
    if (f.deletions) { for (const d of f.deletions) commitDeletion(d); }
  });
  // 1b. Insertion effects (useInsertionEffect) run before the DOM host mutations and
  //     layout reads that follow — React's guarantee that a CSS-in-JS library's style
  //     insertion precedes any layout read. Collected over the work-in-progress tree
  //     (its child / sibling links are already built by render), which excludes any
  //     fiber discarded by a suspense/error unwind, exactly like the layout collection.
  const insertionFibers: Fiber[] = [];
  collectInsertionEffects(wipRoot, insertionFibers);
  runCommitEffects(insertionFibers, (f) => {
    const es = f.insertionEffects;
    f.insertionEffects = [];
    return es;
  });
  // 2. Mutation: host/text property updates.
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
  // 3. Atomic swap: the work-in-progress tree becomes current.
  handle.current = wipRoot;
  // 4. Placement: arrange DOM children of the root and any changed host/portal.
  syncChildren(handle.container, childrenDom(wipRoot));
  walk(wipRoot, (f) => {
    if (f.tag === "host" && f.alternate !== null && needsSync(f)) {
      syncChildren(f.stateNode as Element, childrenDom(f));
    } else if (f.tag === "portal" && needsSync(f)) {
      syncChildren(f.stateNode as Element, childrenDom(f));
    }
  });
  // 4b. Clear committed effect flags across the whole tree. A fully-bailed subtree
  //     on a later render keeps its *current* fibers (not cloned via
  //     createWorkInProgress), so leftover flags/deletions here would be
  //     re-processed by that later commit's walk — double-running deletions
  //     (double cleanup / willUnmount) or re-applying props. Reset so the next
  //     commit starts clean.
  walk(wipRoot, (f) => {
    f.flags = NoFlags;
    f.subtreeFlags = NoFlags;
    f.deletions = null;
  });
  // 4c. Offscreen visibility: hide the primary portion of a boundary that re-suspended
  //     urgently (display:none, kept mounted so its state survives), and restore it on
  //     reveal. Skipped entirely unless a boundary changed Offscreen state this commit.
  if (anyOffscreen) {
    anyOffscreen = false;
    walk(wipRoot, applyOffscreenVisibility);
  }
  // 5. Layout effects (useLayoutEffect / class didMount + didUpdate) run
  //    synchronously now, after mutation and before paint, in mount DFS order. Passive
  //    effects (useEffect) are deferred to a scheduled task after the commit.
  //    Effects are collected by walking the COMMITTED tree (post-order, so
  //    children run before parents), which excludes any fiber discarded by a
  //    suspense/error unwind — its effects must not run for content never placed.
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
function applyOffscreenVisibility(f: Fiber): void {
  if (f.tag !== "suspense") return;
  const shouldHide = f.offscreen === true && f.showingFallback === true &&
    f.primaryCount != null;
  if (shouldHide && f.hiddenEls == null) {
    // First hide: hide the primary DOM AND disconnect its effects — a timer or
    // subscription registered in the hidden subtree must stop while it's offscreen
    // (state in useState/useRef cells is untouched, so it survives the reveal).
    const els: Element[] = [];
    const dom: (Element | Text)[] = [];
    let c = f.child;
    for (let i = 0; c !== null && i < f.primaryCount!; c = c.sibling, i++) {
      collectDom(c, dom);
      disconnectEffects(c);
    }
    for (const n of dom) {
      if (n.nodeType === 1) {
        const el = n as Element;
        const prev = el.getAttribute("style");
        offscreenPrevStyle.set(el, prev);
        // Append at the end so `display:none !important` wins over any prior `display`
        // in the element's own inline style (later + `!important` declaration wins).
        const base = prev && prev.trim()
          ? (prev.trim().endsWith(";") ? prev.trim() : prev.trim() + ";")
          : "";
        el.setAttribute("style", base + "display:none !important");
        els.push(el);
      }
    }
    f.hiddenEls = els;
  } else if (!shouldHide && f.hiddenEls != null) {
    // Reveal: restore the DOM and reconnect the effects torn down on hide. By now
    // beginWork has cleared primaryCount and reconciled just the primary content,
    // so every child of `f` is a revealed primary fiber.
    for (const el of f.hiddenEls) {
      const prev = offscreenPrevStyle.get(el);
      if (prev == null) el.removeAttribute("style");
      else el.setAttribute("style", prev);
      offscreenPrevStyle.delete(el);
    }
    f.hiddenEls = undefined;
    for (let c = f.child; c !== null; c = c.sibling) reconnectEffects(c);
  }
}

/**
 * Tear down every passive/layout effect in an Offscreen subtree (children before
 * parents, unmount order), leaving state cells intact. Each effect cell keeps a
 * `reconnect` thunk so {@linkcode reconnectEffects} can rebuild it on reveal.
 */
function disconnectEffects(fiber: Fiber): void {
  // A nested boundary that is itself offscreen owns its own effect state — leave it
  // (and its subtree) alone so an outer hide/reveal doesn't fight its lifecycle.
  if (fiber.tag === "suspense" && fiber.hiddenEls != null) return;
  for (let c = fiber.child; c !== null; c = c.sibling) disconnectEffects(c);
  if (fiber.tag !== "component" || !fiber.hooks) return;
  for (const cell of fiber.hooks) {
    if (cell.reconnect && cell.disconnected !== true) {
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
  }
}

/** Re-run the setup of every effect a prior {@linkcode disconnectEffects} tore down. */
function reconnectEffects(fiber: Fiber): void {
  // Don't reconnect a subtree that's still offscreen under its own boundary.
  if (fiber.tag === "suspense" && fiber.hiddenEls != null) return;
  for (let c = fiber.child; c !== null; c = c.sibling) reconnectEffects(c);
  if (fiber.tag !== "component" || !fiber.hooks) return;
  for (const cell of fiber.hooks) {
    if (cell.disconnected === true) {
      cell.disconnected = false;
      try {
        cell.reconnect!();
      } catch (err) {
        scheduleEffectError(fiber, err);
      }
    }
  }
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
  // Then run THIS fiber's own unmount cleanups (class lifecycle + hook cleanups).
  if (fiber.tag === "component") {
    if (__DENEXT_CLASS_COMPONENTS__ && fiber.classInstance) unmountClassInstance(fiber as never);
    if (fiber.hooks) {
      for (const cell of fiber.hooks) {
        if (typeof cell.cleanup === "function") {
          try {
            cell.cleanup();
          } catch (err) {
            // A throwing cleanup must not strand the rest of the unmount (sibling
            // cleanups, ref detach, DOM removal). The subtree is being destroyed,
            // so report rather than route to a boundary within it.
            console.error("denext: a cleanup threw during unmount", err);
          }
        }
      }
    }
  }
  if (fiber.attachedRef != null) detachRef(fiber);
  const dom = fiber.stateNode;
  if (dom && (fiber.tag === "host" || fiber.tag === "text") && dom.parentNode) {
    dom.parentNode.removeChild(dom);
  }
  // Mark unmounted and sever tree links so that if anything outside the tree still
  // references this fiber (a pending Suspense retry promise), it can't pin the rest
  // of the detached subtree or the root in memory.
  fiber.unmounted = true;
  if (fiber.alternate) fiber.alternate.unmounted = true;
  fiber.child = null;
  fiber.sibling = null;
  fiber.return = null;
  fiber.stateNode = null;
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
    if (!handleClassError(inst as never, error, componentErrorInfo(inst))) throw error;
    scheduleUpdate(inst);
    flushRoots(SyncLane);
    return;
  }
  inst.__error = error;
  scheduleUpdate(inst);
  // Event-handler / async errors are caught outside render; commit the fallback
  // synchronously so the DOM reflects it immediately (React can't do this).
  flushRoots(SyncLane);
}

function routeToBoundary(inst: Fiber, error: unknown): void {
  const boundary = findErrorBoundary(inst);
  if (!boundary) throw error;
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

// ---- DevTools bridge -------------------------------------------------------

let devToolsActive: boolean | undefined;

function reportCommit(handle: RootHandle): void {
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

function fiberToDevNode(fiber: Fiber): DevNode {
  const vtype = fiber.vnode.type;
  const key = fiber.vnode.key == null ? null : String(fiber.vnode.key);
  const props = fiber.vnode.props;
  switch (fiber.tag) {
    case "text":
      return {
        kind: "text",
        name: "text",
        key: null,
        props: {},
        text: String((props as { nodeValue?: unknown })?.nodeValue ?? ""),
        dom: fiber.stateNode,
        children: [],
      };
    case "component": {
      const name = componentDisplayName(vtype);
      return {
        kind: "component",
        name,
        key,
        props,
        dom: null,
        children: fiber.child ? [fiberToDevNode(fiber.child)] : [],
      };
    }
    case "suspense":
    case "errorboundary":
      return {
        kind: "component",
        name: fiber.tag === "suspense" ? "Suspense" : "ErrorBoundary",
        key,
        props,
        dom: null,
        children: fiberChildrenDevNodes(fiber),
      };
    case "fragment":
      return {
        kind: "fragment",
        name: "Fragment",
        key,
        props,
        dom: null,
        children: fiberChildrenDevNodes(fiber),
      };
    case "portal":
      return {
        kind: "fragment",
        name: "Portal",
        key,
        props: {},
        dom: null,
        children: fiberChildrenDevNodes(fiber),
      };
    default:
      return {
        kind: "host",
        name: typeof vtype === "string" ? vtype : "host",
        key,
        props,
        dom: fiber.stateNode,
        children: fiberChildrenDevNodes(fiber),
      };
  }
}

// ---- Public API ------------------------------------------------------------

/**
 * Render `children` into a different DOM `container` while keeping their place in
 * the component and context tree. Backs `react-dom`'s `createPortal`.
 */
export function createPortal(children: VNodeChild, container: Element): VNode {
  return {
    type: PORTAL as unknown as VNode["type"],
    props: { target: container, children },
    key: null,
  };
}

/** A mounted (or hydrated) render root that can be re-rendered or torn down. */
export interface Root {
  /** Render (or re-render) `vnode` into this root's container. */
  render(vnode: VNode): void;
  /** Unmount the tree and remove its DOM nodes from the container. */
  unmount(): void;
}

function makeRootFiber(container: Element): Fiber {
  const fiber = createFiber("root", { type: "#root", props: {}, key: null });
  fiber.stateNode = container;
  fiber.host = fiber;
  fiber.listeners = new Map();
  return fiber;
}

/** Mount `vnode` into `container`, creating fresh DOM. */
export function createRoot(container: Element): Root {
  const rootFiber = makeRootFiber(container);
  const handle: RootHandle = {
    container,
    current: rootFiber,
    pendingElement: null,
    pendingLanes: NoLane,
    hydrate: false,
  };
  fiberToRoot.set(rootFiber, handle);
  activeRoots.add(handle);
  return {
    render(vnode: VNode) {
      if (handle.current.child === null) clientIdCounter = 0; // first mount: align useId
      handle.pendingElement = vnode;
      renderRoot(handle, SyncLane);
    },
    unmount() {
      for (let c = handle.current.child; c !== null; c = c.sibling) commitDeletion(c);
      handle.current.child = null;
      activeRoots.delete(handle);
      reportCommit(handle);
    },
  };
}

/** Hydrate `vnode` against server-rendered markup already in `container`. */
export function hydrateRoot(container: Element, vnode: VNode): Root {
  const rootFiber = makeRootFiber(container);
  const handle: RootHandle = {
    container,
    current: rootFiber,
    pendingElement: vnode,
    pendingLanes: NoLane,
    hydrate: true,
  };
  fiberToRoot.set(rootFiber, handle);
  activeRoots.add(handle);
  clientIdCounter = 0; // align useId with the server render's id sequence
  renderRoot(handle, SyncLane);
  return {
    render(next: VNode) {
      handle.pendingElement = next;
      renderRoot(handle, SyncLane);
    },
    unmount() {
      for (let c = handle.current.child; c !== null; c = c.sibling) commitDeletion(c);
      handle.current.child = null;
      activeRoots.delete(handle);
      reportCommit(handle);
    },
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
    clientIdCounter = concurrentIdBase;
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
