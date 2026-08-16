// SuspenseList reveal ordering: forwards/backwards/together coordinate when sibling
// <Suspense> boundaries reveal, regardless of the order their data resolves.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { Suspense, SuspenseList, use } from "../mod.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function Item({ p, label }: { p: Promise<string>; label: string }): VNode {
  use(p);
  return h("span", null, label);
}

function boundary(p: Promise<string>, label: string): VNode {
  return h(
    Suspense,
    { fallback: h("i", null, `f${label}`) },
    h(Item, { p, label }),
  );
}

Deno.test("SuspenseList revealOrder=forwards reveals in order despite resolve order", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  const a = deferred<string>();
  const b = deferred<string>();
  const c = deferred<string>();

  createRoot(container as Any).render(
    h(
      SuspenseList,
      { revealOrder: "forwards" },
      boundary(a.promise, "1"),
      boundary(b.promise, "2"),
      boundary(c.promise, "3"),
    ),
  );
  flushSync();
  assertEquals(container.innerHTML, "<i>f1</i><i>f2</i><i>f3</i>", "all fallbacks initially");

  // Resolve the LAST one first — it must NOT reveal before its predecessors.
  c.resolve("c");
  await settle();
  flushSync();
  assertEquals(container.innerHTML, "<i>f1</i><i>f2</i><i>f3</i>", "3rd stays hidden behind 1 & 2");

  // Resolve the first — it reveals; the third still waits on the second.
  a.resolve("a");
  await settle();
  flushSync();
  assertEquals(container.innerHTML, "<span>1</span><i>f2</i><i>f3</i>", "only 1 revealed");

  // Resolve the middle — now 2 and the already-ready 3 reveal in order.
  b.resolve("b");
  await settle();
  flushSync();
  assertEquals(
    container.innerHTML,
    "<span>1</span><span>2</span><span>3</span>",
    "all revealed in order",
  );
});

Deno.test("SuspenseList revealOrder=together holds all until the last resolves", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  const a = deferred<string>();
  const b = deferred<string>();

  createRoot(container as Any).render(
    h(
      SuspenseList,
      { revealOrder: "together" },
      boundary(a.promise, "1"),
      boundary(b.promise, "2"),
    ),
  );
  flushSync();
  assertEquals(container.innerHTML, "<i>f1</i><i>f2</i>");

  a.resolve("a");
  await settle();
  flushSync();
  assertEquals(
    container.innerHTML,
    "<i>f1</i><i>f2</i>",
    "first resolved but held until all ready",
  );

  b.resolve("b");
  await settle();
  flushSync();
  assertEquals(container.innerHTML, "<span>1</span><span>2</span>", "revealed together");
});

Deno.test("SuspenseList revealOrder=backwards reveals from the end", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  const a = deferred<string>();
  const b = deferred<string>();

  createRoot(container as Any).render(
    h(
      SuspenseList,
      { revealOrder: "backwards" },
      boundary(a.promise, "1"),
      boundary(b.promise, "2"),
    ),
  );
  flushSync();

  // Resolve the first — it must wait for the last.
  a.resolve("a");
  await settle();
  flushSync();
  assertEquals(container.innerHTML, "<i>f1</i><i>f2</i>", "1 held behind 2 (backwards)");

  b.resolve("b");
  await settle();
  flushSync();
  assertEquals(
    container.innerHTML,
    "<span>1</span><span>2</span>",
    "revealed backwards → both show",
  );
});

Deno.test("SuspenseList tail=collapsed shows a single leading fallback", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  const a = deferred<string>();
  const b = deferred<string>();
  const c = deferred<string>();

  createRoot(container as Any).render(
    h(
      SuspenseList,
      { revealOrder: "forwards", tail: "collapsed" },
      boundary(a.promise, "1"),
      boundary(b.promise, "2"),
      boundary(c.promise, "3"),
    ),
  );
  flushSync();
  // Only the leading (1st) fallback shows; the rest of the tail is hidden.
  assertEquals(container.innerHTML, "<i>f1</i>", "collapsed: one leading fallback only");

  a.resolve("a");
  await settle();
  flushSync();
  assertEquals(container.innerHTML, "<span>1</span><i>f2</i>", "reveal 1, next fallback shows");
});

Deno.test("SuspenseList tail=hidden shows NO fallbacks (React parity)", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  const a = deferred<string>();
  const b = deferred<string>();
  const c = deferred<string>();

  createRoot(container as Any).render(
    h(
      SuspenseList,
      { revealOrder: "forwards", tail: "hidden" },
      boundary(a.promise, "1"),
      boundary(b.promise, "2"),
      boundary(c.promise, "3"),
    ),
  );
  flushSync();
  // hidden: not even the leading boundary shows a fallback.
  assertEquals(container.innerHTML, "", "hidden: zero fallbacks while pending");

  // Items still load and reveal in order — the tail just never shows fallbacks.
  a.resolve("a");
  await settle();
  flushSync();
  assertEquals(container.innerHTML, "<span>1</span>", "reveal 1, still no fallback for the tail");

  b.resolve("b");
  c.resolve("c");
  await settle();
  flushSync();
  assertEquals(
    container.innerHTML,
    "<span>1</span><span>2</span><span>3</span>",
    "all reveal in order, never a fallback",
  );
});
