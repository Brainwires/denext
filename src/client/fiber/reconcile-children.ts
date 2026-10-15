// Child reconciliation: keyed and unkeyed diffing of a fiber's new vnodes against
// its committed children, and cloning a bailed fiber's children.

import { createFiberFromVNode, devHydrationActive } from "./fiber-utils.ts";
import type { VNode, VNodeChildren } from "../../jsx/types.ts";
import {
  childScopes,
  childSlots,
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
  /** Unkeyed old children, by their slot ({@linkcode slotOf}). */
  slots: Map<string | number | undefined, number>;
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
  const slots = new Map<string | number | undefined, number>();
  const unkeyed = new Map<string | undefined, Map<unknown, number[]>>();
  for (let i = 0; i < old.length; i++) {
    const c = old[i];
    if (c.vnode.key != null) {
      keyed.set(scopedKey(c.vnode.key, c.keyScope as string | undefined), i);
    } else {
      slots.set(c.keyScope, i);
      const scope = scopeOfSlot(c.keyScope);
      let byType = unkeyed.get(scope);
      if (byType === undefined) unkeyed.set(scope, byType = new Map());
      let q = byType.get(c.vnode.type);
      if (q === undefined) byType.set(c.vnode.type, q = []);
      q.push(i);
    }
  }
  return { keyed, slots, unkeyed };
}

/**
 * An unkeyed child's slot — React's implicit key: its position in its own array (holes
 * counted), prefixed by that array's key scope when it is a nested one. Stored as the fiber's
 * `keyScope` (an unkeyed child needs no key scope of its own).
 */
function slotOf(scope: string | undefined, position: number): string | number {
  return scope === undefined ? position : `${scope}/${position}`;
}

/** The key scope a slot ({@linkcode slotOf}) belongs to. */
function scopeOfSlot(slot: string | number | undefined): string | undefined {
  return typeof slot === "string" ? slot.slice(0, slot.lastIndexOf("/")) : undefined;
}

/**
 * The old child a new vnode reuses outright (its position, or -1): by key, else the unkeyed old
 * child in the same slot when it is of the same type (React's implicit-index match).
 */
function exactOldChild(
  nv: VNode,
  scope: string | undefined,
  slot: string | number,
  index: OldChildIndex,
  old: readonly Fiber[],
): number {
  if (nv.key != null) return index.keyed.get(scopedKey(nv.key, scope)) ?? -1;
  const i = index.slots.get(slot);
  return i !== undefined && sameType(old[i].vnode, nv) ? i : -1;
}

/**
 * An unkeyed new vnode no old child in its slot fits: the first unused unkeyed old child of the
 * exact same type (in order), so inserting or removing a child of another type around them
 * doesn't remount the rest. Dev Fast Refresh only: an edited component's type identity changed
 * within its family, so it won't sit in the new type's bucket — scan the remaining unkeyed
 * queues for a family match (never runs in production).
 */
function looseOldChild(
  nv: VNode,
  scope: string | undefined,
  index: OldChildIndex,
  old: readonly Fiber[],
  used: Uint8Array,
): number {
  const byType = index.unkeyed.get(scope);
  if (byType === undefined) return -1;
  const q = byType.get(nv.type);
  while (q !== undefined && q.length > 0) {
    const i = q.shift()!;
    if (used[i] === 0) return i;
  }
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
  scope: string | number | undefined,
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
function sameSlot(old: Fiber, nv: VNode, scope: string | number | undefined): boolean {
  if (old.keyScope !== scope) return false;
  const ok = old.vnode.key;
  if (nv.key != null ? ok !== nv.key : ok != null) return false;
  return sameType(old.vnode, nv);
}

/** What a child's `keyScope` holds: its key scope when keyed, else its slot. */
function scopeFor(
  nv: VNode,
  scope: string | undefined,
  position: number,
): string | number | undefined {
  return nv.key != null ? scope : slotOf(scope, position);
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
  slots: number[] | null,
  start: number,
  oldFiber: Fiber | null,
  prev: Fiber | null,
): void {
  const old: Fiber[] = [];
  for (let c = oldFiber; c !== null; c = c.sibling) old.push(c);
  const used = new Uint8Array(old.length);
  const index = indexOldChildren(old);
  const matched = matchAll(newVNodes, scopes, slots, start, index, old, used);
  let changed = false;
  let lastMatchedOldIndex = -1;
  for (let j = start; j < newVNodes.length; j++) {
    const nv = newVNodes[j];
    const i = matched[j - start];
    // A reuse that lands before the previous one moved (an out-of-order match); a mount changed.
    changed ||= i < 0 || i < lastMatchedOldIndex;
    lastMatchedOldIndex = Math.max(lastMatchedOldIndex, i);
    const fiber = i >= 0 ? createWorkInProgress(old[i], nv) : placed(nv);
    const kept = scopeFor(nv, scopeAt(scopes, j), slotAt(slots, j));
    prev = linkChildFiber(fiber, returnFiber, host, boundary, inherited, prev, kept);
  }
  if (collectDeletions(returnFiber, old, used) || changed) {
    returnFiber.flags |= ChildrenChanged;
  }
}

/** Child `j`'s key scope (`undefined`: a direct child). */
function scopeAt(scopes: (string | undefined)[] | null, j: number): string | undefined {
  return scopes === null ? undefined : scopes[j];
}

/** Child `j`'s position in its own array ({@linkcode childSlots}). */
function slotAt(slots: number[] | null, j: number): number {
  return slots === null ? j : slots[j];
}

/** A fresh fiber for `nv`, flagged for placement. */
function placed(nv: VNode): Fiber {
  const fiber = createFiberFromVNode(nv);
  fiber.flags |= Placement;
  return fiber;
}

/**
 * The old child each new vnode from `start` reuses (-1: mount fresh). Exact matches first — by
 * key, or the same-type child in the same slot — so a child keeps its fiber even when a new
 * sibling of its type lands before it; then each unkeyed vnode left takes the first unused old
 * child of its type ({@linkcode looseOldChild}).
 */
function matchAll(
  newVNodes: readonly VNode[],
  scopes: (string | undefined)[] | null,
  slots: number[] | null,
  start: number,
  index: OldChildIndex,
  old: readonly Fiber[],
  used: Uint8Array,
): Int32Array {
  const matched = new Int32Array(newVNodes.length - start).fill(-1);
  for (let j = start; j < newVNodes.length; j++) {
    const scope = scopeAt(scopes, j);
    const slot = slotOf(scope, slotAt(slots, j));
    const i = exactOldChild(newVNodes[j], scope, slot, index, old);
    take(matched, j - start, i, used, i >= 0 && sameType(old[i].vnode, newVNodes[j]));
  }
  for (let j = start; j < newVNodes.length; j++) {
    const nv = newVNodes[j];
    if (matched[j - start] >= 0 || nv.key != null) continue;
    const i = looseOldChild(nv, scopeAt(scopes, j), index, old, used);
    take(matched, j - start, i, used, i >= 0 && sameType(old[i].vnode, nv));
  }
  return matched;
}

/** Claim old child `i` for new child `k` when it `fits` (same type) and is still unused. */
function take(matched: Int32Array, k: number, i: number, used: Uint8Array, fits: boolean): void {
  if (!fits || used[i] !== 0) return;
  used[i] = 1;
  matched[k] = i;
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
  const slots = childSlots;
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
    j < newVNodes.length && oldFiber !== null &&
    sameSlot(oldFiber, newVNodes[j], scopeFor(newVNodes[j], scopeAt(scopes, j), slotAt(slots, j)));
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
      oldFiber.keyScope,
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
      slots,
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
