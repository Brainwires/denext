// Regression: a Suspense boundary that is unmounted while suspended must not act
// on the settling promise (no re-render of a dead fiber, no retained subtree). The
// retry closure holds the boundary fiber until the promise settles; commitDeletion
// severs its links and marks it unmounted so retrySuspense bails.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, setDocument } from "../src/client/reconciler.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import type { VNode } from "../src/jsx/types.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("unmounting a suspended boundary before its promise settles is safe", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let resolve: () => void = () => {};
  const gate = new Promise<void>((r) => (resolve = r));
  let renders = 0;

  function Suspender(): VNode {
    renders++;
    throw gate; // always suspend until we resolve+retry (we won't retry here)
  }

  const root = createRoot(container as Any);
  root.render(
    h(Suspense, { fallback: h("span", null, "loading"), children: h(Suspender, null) }),
  );
  assertEquals(container.innerHTML, "<span>loading</span>");
  const rendersWhileMounted = renders;

  // Unmount while still suspended, then settle the promise.
  root.unmount();
  assertEquals(container.innerHTML, "");
  resolve();
  // Let the thenable's .then(retrySuspense) microtask run.
  await Promise.resolve();
  await Promise.resolve();

  // The dead boundary was not re-rendered, and nothing threw.
  assertEquals(renders, rendersWhileMounted, "unmounted boundary must not retry");
  assertEquals(container.innerHTML, "");
});
