// `<Activity>` offscreen scheduling. `mode="hidden"` keeps the subtree mounted but removes
// it from layout (`display:none`), tears down its effects, and preserves its state cells, so
// `mode="visible"` restores the SAME instances instantly. A subtree that MOUNTS hidden is
// pre-rendered at transition priority. The offscreen runtime is import-gated — installed via
// the reconciler seam only when the app uses `Activity` — so these unbundled tests install
// it explicitly (see ./helpers/activity-runtime.ts), which the generated entry does in a
// real build.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import "./helpers/activity-runtime.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { Activity } from "../src/runtime/react-extras.ts";
import { useEffect, useLayoutEffect, useState } from "../src/runtime/hooks.ts";
import { render } from "../src/testing/mod.ts";
import { renderToStringSync } from "../src/jsx/render-to-string.ts";
import {
  __pumpForTests,
  __setManualSlicingForTests,
  createRoot,
  flushSync,
  setDocument,
} from "../src/client/fiber/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function hidden(el: { getAttribute(n: string): string | null }): boolean {
  return (el.getAttribute("style") ?? "").includes("display:none");
}

Deno.test("mode=visible renders children live, unhidden", async () => {
  const screen = await render(
    h(Activity, { mode: "visible", children: h("span", { "data-testid": "c" }, "hi") }),
  );
  const el = screen.getByTestId("c");
  assertEquals(el.textContent, "hi");
  assert(!hidden(el), "visible content must not be display:none");
});

Deno.test("visible → hidden → visible preserves state and the same instance, hiding/restoring the DOM", async () => {
  let setMode: (m: "visible" | "hidden") => void = () => {};
  let inc: () => void = () => {};
  let instances = 0;
  function Inner() {
    // Runs once per INSTANCE — a remount (rather than an offscreen hide) would bump it.
    const [instance] = useState(() => ++instances);
    const [n, setN] = useState(0);
    inc = () => setN((x) => x + 1);
    return h("span", { "data-testid": "n" }, `${n}#${instance}`);
  }
  function App() {
    const [mode, setM] = useState<"visible" | "hidden">("visible");
    setMode = setM;
    return h(Activity, { mode, children: h(Inner, {}) });
  }
  const screen = await render(h(App, {}));
  await screen.act(() => inc()); // n = 1
  assertEquals(screen.getByTestId("n").textContent, "1#1");

  await screen.act(() => setMode("hidden"));
  const hiddenEl = screen.getByTestId("n");
  assert(hidden(hiddenEl), "hidden content's host must be display:none");
  assertEquals(hiddenEl.textContent, "1#1", "hidden subtree keeps its state, not re-rendered");

  await screen.act(() => setMode("visible"));
  const shownEl = screen.getByTestId("n");
  assert(!hidden(shownEl), "revealed content must restore its style");
  assertEquals(shownEl.textContent, "1#1", "revealed subtree keeps state + the same instance");
  assertEquals(instances, 1, "the subtree was never remounted");
});

Deno.test("effects disconnect on hide and reconnect on reveal", async () => {
  const log: string[] = [];
  let setMode: (m: "visible" | "hidden") => void = () => {};
  function Inner() {
    useEffect(() => {
      log.push("setup");
      return () => log.push("cleanup");
    }, []);
    return h("span", null, "x");
  }
  function App() {
    const [mode, setM] = useState<"visible" | "hidden">("visible");
    setMode = setM;
    return h(Activity, { mode, children: h(Inner, {}) });
  }
  const screen = await render(h(App, {}));
  assertEquals(log, ["setup"], "effect mounts while visible");

  await screen.act(() => setMode("hidden"));
  assertEquals(log, ["setup", "cleanup"], "effect is torn down while hidden");

  await screen.act(() => setMode("visible"));
  assertEquals(log, ["setup", "cleanup", "setup"], "effect reconnects on reveal");
});

Deno.test("a subtree that mounts hidden is pre-rendered into the DOM, hidden", async () => {
  // render() flushes the deferred transition pass (act → flushSync flushes TransitionLane),
  // so after it the content is mounted but display:none.
  const screen = await render(
    h(Activity, { mode: "hidden", children: h("span", { "data-testid": "c" }, "offscreen") }),
  );
  const el = screen.queryByTestId("c");
  assert(el !== null, "mount-hidden content is pre-rendered into the DOM");
  assertEquals(el!.textContent, "offscreen");
  assert(hidden(el!), "mount-hidden content is display:none");
});

Deno.test("mount-hidden mounts NO effects until revealed (React 19.2), then tears them down on hide", async () => {
  // React: a hidden Activity's effects are not mounted; they mount when it becomes visible
  // and are cleaned up again on visible → hidden. State is preserved throughout.
  const log: string[] = [];
  let setMode: (m: "visible" | "hidden") => void = () => {};
  function Inner() {
    const [n] = useState(() => {
      log.push("init");
      return 7;
    });
    useLayoutEffect(() => {
      log.push("layout");
      return () => log.push("layout-cleanup");
    }, []);
    useEffect(() => {
      log.push("effect");
      return () => log.push("effect-cleanup");
    }, []);
    return h("span", { "data-testid": "n" }, String(n));
  }
  function App() {
    const [mode, setM] = useState<"visible" | "hidden">("hidden");
    setMode = setM;
    return h(Activity, { mode, children: h(Inner, {}) });
  }
  const screen = await render(h(App, {}));
  await screen.act(() => {}); // let any deferred passive flush land
  assertEquals(log, ["init"], "a hidden mount renders (pre-render) but mounts no effect");
  assert(hidden(screen.getByTestId("n")), "the pre-rendered content is display:none");

  await screen.act(() => setMode("visible"));
  assertEquals(log, ["init", "layout", "effect"], "revealing mounts the effects once");
  assert(!hidden(screen.getByTestId("n")));

  await screen.act(() => setMode("hidden"));
  assertEquals(
    log.slice(3).sort(),
    ["effect-cleanup", "layout-cleanup"],
    "hiding cleans both effects up",
  );
  await screen.act(() => setMode("visible"));
  assertEquals(log.filter((l) => l === "init").length, 1, "state preserved: never re-initialized");
  assertEquals(log.slice(5).sort(), ["effect", "layout"], "revealing again re-mounts them");
});

Deno.test("a child that mounts while its Activity is already hidden mounts no effect either", async () => {
  const log: string[] = [];
  let setExtra: (b: boolean) => void = () => {};
  let setMode: (m: "visible" | "hidden") => void = () => {};
  function Leaf({ id }: { id: string }) {
    useEffect(() => {
      log.push(`effect:${id}`);
      return () => log.push(`cleanup:${id}`);
    }, []);
    return h("i", { "data-testid": id }, id);
  }
  function App() {
    const [mode, setM] = useState<"visible" | "hidden">("hidden");
    const [extra, setE] = useState(false);
    setMode = setM;
    setExtra = setE;
    return h(Activity, {
      mode,
      children: [h(Leaf, { key: "a", id: "a" }), extra ? h(Leaf, { key: "b", id: "b" }) : null],
    });
  }
  const screen = await render(h(App, {}));
  await screen.act(() => setExtra(true));
  await screen.act(() => {});
  assertEquals(log, [], "neither the first nor the later hidden child mounted its effect");
  const b = screen.queryByTestId("b");
  assert(b !== null && hidden(b), "the later child is rendered and hidden too");

  await screen.act(() => setMode("visible"));
  assertEquals(log.sort(), ["effect:a", "effect:b"], "both mount on reveal");
});

Deno.test("an update to hidden content pre-renders at low (transition) priority, not before", async () => {
  // React renders a hidden Activity's updates at Offscreen priority: never in the urgent
  // pass that hides/updates the visible tree, but ahead of the reveal, so revealing is instant.
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const log: string[] = [];
  let setLabel: (s: string) => void = () => {};
  function Leaf({ label }: { label: string }) {
    log.push(`render:${label}`);
    useEffect(() => {
      log.push(`effect:${label}`);
    }, [label]);
    return h("b", null, label);
  }
  function App() {
    const [label, setL] = useState("one");
    setLabel = setL;
    return h("div", null, h(Activity, { mode: "hidden", children: h(Leaf, { label }) }));
  }
  createRoot(container as Any).render(h(App, {}));
  flushSync(); // the urgent mount + the deferred (transition) pre-render
  assertEquals(
    (container as Any).innerHTML,
    '<div><b style="display:none !important">one</b></div>',
  );
  __setManualSlicingForTests(true);
  try {
    log.length = 0;
    setLabel("two"); // an urgent update: its hidden half must wait for a transition pass
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(log, [], "the urgent pass does not render the hidden content");
    assertEquals((container as Any).textContent, "one");
    let pumped = 0;
    while (__pumpForTests() && pumped < 20) pumped++;
    assert(pumped > 0, "a transition pass was scheduled for the hidden content");
    assertEquals(log, ["render:two"], "the transition pass pre-renders it, mounting no effect");
    assertEquals(
      (container as Any).innerHTML,
      '<div><b style="display:none !important">two</b></div>',
    );
  } finally {
    __setManualSlicingForTests(false);
  }
});

Deno.test("SSR renders a visible Activity's children, and nothing for a hidden one", () => {
  const visible = renderToStringSync(
    h(Activity, { mode: "visible", children: h("span", null, "shown") }),
  );
  assertStringIncludes(visible, "shown");

  const hiddenHtml = renderToStringSync(
    h(Activity, { mode: "hidden", children: h("span", null, "secret") }),
  );
  assert(!hiddenHtml.includes("secret"), "a hidden Activity emits no server HTML");
});

Deno.test("without the offscreen runtime installed, Activity is a transparent passthrough", async () => {
  // The seam is module-global; other tests install it. Verify the *shape* the passthrough
  // produces (children rendered) still holds — an Activity never swallows its children.
  const screen = await render(
    h(Activity, { children: h("span", { "data-testid": "c" }, "pass") }),
  );
  assertEquals(screen.getByTestId("c").textContent, "pass");
});
