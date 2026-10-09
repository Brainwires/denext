// The Fiber node and its mechanical helpers: work-in-progress cloning (the
// double-buffer), effect flags, priority lanes, and DOM collection/placement.
//
// A Fiber is a unit of work over the component tree. Unlike the recursive
// reconciler's `Instance` (which held `children[]` + `rendered` and mutated the
// live DOM during render), fibers form a singly-linked tree (`child` / `sibling`
// / `return`) so rendering can pause and resume at any node, and each fiber has
// an `alternate` so the next tree is built off-DOM and committed atomically.

import type { VNode } from "../../jsx/types.ts";
import type { DependencyList } from "../../compat/react-types.ts";
import type { FormStatusSignal } from "../../runtime/form-status.ts";
import type { ProfilerOnRender } from "../../runtime/profiler.ts";
import type { IdScope } from "../../jsx/tree-id.ts";

/** Reveal coordination shared by a SuspenseList and its member boundaries. */
export interface SuspenseListState {
  /** Reveal order from the `<SuspenseList>` marker (unset ⇒ no coordination). */
  revealOrder?: "forwards" | "backwards" | "together";
  /** Fallback visibility for not-yet-revealed boundaries. */
  tail?: "collapsed" | "hidden";
  /** Member boundary fibers by index, re-registered each render (scheduling targets). */
  members: Array<Fiber | undefined>;
  /**
   * Number of direct list children, set when the list tags them. Used by the
   * `collapsed`/`hidden` tail to find the leading boundary even on the first render,
   * when {@link SuspenseListState.snapshot} is still empty (no member has reported
   * readiness yet).
   */
  count?: number;
  /**
   * Persistent per-index readiness — the source of truth, indexed by position so it
   * survives the member fibers being recreated each render.
   */
  ready: boolean[];
  /** A frozen copy of {@link SuspenseListState.ready} for one render's decisions. */
  snapshot: boolean[];
}

/**
 * Fiber tags — the recursive reconciler's 8 kinds plus the synthetic root and `singleton`: a
 * root layout's `<html>`/`<head>`/`<body>` rendered inside the page container, which adopts the
 * page's own element (see `documentTagElement` in begin-work.ts) instead of creating one.
 */
export type FiberTag =
  | "root"
  | "host"
  | "singleton"
  | "text"
  | "component"
  | "fragment"
  | "portal"
  | "suspense"
  | "activity"
  | "errorboundary";

/**
 * A committed effect entry. Calling it runs the effect's **setup** (and, for a hook
 * effect, captures its Offscreen reconnect + StrictMode double-invoke). An optional
 * `cleanup` runs the previous render's teardown. The commit runs all entries'
 * cleanups first, then all their setups (React's ordering) — so a class-lifecycle
 * thunk (a plain function with no `cleanup`) participates only in the setup pass.
 */
export type CommitEffect = (() => void) & { cleanup?: () => void };

/** A hook cell (identical shape to the recursive reconciler's). */
export interface HookCell {
  value?: unknown;
  /**
   * Stateful cells: the value the component's last render READ. A pending update whose
   * cells all still equal this is a no-op re-render (React bails out of it) — e.g. a callback
   * ref recreated every render whose detach/attach calls `setNode(null)` then `setNode(node)`.
   */
  rendered?: unknown;
  /** Stateful cells: `rendered` as of the last COMMITTED render (an abandoned render — a
   * suspended transition — never promotes its value here, so its retry still renders). */
  committed?: unknown;
  deps?: DependencyList;
  cleanup?: (() => void) | void;
  inited?: boolean;
  /** Effect cells: set once the effect has mounted (for StrictMode remount). */
  mounted?: boolean;
  /**
   * Effect cells (passive/layout, not insertion): re-run the most-recently-committed
   * setup and store its cleanup. Used to reconnect an Offscreen subtree on reveal —
   * the cell keeps its state, but its side effect is torn down while hidden and
   * rebuilt when shown again.
   */
  reconnect?: () => void;
  /** Effect cell currently torn down by an Offscreen hide (awaiting reconnect). */
  disconnected?: boolean;
  /**
   * Which hook produced this cell (a small `HK_*` tag). Recorded on every hook call
   * so the dev Fast Refresh guard can detect a hooks-shape change across an edit —
   * not just a changed count, but a same-count reorder (e.g. useState↔useRef swapped).
   */
  kind?: number;
  /**
   * useState/useReducer only. The setter/dispatch is created ONCE and reused every
   * render (React guarantees a stable identity — libraries put it in effect/memo deps).
   * `owner` is refreshed to the currently-rendering fiber each render so the stable
   * closure still targets the live buffer across the double-buffer swap; `reducer` holds
   * the latest reducer so a memoized dispatch always uses the current one.
   */
  updater?: (v: unknown) => void;
  owner?: Fiber;
  reducer?: (s: unknown, a: unknown) => unknown;
}

/**
 * One `useDebugValue` call recorded during a component's render (dev only). It takes no
 * hook cell; `index` is how many cells the render had consumed at the call, which places
 * it after the cell it follows. `format` is kept, not applied — the inspector runs it
 * lazily when it serializes the value.
 */
export interface DebugValueEntry {
  /** The hook cursor at the call — the number of cells consumed before it. */
  index: number;
  /** The raw value passed to `useDebugValue`. */
  value: unknown;
  /** The optional formatter, applied only when the inspector reads the entry. */
  format?: (value: unknown) => unknown;
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
/**
 * A freshly-mounted host with a `ref` prop whose ref must be attached at COMMIT (after the
 * node is placed), not in `completeWork`. React attaches refs in the commit phase; firing a
 * ref callback during render breaks libraries that guard against it (e.g. Base UI's
 * "Cannot call an event handler while rendering"). An UPDATE's ref rides its commit-phase
 * `applyProps` instead.
 */
export const RefAttach = 32;
/**
 * This component fiber queued at least one effect this render (insertion / layout /
 * passive, incl. a `useSyncExternalStore` subscription). Coarse on purpose — the precise
 * per-kind filter is the effect arrays themselves; this bit only lets the commit-phase
 * effect collectors PRUNE clean subtrees (descend only where `subtreeFlags & HasEffect`)
 * instead of walking the whole tree to find that a subtree has no effects.
 */
export const HasEffect = 64;
/**
 * This component fiber re-ran its render this pass (mirrors `didRender`). Carries no commit
 * work of its own; it lets `clearCommittedFlags` prune by `subtreeFlags` — a subtree with no
 * flags at all has nothing to reset and no hook baselines to promote.
 */
export const Rendered = 128;

// ---- Priority lanes --------------------------------------------------------

export const NoLane = 0;
/** Urgent, blocking updates: rendered + committed synchronously. */
export const SyncLane = 1;
/** Low-priority (transition) updates: time-sliced and interruptible. */
export const TransitionLane = 2;

export type Lanes = number;

// ---- Per-fiber boolean state (bitmask, `Fiber.bits`) ------------------------
//
// Eleven booleans share one Smi field instead of eleven pointer-sized slots. `bits` is
// persistent state, unlike `flags` (this pass's commit work, reset per render).

/**
 * Something other than a state setter scheduled this fiber (a Suspense retry, an external-store
 * change, a boundary reset, Fast Refresh): the next render must run even though no hook value
 * changed. Cleared when the fiber begins work.
 */
export const ForceRenderBit = 1;
/** A state setter scheduled this fiber — the only updates the no-op bailout may judge; a lane
 * retained for other reasons (a suspended child's retry) always renders. */
export const StateUpdateBit = 2;
/**
 * This fiber actually re-ran its render this pass (not bailed). Lets the commit's
 * `clearCommittedFlags` promote hook `committed` baselines only on fibers that rendered. Reset
 * per pass (in `createWorkInProgress`, and after promotion in the commit walk).
 */
export const DidRenderBit = 4;
/** A class component's shouldComponentUpdate / PureComponent bailed this pass. */
export const BailedBit = 8;
/** Inside a StrictMode subtree (dev double-invoke). */
export const StrictBit = 16;
/** A descendant of a `<Profiler>`: its component renders are timed. */
export const UnderProfilerBit = 32;
/** A `<Profiler>` that has committed once (its next `onRender` phase is "update"). */
export const ProfilerMountedBit = 64;
/** Suspense-only: the fallback (vs. real children) is showing. */
export const ShowingFallbackBit = 128;
/**
 * Suspense-only (Offscreen): on an URGENT re-suspend of an already-revealed boundary, the
 * primary subtree is kept mounted-but-hidden and the fallback is shown alongside (instead of
 * remounting on reveal — state is preserved). Also an `<Activity>` in its hidden mode.
 */
export const OffscreenBit = 256;
/**
 * Set on the top-level fibers of an Offscreen-hidden primary subtree: beginWork skips
 * re-rendering them (a suspended child must not re-throw) and preserves their committed
 * subtree; commit sets an inline `display:none !important` on their DOM.
 */
export const HiddenBit = 512;
/** Set by commitDeletion once this fiber is unmounted, so a late async callback (a settling
 * Suspense promise) can bail instead of acting on a dead fiber. */
export const UnmountedBit = 1024;

/** The bits `createWorkInProgress` carries from the current fiber onto its twin. */
const CARRIED_BITS = StrictBit | UnderProfilerBit | ProfilerMountedBit | ShowingFallbackBit |
  OffscreenBit | HiddenBit;
/** The bits a work-in-progress fiber keeps from its own previous life (never carried). */
const OWN_BITS = ForceRenderBit | StateUpdateBit | UnmountedBit;

// ---- The Fiber node --------------------------------------------------------

/**
 * A fiber's rarely used state: providers, Suspense / Activity / SuspenseList bookkeeping,
 * error boundaries, the root's element, class components, the Profiler, form actions and
 * dev-only records. Allocated on the first write ({@link fiberExt}); most fibers (plain host
 * elements, text, function components) never have one, so these fields cost them nothing.
 * Every field is declared here, so all extensions share one hidden class.
 */
class FiberExt {
  /**
   * The INSERTION effect queue (useInsertionEffect) — run synchronously at commit *before*
   * DOM mutation, so CSS-in-JS style insertion precedes any layout read.
   */
  insertionEffects: CommitEffect[] | undefined;
  /** A provider fragment's memo of the parent map and value its derived map was built from. */
  provParent: Map<symbol, unknown> | undefined;
  provValue: unknown;
  /**
   * Dev only: this render's `useDebugValue` calls (not hook cells — see DebugValueEntry).
   * Cleared at the start of every render pass; carried on a bailout like readContexts.
   */
  debugValues: DebugValueEntry[] | undefined;
  /** Host `<form action={fn}>` only: the per-form pending signal backing useFormStatus,
   * persisted across renders and carried between buffers. */
  formStatus: FormStatusSignal | undefined;
  /**
   * Dev per-module HMR only: the component implementation this fiber last rendered with
   * (after family-current substitution). Compared against the resolved impl on the next
   * render to detect a per-module refresh swap. Never set in production.
   */
  lastImpl: unknown;
  /**
   * Profiler timing. `profiler` marks a <Profiler> boundary. `actualDuration` is this
   * fiber's own render time this pass (0 if it bailed); `selfBaseDuration` is its
   * most-recent render time (persisted, for baseDuration).
   */
  profiler: { id: string; onRender?: ProfilerOnRender } | undefined;
  actualDuration: number | undefined;
  selfBaseDuration: number | undefined;
  /**
   * Offscreen (see {@link OffscreenBit}): how many of the boundary's top-level children are
   * the (hidden) primary vs the fallback; `hiddenEls` records the host elements hidden at
   * commit (via an inline `display:none !important`) so reveal can restore their prior style.
   */
  primaryCount: number | undefined;
  hiddenEls: Element[] | undefined;
  /**
   * SuspenseList coordination. A single {@link SuspenseListState} object is shared by the
   * list fragment and its member <Suspense> fibers across all buffers, so a bailed/cloned
   * member always reads the freshly-rendered reveal state. `listOwnerState` is set on a
   * SuspenseList's direct children so membership propagates one level to the <Suspense>
   * each renders.
   */
  listState: SuspenseListState | undefined;
  listIndex: number | undefined;
  listOwnerState: SuspenseListState | undefined;
  /** Error-boundary-only (function ErrorBoundary): the caught error whose fallback is
   * currently rendered, or null/undefined when showing real children. */
  __error: unknown;
  /** Root-only: the element to render into the container. */
  pendingElement: VNode | null | undefined;
  /** Class-component only (gated) — the field names the class runtime reads. */
  classInstance: unknown;
  __snapshot: unknown;
  __prevProps: unknown;
  __prevState: unknown;
}

/** An extension with every field unset: the source {@link carryExt} resets a twin from. */
const EMPTY_EXT = new FiberExt();

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

  /** Persistent boolean state — the `*Bit` constants above. */
  bits: number;

  // Component-only. `pendingEffects` is the LAYOUT queue (useLayoutEffect and class
  // componentDidMount/DidUpdate) — run synchronously at commit after mutation, before paint.
  // `passiveEffects` is the PASSIVE queue (useEffect, useSyncExternalStore subscribe) —
  // scheduled after commit (after paint). The insertion queue is on {@link FiberExt}.
  hooks?: HookCell[];
  pendingEffects?: CommitEffect[];
  passiveEffects?: CommitEffect[];

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
  // The context ids this fiber READ during its last render (via useContext / use /
  // Consumer). Lets the memo bailout re-render a consumer only when a context it
  // actually reads changed value — instead of when any ancestor provider re-rendered
  // (which cascades a fresh `inherited` map identity to the whole subtree). `undefined`
  // means the last render read no context. Rebuilt each render; carried on a bailout.
  readContexts?: Set<symbol>;

  // Host bookkeeping (satisfies HostState from dom-props.ts).
  listeners?: Map<string, EventListener>;
  attachedRef?: unknown;
  refCleanup?: (() => void) | void;

  // Path-based useId. `idParentScope` is the enclosing component's id scope (the
  // scope this fiber's component children slot into); host/fragment/suspense/
  // error-boundary levels pass it straight through. `idScope` is set on a
  // component fiber at its first render — `enterScope(idParentScope)` — and read
  // by `useId`. Both are assigned once (mount) and carried across buffers; useId
  // is cached per hook cell, so only the first render's positions matter.
  idParentScope?: IdScope;
  idScope?: IdScope;

  // The key scope this fiber occupies among its siblings: which nested child array it came
  // from (`"1"`, `"1.0"`, …; `undefined` for a direct child). React scopes keys per array,
  // so a key only matches an old fiber of the same scope. Set by the parent's reconcile.
  keyScope?: string;

  /** Rarely used state, allocated on first write — see {@link FiberExt} / {@link fiberExt}. */
  ext: FiberExt | undefined;
}

/**
 * The context map of a fiber nothing has provided to yet. Shared: context maps are never
 * mutated in place (a provider derives a new map, `providerContexts`), and reconcile replaces
 * a new fiber's map before it renders, so two fresh `Map`s per fiber were garbage.
 */
const NO_CONTEXT: Map<symbol, unknown> = new Map();

/**
 * A fiber. Every field is a class field, declared up front, so all fibers share ONE hidden
 * class: added lazily (in whatever order a fiber's life assigns them) they left V8 with many
 * shapes, and `carryOver`'s property copies per re-rendered fiber went megamorphic — the
 * single largest cost of re-rendering a long list. A class states the shape once (an
 * uninitialized field is `undefined`), which is also far smaller in the client bundle than
 * the same shape as an object literal of `field: undefined` pairs. The fields every fiber
 * kind uses live here; booleans share `bits`, and rarely used state lives in a lazily
 * allocated {@link FiberExt} — a fiber is ~half the size it was with all of them inline.
 */
class FiberNode implements Fiber {
  tag: FiberTag;
  vnode: VNode;
  stateNode: Fiber["stateNode"] = null;
  child: Fiber | null = null;
  sibling: Fiber | null = null;
  return: Fiber | null = null;
  alternate: Fiber | null = null;
  flags = NoFlags;
  subtreeFlags = NoFlags;
  deletions: Fiber[] | null = null;
  lanes = NoLane;
  childLanes = NoLane;
  bits = 0;
  host: Fiber | null = null;
  boundary: Fiber | null = null;
  inherited: Map<symbol, unknown> = NO_CONTEXT;
  contexts: Map<symbol, unknown> = NO_CONTEXT;
  hooks: Fiber["hooks"];
  pendingEffects: Fiber["pendingEffects"];
  passiveEffects: Fiber["passiveEffects"];
  readContexts: Fiber["readContexts"];
  listeners: Fiber["listeners"];
  attachedRef: Fiber["attachedRef"];
  refCleanup: Fiber["refCleanup"];
  idParentScope: Fiber["idParentScope"];
  idScope: Fiber["idScope"];
  keyScope: Fiber["keyScope"];
  ext: Fiber["ext"];

  constructor(tag: FiberTag, vnode: VNode) {
    this.tag = tag;
    this.vnode = vnode;
  }
}

/** Allocate a fresh fiber for `vnode` with the given tag. */
export function createFiber(tag: FiberTag, vnode: VNode): Fiber {
  return new FiberNode(tag, vnode);
}

/** `fiber`'s {@link FiberExt}, allocated on first use — call it to WRITE a rare field. */
export function fiberExt(fiber: Fiber): FiberExt {
  return fiber.ext ??= new FiberExt();
}

/** Whether every bit of `bit` is set on `fiber`. */
export function hasBit(fiber: Fiber, bit: number): boolean {
  return (fiber.bits & bit) !== 0;
}

/** Set (`on`) or clear `bit` on `fiber`. */
export function setBit(fiber: Fiber, bit: number, on: boolean): void {
  fiber.bits = on ? fiber.bits | bit : fiber.bits & ~bit;
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
  carryOver(wip, current);
  // Carried bits from `current`, the twin's own scheduling/unmount bits; `BailedBit` and
  // `DidRenderBit` start clear every pass.
  wip.bits = (current.bits & CARRIED_BITS) | (wip.bits & OWN_BITS);
  return wip;
}

/** Carry the current fiber's mutable state onto its work-in-progress twin, by reference. */
function carryOver(wip: Fiber, current: Fiber): void {
  wip.hooks = current.hooks;
  wip.readContexts = current.readContexts; // kept if the fiber bails (doesn't re-render)
  wip.pendingEffects = undefined;
  wip.passiveEffects = undefined;
  wip.inherited = current.inherited;
  wip.contexts = current.contexts;
  wip.listeners = current.listeners;
  wip.attachedRef = current.attachedRef;
  wip.refCleanup = current.refCleanup;
  wip.idParentScope = current.idParentScope;
  wip.idScope = current.idScope;
  wip.keyScope = current.keyScope;
  wip.host = current.host;
  wip.boundary = current.boundary;
  carryExt(wip, current);
}

/**
 * Carry `current`'s {@link FiberExt} onto its twin — copied, not shared, so a render that is
 * abandoned never leaks its writes into the committed buffer. A twin of a fiber with no
 * extension keeps its own (holding its uncarried `lastImpl` / `profiler` / `actualDuration`)
 * with every carried field reset, as the old inline copy did.
 */
function carryExt(wip: Fiber, current: Fiber): void {
  const from = current.ext;
  if (from === undefined && wip.ext === undefined) return;
  const to = fiberExt(wip);
  const src = from ?? EMPTY_EXT;
  to.insertionEffects = undefined;
  to.provParent = src.provParent;
  to.provValue = src.provValue;
  to.debugValues = src.debugValues;
  to.formStatus = src.formStatus;
  to.selfBaseDuration = src.selfBaseDuration;
  to.primaryCount = src.primaryCount;
  to.hiddenEls = src.hiddenEls;
  to.listState = src.listState;
  to.listIndex = src.listIndex;
  to.listOwnerState = src.listOwnerState;
  to.__error = src.__error;
  to.pendingElement = src.pendingElement;
  to.classInstance = src.classInstance;
  to.__prevProps = src.__prevProps;
  to.__prevState = src.__prevState;
  to.__snapshot = src.__snapshot;
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

/** Place `node` before `anchor`: appendChild at the end, as React does; else insertBefore. */
function placeBefore(parent: Element, node: Element | Text, anchor: Node | null): void {
  if (anchor === null) parent.appendChild(node);
  else parent.insertBefore(node, anchor);
}

/**
 * Arrange `desired` nodes as the exact ordered children of `parent`, with the fewest DOM
 * moves: the common prefix and suffix stay put, and in the changed middle only nodes outside
 * the longest run already in order (a longest increasing subsequence of their current
 * positions) are moved — so an append, prepend, insert, removal, swap or single move touches
 * only the nodes that changed. The current children are read ONCE, in order; indexing the
 * live `childNodes` per position instead is quadratic in a real browser, whose NodeList
 * index cache every insertBefore invalidates (a 100k-row reorder took seconds). Every move
 * is an `insertBefore` against a known reference node, never a position.
 */
export function syncChildren(parent: Element, desired: (Element | Text)[]): void {
  // Nothing to place into an empty parent (a root whose tree rendered only `null`): no DOM
  // is touched, so a bare container stub without `childNodes` works, as it does in React.
  const oldLen = parent.childNodes?.length ?? 0;
  if (oldLen === 0) {
    for (const node of desired) placeBefore(parent, node, null);
    return;
  }
  const current: Node[] = Array.from(parent.childNodes);
  const newLen = desired.length;
  let start = 0;
  while (start < newLen && start < oldLen && desired[start] === current[start]) start++;
  let newEnd = newLen;
  let oldEnd = oldLen;
  while (newEnd > start && oldEnd > start && desired[newEnd - 1] === current[oldEnd - 1]) {
    newEnd--;
    oldEnd--;
  }
  if (start === newEnd && start === oldEnd) return; // already in order
  syncMiddle(parent, desired, current, start, newEnd, oldEnd);
}

/**
 * The changed middle of {@link syncChildren}: `desired[start, newEnd)` must replace
 * `current[start, oldEnd)`. Nodes of the old middle that are not wanted are removed; the
 * wanted ones that already sit in increasing order stay; everything else is inserted,
 * back to front, before its successor.
 */
function syncMiddle(
  parent: Element,
  desired: (Element | Text)[],
  current: Node[],
  start: number,
  newEnd: number,
  oldEnd: number,
): void {
  const count = newEnd - start;
  // Old position of each node of the old middle (the prefix/suffix are fixed, and a desired
  // node appears once, so no middle node of `desired` sits in the prefix or suffix).
  const oldPos = new Map<Node, number>();
  for (let i = start; i < oldEnd; i++) oldPos.set(current[i], i);
  // For each desired middle node: its old position, or -1 for a node new to `parent`.
  const sources = new Int32Array(count);
  for (let j = 0; j < count; j++) {
    const pos = oldPos.get(desired[start + j]);
    sources[j] = pos === undefined ? -1 : pos;
    if (pos !== undefined) oldPos.delete(desired[start + j]);
  }
  // Whatever is left in `oldPos` is not wanted here any more (a deletion normally removed it
  // already; this catches a node the reconciler never inserted).
  for (const node of oldPos.keys()) parent.removeChild(node);
  const stable = longestIncreasingRun(sources);
  let anchor: Node | null = newEnd < desired.length ? desired[newEnd] : null;
  for (let j = count - 1; j >= 0; j--) {
    const node = desired[start + j];
    if (stable[j] !== 1) placeBefore(parent, node, anchor);
    anchor = node;
  }
}

/**
 * Mark (1) the members of one longest strictly increasing subsequence of `sources`,
 * skipping `-1` entries (new nodes, always placed). O(n log n) patience sort with
 * predecessor links.
 */
function longestIncreasingRun(sources: Int32Array): Uint8Array {
  const n = sources.length;
  const marks = new Uint8Array(n);
  const prev = new Int32Array(n);
  // tails[k]: index (into sources) of the smallest tail of an increasing run of length k+1.
  const tails = new Int32Array(n);
  let len = 0;
  for (let i = 0; i < n; i++) {
    const v = sources[i];
    if (v < 0) continue;
    let lo = 0;
    let hi = len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sources[tails[mid]] < v) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
    if (lo === len) len++;
  }
  for (let i = len > 0 ? tails[len - 1] : -1; i >= 0; i = prev[i]) marks[i] = 1;
  return marks;
}

/**
 * Place `desired` as a contiguous, ordered group inside `parent` WITHOUT removing any
 * node `parent` also holds that isn't in `desired`. A portal target is a container the
 * reconciler does NOT exclusively own — `document.body` also holds `#root`, the entry
 * `<script>`, and other portals — so the count-based prune in {@link syncChildren} would
 * evict those foreign siblings (React never prunes portal-container nodes it didn't
 * insert). Removals of the portal's own children are handled by the normal deletion
 * commit, so this only inserts/reorders; it anchors the group at its last node's current
 * position (appending the group when absent) so it doesn't fight other portals for the
 * container's tail.
 */
export function placePortalChildren(parent: Element, desired: (Element | Text)[]): void {
  for (let i = desired.length - 1; i >= 0; i--) {
    const node = desired[i];
    const next = desired[i + 1] ?? null; // already positioned (we processed i+1 first)
    if (next === null) {
      if (node.parentNode !== parent) parent.appendChild(node);
    } else if (node.nextSibling !== next || node.parentNode !== parent) {
      parent.insertBefore(node, next);
    }
  }
}
