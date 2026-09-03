// Child reconciliation: keyed and unkeyed diffing of a fiber's new vnodes against
// its committed children, and cloning a bailed fiber's children.

import { createFiberFromVNode } from "./fiber-utils.ts";
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

export function reconcileChildren(
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
