// Child reconciliation: keyed and unkeyed diffing of a fiber's new vnodes against
// its committed children, and cloning a bailed fiber's children.

import { createFiberFromVNode, devHydrationActive } from "./fiber-utils.ts";
import type { VNode, VNodeChildren } from "../../jsx/types.ts";
import { familyMatchActive, normalizeChildren, sameType } from "../vnode-utils.ts";
import {
  ChildDeletion,
  ChildrenChanged,
  createWorkInProgress,
  type Fiber,
  Placement,
} from "./fiber.ts";

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

/** The committed children of a fiber, indexed for matching against the new vnodes. */
interface OldChildIndex {
  oldChildren: Fiber[];
  keyed: Map<unknown, Fiber>;
  /** Unkeyed old children bucketed by element type, each queue kept in document order. */
  unkeyedByType: Map<unknown, Fiber[]>;
  oldIndexOf: Map<Fiber, number>;
}

/**
 * Index the committed children from `first` on (`firstIndex` is its position among them). Matching an unkeyed new child pops the
 * FIRST unused old child of the SAME type, so inserting or removing a child of one type
 * never strands the reusable same-type siblings that follow it. (A single forward
 * cursor instead CONSUMED candidates on a type mismatch: one front-insert would burn the
 * cursor past every real candidate and remount all trailing siblings — a whole-subtree
 * churn under any list that grows a differently-typed child at the front.)
 */
function indexOldChildren(first: Fiber | null, firstIndex: number): OldChildIndex {
  const oldChildren: Fiber[] = [];
  for (let c = first; c !== null; c = c.sibling) oldChildren.push(c);
  const keyed = new Map<unknown, Fiber>();
  const unkeyedByType = new Map<unknown, Fiber[]>();
  const oldIndexOf = new Map<Fiber, number>();
  for (let i = 0; i < oldChildren.length; i++) {
    const c = oldChildren[i];
    oldIndexOf.set(c, firstIndex + i);
    if (c.vnode.key != null) {
      keyed.set(c.vnode.key, c);
    } else {
      let q = unkeyedByType.get(c.vnode.type);
      if (q === undefined) unkeyedByType.set(c.vnode.type, q = []);
      q.push(c);
    }
  }
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

/**
 * Dev only: React's duplicate-key warning. Two siblings with one key cannot both keep their
 * identity — the second never matches the first's old fiber and remounts on every render.
 * `seen` is null in production, so the check costs nothing there.
 */
function warnDuplicateKey(seen: Set<unknown> | null, nv: VNode): void {
  if (seen === null || nv.key == null) return;
  if (!seen.has(nv.key)) {
    seen.add(nv.key);
    return;
  }
  console.error(
    `denext: Encountered two children with the same key, \`${String(nv.key)}\`. Keys ` +
      "should be unique so that components maintain their identity across updates; " +
      "non-unique keys may cause children to be duplicated, omitted or remounted.",
  );
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

/**
 * Whether the old child in the same slot can be reused as-is by `nv` — the lockstep fast
 * path: equal keys (or both unkeyed) and the same type. For an unkeyed pair this is exactly
 * what the indexed matcher would pick (every earlier old child is already used, so this one
 * is the first unused of its type).
 */
function sameSlot(old: Fiber, nv: VNode): boolean {
  const ok = old.vnode.key;
  if (nv.key != null ? ok !== nv.key : ok != null) return false;
  return sameType(old.vnode, nv);
}

/** The child chain being built for one reconcile, plus what each child inherits. */
interface ChildChain {
  returnFiber: Fiber;
  links: ChildLinks;
  first: Fiber | null;
  last: Fiber | null;
  /** Dev only: keys seen so far, for the duplicate-key warning (null in production). */
  seenKeys: Set<unknown> | null;
}

function appendChild(chain: ChildChain, fiber: Fiber): void {
  linkChildFiber(fiber, chain.returnFiber, chain.links);
  if (chain.last) chain.last.sibling = fiber;
  else chain.first = fiber;
  chain.last = fiber;
}

/**
 * Pass 1, lockstep (React's first pass): reuse old children in place while each new vnode
 * matches the old child in its slot — no maps, no allocation. Covers a re-render of an
 * unchanged list and an append in O(n) with small constants.
 *
 * @returns The first new index and the first old child the pass did not consume.
 */
function reconcileLockstep(
  chain: ChildChain,
  newVNodes: VNode[],
): { index: number; oldFiber: Fiber | null } {
  let oldFiber = chain.returnFiber.child;
  let j = 0;
  for (; j < newVNodes.length && oldFiber !== null; j++) {
    const nv = newVNodes[j];
    if (!sameSlot(oldFiber, nv)) break;
    warnDuplicateKey(chain.seenKeys, nv);
    const next: Fiber | null = oldFiber.sibling;
    appendChild(chain, createWorkInProgress(oldFiber, nv));
    oldFiber = next;
  }
  return { index: j, oldFiber };
}

/**
 * Pass 2 (a prepend, insert, removal or move): match the remaining new vnodes against the
 * remaining old children by key / by type, mount the rest and queue the unused old ones for
 * deletion. True when membership or order changed.
 */
function reconcileRemaining(
  chain: ChildChain,
  newVNodes: VNode[],
  start: number,
  oldFiber: Fiber | null,
): boolean {
  const index = indexOldChildren(oldFiber, start);
  const used = new Set<Fiber>();
  let changed = false;
  let lastMatchedOldIndex = start - 1;
  for (let j = start; j < newVNodes.length; j++) {
    const nv = newVNodes[j];
    warnDuplicateKey(chain.seenKeys, nv);
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
    appendChild(chain, fiber);
  }
  return collectDeletions(chain.returnFiber, index.oldChildren, used) || changed;
}

export function reconcileChildren(
  returnFiber: Fiber,
  childrenRaw: VNodeChildren,
  childHost: Fiber | null,
  childBoundary: Fiber | null,
  childInherited: Map<symbol, unknown>,
): void {
  const newVNodes = normalizeChildren(childrenRaw);
  const chain: ChildChain = {
    returnFiber,
    links: {
      host: childHost,
      boundary: childBoundary,
      inherited: childInherited,
      // The id scope the children's components slot into: a component parent exposes
      // its own scope; host/fragment/suspense/… levels pass their enclosing one through.
      idParentScope: returnFiber.idScope ?? returnFiber.idParentScope,
    },
    first: null,
    last: null,
    seenKeys: newVNodes.length > 1 && devHydrationActive() ? new Set<unknown>() : null,
  };
  const { index, oldFiber } = reconcileLockstep(chain, newVNodes);
  const changed = (index < newVNodes.length || oldFiber !== null) &&
    reconcileRemaining(chain, newVNodes, index, oldFiber);
  returnFiber.child = chain.first;
  if (changed) returnFiber.flags |= ChildrenChanged;
}

/** Clone a bailed-out fiber's current children into fresh work-in-progress. */
export function cloneChildFibers(wip: Fiber): void {
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
