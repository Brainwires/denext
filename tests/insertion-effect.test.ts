// useInsertionEffect runs in its own pre-mutation commit phase: before any DOM
// mutation and before layout effects. CSS-in-JS libraries rely on this so their
// style insertion precedes the layout reads a `useLayoutEffect` might perform.
// These tests observe the live DOM at each effect's firing time to prove the
// insertion effect sees the DOM as it was BEFORE this commit's mutations, while
// the layout effect sees it AFTER.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useInsertionEffect, useLayoutEffect, useState } from "../mod.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("useInsertionEffect fires before DOM mutation on mount (layout fires after)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  const log: string[] = [];

  function App(): VNode {
    useInsertionEffect(() => {
      // The mounted subtree has NOT been placed into the container yet.
      log.push(`insertion:children=${container.childNodes.length}`);
    });
    useLayoutEffect(() => {
      // Mutation/placement has happened: the <div> is now in the container.
      log.push(`layout:children=${container.childNodes.length}`);
    });
    return h("div", null, "hi");
  }

  createRoot(container as Any).render(h(App, null));
  flushSync();

  assertEquals(
    log,
    ["insertion:children=0", "layout:children=1"],
    "insertion effect runs pre-mutation (empty container), layout effect post-mutation",
  );
  assertEquals(container.innerHTML, "<div>hi</div>");
});

Deno.test("useInsertionEffect sees pre-mutation attributes on update", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  const log: string[] = [];
  let setN: (v: number) => void = () => {};

  function App(): VNode {
    const [n, set] = useState(0);
    setN = (v) => set(() => v);
    useInsertionEffect(() => {
      // The host node exists across updates; before this commit's mutation walk
      // applies the new prop it still carries the PREVIOUS value.
      const el = container.childNodes[0] as { getAttribute?: (k: string) => string | null };
      log.push(`insertion:data-n=${el?.getAttribute?.("data-n")}`);
    }, [n]);
    useLayoutEffect(() => {
      const el = container.childNodes[0] as { getAttribute?: (k: string) => string | null };
      log.push(`layout:data-n=${el?.getAttribute?.("data-n")}`);
    }, [n]);
    return h("div", { "data-n": String(n) });
  }

  createRoot(container as Any).render(h(App, null));
  flushSync();
  // Mount: container empty when insertion fires, then div present for layout.
  assertEquals(log, ["insertion:data-n=undefined", "layout:data-n=0"]);

  log.length = 0;
  setN(1);
  flushSync();
  // Update: insertion sees the OLD attribute (0), layout sees the NEW one (1).
  assertEquals(
    log,
    ["insertion:data-n=0", "layout:data-n=1"],
    "insertion effect observes the DOM before the new prop is applied",
  );
});

Deno.test("insertion effects of ALL components run before ANY layout effect", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  const log: string[] = [];

  function Child(): VNode {
    useInsertionEffect(() => {
      log.push("child:insertion");
    });
    useLayoutEffect(() => {
      log.push("child:layout");
    });
    return h("span", null, "c");
  }
  function Parent(): VNode {
    useInsertionEffect(() => {
      log.push("parent:insertion");
    });
    useLayoutEffect(() => {
      log.push("parent:layout");
    });
    return h("div", null, h(Child, null));
  }

  createRoot(container as Any).render(h(Parent, null));
  flushSync();

  // Both insertion effects precede both layout effects (a CSS-in-JS provider's
  // style insertion is guaranteed to run before a consumer's layout read).
  const firstLayout = log.indexOf("parent:layout");
  const lastInsertion = Math.max(
    log.indexOf("parent:insertion"),
    log.indexOf("child:insertion"),
  );
  assertEquals(
    lastInsertion < firstLayout,
    true,
    `all insertion effects run before any layout effect (log: ${log.join(",")})`,
  );
});

Deno.test("useInsertionEffect cleanup runs on unmount", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  const log: string[] = [];
  let show: (v: boolean) => void = () => {};

  function Styled(): VNode {
    useInsertionEffect(() => {
      log.push("insert");
      return () => log.push("cleanup");
    });
    return h("div", null, "styled");
  }
  function App(): VNode {
    const [on, set] = useState(true);
    show = (v) => set(() => v);
    return on ? h(Styled, null) : h("p", null, "gone");
  }

  createRoot(container as Any).render(h(App, null));
  flushSync();
  assertEquals(log, ["insert"]);

  show(false);
  flushSync();
  assertEquals(log, ["insert", "cleanup"], "the insertion effect's cleanup runs when unmounted");
});
