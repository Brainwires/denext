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
import { initialState, mountPanel } from "../src/client/devtools-panel.ts";
import type { PanelCtx } from "../src/client/devtools-panel/ctx.ts";
import { buildStyles } from "../src/client/devtools-panel/styles.ts";
import {
  DEV_CACHE_PATH,
  DEV_ROUTES_PATH,
  DEV_STATE_PATH,
  devFetch,
  OPEN_IN_EDITOR_PATH,
  openInEditor,
} from "../src/client/devtools-panel/dev-api.ts";
import { buildTabStrip } from "../src/client/devtools-panel/shell.ts";
import { refreshNetworkTab, renderNetworkTab } from "../src/client/devtools-panel/network.ts";
import { refreshCacheTab, renderCacheTab } from "../src/client/devtools-panel/cache.ts";
import { refreshRoutesTab, renderRoutesTab } from "../src/client/devtools-panel/routes.ts";
import {
  DEV_STATE_PATH as SERVER_DEV_STATE_PATH,
  OPEN_IN_EDITOR_PATH as SERVER_OPEN_IN_EDITOR_PATH,
} from "../src/build/dev-server/state.ts";

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

Deno.test("panel: the Render-modes tab shows the live boundary waterfall", () => {
  const gg = globalThis as { __denextBoundaries?: unknown };
  const prevB = gg.__denextBoundaries;
  // A boundary revealed in real time (client reveal 30ms, server resolve 8ms).
  gg.__denextBoundaries = [{ id: "dnx0", revealAt: 30, serverMs: 8 }];
  function WaterfallApp(): VNode {
    return h("div", null, "x");
  }
  try {
    withPanel(WaterfallApp, ({ body }) => {
      queryAll(body, (e) => e.tagName === "BUTTON" && e.textContent === "Render modes")[0]
        .dispatch("click");
      assert(
        queryAll(body, (e) => e.textContent.includes("dnx0")).length >= 1,
        "boundary id shown in the waterfall",
      );
      assert(
        queryAll(body, (e) => e.textContent.includes("revealed @30ms")).length >= 1,
        "the live client reveal time is shown",
      );
    });
  } finally {
    if (prevB === undefined) delete gg.__denextBoundaries;
    else gg.__denextBoundaries = prevB;
  }
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

// ---- Panel shell: the six-tab IA, the keyboard map, highlight-updates, dev-api --------

/** The panel frame (the fixed, column-flex chrome the launcher opens). */
function panelEl(body: FakeElement): FakeElement {
  return queryAll(
    body,
    (e) =>
      e.tagName === "DIV" && e.style.cssText.includes("position:fixed") &&
      e.style.cssText.includes("flex-direction:column"),
  )[0];
}

/** Every `role="tab"` button, in strip order. */
function tabButtons(body: FakeElement): FakeElement[] {
  return queryAll(body, (e) => e.getAttribute("role") === "tab");
}

function tabByLabel(body: FakeElement, label: string): FakeElement {
  return tabButtons(body).find((b) => b.textContent === label)!;
}

function Tiny(): VNode {
  return h("div", null, "tiny");
}

Deno.test("panel: the header is a six-tab tablist with aria-selected tracking", () => {
  withPanel(Tiny, ({ body }) => {
    const tabs = tabButtons(body);
    assertEquals(
      tabs.map((t) => t.textContent),
      ["Components", "Render modes", "Profiler", "Network", "Cache", "Routes"],
    );
    assertEquals(
      tabs.map((t) => t.getAttribute("aria-selected")),
      ["true", "false", "false", "false", "false", "false"],
    );
    // The strip itself scrolls rather than squeezing the buttons on a narrow panel.
    const strip = queryAll(body, (e) => e.getAttribute("role") === "tablist")[0];
    assert(strip, "the tab strip is a tablist");
    assert(strip.style.cssText.includes("overflow-x:auto"), strip.style.cssText);
    for (const t of tabs) assert(t.style.cssText.includes("flex:0 0 auto"), t.style.cssText);

    tabByLabel(body, "Render modes").dispatch("click");
    assertEquals(tabByLabel(body, "Render modes").getAttribute("aria-selected"), "true");
    assertEquals(tabByLabel(body, "Components").getAttribute("aria-selected"), "false");
  });
});

Deno.test("panel: Alt+3 selects the Profiler tab and Ctrl+Shift+] steps to the next", () => {
  withPanel(Tiny, ({ doc, body }) => {
    doc.dispatch("keydown", { altKey: true, key: "3" });
    assertEquals(tabByLabel(body, "Profiler").getAttribute("aria-selected"), "true");
    assert(
      queryAll(body, (e) => e.tagName === "BUTTON" && e.textContent === "Clear").length >= 1,
      "the profiler pane rendered",
    );

    doc.dispatch("keydown", { ctrlKey: true, shiftKey: true, key: "]" });
    assertEquals(tabByLabel(body, "Network").getAttribute("aria-selected"), "true");
    doc.dispatch("keydown", { ctrlKey: true, shiftKey: true, key: "[" });
    assertEquals(tabByLabel(body, "Profiler").getAttribute("aria-selected"), "true");

    // Cmd+… belongs to the browser: the same chord with metaKey is ignored.
    doc.dispatch("keydown", { metaKey: true, altKey: true, key: "1" });
    assertEquals(tabByLabel(body, "Profiler").getAttribute("aria-selected"), "true");
    doc.dispatch("keydown", { altKey: true, key: "1" });
    assertEquals(tabByLabel(body, "Components").getAttribute("aria-selected"), "true");
  });
});

Deno.test("panel: the header title hides on a narrow panel", () => {
  withPanel(Tiny, ({ body }) => {
    const title = queryAll(body, (e) => e.textContent === "denext · glass-box")[0];
    assert(title, "the title is shown at full width");
    assertEquals(asAny(title.style).display, "");

    // Simulate a 380px-wide panel and re-render.
    panelEl(body).getBoundingClientRect = () => ({ top: 0, left: 0, width: 380, height: 400 });
    tabByLabel(body, "Profiler").dispatch("click");
    assertEquals(asAny(title.style).display, "none");

    panelEl(body).getBoundingClientRect = () => ({ top: 0, left: 0, width: 620, height: 400 });
    tabByLabel(body, "Components").dispatch("click");
    assertEquals(asAny(title.style).display, "");
  });
});

Deno.test("panel: Escape stops the picker first, and closes the panel next", () => {
  withPanel(Tiny, ({ doc, body }) => {
    const pickBtn = queryAll(body, (e) => e.tagName === "BUTTON" && e.textContent === "🎯")[0];
    const panel = panelEl(body);
    pickBtn.dispatch("click");
    assert(pickBtn.style.cssText.includes("#8aa2ff"), "picking");

    doc.dispatch("keydown", { key: "Escape" });
    assert(!pickBtn.style.cssText.includes("#8aa2ff"), "Escape left pick mode");
    assertEquals(asAny(panel.style).display, "flex", "the panel is still open");

    doc.dispatch("keydown", { key: "Escape" });
    assertEquals(asAny(panel.style).display, "none", "a second Escape closes it");
    // Re-open so withPanel's Ctrl+Shift+D teardown leaves the panel closed.
    doc.dispatch("keydown", { ctrlKey: true, shiftKey: true, key: "d" });
  });
});

Deno.test("panel: highlight-updates flashes only the component that re-rendered", () => {
  function HlLeaf(): VNode {
    const [n] = useState(1);
    return h("div", { "data-n": String(n) });
  }
  function HlStatic(): VNode {
    return h("p", null, "static");
  }
  function HlApp(): VNode {
    return h("section", null, h(HlLeaf, null), h(HlStatic, null));
  }
  withPanel(HlApp, ({ body, api }) => {
    const tree = api!.getInspectorTree();
    const leaf = findByName(tree, "HlLeaf")!;
    const still = findByName(tree, "HlStatic")!;
    // Give the two host nodes distinguishable boxes so the flash target is identifiable.
    const rect = (top: number) => () => ({ top, left: 0, width: 10, height: 10 });
    asAny(api!.getHostNode(leaf.id)).getBoundingClientRect = rect(11);
    asAny(api!.getHostNode(still.id)).getBoundingClientRect = rect(99);

    const overlay = queryAll(body, (e) => e.style.cssText.includes("rgba(138,162,255,.22)"))[0];
    const hlBtn = queryAll(body, (e) => e.tagName === "BUTTON" && e.textContent === "✨")[0];
    assert(hlBtn, "the ✨ highlight-updates toggle exists");
    hlBtn.dispatch("click");
    assert(hlBtn.style.cssText.includes("#8aa2ff"), "the toggle shows active");
    assert(asAny(overlay.style).display !== "block", "enabling only baselines the tree");

    const idx = leaf.hooks.find((hk) => hk.kind === "state")!.index;
    api!.setHookState(leaf.id, idx, 2);
    flushSync();

    assertEquals(asAny(overlay.style).display, "block", "the re-rendered node flashed");
    assertEquals(asAny(overlay.style).top, "11px", "it was HlLeaf's host node, not HlStatic's");
    assert(asAny(overlay.style).borderColor, "the flash tints the overlay border");
  });
});

// ---- The dev-endpoint contract (dev-api.ts) and the data tabs' unavailable state ------

/** A panel context with no live panel, for driving one data tab in isolation. */
function dataTabCtx(): { ctx: PanelCtx; detailPane: FakeElement } {
  const doc = new FakeDocument();
  const { S, S_BADGE } = buildStyles();
  const treePane = doc.createElement("div");
  const detailPane = doc.createElement("div");
  const ctx: PanelCtx = {
    doc: asAny(doc),
    api: asAny({}),
    S,
    S_BADGE,
    state: initialState(),
    treePane: asAny(treePane),
    detailPane: asAny(detailPane),
    render: () => {},
    selectNode: () => {},
    highlight: () => {},
    hideHighlight: () => {},
  };
  return { ctx, detailPane };
}

/** Run `fn` with `fetch` replaced by `stub`. */
async function withFetch(stub: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

Deno.test("dev-api: the panel's path constants match the dev server's", () => {
  assertEquals(DEV_STATE_PATH, SERVER_DEV_STATE_PATH);
  assertEquals(OPEN_IN_EDITOR_PATH, SERVER_OPEN_IN_EDITOR_PATH);
  // Job 5 adds these two to the dev server; the panel fixes their spelling here.
  assertEquals(DEV_CACHE_PATH, "/_denext/dev-cache");
  assertEquals(DEV_ROUTES_PATH, "/_denext/dev-routes");
});

Deno.test("dev-api: 404, 403 and a network failure all read as 'unavailable'", async () => {
  for (const status of [403, 404]) {
    await withFetch(
      () => Promise.resolve(new Response("no", { status })),
      async () => {
        assertEquals(await devFetch(DEV_CACHE_PATH), { ok: false, reason: "unavailable" });
      },
    );
  }
  await withFetch(() => Promise.reject(new TypeError("failed to fetch")), async () => {
    assertEquals(await devFetch(DEV_ROUTES_PATH), { ok: false, reason: "unavailable" });
  });
  // A relative URL with no document base (this test runtime) is a network failure too.
  assertEquals(await devFetch(DEV_STATE_PATH, { kind: "request" }), {
    ok: false,
    reason: "unavailable",
  });
});

Deno.test("dev-api: a 500 is an error, and a 200 returns the parsed payload", async () => {
  await withFetch(() => Promise.resolve(new Response("boom", { status: 500 })), async () => {
    assertEquals(await devFetch(DEV_CACHE_PATH), { ok: false, reason: "error" });
  });
  await withFetch(
    (input) => {
      assertEquals(String(input), `${DEV_STATE_PATH}?kind=request&limit=2`);
      return Promise.resolve(Response.json({ events: [1] }));
    },
    async () => {
      assertEquals(await devFetch(DEV_STATE_PATH, { kind: "request", limit: "2" }), {
        ok: true,
        data: { events: [1] },
      });
    },
  );
});

Deno.test("panel: the data tabs say they are App-Router-only when the endpoint is absent", async () => {
  const tabs = [
    { name: "Network", render: renderNetworkTab, refresh: refreshNetworkTab },
    { name: "Cache", render: renderCacheTab, refresh: refreshCacheTab },
    { name: "Routes", render: renderRoutesTab, refresh: refreshRoutesTab },
  ];
  for (const tab of tabs) {
    const { ctx, detailPane } = dataTabCtx();
    tab.render(ctx);
    assertEquals(detailPane.textContent, "loading…", `${tab.name} starts out loading`);

    let rendered = 0;
    asAny(ctx).render = () => {
      rendered++;
      detailPane.replaceChildren();
      tab.render(ctx);
    };
    await withFetch(() => Promise.resolve(new Response("nope", { status: 404 })), async () => {
      tab.refresh(ctx);
      await new Promise((r) => setTimeout(r, 0));
    });
    assertEquals(rendered, 1, `${tab.name} re-rendered once per read`);
    assertEquals(
      detailPane.textContent,
      `${tab.name} is not available in SPA dev (App Router only)`,
    );
    assertEquals(ctx.state.dataUnavailable, true);
  }
});

Deno.test("shell: buildTabStrip produces an accessible, scrollable tablist", () => {
  const doc = new FakeDocument();
  const { S } = buildStyles();
  const { strip, buttons } = buildTabStrip(asAny(doc), S, [
    { id: "components", label: "Components" },
    { id: "cache", label: "Cache" },
  ]);
  assertEquals(asAny(strip).getAttribute("role"), "tablist");
  assert(asAny(strip).style.cssText.includes("overflow-x:auto"));
  assertEquals(Object.keys(buttons).sort(), ["cache", "components"]);
  assertEquals(asAny(buttons.cache).getAttribute("role"), "tab");
  assertEquals(asAny(buttons.cache).getAttribute("aria-selected"), "false");
  assertEquals(asAny(buttons.cache).title, "Cache (Alt+2)");
});

Deno.test("dev-api: openInEditor asks the dev server for file:line:column", async () => {
  let asked = "";
  await withFetch((input) => {
    asked = String(input);
    return Promise.resolve(new Response("ok"));
  }, async () => {
    openInEditor("/proj/app/page.tsx", 12, 5);
    await new Promise((r) => setTimeout(r, 0));
  });
  assertEquals(
    asked,
    `${OPEN_IN_EDITOR_PATH}?file=%2Fproj%2Fapp%2Fpage.tsx&line=12&column=5`,
  );
  // No dev server (a relative URL with no document base) must not throw.
  openInEditor("/proj/app/page.tsx");
});
