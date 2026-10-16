// React's implicit index counts the holes a conditional child leaves: in
// `{open && <Counter id="a" />}<Counter id="b" />`, showing `a` mounts a fresh `a` and `b`
// keeps its own state — the hole held `a`'s slot. (Matching unkeyed children by type alone
// handed `b`'s fiber, and its state, to the newly shown `a`.)
import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useState } from "../src/runtime/hooks.ts";
import { render } from "../src/testing/mod.ts";
let bump: () => void = () => {};
function Counter({ id }: { id: string }) {
  const [n, setN] = useState(0);
  if (id === "b") bump = () => setN((x) => x + 1);
  return h("i", null, `${id}${n}`);
}
let setShow: (b: boolean) => void = () => {};
function App() {
  const [show, s] = useState(false);
  setShow = s;
  return h("div", null, show && h(Counter, { id: "a" }), h(Counter, { id: "b" }));
}
Deno.test("a conditional child keeps its slot: showing it never takes its sibling's state", async () => {
  const screen = await render(h(App, null));
  await screen.act(() => bump());
  await screen.act(() => setShow(true));
  assertEquals(
    (screen.container as { innerHTML: string }).innerHTML,
    "<div><i>a0</i><i>b1</i></div>",
  );
});

Deno.test("the same holds in a nested array, and when the shown child is removed again", async () => {
  let toggle: (b: boolean) => void = () => {};
  function List() {
    const [on, s] = useState(true);
    toggle = s;
    return h(
      "div",
      null,
      [h("i", { key: "k" }, "k"), on ? h(Counter, { id: "a" }) : null],
      h(Counter, { id: "b" }),
    );
  }
  const screen = await render(h(List, null));
  await screen.act(() => bump());
  await screen.act(() => toggle(false));
  assertEquals(
    (screen.container as { innerHTML: string }).innerHTML,
    "<div><i>k</i><i>b1</i></div>",
  );
  await screen.act(() => toggle(true));
  assertEquals(
    (screen.container as { innerHTML: string }).innerHTML,
    "<div><i>k</i><i>a0</i><i>b1</i></div>",
  );
});
