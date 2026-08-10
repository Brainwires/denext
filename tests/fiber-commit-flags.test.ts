// Regression: committed effect flags must be cleared after each commit. A fully
// bailed subtree on a later render keeps its *current* fibers (not re-cloned), so
// stale flags/deletions left on them would be re-processed by a later commit —
// double-running a deleted child's cleanup, or re-applying host props. These tests
// exercise the delete-then-bail and update-then-bail sequences.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useState } from "../mod.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useEffect } from "../src/runtime/hooks.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("a deleted child's cleanup runs once, even when a later render bails", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  const cleanups: string[] = [];
  function Item(props: { id: string }): VNode {
    useEffect(() => {
      return () => cleanups.push(props.id);
    }, []);
    return h("li", null, props.id);
  }

  // A stable sibling that bails on later renders, plus a list that shrinks once.
  let setItems: (v: string[]) => void = () => {};
  let bump: () => void = () => {};
  function List(): VNode {
    const [items, set] = useState<string[]>(["a", "b"]);
    setItems = (v) => set(() => v);
    return h("ul", null, ...items.map((id) => h(Item, { key: id, id })));
  }
  function App(): VNode {
    const [, setN] = useState(0);
    bump = () => setN((n) => n + 1);
    return h("div", null, h(List, null));
  }

  createRoot(container as Any).render(h(App, null));
  flushSync();

  // Render 2: remove "b" — Item("b") is deleted, its cleanup runs once.
  setItems(["a"]);
  flushSync();
  assertEquals(cleanups, ["b"], "cleanup ran once on deletion");

  // Render 3: an unrelated App update; List's props are unchanged so its subtree
  // bails. The stale ChildDeletion from render 2 must NOT re-run b's cleanup.
  bump();
  flushSync();
  assertEquals(cleanups, ["b"], "bailed subtree must not re-run the deletion cleanup");

  // And a few more bailing renders for good measure.
  bump();
  flushSync();
  bump();
  flushSync();
  assertEquals(cleanups, ["b"], "still exactly one cleanup after repeated bails");
});

Deno.test("host props are not spuriously re-applied when a subtree bails", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let applied = 0;
  // A ref callback fires whenever the element is (re)attached; a stable ref that
  // is re-run would signal a spurious applyProps on a bailed subtree.
  const ref = () => {
    applied++;
  };

  let bump: () => void = () => {};
  function Leaf(): VNode {
    return h("span", { ref, className: "x" }, "leaf");
  }
  function App(): VNode {
    const [, setN] = useState(0);
    bump = () => setN((n) => n + 1);
    return h("div", null, h(Leaf, null));
  }

  createRoot(container as Any).render(h(App, null));
  flushSync();
  const afterMount = applied;

  // App updates; Leaf has no own update and equal props → bails. Its host must not
  // be re-applyProps'd (which would re-run the stable ref).
  bump();
  flushSync();
  bump();
  flushSync();
  assertEquals(applied, afterMount, "stable ref not re-run by a bailed subtree");
});
