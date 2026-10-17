// The Fragment-ref runtime is loaded on first use: the reconciler ships only the seam
// (fragment-ref-support.ts), and the first `<Fragment ref>` a render reaches suspends it — its
// Suspense boundary, or the root, which keeps what is on screen — until the on-demand chunk has
// loaded; the retry then commits the ref as usual, so layout effects already see it.

import { assert, assertEquals } from "@std/assert";
import { Fragment, h } from "../src/jsx/jsx-runtime.ts";
import type { FragmentInstance } from "../src/runtime/react-extras.ts";
import { createRef } from "../src/runtime/react-core.ts";
import { useLayoutEffect, useRef } from "../src/runtime/hooks.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { createRoot, flushSync, setDocument } from "../src/client/fiber/reconciler.ts";
import {
  fragmentRefs,
  loadFragmentRefs,
  setFragmentRefs,
} from "../src/client/fiber/fragment-ref-support.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Let the load settle and the suspended render retry. */
async function settle(): Promise<void> {
  await loadFragmentRefs();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

Deno.test("Fragment ref load: a render without a ref'd Fragment never loads the runtime", () => {
  setFragmentRefs(null);
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  flushSync(() => createRoot(container as Any).render(h(Fragment, null, h("p", null, "x"))));
  assertEquals(container.innerHTML, "<p>x</p>");
  assertEquals(fragmentRefs, null, "a plain Fragment needs no runtime");
});

Deno.test("Fragment ref load: the first <Fragment ref> suspends the root until the runtime lands", async () => {
  setFragmentRefs(null);
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  container.innerHTML = "<p>before</p>";
  const seen: boolean[] = [];
  function Test() {
    const ref = useRef<FragmentInstance | null>(null);
    useLayoutEffect(() => void seen.push(ref.current !== null), []);
    return h(Fragment as Any, { ref }, h("div", { id: "child" }));
  }
  const root = createRoot(container as Any);
  flushSync(() => root.render(h(Test, {})));
  assertEquals(seen, [], "nothing committed while the runtime loads");
  assertEquals(container.innerHTML, "<p>before</p>", "what was on screen stays");
  await settle();
  assert(fragmentRefs !== null, "the runtime filled the seam");
  assertEquals(container.innerHTML, '<div id="child"></div>');
  assertEquals(seen, [true], "the retry commits the ref before layout effects run");
});

Deno.test("Fragment ref load: under a Suspense boundary, the boundary waits for it", async () => {
  setFragmentRefs(null);
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const ref = createRef<FragmentInstance>();
  const root = createRoot(container as Any);
  flushSync(() =>
    root.render(
      h(
        "main",
        null,
        h(Suspense, {
          fallback: h("i", null, "loading"),
          children: h(Fragment as Any, { ref }, h("b", null, "ok")),
        }),
      ),
    )
  );
  assertEquals(container.innerHTML, "<main><i>loading</i></main>");
  assertEquals(ref.current, null);
  await settle();
  assertEquals(container.innerHTML, "<main><b>ok</b></main>");
  assert(ref.current !== null);
});
