// Structural diff of two Flight trees into a short op list, and its copy-on-write application.
//
// A live view (`defineLiveView`) re-renders on the server after every update; instead of the
// whole tree, the hub sends the ops that turn the client's copy (revision `base`) into the new
// one. The client applies them without mutating the old tree (the parsed VNodes of the previous
// render still reference its props objects) and hands the result to the reconciler, which then
// touches only the DOM that changed.
//
// A path walks from the view's child list: each index steps into an array node, or into the
// child list (`c`) of a host / client / boundary node. Ops:
//   ["r", path, node]                     replace the node at `path`
//   ["p", path, set, del]                 set / delete props of the host or client node at `path`
//   ["s", path, start, deleteCount, items] splice the child list of the node at `path` (`[]`: root)
//   ["m", path, from, items]              reorder that child list: entry `i` of the new list is old
//                                         child `from[i]`, or (`-1`) the next of `items`
// A node's shape is its kind, tag / reference id and `key` (`k`). Lists are matched over a common
// prefix and suffix of same-shaped nodes, with one splice for the rest. A list holding keyed
// nodes whose surviving children changed order is matched by shape instead (one `m`), so a
// reordered keyed list moves its elements rather than rewriting them in place.

import type { FlightNode } from "../jsx/render-to-flight.ts";
import type { LiveViewOp } from "./live-protocol.ts";

type Obj = Record<string, unknown>;

/** A node with a child list (`h` host, `c` client reference, `b` boundary). */
function hasChildren(n: FlightNode): n is FlightNode & { c: FlightNode[] } {
  return n !== null && typeof n === "object" && !Array.isArray(n) &&
    Array.isArray((n as { c?: unknown }).c);
}

/** Deep structural equality of two JSON values. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && arraysEqual(a, b);
  }
  return objectsEqual(a as Obj, b as Obj);
}

function arraysEqual(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
}

function objectsEqual(a: Obj, b: Obj): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
}

/**
 * What a node must keep to be patched in place rather than swapped: its kind and its tag /
 * reference id (`""` for a text or empty leaf, `"[]"` for a nested list, `null` for anything a
 * patch never reuses).
 */
function shapeOf(n: FlightNode): string | null {
  if (n === null || typeof n !== "object") return "";
  if (Array.isArray(n)) return "[]";
  const o = n as unknown as Obj;
  const id = o.$ === "h" ? o.t : o.$ === "c" ? o.i : o.$ === "b" ? o.f : undefined;
  if (typeof id !== "string") return null;
  return typeof o.k === "string" ? `${o.$}:${id}\0${o.k}` : `${o.$}:${id}`;
}

/** Whether any node of `list` carries a `key`. */
function hasKey(list: FlightNode[]): boolean {
  return list.some((n) => typeof (n as { k?: unknown } | null)?.k === "string");
}

/**
 * For each node of `b`, the index of the unused same-shaped node of `a` it continues (first come,
 * first served — keys are unique in a well-formed list), or `-1` for a new node.
 */
function matchByShape(a: FlightNode[], b: FlightNode[]): number[] {
  const pool = new Map<string, number[]>();
  a.forEach((n, i) => {
    const shape = shapeOf(n);
    if (shape === null) return;
    const queue = pool.get(shape);
    if (queue) queue.push(i);
    else pool.set(shape, [i]);
  });
  return b.map((n) => {
    const shape = shapeOf(n);
    const queue = shape === null ? undefined : pool.get(shape);
    return queue?.length ? queue.shift()! : -1;
  });
}

/** Whether the kept children of a match changed their relative order. */
function reordered(from: number[]): boolean {
  let last = -1;
  for (const i of from) {
    if (i < 0) continue;
    if (i < last) return true;
    last = i;
  }
  return false;
}

/** Whether `b` can be reached from `a` by patching in place (same kind, same tag / id). */
function sameShape(a: FlightNode, b: FlightNode): boolean {
  const shape = shapeOf(a);
  return shape !== null && shape === shapeOf(b);
}

/**
 * The ops turning `prev` (a view's child list) into `next`.
 *
 * @param prev The tree the client holds.
 * @param next The new render.
 * @returns The ops, in application order (empty when nothing changed).
 */
export function diffFlight(prev: FlightNode[], next: FlightNode[]): LiveViewOp[] {
  const ops: LiveViewOp[] = [];
  diffList(prev, next, [], ops);
  return ops;
}

function diffNode(a: FlightNode, b: FlightNode, path: number[], ops: LiveViewOp[]): void {
  if (a === b) return;
  if (!sameShape(a, b) || a === null || typeof a !== "object") {
    return void ops.push(["r", path, b]);
  }
  if (Array.isArray(a)) return diffList(a, b as FlightNode[], path, ops);
  const x = a as unknown as Obj;
  if (x.p !== undefined) diffProps(x.p as Obj, (b as unknown as Obj).p as Obj, path, ops);
  diffList((a as { c: FlightNode[] }).c, (b as { c: FlightNode[] }).c, path, ops);
}

function diffProps(a: Obj, b: Obj, path: number[], ops: LiveViewOp[]): void {
  const set: Obj = {};
  const del: string[] = [];
  let changed = false;
  for (const k of Object.keys(b)) {
    if (!Object.hasOwn(a, k) || !jsonEqual(a[k], b[k])) {
      set[k] = b[k];
      changed = true;
    }
  }
  for (const k of Object.keys(a)) {
    if (!Object.hasOwn(b, k)) {
      del.push(k);
      changed = true;
    }
  }
  if (changed) ops.push(["p", path, set, del]);
}

function diffList(a: FlightNode[], b: FlightNode[], path: number[], ops: LiveViewOp[]): void {
  if (hasKey(a) || hasKey(b)) {
    const from = matchByShape(a, b);
    if (reordered(from)) return diffMoved(a, b, from, path, ops);
  }
  diffAligned(a, b, path, ops);
}

/** Same-shaped common prefix and suffix diffed in place, one splice for the rest. */
function diffAligned(a: FlightNode[], b: FlightNode[], path: number[], ops: LiveViewOp[]): void {
  const min = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < min && sameShape(a[pre], b[pre])) pre++;
  let suf = 0;
  while (suf < min - pre && sameShape(a[a.length - 1 - suf], b[b.length - 1 - suf])) suf++;
  // Prefix pairs keep their index through the splice; suffix pairs are diffed after it, at
  // their index in `b`.
  for (let i = 0; i < pre; i++) diffNode(a[i], b[i], [...path, i], ops);
  const del = a.length - pre - suf;
  const ins = b.slice(pre, b.length - suf);
  if (del > 0 || ins.length > 0) ops.push(["s", path, pre, del, ins]);
  for (let j = 0; j < suf; j++) {
    const ai = a.length - suf + j;
    const bi = b.length - suf + j;
    diffNode(a[ai], b[bi], [...path, bi], ops);
  }
}

/** One `m` op for a reordered list, then each kept child diffed at its new index. */
function diffMoved(
  a: FlightNode[],
  b: FlightNode[],
  from: number[],
  path: number[],
  ops: LiveViewOp[],
): void {
  ops.push(["m", path, from, b.filter((_, i) => from[i] < 0)]);
  from.forEach((ai, bi) => {
    if (ai >= 0) diffNode(a[ai], b[bi], [...path, bi], ops);
  });
}

/** Thrown by {@link applyFlightOps} when an op does not fit the tree (the client resyncs). */
export class FlightPatchError extends Error {
  /** @param message What did not fit. */
  constructor(message: string) {
    super(message);
    this.name = "FlightPatchError";
  }
}

/** A shallow copy of a node that owns a child list or is a list itself. */
function cloneNode(n: FlightNode): FlightNode {
  if (Array.isArray(n)) return [...n];
  if (n !== null && typeof n === "object") {
    const copy = { ...(n as unknown as Obj) };
    if (Array.isArray(copy.c)) copy.c = [...(copy.c as FlightNode[])];
    return copy as unknown as FlightNode;
  }
  return n;
}

/** The child list of a (cloned) container node. */
function listOf(n: FlightNode): FlightNode[] {
  if (Array.isArray(n)) return n;
  if (hasChildren(n)) return n.c;
  throw new FlightPatchError("path steps into a leaf");
}

/**
 * Apply ops to a view's child list without mutating it: every node on an op's path is copied,
 * everything else is shared.
 *
 * @param root The tree at the ops' base revision.
 * @param ops The ops from {@link diffFlight}.
 * @returns The new tree.
 * @throws {FlightPatchError} When an op does not fit (a stale base): resync.
 */
export function applyFlightOps(root: FlightNode[], ops: readonly LiveViewOp[]): FlightNode[] {
  let out = [...root];
  for (const op of ops) out = applyOne(out, op);
  return out;
}

/** A valid index into `list` (`end`: one past the last is allowed, for a splice). */
function checkIndex(i: unknown, list: FlightNode[], end = false): number {
  const max = end ? list.length : list.length - 1;
  if (!Number.isInteger(i) || (i as number) < 0 || (i as number) > max) {
    throw new FlightPatchError("bad index");
  }
  return i as number;
}

/** Copy the spine of `root` along the first `depth` steps of `path`; returns the copy's node. */
function copySpine(copy: FlightNode[], path: number[], depth: number): FlightNode {
  let node: FlightNode = copy;
  for (let d = 0; d < depth; d++) {
    const list = listOf(node);
    const i = checkIndex(path[d], list);
    list[i] = cloneNode(list[i]);
    node = list[i];
  }
  return node;
}

/** Each op applied to its (already copied) target. */
const APPLY: Record<string, (node: FlightNode, op: LiveViewOp) => void> = {
  r(parent, op) {
    const list = listOf(parent);
    const path = op[1];
    list[checkIndex(path[path.length - 1], list)] = (op as ["r", number[], FlightNode])[2];
  },
  p(node, op) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      throw new FlightPatchError("props on a non-element");
    }
    const [, , set, del] = op as ["p", number[], Obj, string[]];
    const el = node as unknown as Obj;
    const props: Obj = { ...(el.p as Obj | undefined), ...set };
    for (const k of del) delete props[k];
    el.p = props;
  },
  s(node, op) {
    const list = listOf(node);
    const [, , start, count, items] = op as ["s", number[], number, number, FlightNode[]];
    if (!(count >= 0)) throw new FlightPatchError("bad splice");
    list.splice(checkIndex(start, list, true), count, ...items);
  },
  m(node, op) {
    const list = listOf(node);
    const [, , from, items] = op as ["m", number[], number[], FlightNode[]];
    if (!Array.isArray(from) || !Array.isArray(items)) throw new FlightPatchError("bad move");
    const old = [...list];
    let n = 0;
    const next = from.map((i) => i === -1 ? items[n++] : old[checkIndex(i, old)]);
    if (n !== items.length) throw new FlightPatchError("bad move");
    list.splice(0, list.length, ...next);
  },
};

function applyOne(root: FlightNode[], op: LiveViewOp): FlightNode[] {
  const apply = Object.hasOwn(APPLY, op?.[0]) ? APPLY[op[0]] : undefined;
  const path = op?.[1];
  if (!apply || !Array.isArray(path)) throw new FlightPatchError("unknown op");
  // `r` targets a child of the node at the path's parent; the root list itself is not a node.
  const depth = op[0] === "r" ? path.length - 1 : path.length;
  if (depth < 0) throw new FlightPatchError("cannot replace the root");
  const copy = [...root];
  apply(copySpine(copy, path, depth), op);
  return copy;
}
