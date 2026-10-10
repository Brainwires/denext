// Child reconciliation: keyed and unkeyed diffing of a fiber's new vnodes against
// its committed children, and cloning a bailed fiber's children.

import { createFiberFromVNode, devHydrationActive } from "./fiber-utils.ts";
import type { VNode, VNodeChildren } from "../../jsx/types.ts";
import {
  childScopes,
  familyMatchActive,
  normalizeChildrenScoped,
  sameType,
} from "../vnode-utils.ts";
import {
  ChildDeletion,
  ChildrenChanged,
  type ContextMap,
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
  unkeyedByType: Map<unknown, number[]>,
  old: readonly Fiber[],
  nv: VNode,
): number {
  for (const q of unkeyedByType.values()) {
    if (q.length > 0 && sameType(old[q[0]].vnode, nv)) return q.shift()!;
  }
  return -1;
}

/**
 * The remaining committed children of a fiber, indexed for matching against the new vnodes
 * (by position in the remaining list).
 */
interface OldChildIndex {
  /** Keyed old children, by key (a direct child) or by {@linkcode scopedKey}. */
  keyed: Map<unknown, number>;
  /**
   * Unkeyed old children bucketed by element type, each queue kept in document order — one
   * bucket map per key scope (`undefined` is the direct children).
   */
  unkeyed: Map<string | undefined, Map<unknown, number[]>>;
}

/**
 * The keyed-map entry for `key` in `scope`: the key itself for a direct child (no allocation
 * on the common path), else a string no direct key can collide with in practice.
 */
function scopedKey(key: unknown, scope: string | undefined): unknown {
  return scope === undefined ? key : `\u0000${scope}\u0000${String(key)}`;
}

/**
 * Index the remaining committed children. Matching an unkeyed new child pops the
 * FIRST unused old child of the SAME type, so inserting or removing a child of one type
 * never strands the reusable same-type siblings that follow it. (A single forward
 * cursor instead CONSUMED candidates on a type mismatch: one front-insert would burn the
 * cursor past every real candidate and remount all trailing siblings — a whole-subtree
 * churn under any list that grows a differently-typed child at the front.)
 */
function indexOldChildren(old: readonly Fiber[]): OldChildIndex {
  const keyed = new Map<unknown, number>();
  const unkeyed = new Map<string | undefined, Map<unknown, number[]>>();
  for (let i = 0; i < old.length; i++) {
    const c = old[i];
    if (c.vnode.key != null) {
      keyed.set(scopedKey(c.vnode.key, c.keyScope), i);
    } else {
      let byType = unkeyed.get(c.keyScope);
      if (byType === undefined) unkeyed.set(c.keyScope, byType = new Map());
      let q = byType.get(c.vnode.type);
      if (q === undefined) byType.set(c.vnode.type, q = []);
      q.push(i);
    }
  }
  return { keyed, unkeyed };
}

/**
 * The old child a new vnode may reuse (its position, or -1): by key, else the first unused
 * unkeyed old child of the exact same type (in order). Dev Fast Refresh only: an edited
 * component's type identity changed within its family, so it won't sit in the new type's
 * bucket — scan the remaining unkeyed queues for a family match (never runs in production).
 */
function matchOldChild(
  nv: VNode,
  scope: string | undefined,
  index: OldChildIndex,
  old: readonly Fiber[],
): number {
  if (nv.key != null) return index.keyed.get(scopedKey(nv.key, scope)) ?? -1;
  const byType = index.unkeyed.get(scope);
  if (byType === undefined) return -1;
  const q = byType.get(nv.type);
  if (q !== undefined && q.length > 0) return q.shift()!;
  return familyMatchActive() ? takeUnkeyedFamilyMatch(byType, old, nv) : -1;
}

/**
 * Dev only: React's duplicate-key warning. Two siblings with one key cannot both keep their
 * identity — the second never matches the first's old fiber and remounts on every render.
 * Installed by the dev entries ({@linkcode installDuplicateKeyWarning}, via `installDevtools`);
 * a production bundle never references the checker, so the check and its message are
 * tree-shaken out and the reconciler pays one `?.` per reconcile.
 */
let checkKeys:
  | ((children: readonly VNode[], scopes: (string | undefined)[] | null) => void)
  | null = null;

function warnDuplicateKeys(
  children: readonly VNode[],
  scopes: (string | undefined)[] | null,
): void {
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

/**
 * Link `fiber` in after `prev` (as the first child when `prev` is null), in key scope `scope`,
 * with what every child inherits from its parent during reconcile; returns it.
 */
function linkChildFiber(
  fiber: Fiber,
  returnFiber: Fiber,
  host: Fiber | null,
  boundary: Fiber | null,
  inherited: ContextMap,
  prev: Fiber | null,
  scope: string | undefined,
): Fiber {
  fiber.return = returnFiber;
  fiber.keyScope = scope;
  fiber.host = host;
  fiber.boundary = boundary;
  // The id scope the children's components slot into: a component parent exposes its own
  // scope; host/fragment/suspense/… levels pass their enclosing one through.
  fiber.idParentScope = returnFiber.idScope ?? returnFiber.idParentScope;
  fiber.inherited = inherited;
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
function collectDeletions(returnFiber: Fiber, old: readonly Fiber[], used: Uint8Array): boolean {
  let changed = false;
  for (let i = 0; i < old.length; i++) {
    if (used[i] === 0) {
      (returnFiber.deletions ??= []).push(old[i]);
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
  host: Fiber | null,
  boundary: Fiber | null,
  inherited: ContextMap,
  newVNodes: readonly VNode[],
  scopes: (string | undefined)[] | null,
  start: number,
  oldFiber: Fiber | null,
  prev: Fiber | null,
): void {
  const old: Fiber[] = [];
  for (let c = oldFiber; c !== null; c = c.sibling) old.push(c);
  const used = new Uint8Array(old.length);
  const index = indexOldChildren(old);
  let changed = false;
  let lastMatchedOldIndex = -1;
  for (let j = start; j < newVNodes.length; j++) {
    const nv = newVNodes[j];
    const scope = scopes?.[j];
    const i = matchOldChild(nv, scope, index, old);
    let fiber: Fiber;
    // Reuse an unused old child of the same type.
    if (i >= 0 && used[i] === 0 && sameType(old[i].vnode, nv)) {
      used[i] = 1;
      fiber = createWorkInProgress(old[i], nv);
      // A reuse that lands before the previous one moved (an out-of-order match).
      changed ||= i < lastMatchedOldIndex;
      lastMatchedOldIndex = Math.max(lastMatchedOldIndex, i);
    } else {
      fiber = createFiberFromVNode(nv);
      fiber.flags |= Placement;
      changed = true;
    }
    prev = linkChildFiber(fiber, returnFiber, host, boundary, inherited, prev, scope);
  }
  if (collectDeletions(returnFiber, old, used) || changed) {
    returnFiber.flags |= ChildrenChanged;
  }
}

export function reconcileChildren(
  returnFiber: Fiber,
  childrenRaw: VNodeChildren,
  childHost: Fiber | null,
  childBoundary: Fiber | null,
  childInherited: ContextMap,
): void {
  const newVNodes = normalizeChildrenScoped(childrenRaw);
  const scopes = childScopes;
  checkKeys?.(newVNodes, scopes);
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
    prev = linkChildFiber(
      wip,
      returnFiber,
      childHost,
      childBoundary,
      childInherited,
      prev,
      scopes?.[j],
    );
    oldFiber = next;
  }
  if (j < newVNodes.length || oldFiber !== null) {
    reconcileRemaining(
      returnFiber,
      childHost,
      childBoundary,
      childInherited,
      newVNodes,
      scopes,
      j,
      oldFiber,
      prev,
    );
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
