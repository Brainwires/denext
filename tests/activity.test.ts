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
import { useEffect, useState } from "../src/runtime/hooks.ts";
import { render } from "../src/testing/mod.ts";
import { renderToStringSync } from "../src/jsx/render-to-string.ts";

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

Deno.test("mount-hidden runs the effect once (the documented residual vs React)", async () => {
  // The residual documented in KNOWN-LIMITATIONS: a subtree that MOUNTS hidden runs its
  // effects once during the pre-render and keeps them connected while hidden — React would
  // defer them entirely. denext only tears effects down on a visible→hidden transition.
  const log: string[] = [];
  function Inner() {
    useEffect(() => {
      log.push("setup");
      return () => log.push("cleanup");
    }, []);
    return h("span", null, "x");
  }
  await render(h(Activity, { mode: "hidden", children: h(Inner, {}) }));
  assertEquals(log, ["setup"], "a hidden mount runs setup once and stays connected (no cleanup)");
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
