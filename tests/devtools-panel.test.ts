// First-party DevTools in-page panel: a JSDOM-free smoke over the vanilla-DOM panel,
// driven through the extended in-memory DOM harness. Exercises the React-DevTools-parity
// interactions added in Phase 2 — tree render + search, the element picker + highlight
// overlay, "why did this render" marking, and lazy deep-value expansion.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useState } from "../src/runtime/hooks.ts";
import type { VNode } from "../src/jsx/types.ts";
import { FakeDocument, type FakeElement, FakeNode } from "./helpers/dom.ts";
import { installInspector } from "../src/client/devtools-inspect.ts";
import { mountPanel } from "../src/client/devtools-panel.ts";

// deno-lint-ignore no-explicit-any
const asAny = (v: unknown): any => v;

interface DevGlobals {
  __denextDev?: boolean;
  requestAnimationFrame?: (cb: () => void) => number;
}
const g = globalThis as DevGlobals;

function withPanel(
  App: () => VNode,
  fn: (
    ctx: { doc: FakeDocument; body: FakeElement; api: ReturnType<typeof installInspector> },
  ) => void,
): void {
  const prevDev = g.__denextDev;
  const prevRaf = g.requestAnimationFrame;
  g.__denextDev = true;
  // Synchronous rAF so a commit's panel re-render happens inline (deterministic, no leaks).
  g.requestAnimationFrame = (cb: () => void) => {
    cb();
    return 0;
  };
  try {
    const doc = new FakeDocument();
    setDocument(asAny(doc));
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    createRoot(asAny(container)).render(h(App, null));
    flushSync();

    const api = installInspector()!;
    mountPanel(api, asAny(doc));
    // Open via Ctrl+Shift+D.
    doc.dispatch("keydown", { ctrlKey: true, shiftKey: true, key: "d" });
    try {
      fn({ doc, body: doc.body, api });
    } finally {
      // Close so this panel's commit subscriber goes inert for later tests.
      doc.dispatch("keydown", { ctrlKey: true, shiftKey: true, key: "d" });
    }
  } finally {
    g.__denextDev = prevDev;
    if (prevRaf === undefined) delete g.requestAnimationFrame;
    else g.requestAnimationFrame = prevRaf;
  }
}

function queryAll(root: FakeNode, pred: (e: FakeElement) => boolean): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (n: FakeNode) => {
    if (
      n instanceof FakeNode && (n as FakeElement).tagName !== undefined && pred(n as FakeElement)
    ) {
      out.push(n as FakeElement);
    }
    for (const c of n.childNodes) walk(c);
  };
  walk(root);
  return out;
}

/** Component tree rows are the clickable flex divs in the tree pane. */
function rows(body: FakeElement): FakeElement[] {
  return queryAll(
    body,
    (e) =>
      e.tagName === "DIV" && e.style.cssText.includes("cursor:pointer") &&
      e.style.cssText.includes("display:flex"),
  );
}

function rowFor(body: FakeElement, name: string): FakeElement | undefined {
  return rows(body).find((r) => r.textContent.includes(name));
}

Deno.test("panel: mounts, renders the tree, and shows props on select", () => {
  function PanelLeaf(): VNode {
    return h("div", { "data-x": "1" }, "leaf");
  }
  function PanelApp(): VNode {
    return h(PanelLeaf, null);
  }
  withPanel(PanelApp, ({ body }) => {
    // The launcher (dino head-shot icon) + a component row for PanelLeaf are present.
    assert(
      queryAll(body, (e) => e.tagName === "IMG" && String(asAny(e).alt) === "denext devtools")
        .length === 1,
      "launcher icon present",
    );
    const row = rowFor(body, "PanelLeaf");
    assert(row, "PanelLeaf has a tree row");

    // Selecting it fills the detail pane with a Props section.
    row!.dispatch("click");
    const headings = queryAll(body, (e) => e.tagName === "H4").map((e) => e.textContent);
    assert(headings.includes("Props"), headings.join(","));
    assert(headings.includes("Hooks"), headings.join(","));
  });
});

Deno.test("panel: the search box filters tree rows by component name", () => {
  function Alpha(): VNode {
    return h("span", null, "a");
  }
  function Beta(): VNode {
    return h("span", null, "b");
  }
  function SearchApp(): VNode {
    return h("div", null, h(Alpha, null), h(Beta, null));
  }
  withPanel(SearchApp, ({ body }) => {
    assert(rowFor(body, "Alpha"), "Alpha shown before filtering");
    assert(rowFor(body, "Beta"), "Beta shown before filtering");

    const search = queryAll(body, (e) =>
      e.tagName === "INPUT" && asAny(e).placeholder === "filter…")[0];
    assert(search, "the search box exists");
    asAny(search).value = "alpha";
    search.dispatch("input");

    assert(rowFor(body, "Alpha"), "Alpha still shown");
    assertEquals(rowFor(body, "Beta"), undefined, "Beta filtered out");
  });
});

Deno.test("panel: the element picker highlights and selects a component", () => {
  function PickLeaf(): VNode {
    return h("section", { "data-pick": "y" }, "x");
  }
  function PickApp(): VNode {
    return h("main", null, h(PickLeaf, null));
  }
  withPanel(PickApp, ({ doc, body, api }) => {
    const tree = api!.getInspectorTree();
    const leaf = findByName(tree, "PickLeaf")!;
    const host = api!.getHostNode(leaf.id) as unknown as FakeElement;
    assert(host, "PickLeaf resolves to a host element");

    // Turn on the picker.
    const pickBtn = queryAll(body, (e) => e.tagName === "BUTTON" && e.textContent === "🎯")[0];
    pickBtn.dispatch("click");
    assert(pickBtn.style.cssText.includes("#8aa2ff"), "pick button shows active");

    // Hovering the page draws the highlight overlay.
    const overlay = queryAll(body, (e) => e.style.cssText.includes("rgba(138,162,255,.22)"))[0];
    assert(overlay, "overlay element exists");
    doc.dispatch("pointermove", { target: host });
    assertEquals(asAny(overlay.style).display, "block", "overlay shown on hover");

    // Clicking the page selects the owning component and exits pick mode.
    doc.dispatch("click", { target: host });
    assert(!pickBtn.style.cssText.includes("#8aa2ff"), "pick mode exited");
    const nameRows = queryAll(body, (e) => e.textContent.includes("PickLeaf"));
    assert(nameRows.length >= 1, "PickLeaf is now selected/shown in detail");
  });
});

Deno.test("panel: 'why did this render' marks the changed hook after an update", () => {
  function ReasonLeaf(): VNode {
    const [n] = useState(1);
    return h("div", { "data-n": String(n) });
  }
  function ReasonApp(): VNode {
    return h(ReasonLeaf, null);
  }
  withPanel(ReasonApp, ({ body, api }) => {
    const leaf = findByName(api!.getInspectorTree(), "ReasonLeaf")!;
    rowFor(body, "ReasonLeaf")!.dispatch("click");

    // Change the state → a commit records the render reason → the panel re-renders.
    const stateIdx = leaf.hooks.find((hk) => hk.kind === "state")!.index;
    api!.setHookState(leaf.id, stateIdx, 2);
    flushSync();

    // The hook's label is drawn in the "changed" accent (#ff9d5c) with a render count.
    const changed = queryAll(
      body,
      (e) => e.textContent.startsWith(`${stateIdx} state`) && e.style.cssText.includes("#ff9d5c"),
    );
    assert(changed.length >= 1, "the changed state hook is marked");
    const counts = queryAll(body, (e) => e.textContent.includes("rendered ×"));
    assert(counts.length >= 1, "a render count is shown");
  });
});

Deno.test("panel: deep value expansion reads a nested object level lazily", () => {
  function DeepLeaf(props: { data: { x: number } }): VNode {
    return h("div", { "data-x": String(props.data.x) });
  }
  function DeepApp(): VNode {
    return h(DeepLeaf, { data: { x: 7 } });
  }
  withPanel(DeepApp, ({ body }) => {
    rowFor(body, "DeepLeaf")!.dispatch("click");

    // The object prop renders a collapsed expander (▶ …). Before expanding, no `x` child.
    const expander = queryAll(
      body,
      (e) => e.tagName === "SPAN" && e.textContent.includes("▶") && e.textContent.includes("{"),
    )[0];
    assert(expander, "an expandable object value is shown");

    // Expand → a nested `x: 7` row appears.
    expander.dispatch("click");
    const childKey = queryAll(body, (e) => e.tagName === "SPAN" && e.textContent === "x");
    assert(childKey.length >= 1, "the nested key `x` is revealed after expanding");
  });
});

Deno.test("panel: the profiler records a commit and renders a flamegraph", () => {
  function ProfLeaf(): VNode {
    const [n] = useState(0);
    return h("div", { "data-n": String(n) });
  }
  function ProfApp(): VNode {
    return h("section", null, h(ProfLeaf, null));
  }
  withPanel(ProfApp, ({ body, api }) => {
    // Switch to the Profiler tab and start recording.
    queryAll(body, (e) => e.tagName === "BUTTON" && e.textContent === "Profiler")[0].dispatch(
      "click",
    );
    queryAll(body, (e) => e.tagName === "BUTTON" && e.textContent.includes("Record"))[0].dispatch(
      "click",
    );

    // Trigger a state update → one recorded commit → the panel re-renders on commit.
    const leaf = findByName(api!.getInspectorTree(), "ProfLeaf")!;
    const idx = leaf.hooks.find((hk) => hk.kind === "state")!.index;
    api!.setHookState(leaf.id, idx, 3);
    flushSync();

    // A commit-strip bar and a flamegraph bar for ProfLeaf are shown.
    const bars = queryAll(body, (e) => e.style.cssText.includes("border-radius:2px 2px 0 0"));
    assert(bars.length >= 1, "a commit bar is shown");
    const flame = queryAll(body, (e) => e.textContent.startsWith("ProfLeaf"));
    assert(flame.length >= 1, "ProfLeaf appears in the flamegraph/ranked view");
  });
});

function findByName(
  nodes: ReturnType<NonNullable<ReturnType<typeof installInspector>>["getInspectorTree"]>,
  name: string,
): { id: number; hooks: { kind: string; index: number }[] } | null {
  for (const n of nodes) {
    if (n.name === name) return n;
    const hit = findByName(n.children, name);
    if (hit) return hit;
  }
  return null;
}
