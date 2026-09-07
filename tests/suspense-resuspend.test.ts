// A committed <Suspense> whose child re-suspends: the Offscreen path keeps the old primary
// mounted-but-hidden while the fallback shows, then reveals it. When the re-suspend REPLACED
// the child (a new key or type), the replacement mounted during the offscreen pass without
// rendering and carried no lane of its own — so the reveal's props-equal bailout kept its
// empty subtree forever and the boundary rendered nothing. Found through `dynamic()`'s retry
// (a new key per attempt); the same shape is any `<Child key={id}>` swap under a boundary.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { Suspense, use } from "../src/runtime/suspense.ts";
import { useState } from "../src/runtime/hooks.ts";
import { render, waitFor } from "../src/testing/mod.ts";

const cache = new Map<string, Promise<string>>();
function load(id: string, ms = 10): Promise<string> {
  let p = cache.get(id);
  if (!p) {
    p = new Promise<string>((r) => setTimeout(() => r("v:" + id), ms));
    cache.set(id, p);
  }
  return p;
}

function Child({ id }: { id: string }) {
  const value = use(load(id));
  return h("span", { id: "content" }, value);
}

Deno.test("a KEYED child that re-suspends in a committed Suspense renders its content once resolved", async () => {
  let bump: () => void = () => {};
  function App() {
    const [n, setN] = useState(1);
    bump = () => setN((x) => x + 1);
    return h(Suspense, {
      fallback: h("i", {}, "fallback"),
      children: h(Child, { id: `k${n}`, key: `k${n}` }),
    });
  }
  const screen = await render(h(App, {}));
  await waitFor(() => screen.getByText("v:k1"));
  bump();
  // (The fallback shows in between; the 10 ms promise settles before a poll can see it.)
  await waitFor(() => screen.getByText("v:k2"), { timeout: 1000 });
  assertEquals(screen.container.textContent, "v:k2");
});

Deno.test("the SAME child re-suspending keeps its instance (Offscreen) and shows the new data", async () => {
  let setId: (id: string) => void = () => {};
  let instances = 0;
  function Stateful({ id }: { id: string }) {
    // Runs once per INSTANCE (the initializer of a fresh mount); a re-suspend that remounted
    // instead of preserving the Offscreen primary would change the number.
    const [instance] = useState(() => ++instances);
    const value = use(load(id));
    return h("span", {}, `${value}#${instance}`);
  }
  function App() {
    const [id, set] = useState("same-a");
    setId = set;
    return h(Suspense, { fallback: h("i", {}, "fallback"), children: h(Stateful, { id }) });
  }
  const screen = await render(h(App, {}));
  const first = await waitFor(() => screen.getByText(/^v:same-a#\d+$/));
  const instance = first.textContent!.split("#")[1];
  setId("same-b");
  await waitFor(() => screen.getByText(`v:same-b#${instance}`), { timeout: 1000 });
  assertEquals(screen.container.textContent, `v:same-b#${instance}`);
});
