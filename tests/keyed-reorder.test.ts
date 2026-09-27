// Keyed child reconciliation: every reorder pattern lands the DOM in the expected order,
// keeps each surviving child's element, state and ref (no remount), and touches only the
// nodes that changed — a guard on DOM OPERATION COUNTS (not wall-clock, which a loaded CI
// box makes meaningless). syncChildren used to index the live `childNodes` per position,
// which a real browser makes quadratic once an insertBefore invalidates its NodeList cache
// (a 100k-row swap took seconds); it now reads the children once and moves only the nodes
// outside the longest run already in order.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, setDocument } from "../src/client/reconciler.ts";
import { installDuplicateKeyWarning } from "../src/client/fiber/reconcile-children.ts";
import { useState } from "../src/runtime/hooks.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeElement, type FakeNode, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Per-key mount log: a remount of a surviving key shows up as a second entry. */
let mounts: string[] = [];
let refCalls: string[] = [];

function Row(props: { id: string }): VNode {
  // State captured at mount: a row that kept its fiber still reports its original id.
  const [mountedAs] = useState(() => {
    mounts.push(props.id);
    return props.id;
  });
  return h("span", null, `${props.id}=${mountedAs}`);
}

// Stable per-key ref callbacks: React never re-fires a keyed child's unchanged ref on a move.
const refFor = new Map<string, (el: unknown) => void>();
function stableRef(id: string): (el: unknown) => void {
  let r = refFor.get(id);
  if (!r) {
    r = (el) => refCalls.push(`${id}:${el === null ? "detach" : "attach"}`);
    refFor.set(id, r);
  }
  return r;
}

function List(props: { ids: string[] }): VNode {
  return h(
    "ul",
    null,
    props.ids.map((id) => h("li", { key: id, ref: stableRef(id) }, h(Row, { id }))),
  );
}

interface Ops {
  inserts: number;
  removes: number;
}

/** Count the DOM operations `list` receives (appendChild/insertBefore = inserts). */
function instrument(list: FakeElement): Ops {
  const ops: Ops = { inserts: 0, removes: 0 };
  const el = list as Any;
  const append = el.appendChild.bind(el);
  const insert = el.insertBefore.bind(el);
  const remove = el.removeChild.bind(el);
  // The fake DOM detaches a moved node through removeChild; that is part of the move.
  let moving = false;
  const move = <T>(run: () => T): T => {
    ops.inserts++;
    moving = true;
    try {
      return run();
    } finally {
      moving = false;
    }
  };
  el.appendChild = (n: FakeNode) => move(() => append(n));
  el.insertBefore = (n: FakeNode, r: FakeNode | null) => move(() => insert(n, r));
  el.removeChild = (n: FakeNode) => {
    if (!moving) ops.removes++;
    return remove(n);
  };
  return ops;
}

const ids = (n: number, prefix = "k") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

function mountList(initial: string[]) {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  mounts = [];
  refCalls = [];
  refFor.clear();
  const root = createRoot(container as Any);
  root.render(h(List, { ids: initial }));
  const ul = container.childNodes[0] as FakeElement;
  const byKey = new Map<string, FakeNode>(initial.map((id, i) => [id, ul.childNodes[i]]));
  return { root, ul, byKey };
}

/**
 * Render `before` then `after`; assert DOM order, element identity, preserved state, no
 * remount or ref churn for surviving keys; return the DOM operations the update cost.
 */
function reorder(before: string[], after: string[]): Ops {
  const { root, ul, byKey } = mountList(before);
  const ops = instrument(ul);
  mounts = [];
  refCalls = [];
  root.render(h(List, { ids: after }));
  assertEquals(
    ul.childNodes.map((li) => (li as Any).textContent),
    after.map((id) => `${id}=${id}`),
    "DOM order + each row's mount-time state",
  );
  const kept = after.filter((id) => byKey.has(id));
  for (const id of kept) {
    assertStrictEquals(ul.childNodes[after.indexOf(id)], byKey.get(id), `element of ${id} kept`);
  }
  const fresh = after.filter((id) => !byKey.has(id));
  assertEquals(mounts.sort(), fresh.sort(), "only new keys mount");
  const gone = before.filter((id) => !after.includes(id));
  assertEquals(
    refCalls.sort(),
    [...fresh.map((id) => `${id}:attach`), ...gone.map((id) => `${id}:detach`)].sort(),
    "refs attach for new keys, detach for removed ones, and never fire for moved ones",
  );
  return ops;
}

/** A seeded shuffle (mulberry32), so the random pattern is reproducible. */
function shuffled<T>(xs: T[], seed: number): T[] {
  const out = xs.slice();
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const N = 1000;
const base = ids(N);
const fifty = ids(50, "n");

Deno.test("keyed: append inserts only the new rows", () => {
  const ops = reorder(base, [...base, ...fifty]);
  assertEquals(ops, { inserts: 50, removes: 0 });
});

Deno.test("keyed: prepend inserts only the new rows", () => {
  const ops = reorder(base, [...fifty, ...base]);
  assertEquals(ops, { inserts: 50, removes: 0 });
});

Deno.test("keyed: insert in the middle inserts only the new rows", () => {
  const ops = reorder(base, [...base.slice(0, 500), ...fifty, ...base.slice(500)]);
  assertEquals(ops, { inserts: 50, removes: 0 });
});

Deno.test("keyed: removal from the front, middle and end moves nothing", () => {
  for (
    const after of [base.slice(50), [...base.slice(0, 400), ...base.slice(450)], base.slice(0, -50)]
  ) {
    const ops = reorder(base, after);
    assertEquals(ops.inserts, 0);
    assertEquals(ops.removes, 50, "each removed row is removed once (by its deletion)");
  }
});

Deno.test("keyed: moving one row costs one move", () => {
  assertEquals(reorder(base, [...base.slice(1), base[0]]), { inserts: 1, removes: 0 });
  assertEquals(reorder(base, [base[N - 1], ...base.slice(0, -1)]), { inserts: 1, removes: 0 });
  const mid = [...base];
  const [x] = mid.splice(300, 1);
  mid.splice(700, 0, x);
  assertEquals(reorder(base, mid), { inserts: 1, removes: 0 });
});

Deno.test("keyed: swapping two distant rows costs two moves", () => {
  const swapped = [...base];
  [swapped[1], swapped[N - 2]] = [swapped[N - 2], swapped[1]];
  assertEquals(reorder(base, swapped), { inserts: 2, removes: 0 });
});

Deno.test("keyed: reverse moves every row but one", () => {
  assertEquals(reorder(base, [...base].reverse()), { inserts: N - 1, removes: 0 });
});

Deno.test("keyed: a shuffle moves at most every row and keeps identity", () => {
  const ops = reorder(base, shuffled(base, 7));
  assert(ops.inserts < N, `${ops.inserts} moves`);
  assertEquals(ops.removes, 0);
});

Deno.test("keyed: mixed insert + remove + move in one update", () => {
  const after = shuffled(
    [...base.slice(100, 600), ...fifty, ...base.slice(650, 900)],
    11,
  );
  const ops = reorder(base, after);
  assertEquals(ops.removes, N - 750, "each dropped row is removed exactly once");
  assert(ops.inserts <= after.length, `${ops.inserts} inserts`);
});

Deno.test("keyed: replacing every row removes and inserts each once", () => {
  assertEquals(reorder(ids(100), ids(100, "z")), { inserts: 100, removes: 100 });
});

Deno.test("keyed: an unchanged re-render touches no DOM", () => {
  assertEquals(reorder(base, [...base]), { inserts: 0, removes: 0 });
});

Deno.test("keyed: a duplicate key warns in dev and still renders every child", () => {
  const g = globalThis as { __denextDev?: boolean };
  const errors: string[] = [];
  const orig = console.error;
  g.__denextDev = true;
  installDuplicateKeyWarning(); // the dev entries install it (via installDevtools)
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  try {
    const { ul } = mountList(["a", "b", "a"]);
    assertEquals(ul.childNodes.length, 3);
    assert(errors.some((e) => e.includes("two children with the same key") && e.includes("`a`")));
  } finally {
    console.error = orig;
    installDuplicateKeyWarning(false);
    delete g.__denextDev;
  }
});

Deno.test("keyed: no duplicate-key warning in production", () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  try {
    mountList(["a", "b", "a"]);
  } finally {
    console.error = orig;
  }
  assertEquals(errors, []);
});
