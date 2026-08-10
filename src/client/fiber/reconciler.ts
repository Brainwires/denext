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
import { isThenable, SUSPENSE } from "../../runtime/suspense.ts";
import {
  ERROR_BOUNDARY,
  isControlSignal,
  isRedirect,
  toError,
} from "../../runtime/error-boundary.ts";
import { applyProps, detachRef } from "../dom-props.ts";
import { normalizeChildren, sameType, TEXT_TYPE, textVNode } from "../vnode-utils.ts";
import { propsAndContextEqual, providerContexts } from "../context-map.ts";
import { commitToDevTools, type DevNode, injectDevTools } from "../devtools.ts";
import "../../runtime/class-flag.ts";
import { classComponentsDisabledError, isClassComponent } from "../../compat/class-detect.ts";
import {
  captureSnapshot,
  handleClassError,
  hasErrorLifecycle,
  renderClassInstance,
  unmountClassInstance,
} from "../../compat/class-component.ts";
import {
  bubbleFlags,
  ChildDeletion,
  ChildrenChanged,
  childrenDom,
  createFiber,
  createWorkInProgress,
  type Cursor,
  type Fiber,
  type FiberTag,
  NoFlags,
  NoLane,
  Placement,
  Snapshot,
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

interface HookCell {
  value?: unknown;
  deps?: unknown[];
  cleanup?: (() => void) | void;
  inited?: boolean;
}

function getHook(): HookCell {
  const inst = currentFiber!;
  const hooks = inst.hooks!;
  if (hookIndex >= hooks.length) hooks.push({});
  return hooks[hookIndex++];
}

const clientDispatcher: Dispatcher = {
  useState<S>(initial: S | (() => S)): [S, (v: S | ((p: S) => S)) => void] {
    const inst = currentFiber!;
    const cell = getHook();
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
    const cell = getHook();
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
    const cell = getHook();
    if (depsChanged(cell.deps, deps)) {
      inst.passiveEffects!.push(() => {
        if (typeof cell.cleanup === "function") cell.cleanup();
        cell.cleanup = effect();
      });
      cell.deps = deps ? [...deps] : undefined;
    }
  },

  useMemo<T>(factory: () => T, deps?: unknown[]): T {
    const cell = getHook();
    if (!("value" in cell) || depsChanged(cell.deps, deps)) {
      cell.value = factory();
      cell.deps = deps ? [...deps] : undefined;
    }
    return cell.value as T;
  },

  useRef<T>(initial: T) {
    const cell = getHook();
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
    const cell = getHook();
    if (!cell.inited) {
      cell.value = `:d${clientIdCounter++}:`;
      cell.inited = true;
    }
    return cell.value as string;
  },

  useSyncExternalStore<T>(
    subscribe: (onChange: () => void) => () => void,
    getSnapshot: () => T,
    _getServerSnapshot?: () => T,
  ): T {
    const inst = currentFiber!;
    const cell = getHook();
    const value = getSnapshot();
    cell.value = value;
    if (depsChanged(cell.deps, [subscribe])) {
      inst.passiveEffects!.push(() => {
        if (typeof cell.cleanup === "function") cell.cleanup();
        cell.cleanup = subscribe(() => {
          if (!Object.is(getSnapshot(), cell.value)) scheduleUpdate(inst);
        });
      });
      cell.deps = [subscribe];
    }
    return value;
  },

  useMemoCache(size: number): unknown[] {
    const cell = getHook();
    if (!cell.inited) {
      cell.value = new Array(size).fill(MEMO_CACHE_SENTINEL);
      cell.inited = true;
    }
    return cell.value as unknown[];
  },

  // denext commits effects synchronously post-commit; layout + insertion effects
  // share the same queue mechanism as passive effects.
  useLayoutEffect(effect, deps?: unknown[]) {
    const inst = currentFiber!;
    const cell = getHook();
    if (depsChanged(cell.deps, deps)) {
      inst.pendingEffects!.push(() => {
        if (typeof cell.cleanup === "function") cell.cleanup();
        cell.cleanup = effect();
      });
      cell.deps = deps ? [...deps] : undefined;
    }
  },
  useInsertionEffect(effect, deps?: unknown[]) {
    const inst = currentFiber!;
    const cell = getHook();
    if (depsChanged(cell.deps, deps)) {
      inst.pendingEffects!.push(() => {
        if (typeof cell.cleanup === "function") cell.cleanup();
        cell.cleanup = effect();
      });
      cell.deps = deps ? [...deps] : undefined;
    }
  },
};

// ---- Component rendering ----------------------------------------------------

/** Internal prop carrying a Flight client island's `useId` base. */
const ID_BASE_PROP = "__dnxIdBase";

/** Run a component fiber's render, returning the single rendered vnode. */
function renderComponent(inst: Fiber): VNode {
  const prevInst = currentFiber;
  const prevIdx = hookIndex;
  currentFiber = inst;
  hookIndex = 0;
  inst.pendingEffects = [];
  inst.passiveEffects = [];
  if (__DENEXT_CLASS_COMPONENTS__) inst.bailed = false;
  const prevDispatcher = setDispatcher(clientDispatcher);
  try {
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
    const type = inst.vnode.type as (props: unknown) => VNode;
    let props = inst.vnode.props;
    const base = (props as Record<string, unknown>)[ID_BASE_PROP];
    if (typeof base === "number") {
      clientIdCounter = base;
      const { [ID_BASE_PROP]: _drop, ...rest } = props as Record<string, unknown>;
      props = rest;
    }
    const result = type(props);
    if (result instanceof Promise) {
      throw new Error("denext: async components are server-only; cannot render on the client.");
    }
    return result ?? textVNode("");
  } finally {
    setDispatcher(prevDispatcher);
    currentFiber = prevInst;
    hookIndex = prevIdx;
  }
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
      reconcileChildren(
        wip,
        (wip.vnode.props?.children ?? null) as VNodeChildren,
        wip,
        wip.boundary,
        wip.inherited,
      );
      return wip.child;
    }

    case "fragment": {
      const exposed = providerContexts(wip, wip.vnode, wip.inherited);
      wip.contexts = exposed;
      reconcileChildren(
        wip,
        (wip.vnode.props?.children ?? null) as VNodeChildren,
        wip.host,
        wip.boundary,
        exposed,
      );
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
      const children = wip.showingFallback
        ? (wip.vnode.props.fallback as VNodeChildren)
        : (wip.vnode.props.children as VNodeChildren);
      reconcileChildren(wip, children, wip.host, wip.boundary, wip.inherited);
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
  const t = fiber.vnode.type as unknown;
  const fn = typeof t === "function" ? (t as { displayName?: string; name?: string }) : null;
  const name = fn?.displayName || fn?.name || "Component";
  return { componentStack: `\n    in ${name}` };
}

/**
 * Handle a throw during begin/completeWork: a thenable suspends the nearest
 * Suspense (commit its fallback, retry when it settles); a genuine error routes
 * to the nearest error boundary (function fallback, or class error lifecycle);
 * control signals and unhandled throws re-throw to abort the render.
 */
function handleThrow(sourceFiber: Fiber, thrown: unknown): Fiber | null {
  if (isThenable(thrown)) {
    const suspense = findSuspense(sourceFiber);
    if (!suspense) throw thrown;
    suspense.showingFallback = true;
    suspense.child = suspense.alternate ? suspense.alternate.child : null;
    suspense.deletions = null;
    // During hydration the server streamed the RESOLVED content; the fallback must
    // mount fresh (adopt nothing) rather than warn against that server DOM.
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
  if (fiber == null) return; // an SSR class setState has no reconciler fiber
  const lane = transitionDepth > 0 ? TransitionLane : SyncLane;
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
let transitionScheduled = false;
let transitionTimer: ReturnType<typeof setTimeout> | undefined;
const transitionDoneCallbacks: Array<() => void> = [];

// The in-flight concurrent (transition) render, or null when none is running.
let concurrentHandle: RootHandle | null = null;
let concurrentWipRoot: Fiber | null = null;
let concurrentIdBase = 0;

const yieldChannel = new MessageChannel();
let continuationScheduled = false;
yieldChannel.port1.onmessage = () => {
  continuationScheduled = false;
  resumeConcurrent();
};
function scheduleContinuation(): void {
  if (continuationScheduled) return;
  continuationScheduled = true;
  if (manualSlicing) return; // pumped via __pumpForTests()
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

setTransitionScheduler((cb, onComplete) => {
  transitionDepth++;
  try {
    cb();
  } finally {
    transitionDepth--;
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
}

function commitRoot(handle: RootHandle, wipRoot: Fiber): void {
  // 1. Before mutation: class getSnapshotBeforeUpdate.
  if (__DENEXT_CLASS_COMPONENTS__) {
    walk(wipRoot, (f) => {
      if ((f.flags & Snapshot) !== 0) captureSnapshot(f as never);
    });
  }
  // 2. Mutation: deletions, then host/text property updates.
  walk(wipRoot, (f) => {
    if (f.deletions) { for (const d of f.deletions) commitDeletion(d); }
  });
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
  // 5. Layout effects (useLayoutEffect / useInsertionEffect / class didMount +
  //    didUpdate) run synchronously now, before paint, in mount DFS order. Passive
  //    effects (useEffect) are deferred to a scheduled task after the commit.
  //    Effects are collected by walking the COMMITTED tree (post-order, so
  //    children run before parents), which excludes any fiber discarded by a
  //    suspense/error unwind — its effects must not run for content never placed.
  const effects: Fiber[] = [];
  collectEffects(wipRoot, effects);
  for (const f of effects) runLayoutEffects(f);
  for (const f of effects) {
    if (f.passiveEffects && f.passiveEffects.length > 0) pendingPassive.push(f);
  }
  if (pendingPassive.length > 0) schedulePassiveFlush();
  // 6. DevTools.
  reportCommit(handle);
}

/** Collect component fibers with pending effects, children before parents. */
function collectEffects(fiber: Fiber, out: Fiber[]): void {
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

function runLayoutEffects(inst: Fiber): void {
  const effects = inst.pendingEffects;
  inst.pendingEffects = [];
  if (effects) { for (const e of effects) e(); }
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
    for (const f of batch) {
      const effects = f.passiveEffects;
      f.passiveEffects = [];
      if (effects) { for (const e of effects) e(); }
    }
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
  if (fiber.tag === "component") {
    if (__DENEXT_CLASS_COMPONENTS__ && fiber.classInstance) unmountClassInstance(fiber as never);
    if (fiber.hooks) {
      for (const cell of fiber.hooks) {
        if (typeof cell.cleanup === "function") cell.cleanup();
      }
    }
  }
  // Capture the next sibling before recursing — we sever links below, which would
  // otherwise cut the traversal short.
  for (let c = fiber.child; c !== null;) {
    const next = c.sibling;
    commitDeletion(c);
    c = next;
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

function retrySuspense(inst: Fiber): void {
  if (inst.unmounted) return; // boundary was unmounted before the promise settled
  inst.showingFallback = false;
  scheduleUpdate(inst);
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
      const fn = vtype as { displayName?: string; name?: string };
      const name = (typeof vtype === "function" ? fn.displayName || fn.name : "Component") ||
        "Anonymous";
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
