// Child reconciliation: keyed and unkeyed diffing of a fiber's new vnodes against
// its committed children, and cloning a bailed fiber's children.

import { createFiberFromVNode, devHydrationActive } from "./fiber-utils.ts";
import type { VNode, VNodeChildren } from "../../jsx/types.ts";
import { familyMatchActive, normalizeChildrenScoped, sameType } from "../vnode-utils.ts";
import {
  ChildDeletion,
  ChildrenChanged,
  createWorkInProgress,
  type Fiber,
  fiberExt,
  Placement,
  StrictBit,
  UnderProfilerBit,
} from "./fiber.ts";

/** The inherited bits a child takes from its parent at every reconcile. */
const INHERITED_BITS = StrictBit | UnderProfilerBit;

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
  /** Keyed old children, by key (a direct child) or by {@linkcode scopedKey}. */
  keyed: Map<unknown, Fiber>;
  /**
   * Unkeyed old children bucketed by element type, each queue kept in document order — one
   * bucket map per key scope (`undefined` is the direct children).
   */
  unkeyed: Map<string | undefined, Map<unknown, Fiber[]>>;
  oldIndexOf: Map<Fiber, number>;
}

/**
 * The keyed-map entry for `key` in `scope`: the key itself for a direct child (no allocation
 * on the common path), else a string no direct key can collide with in practice.
 */
function scopedKey(key: unknown, scope: string | undefined): unknown {
  return scope === undefined ? key : `\u0000${scope}\u0000${String(key)}`;
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
  const unkeyed = new Map<string | undefined, Map<unknown, Fiber[]>>();
  const oldIndexOf = new Map<Fiber, number>();
  for (let i = 0; i < oldChildren.length; i++) {
    const c = oldChildren[i];
    oldIndexOf.set(c, firstIndex + i);
    if (c.vnode.key != null) {
      keyed.set(scopedKey(c.vnode.key, c.keyScope), c);
    } else {
      let byType = unkeyed.get(c.keyScope);
      if (byType === undefined) unkeyed.set(c.keyScope, byType = new Map());
      let q = byType.get(c.vnode.type);
      if (q === undefined) byType.set(c.vnode.type, q = []);
      q.push(c);
    }
  }
  return { oldChildren, keyed, unkeyed, oldIndexOf };
}

/**
 * The old child a new vnode may reuse: by key, else the first unused unkeyed old child
 * of the exact same type (in order). Dev Fast Refresh only: an edited component's type
 * identity changed within its family, so it won't sit in the new type's bucket — scan
 * the remaining unkeyed queues for a family match (never runs in production).
 */
function matchOldChild(
  nv: VNode,
  scope: string | undefined,
  index: OldChildIndex,
): Fiber | undefined {
  if (nv.key != null) return index.keyed.get(scopedKey(nv.key, scope));
  const byType = index.unkeyed.get(scope);
  if (byType === undefined) return undefined;
  const q = byType.get(nv.type);
  if (q !== undefined && q.length > 0) return q.shift();
  return familyMatchActive() ? takeUnkeyedFamilyMatch(byType, nv) : undefined;
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
 * Installed by the dev entries ({@linkcode installDuplicateKeyWarning}, via `installDevtools`);
 * a production bundle never references the checker, so the check and its message are
 * tree-shaken out and the reconciler pays one `?.` per reconcile.
 */
let checkKeys: ((children: VNode[], scopes: (string | undefined)[] | null) => void) | null = null;

function warnDuplicateKeys(children: VNode[], scopes: (string | undefined)[] | null): void {
  if (children.length < 2 || !devHydrationActive()) return;
  const seen = new Set<unknown>();
  for (let i = 0; i < children.length; i++) {
    const { key } = children[i];
    if (key == null) continue;
    // Keys are unique per array: the same key in two sibling arrays is valid.
    const scoped = scopedKey(key, scopes?.[i]);
    if (!seen.has(scoped)) {
      seen.add(scoped);
      continue;
    }
    console.error(
      `denext: Encountered two children with the same key, \`${String(key)}\`. Keys ` +
        "should be unique so that components maintain their identity across updates; " +
        "non-unique keys may cause children to be duplicated, omitted or remounted.",
    );
  }
}

/**
 * Install (`true`) or remove (`false`) the dev-only duplicate-key warning. Called from the
 * dev path only (`installDevtools`), so production bundles never contain the check.
 */
export function installDuplicateKeyWarning(on = true): void {
  checkKeys = on ? warnDuplicateKeys : null;
}

/** What every child fiber inherits from its parent during reconcile. */
interface ChildLinks {
  host: Fiber | null;
  boundary: Fiber | null;
  inherited: Map<symbol, unknown>;
  idParentScope: Fiber["idParentScope"];
}

/** Link `fiber` in after `prev` (as the first child when `prev` is null), in key scope `scope`; returns it. */
function linkChildFiber(
  fiber: Fiber,
  returnFiber: Fiber,
  links: ChildLinks,
  prev: Fiber | null,
  scope: string | undefined,
): Fiber {
  fiber.return = returnFiber;
  fiber.keyScope = scope;
  fiber.host = links.host;
  fiber.boundary = links.boundary;
  fiber.idParentScope = links.idParentScope;
  fiber.inherited = links.inherited;
  fiber.bits = (fiber.bits & ~INHERITED_BITS) | (returnFiber.bits & INHERITED_BITS);
  // SuspenseList membership propagates from a list's direct child (the <Suspense>
  // wrapper) to the suspense fiber it renders.
  const owner = returnFiber.ext;
  if (owner?.listOwnerState != null && fiber.tag === "suspense") {
    const x = fiberExt(fiber);
    x.listState = owner.listOwnerState;
    x.listIndex = owner.listIndex;
  }
  fiber.sibling = null;
  if (prev) prev.sibling = fiber;
  else returnFiber.child = fiber;
  return fiber;
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
 * is the first unused of its type). Both must sit in the same key scope.
 */
function sameSlot(old: Fiber, nv: VNode, scope: string | undefined): boolean {
  if (old.keyScope !== scope) return false;
  const ok = old.vnode.key;
  if (nv.key != null ? ok !== nv.key : ok != null) return false;
  return sameType(old.vnode, nv);
}

/**
 * Pass 2 (a prepend, insert, removal or move): match the remaining new vnodes against the
 * remaining old children by key / by type, mount the rest and queue the unused old ones for
 * deletion; flags `ChildrenChanged` when membership or order changed. `prev` is the last
 * child pass 1 linked.
 */
function reconcileRemaining(
  returnFiber: Fiber,
  links: ChildLinks,
  newVNodes: VNode[],
  scopes: (string | undefined)[] | null,
  start: number,
  oldFiber: Fiber | null,
  prev: Fiber | null,
): void {
  const index = indexOldChildren(oldFiber, start);
  const used = new Set<Fiber>();
  let changed = false;
  let lastMatchedOldIndex = start - 1;
  for (let j = start; j < newVNodes.length; j++) {
    const nv = newVNodes[j];
    const scope = scopes?.[j];
    const match = claimReusable(matchOldChild(nv, scope, index), used, nv);
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
    prev = linkChildFiber(fiber, returnFiber, links, prev, scope);
  }
  if (collectDeletions(returnFiber, index.oldChildren, used) || changed) {
    returnFiber.flags |= ChildrenChanged;
  }
}

export function reconcileChildren(
  returnFiber: Fiber,
  childrenRaw: VNodeChildren,
  childHost: Fiber | null,
  childBoundary: Fiber | null,
  childInherited: Map<symbol, unknown>,
): void {
  const { nodes: newVNodes, scopes } = normalizeChildrenScoped(childrenRaw);
  checkKeys?.(newVNodes, scopes);
  const links: ChildLinks = {
    host: childHost,
    boundary: childBoundary,
    inherited: childInherited,
    // The id scope the children's components slot into: a component parent exposes
    // its own scope; host/fragment/suspense/… levels pass their enclosing one through.
    idParentScope: returnFiber.idScope ?? returnFiber.idParentScope,
  };
  let oldFiber = returnFiber.child;
  returnFiber.child = null; // re-linked below, child by child
  let prev: Fiber | null = null;
  let j = 0;
  // Pass 1, lockstep (React's first pass): reuse old children in place while each new vnode
  // matches the old child in its slot — no maps, no allocation. Covers a re-render of an
  // unchanged list and an append in O(n) with small constants.
  for (
    ;
    j < newVNodes.length && oldFiber !== null && sameSlot(oldFiber, newVNodes[j], scopes?.[j]);
    j++
  ) {
    const next: Fiber | null = oldFiber.sibling;
    const wip = createWorkInProgress(oldFiber, newVNodes[j]);
    prev = linkChildFiber(wip, returnFiber, links, prev, scopes?.[j]);
    oldFiber = next;
  }
  if (j < newVNodes.length || oldFiber !== null) {
    reconcileRemaining(returnFiber, links, newVNodes, scopes, j, oldFiber, prev);
  }
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
