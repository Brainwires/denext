// The Fiber node and its mechanical helpers: work-in-progress cloning (the
// double-buffer), effect flags, priority lanes, and DOM collection/placement.
//
// A Fiber is a unit of work over the component tree. Unlike the recursive
// reconciler's `Instance` (which held `children[]` + `rendered` and mutated the
// live DOM during render), fibers form a singly-linked tree (`child` / `sibling`
// / `return`) so rendering can pause and resume at any node, and each fiber has
// an `alternate` so the next tree is built off-DOM and committed atomically.

import type { VNode } from "../../jsx/types.ts";
import type { FormStatusSignal } from "../../runtime/form-status.ts";
import type { ProfilerOnRender } from "../../runtime/profiler.ts";

/** Reveal coordination shared by a SuspenseList and its member boundaries. */
export interface SuspenseListState {
  /** Reveal order from the `<SuspenseList>` marker (unset ⇒ no coordination). */
  revealOrder?: "forwards" | "backwards" | "together";
  /** Fallback visibility for not-yet-revealed boundaries. */
  tail?: "collapsed" | "hidden";
  /** Member boundary fibers by index, re-registered each render (scheduling targets). */
  members: Array<Fiber | undefined>;
  /**
   * Persistent per-index readiness — the source of truth, indexed by position so it
   * survives the member fibers being recreated each render.
   */
  ready: boolean[];
  /** A frozen copy of {@link SuspenseListState.ready} for one render's decisions. */
  snapshot: boolean[];
}

/** Fiber tags — the recursive reconciler's 7 kinds plus the synthetic root. */
export type FiberTag =
  | "root"
  | "host"
  | "text"
  | "component"
  | "fragment"
  | "portal"
  | "suspense"
  | "errorboundary";

/** A hook cell (identical shape to the recursive reconciler's). */
export interface HookCell {
  value?: unknown;
  deps?: unknown[];
  cleanup?: (() => void) | void;
  inited?: boolean;
}

/** A cursor over a parent's server-rendered child nodes, used during hydration. */
export interface Cursor {
  parent: Node;
  index: number;
}

// ---- Effect flags (bitmask) ------------------------------------------------

export const NoFlags = 0;
/** This fiber is newly created this render (fresh mount). */
export const Placement = 1;
/** This host/text fiber's props/value changed and must be applied at commit. */
export const Update = 2;
/** This fiber has entries in `deletions` to unmount at commit. */
export const ChildDeletion = 4;
/** A class fiber with getSnapshotBeforeUpdate (captured before mutation). */
export const Snapshot = 8;
/** This fiber's child list changed membership or order (host must re-sync). */
export const ChildrenChanged = 16;

// ---- Priority lanes --------------------------------------------------------

export const NoLane = 0;
/** Urgent, blocking updates: rendered + committed synchronously. */
export const SyncLane = 1;
/** Low-priority (transition) updates: time-sliced and interruptible. */
export const TransitionLane = 2;

export type Lanes = number;

// ---- The Fiber node --------------------------------------------------------

export interface Fiber {
  tag: FiberTag;
  /** The element this fiber renders (root: a synthetic placeholder). */
  vnode: VNode;
  /** The DOM node (host Element / text Text), portal target, or root container. */
  stateNode: Element | Text | null;

  // Tree links (singly-linked, React-style).
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;

  /** The other buffer of this fiber (current ↔ work-in-progress). */
  alternate: Fiber | null;

  // Effects.
  flags: number;
  subtreeFlags: number;
  deletions: Fiber[] | null;

  // Scheduling.
  lanes: Lanes;
  childLanes: Lanes;

  // Component-only. `insertionEffects` is the INSERTION queue (useInsertionEffect)
  // — run synchronously at commit *before* DOM mutation, so CSS-in-JS style
  // insertion precedes any layout read. `pendingEffects` is the LAYOUT queue
  // (useLayoutEffect and class componentDidMount/DidUpdate) — run synchronously at
  // commit after mutation, before paint. `passiveEffects` is the PASSIVE queue
  // (useEffect, useSyncExternalStore subscribe) — scheduled after commit (after paint).
  hooks?: HookCell[];
  insertionEffects?: Array<() => void>;
  pendingEffects?: Array<() => void>;
  passiveEffects?: Array<() => void>;

  // Routing pointers (into the current render's fibers).
  /** Nearest host fiber owning DOM placement (self for host/portal/root). */
  host: Fiber | null;
  /** Nearest enclosing error-boundary fiber, for runtime error routing. */
  boundary: Fiber | null;

  // Context. `inherited` is the map visible to THIS fiber (what its parent
  // exposed) — read by useContext and compared for the bailout. `contexts` is the
  // map this fiber exposes to its children; for a provider fragment it is the
  // derived map (and doubles as the provider memo cache), otherwise it equals
  // `inherited`.
  inherited: Map<symbol, unknown>;
  contexts: Map<symbol, unknown>;
  provParent?: Map<symbol, unknown>;
  provValue?: unknown;

  // Host bookkeeping (satisfies HostState from dom-props.ts).
  listeners?: Map<string, EventListener>;
  attachedRef?: unknown;
  refCleanup?: (() => void) | void;
  // Host `<form action={fn}>` only: the per-form pending signal backing
  // useFormStatus, persisted across renders and carried between buffers.
  formStatus?: FormStatusSignal;

  // True when this fiber is inside a StrictMode subtree (dev double-invoke).
  strict?: boolean;

  // Profiler timing. `profiler` marks a <Profiler> boundary; `underProfiler` is set
  // on its descendants so their render time is measured. `actualDuration` is this
  // fiber's own render time this pass (0 if it bailed); `selfBaseDuration` is its
  // most-recent render time (persisted, for baseDuration).
  profiler?: { id: string; onRender?: ProfilerOnRender };
  underProfiler?: boolean;
  actualDuration?: number;
  selfBaseDuration?: number;
  profilerMounted?: boolean;

  // Suspense-only: whether the fallback (vs. real children) is showing.
  showingFallback?: boolean;
  // Suspense-only (Offscreen): on an URGENT re-suspend of an already-revealed
  // boundary, the primary subtree is kept mounted-but-hidden and the fallback is
  // shown alongside (instead of remounting on reveal — state is preserved).
  // `offscreen` marks that mode; `primaryCount` is how many of the boundary's
  // top-level children are the (hidden) primary vs the fallback; `hiddenEls` records
  // the host elements hidden at commit (via the `hidden` attribute) so reveal can
  // un-hide them.
  offscreen?: boolean;
  primaryCount?: number;
  hiddenEls?: Element[];
  // Set on the top-level fibers of an Offscreen-hidden primary subtree: beginWork
  // skips re-rendering them (a suspended child must not re-throw) and preserves their
  // committed subtree; commit sets `display:none` on their DOM.
  hidden?: boolean;
  // SuspenseList coordination. A single {@link SuspenseListState} object is shared
  // by the list fragment and its member <Suspense> fibers across all buffers, so a
  // bailed/cloned member always reads the freshly-rendered reveal state.
  listState?: SuspenseListState;
  listIndex?: number;
  // Set on a SuspenseList's direct children so membership propagates one level to
  // the <Suspense> each renders.
  listOwnerState?: SuspenseListState;

  // Error-boundary-only (function ErrorBoundary): the caught error whose fallback
  // is currently rendered, or null/undefined when showing real children.
  __error?: unknown;

  // Root-only: the element to render into the container.
  pendingElement?: VNode | null;

  // Class-component only (gated) — same field names the class runtime reads.
  classInstance?: unknown;
  __snapshot?: unknown;
  __prevProps?: unknown;
  __prevState?: unknown;
  bailed?: boolean;

  // Hydration: the server-node cursor for this host/root's children.
  hydrationCursor?: Cursor | null;

  // Set by commitDeletion once this fiber is unmounted, so a late async callback
  // (a settling Suspense promise) can bail instead of acting on a dead fiber.
  unmounted?: boolean;
}

/** Allocate a fresh fiber for `vnode` with the given tag. */
export function createFiber(tag: FiberTag, vnode: VNode): Fiber {
  return {
    tag,
    vnode,
    stateNode: null,
    child: null,
    sibling: null,
    return: null,
    alternate: null,
    flags: NoFlags,
    subtreeFlags: NoFlags,
    deletions: null,
    lanes: NoLane,
    childLanes: NoLane,
    host: null,
    boundary: null,
    inherited: new Map(),
    contexts: new Map(),
  };
}

/**
 * Clone `current` into its `alternate` (the work-in-progress buffer), or create
 * the alternate on first render. Hook state, class instance, context maps, DOM
 * node, and host bookkeeping are carried **by reference** so they survive across
 * re-renders and restarts; effect flags and the child pointer are reset for the
 * new render (the child pointer starts pointing at the current children and is
 * re-linked by the parent's reconcile).
 */
export function createWorkInProgress(current: Fiber, pendingVNode: VNode | null): Fiber {
  let wip = current.alternate;
  if (wip === null) {
    wip = createFiber(current.tag, pendingVNode ?? current.vnode);
    wip.stateNode = current.stateNode;
    wip.alternate = current;
    current.alternate = wip;
  } else {
    wip.vnode = pendingVNode ?? current.vnode;
    wip.tag = current.tag;
    wip.stateNode = current.stateNode;
    wip.flags = NoFlags;
    wip.subtreeFlags = NoFlags;
    wip.deletions = null;
  }
  // Share until the parent's reconcile re-links them.
  wip.child = current.child;
  wip.sibling = null;
  wip.return = null;
  wip.lanes = current.lanes;
  wip.childLanes = current.childLanes;
  // Carry mutable state by reference.
  wip.hooks = current.hooks;
  wip.insertionEffects = undefined;
  wip.pendingEffects = undefined;
  wip.passiveEffects = undefined;
  wip.inherited = current.inherited;
  wip.contexts = current.contexts;
  wip.provParent = current.provParent;
  wip.provValue = current.provValue;
  wip.listeners = current.listeners;
  wip.attachedRef = current.attachedRef;
  wip.refCleanup = current.refCleanup;
  wip.formStatus = current.formStatus;
  wip.strict = current.strict;
  wip.underProfiler = current.underProfiler;
  wip.selfBaseDuration = current.selfBaseDuration;
  wip.profilerMounted = current.profilerMounted;
  wip.showingFallback = current.showingFallback;
  wip.offscreen = current.offscreen;
  wip.primaryCount = current.primaryCount;
  wip.hiddenEls = current.hiddenEls;
  wip.hidden = current.hidden;
  wip.listState = current.listState;
  wip.listIndex = current.listIndex;
  wip.listOwnerState = current.listOwnerState;
  wip.__error = current.__error;
  wip.pendingElement = current.pendingElement;
  wip.classInstance = current.classInstance;
  wip.__prevProps = current.__prevProps;
  wip.__prevState = current.__prevState;
  wip.__snapshot = current.__snapshot;
  wip.hydrationCursor = current.hydrationCursor;
  wip.host = current.host;
  wip.boundary = current.boundary;
  wip.bailed = false;
  return wip;
}

/** Merge a completed fiber's flags into its own `subtreeFlags` accumulator. */
export function bubbleFlags(completed: Fiber): void {
  let subtree = NoFlags;
  let child = completed.child;
  while (child !== null) {
    subtree |= child.subtreeFlags;
    subtree |= child.flags;
    child = child.sibling;
  }
  completed.subtreeFlags |= subtree;
}

// ---- DOM collection + placement (ported verbatim from the recursive core) --

/** Collect the ordered top-level DOM nodes produced by a fiber's subtree. */
export function collectDom(fiber: Fiber, out: (Element | Text)[]): void {
  // A portal's DOM lives in its target, not in the in-place parent — skip it.
  if (fiber.tag === "portal") return;
  if (fiber.stateNode !== null && (fiber.tag === "host" || fiber.tag === "text")) {
    out.push(fiber.stateNode);
    return;
  }
  let child = fiber.child;
  while (child !== null) {
    collectDom(child, out);
    child = child.sibling;
  }
}

/** The ordered DOM nodes that should be `fiber`'s (host/root/portal) children. */
export function childrenDom(fiber: Fiber): (Element | Text)[] {
  const out: (Element | Text)[] = [];
  let child = fiber.child;
  while (child !== null) {
    collectDom(child, out);
    child = child.sibling;
  }
  return out;
}

/** Arrange `desired` nodes as the exact ordered children of `parent`. */
export function syncChildren(parent: Element, desired: (Element | Text)[]): void {
  for (let i = 0; i < desired.length; i++) {
    const node = desired[i];
    const current = parent.childNodes[i] ?? null;
    if (current !== node) parent.insertBefore(node, current);
  }
  while (parent.childNodes.length > desired.length) {
    parent.removeChild(parent.childNodes[parent.childNodes.length - 1]);
  }
}
