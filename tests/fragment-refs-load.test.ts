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
  __setFragmentRuntimeImportForTests,
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

/** Run `body` with `Date.now()` reading `clock.now`. */
async function withClock(body: (clock: { now: number }) => Promise<void>): Promise<void> {
  const clock = { now: 1_000_000 };
  const real = Date.now;
  Date.now = () => clock.now;
  try {
    await body(clock);
  } finally {
    Date.now = real;
  }
}

/** Render a `<Fragment ref>` into a fresh root and let any load it starts settle. */
async function renderRef(): Promise<{ attached: boolean; html: string }> {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const ref = createRef<FragmentInstance>();
  const root = createRoot(container as Any);
  flushSync(() => root.render(h(Fragment as Any, { ref }, h("b", null, "ok"))));
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
  const html = container.innerHTML;
  const attached = ref.current !== null;
  root.unmount();
  return { attached, html };
}

Deno.test("Fragment ref load: a chunk that failed is loaded again by a later Fragment ref, after a backoff", async () => {
  setFragmentRefs(null);
  let attempts = 0;
  let fail = true;
  const errors = console.error;
  console.error = () => {};
  __setFragmentRuntimeImportForTests(() => {
    attempts++;
    return fail
      ? Promise.reject(new TypeError("Failed to fetch dynamically imported module"))
      : import("../src/client/fiber/fragment-instance.ts");
  });
  try {
    await withClock(async (clock) => {
      const first = await renderRef();
      assertEquals(first.html, "<b>ok</b>", "the render went on without the ref");
      assertEquals(first.attached, false);
      assertEquals(attempts, 1);

      // Inside the backoff: the next Fragment ref renders without loading again.
      clock.now += 500;
      await renderRef();
      assertEquals(attempts, 1, "no load inside the backoff");

      // Past it: the next Fragment ref loads the chunk again, and gets its ref.
      fail = false;
      clock.now += 1000;
      const retried = await renderRef();
      assertEquals(attempts, 2);
      assert(retried.attached, "the retried load attached the ref");
      assertEquals(retried.html, "<b>ok</b>");
    });
  } finally {
    console.error = errors;
    __setFragmentRuntimeImportForTests(null);
    setFragmentRefs(null);
  }
});

Deno.test("Fragment ref load: a chunk that keeps failing is tried a bounded number of times", async () => {
  setFragmentRefs(null);
  let attempts = 0;
  const errors = console.error;
  console.error = () => {};
  __setFragmentRuntimeImportForTests(() => {
    attempts++;
    return Promise.reject(new TypeError("Failed to fetch dynamically imported module"));
  });
  try {
    await withClock(async (clock) => {
      for (let i = 0; i < 10; i++) {
        const { html } = await renderRef();
        assertEquals(html, "<b>ok</b>", "every render still commits");
        clock.now += 60_000; // past any backoff
      }
      assertEquals(attempts, 5, "five loads, then the no-op stays for the page's life");
    });
  } finally {
    console.error = errors;
    __setFragmentRuntimeImportForTests(null);
    setFragmentRefs(null);
  }
});
