// The reverse DOM → fiber index that resumability's delegated dispatch resolves
// through. `completeWork` stamps every committed host node; `fiberForNode` reads
// it back. Driven through a real reconciler mount over the in-memory DOM shim.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { fiberForNode } from "../src/client/dom-fiber-map.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("stamps every host node so fiberForNode resolves node → fiber", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  function App() {
    return h("main", null, h("button", { id: "b" }, "Click"));
  }
  const root = createRoot(container as Any);
  root.render(h(App as Any, null));
  flushSync();

  const main = container.childNodes[0] as Any;
  const button = main.childNodes[0] as Any;

  const mainFiber = fiberForNode(main);
  const buttonFiber = fiberForNode(button);
  assert(mainFiber, "expected a fiber for the <main> node");
  assert(buttonFiber, "expected a fiber for the <button> node");
  assertEquals(mainFiber!.vnode.type, "main");
  assertEquals(buttonFiber!.vnode.type, "button");
});

Deno.test("fiberForNode returns undefined for an unstamped node", () => {
  const { doc } = makeDom();
  setDocument(doc as Any);
  const orphan = doc.createElement("div");
  assertEquals(fiberForNode(orphan), undefined);
  assertEquals(fiberForNode(null), undefined);
});

Deno.test("re-stamps the live buffer across an update", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  function App({ label }: { label: string }) {
    return h("button", { id: "b" }, label);
  }
  const root = createRoot(container as Any);
  root.render(h(App as Any, { label: "one" }));
  flushSync();

  const button = container.childNodes[0] as Any;
  const first = fiberForNode(button);
  assert(first, "expected a fiber after mount");

  root.render(h(App as Any, { label: "two" }));
  flushSync();

  const second = fiberForNode(button);
  assert(second, "expected a fiber after update");
  // The node is shared across buffers; the map tracks whichever rendered last.
  assertEquals(second!.vnode.props.children, "two");
});
