// First-party DevTools inspector: walk the live fiber tree for component
// names + hooks/state + context, edit state live through the hook's own setter,
// notify on commit, and stay a no-op in production. Uses the in-memory DOM harness.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useContext, useReducer, useState } from "../src/runtime/hooks.ts";
import { createContext } from "../src/runtime/context.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";
import {
  clearPropOverrides,
  getBoundaryTimings,
  getInspectorTree,
  getOwnerStack,
  getPageRenderMode,
  getProfile,
  getRenderModes,
  type InspectNode,
  installInspector,
  setHookState,
  setPropOverride,
  startProfiling,
  stopProfiling,
  subscribe,
} from "../src/client/devtools-inspect.ts";
import { registerFamily } from "../src/client/refresh-runtime.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

interface DevGlobals {
  __denextDev?: boolean;
  __denextIslands?: unknown[];
  __denextDevtools?: unknown;
}
const g = globalThis as DevGlobals;

function withDev<T>(dev: boolean | undefined, fn: () => T): T {
  const prev = g.__denextDev;
  g.__denextDev = dev;
  try {
    return fn();
  } finally {
    g.__denextDev = prev;
  }
}

function find(nodes: InspectNode[], name: string): InspectNode | null {
  for (const n of nodes) {
    if (n.name === name) return n;
    const hit = find(n.children, name);
    if (hit) return hit;
  }
  return null;
}

const Theme = createContext("light");

function Counter(): VNode {
  const [count] = useState(3);
  const theme = useContext(Theme);
  return h("div", { "data-count": String(count), "data-theme": theme }, `n=${count}`);
}

function App(): VNode {
  return h(Theme.Provider, { value: "dark" }, h(Counter, null));
}

Deno.test("inspector tree: component names, labeled hooks + state, and context", () => {
  withDev(true, () => {
    const { doc, container } = makeDom();
    setDocument(asDoc(doc));
    createRoot(asEl(container)).render(h(App, null));
    flushSync();

    const tree = getInspectorTree();
    const counter = find(tree, "Counter");
    assert(counter, "Counter should appear in the tree");
    assertEquals(counter.kind, "component");

    // Hooks are labeled by kind, with the current state value.
    const state = counter.hooks.find((hk) => hk.kind === "state");
    assert(state, "a useState hook should be listed");
    assertEquals(state.value.raw, 3);
    assert(state.editable, "primitive useState is live-editable");

    // Context read this render is surfaced with the provider's value.
    const ctx = counter.contexts.find((c) => c.name === "Theme" || c.value.raw === "dark");
    assert(ctx, "the read context should be listed");
    assertEquals(ctx.value.raw, "dark");
  });
});

Deno.test("inspector: setHookState edits state live and re-renders", () => {
  withDev(true, () => {
    // A uniquely-named component: roots from earlier tests stay in the reconciler's
    // active set (the inspector correctly walks every mounted root), so target this
    // test's mount by a name no other test uses.
    function EditCounter(): VNode {
      const [count] = useState(3);
      return h("div", { "data-count": String(count) }, `n=${count}`);
    }
    const { doc, container } = makeDom();
    setDocument(asDoc(doc));
    createRoot(asEl(container)).render(h(EditCounter, null));
    flushSync();

    const counter = find(getInspectorTree(), "EditCounter")!;
    const state = counter.hooks.find((hk) => hk.kind === "state")!;

    assertEquals(setHookState(counter.id, state.index, 10), true);
    flushSync();

    assertEquals(
      (container.childNodes[0] as unknown as FakeElement).getAttribute("data-count"),
      "10",
    );
    const after = find(getInspectorTree(), "EditCounter")!;
    assertEquals(after.hooks.find((hk) => hk.kind === "state")!.value.raw, 10);
  });
});

Deno.test("inspector: a reducer hook is listed but not editable-as-value", () => {
  withDev(true, () => {
    function WithReducer(): VNode {
      const [n] = useReducer((s: number, a: number) => s + a, 1);
      return h("span", null, String(n));
    }
    const { doc, container } = makeDom();
    setDocument(asDoc(doc));
    createRoot(asEl(container)).render(h(WithReducer, null));
    flushSync();

    const node = find(getInspectorTree(), "WithReducer")!;
    const reducer = node.hooks.find((hk) => hk.kind === "reducer")!;
    assertEquals(reducer.value.raw, 1);
    assertEquals(reducer.editable, false); // dispatch expects an action, not a value
  });
});

Deno.test("inspector: subscribe fires on commit; unsubscribe stops it", () => {
  withDev(true, () => {
    function SubCounter(): VNode {
      const [count] = useState(0);
      return h("div", { "data-count": String(count) });
    }
    const { doc, container } = makeDom();
    setDocument(asDoc(doc));
    createRoot(asEl(container)).render(h(SubCounter, null));
    flushSync();

    let hits = 0;
    const off = subscribe(() => hits++);

    const counter = find(getInspectorTree(), "SubCounter")!;
    setHookState(counter.id, counter.hooks.find((hk) => hk.kind === "state")!.index, 7);
    flushSync();
    assert(hits >= 1, "observer fires on commit");

    off();
    const before = hits;
    const c2 = find(getInspectorTree(), "SubCounter")!;
    setHookState(c2.id, c2.hooks.find((hk) => hk.kind === "state")!.index, 9);
    flushSync();
    assertEquals(hits, before, "no more notifications after unsubscribe");
  });
});

Deno.test("inspector: render modes derive from the island timeline", () => {
  const prev = g.__denextIslands;
  withDev(true, () => {
    g.__denextIslands = [{ id: "1.2", strategy: "visible", at: 5 }];
    const modes = getRenderModes();
    assertEquals(modes.length, 1);
    assertEquals(modes[0].mode, "client-island");
    assertEquals(modes[0].strategy, "visible");
    assertEquals(modes[0].id, "1.2");
    assertEquals(modes[0].hydratedAt, 5);
  });
  g.__denextIslands = prev;
});

Deno.test("inspector: getPageRenderMode reads the server render-mode island", () => {
  const g2 = globalThis as { document?: unknown };
  const prevDoc = g2.document;
  g2.document = {
    getElementById: (id: string) =>
      id === "__denext_render_modes"
        ? { textContent: JSON.stringify({ route: "/p", mode: "streamed", cache: "MISS" }) }
        : null,
  };
  try {
    withDev(true, () => {
      const page = getPageRenderMode();
      assert(page, "reads the island");
      assertEquals(page.mode, "streamed");
      assertEquals(page.cache, "MISS");
      assertEquals(page.route, "/p");
    });
    withDev(undefined, () => assertEquals(getPageRenderMode(), null)); // production
  } finally {
    if (prevDoc === undefined) delete g2.document;
    else g2.document = prevDoc;
  }
});

Deno.test("inspector: no-op in production (no __denextDev)", () => {
  withDev(undefined, () => {
    assertEquals(getInspectorTree(), []);
    assertEquals(getRenderModes(), []);
    assertEquals(getPageRenderMode(), null);
    assertEquals(setHookState(1, 0, 42), false);
    assertEquals(installInspector(), null);
    const off = subscribe(() => {});
    off();
  });
});

Deno.test("inspector: source location + owner stack from the family registry", () => {
  withDev(true, () => {
    function SrcChild(): VNode {
      useState(0);
      return h("span", null, "child");
    }
    function SrcParent(): VNode {
      return h(SrcChild, null);
    }
    // The dev bundle registers each component under `moduleUrl#Export`; do it by hand.
    registerFamily(SrcParent, "file:///app/parent.tsx?g=0#SrcParent");
    registerFamily(SrcChild, "file:///app/child.tsx#SrcChild");

    const { doc, container } = makeDom();
    setDocument(asDoc(doc));
    createRoot(asEl(container)).render(h(SrcParent, null));
    flushSync();

    const tree = getInspectorTree();
    const child = find(tree, "SrcChild");
    const parent = find(tree, "SrcParent");
    assert(child && parent, "both nodes present");
    // Cache-buster (?g=0) stripped; export preserved.
    assertEquals(parent!.source, "file:///app/parent.tsx#SrcParent");
    assertEquals(child!.source, "file:///app/child.tsx#SrcChild");
    // The child's owner/ancestor stack names its component parent.
    const owners = getOwnerStack(child!.id).map((o) => o.name);
    assert(owners.includes("SrcParent"), owners.join(","));
    assertEquals(getOwnerStack(child!.id)[0]?.source, "file:///app/parent.tsx#SrcParent");
  });
});

Deno.test("inspector: profiler records per-component render counts + timing", () => {
  function ProfiledThing(): VNode {
    const [n] = useState(0);
    return h("div", { "data-n": String(n) });
  }
  withDev(true, () => {
    startProfiling();
    try {
      const { doc, container } = makeDom();
      setDocument(asDoc(doc));
      createRoot(asEl(container)).render(h(ProfiledThing, null));
      flushSync();

      // Force a re-render through the live setter.
      const node = find(getInspectorTree(), "ProfiledThing")!;
      setHookState(node.id, node.hooks.find((hk) => hk.kind === "state")!.index, 5);
      flushSync();
    } finally {
      stopProfiling();
    }
    const entry = getProfile().find((p) => p.name === "ProfiledThing");
    assert(entry, "ProfiledThing was profiled");
    assert(entry!.count >= 2, `expected >=2 renders, got ${entry!.count}`);
    assert(entry!.totalMs >= 0 && entry!.maxMs >= 0, "timings are non-negative");
  });
});

Deno.test("inspector: profiler is a no-op in production", () => {
  withDev(undefined, () => {
    startProfiling(); // no-op without __denextDev
    assertEquals(getProfile(), []);
    stopProfiling();
  });
});

Deno.test("inspector: setPropOverride pins a component prop and re-renders", () => {
  function Greeting(props: { name: string }): VNode {
    return h("div", { "data-name": props.name }, `hi ${props.name}`);
  }
  function OverrideApp(): VNode {
    return h(Greeting, { name: "world" });
  }
  withDev(true, () => {
    const { doc, container } = makeDom();
    setDocument(asDoc(doc));
    createRoot(asEl(container)).render(h(OverrideApp, null));
    flushSync();

    const g = find(getInspectorTree(), "Greeting")!;
    const nameProp = g.propEntries!.find((p) => p.key === "name")!;
    assert(nameProp.editable, "string prop is overridable");
    assertEquals(nameProp.value.raw, "world");

    // Override the prop; the effective value (and re-render) reflect it.
    assertEquals(setPropOverride(g.id, "name", "denext"), true);
    flushSync();
    const after = find(getInspectorTree(), "Greeting")!;
    assertEquals(after.propEntries!.find((p) => p.key === "name")!.value.raw, "denext");

    // Clearing restores the real prop.
    assertEquals(clearPropOverrides(g.id), true);
    flushSync();
    const restored = find(getInspectorTree(), "Greeting")!;
    assertEquals(restored.propEntries!.find((p) => p.key === "name")!.value.raw, "world");
  });
});

Deno.test("inspector: getBoundaryTimings reads the server boundary-timing island", () => {
  const g2 = globalThis as { document?: unknown };
  const prevDoc = g2.document;
  g2.document = {
    getElementById: (id: string) =>
      id === "__denext_boundary_timing"
        ? { textContent: JSON.stringify([{ id: "dnx0", ms: 12.5 }, { id: "dnx1", ms: 3 }]) }
        : null,
  };
  try {
    withDev(true, () => {
      const t = getBoundaryTimings();
      assertEquals(t.length, 2);
      assertEquals(t[0].id, "dnx0");
      assertEquals(t[0].ms, 12.5);
    });
    withDev(undefined, () => assertEquals(getBoundaryTimings(), [])); // production
  } finally {
    if (prevDoc === undefined) delete g2.document;
    else g2.document = prevDoc;
  }
});
