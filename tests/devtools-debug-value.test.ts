// DevTools D3 — a real, zero-cell `useDebugValue`.
//
// In development on the client the call is recorded on the rendering fiber (NOT as a hook
// cell) with its formatter kept unapplied; the inspector formats it lazily and shows it on
// the hook row it follows. These tests pin the four properties that make that safe: the
// value reaches every surface (inspector row, panel, snapshot, MCP text), `format` never
// runs during render, production/SSR record nothing, and the hook-cell sequence is
// untouched — so Fast Refresh keeps state across an edit that adds a call.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { devRootFibers } from "../src/client/fiber/devtools-bridge.ts";
import type { Fiber } from "../src/client/fiber/fiber.ts";
import { useDebugValue, useEffect, useState } from "../src/runtime/hooks.ts";
import { StrictMode } from "../src/runtime/strict-mode.ts";
import { renderToStringSync } from "../src/jsx/render-to-string.ts";
import type { VNode } from "../src/jsx/types.ts";
import { FakeDocument, type FakeElement, type FakeNode, makeDom } from "./helpers/dom.ts";
import {
  getInspectorTree,
  type InspectNode,
  installInspector,
} from "../src/client/devtools-inspect.ts";
import { clearComponentMeta, registerComponentMeta } from "../src/client/devtools-meta.ts";
import { registerFamily, sameFamily } from "../src/client/refresh-runtime.ts";
import { setFamilyMatch, setSignatureChangeHandler } from "../src/client/vnode-utils.ts";
import { mountPanel } from "../src/client/devtools-panel.ts";
import { buildSnapshot, type InspectSnapshot } from "../src/client/devtools-inspect-sink.ts";
import { parseSnapshot } from "../src/build/dev-server/devtools-snapshot.ts";
import { hookStateText } from "../src/mcp/devtools.ts";

// deno-lint-ignore no-explicit-any
const asAny = (v: unknown): any => v;

interface DevGlobals {
  __denextDev?: boolean;
  requestAnimationFrame?: (cb: () => void) => number;
}
const g = globalThis as DevGlobals;

/** Run `fn` with the dev flag set to `dev`, restoring it (and the metadata registry) after. */
function withDev<T>(fn: () => T, dev = true): T {
  const prev = g.__denextDev;
  g.__denextDev = dev;
  try {
    return fn();
  } finally {
    g.__denextDev = prev;
    clearComponentMeta();
  }
}

/** Mount `vnode` into a fresh fake DOM and flush. */
function mount(vnode: VNode): void {
  const { doc, container } = makeDom();
  setDocument(asAny(doc));
  createRoot(asAny(container)).render(vnode);
  flushSync();
}

/** The committed fiber rendering `type` (matched by identity — earlier roots stay mounted). */
function fiberOf(type: unknown): Fiber {
  const stack: Fiber[] = [...devRootFibers()];
  while (stack.length > 0) {
    const fiber = stack.shift()!;
    if (fiber.tag === "component" && fiber.vnode.type === type) return fiber;
    for (let c = fiber.child; c !== null; c = c.sibling) stack.push(c);
  }
  throw new Error("component not mounted");
}

/** The most recently mounted inspector node named `name`. */
function nodeNamed(name: string): InspectNode {
  let hit: InspectNode | undefined;
  const visit = (nodes: InspectNode[]): void => {
    for (const n of nodes) {
      if (n.name === name) hit = n;
      visit(n.children);
    }
  };
  visit(getInspectorTree());
  assert(hit, `${name} present in the tree`);
  return hit!;
}

// ---- The value, on the right row --------------------------------------------

function useOnline(): boolean {
  const [online] = useState(true);
  useDebugValue(online ? "Online" : "Offline");
  return online;
}

function Status(): VNode {
  const [count] = useState(0);
  const online = useOnline();
  const [label] = useState("x");
  return h("i", null, `${count}${online}${label}`);
}

const MODULE = "file:///app/debug.tsx";

Deno.test("useDebugValue: recorded in dev and shown on the custom hook's row", () => {
  withDev(() => {
    registerFamily(Status, `${MODULE}#Status`);
    registerComponentMeta(`${MODULE}#Status`, {
      name: "Status",
      line: 1,
      column: 1,
      hooks: [
        { hook: "useState", name: "count", line: 2 },
        { hook: "useOnline", name: "online", line: 3 },
        { hook: "useState", name: "label", line: 4 },
      ],
    });
    registerComponentMeta(`${MODULE}#useOnline`, {
      name: "useOnline",
      line: 8,
      column: 1,
      hooks: [
        { hook: "useState", name: "online", line: 9 },
        { hook: "useDebugValue", name: "", line: 10 },
      ],
    });
    mount(h(Status, null));
    // One record, placed after the custom hook's cell (cursor 2 = two cells consumed).
    assertEquals(fiberOf(Status).debugValues?.map((e) => e.index), [2]);

    const node = nodeNamed("Status");
    assertEquals(node.hooksNamed, true, "a zero-cell call keeps the naming walk aligned");
    assertEquals(node.hooks[1].name, "useOnline › online");
    assertEquals(node.hooks[1].debug?.preview, '"Online"');
    assertEquals(node.hooks[0].debug, undefined);
    assertEquals(node.hooks[2].debug, undefined);
  });
});

// ---- format is lazy, and a throwing one is contained ------------------------

let formatCalls = 0;
function useLazy(): number {
  const [n] = useState(41);
  useDebugValue(n, (v) => {
    formatCalls++;
    return `n=${v}`;
  });
  return n;
}
function Lazy(): VNode {
  return h("b", null, String(useLazy()));
}

Deno.test("useDebugValue: format runs only when the inspector reads the value", () => {
  withDev(() => {
    formatCalls = 0;
    mount(h(Lazy, null));
    assertEquals(formatCalls, 0, "render never calls format");
    assertEquals(fiberOf(Lazy).debugValues?.length, 1, "the raw value is recorded");
    const node = nodeNamed("Lazy");
    assert(formatCalls >= 1, "the inspector applied format on read");
    assertEquals(node.hooks[0].debug?.preview, '"n=41"');
  });
});

function Throws(): VNode {
  const [n] = useState(1);
  useDebugValue(n, () => {
    throw new Error("bad formatter");
  });
  return h("u", null, String(n));
}

Deno.test("useDebugValue: a throwing format yields a placeholder, never a throw", () => {
  withDev(() => {
    mount(h(Throws, null));
    const node = nodeNamed("Throws"); // would throw here if format escaped
    assertStringIncludes(node.hooks[0].debug?.preview ?? "", "<format threw>");
  });
});

function Several(): VNode {
  const [a] = useState(1);
  useDebugValue("first");
  useDebugValue(2);
  return h("s", null, String(a));
}

Deno.test("useDebugValue: several calls after one cell read as an array", () => {
  withDev(() => {
    mount(h(Several, null));
    const debug = nodeNamed("Several").hooks[0].debug!;
    assertEquals(debug.type, "array");
    assertEquals(debug.entries?.map((e) => e.value.preview), ['"first"', "2"]);
  });
});

// ---- production + SSR record nothing ----------------------------------------

let prodFormatCalls = 0;
let prodBump: () => void = () => {};
function Prod(): VNode {
  const [n, set] = useState(0);
  prodBump = () => set((x) => x + 1);
  useDebugValue(n, (v) => {
    prodFormatCalls++;
    return v;
  });
  return h("p", null, String(n));
}

Deno.test("useDebugValue: production records nothing and never adds the fiber slot", () => {
  withDev(() => {
    prodFormatCalls = 0;
    mount(h(Prod, null));
    prodBump();
    flushSync(); // a re-render through the double buffer (carryOver) as well
    const fiber = fiberOf(Prod);
    assert(!("debugValues" in fiber), "no slot on the committed fiber");
    assert(fiber.alternate !== null && !("debugValues" in fiber.alternate), "nor its alternate");
    assertEquals(prodFormatCalls, 0);
  }, false);
});

Deno.test("useDebugValue: a no-op during SSR and outside any render", () => {
  withDev(() => {
    let calls = 0;
    function C(): VNode {
      useDebugValue("label", () => calls++);
      return h("i", null, "ok");
    }
    assertEquals(renderToStringSync(h(C, null)), "<i>ok</i>");
    // No dispatcher installed: silent, as in React. (Aliased — the lint rule rightly
    // rejects a literal hook call outside a component; this test is exactly that case.)
    const stray: (value: unknown) => void = useDebugValue;
    stray("stray call");
    assertEquals(calls, 0);
  });
});

// ---- zero cells: the hook sequence (and so Fast Refresh) is untouched -------

function Plain(): VNode {
  const [a] = useState(0);
  useEffect(() => {}, []);
  return h("em", null, String(a));
}
function Labelled(): VNode {
  useDebugValue("before any cell");
  const [a] = useState(0);
  useDebugValue(a);
  useEffect(() => {}, []);
  useDebugValue("after");
  return h("em", null, String(a));
}

Deno.test("useDebugValue: consumes no hook cell", () => {
  withDev(() => {
    mount(h(Plain, null));
    mount(h(Labelled, null));
    const plain = fiberOf(Plain).hooks!;
    const labelled = fiberOf(Labelled).hooks!;
    assertEquals(labelled.length, plain.length);
    assertEquals(labelled.map((c) => c.kind), plain.map((c) => c.kind));
    assertEquals(fiberOf(Labelled).debugValues?.map((e) => e.index), [0, 1, 2]);
  });
});

let strictRenders = 0;
let strictBump: () => void = () => {};
function Strict(): VNode {
  strictRenders++;
  const [n, set] = useState(0);
  strictBump = () => set((x) => x + 1);
  useDebugValue(`n=${n}`);
  return h("q", null, String(n));
}

Deno.test("useDebugValue: StrictMode's second pass and a re-render do not duplicate records", () => {
  withDev(() => {
    strictRenders = 0;
    mount(h(StrictMode, null, h(Strict, null)));
    assert(strictRenders >= 2, "StrictMode double-rendered");
    assertEquals(fiberOf(Strict).debugValues?.map((e) => e.value), ["n=0"]);
    strictBump();
    flushSync();
    assertEquals(fiberOf(Strict).debugValues?.map((e) => e.value), ["n=1"]);
  });
});

Deno.test("useDebugValue: Fast Refresh keeps state when an edit adds a call", () => {
  withDev(() => {
    const { doc, container } = makeDom();
    setDocument(asAny(doc));
    setFamilyMatch(sameFamily);
    let reloads = 0;
    setSignatureChangeHandler(() => reloads++);
    try {
      let bump: () => void = () => {};
      const V1 = (): VNode => {
        const [n, set] = useState(0);
        bump = () => set((x) => x + 1);
        return h("span", null, "v1:", String(n));
      };
      registerFamily(V1, "file:///app/Edit.tsx#Edit");
      createRoot(asAny(container)).render(h(V1, null));
      flushSync();
      bump();
      bump();
      flushSync();

      // The edit adds a useDebugValue — no cell, so the signature is unchanged.
      const V2 = (): VNode => {
        const [n, set] = useState(0);
        bump = () => set((x) => x + 1);
        useDebugValue(`count ${n}`);
        return h("span", null, "v2:", String(n));
      };
      registerFamily(V2, "file:///app/Edit.tsx#Edit");
      createRoot(asAny(container)).render(h(V2, null));
      flushSync();
      assertEquals(container.innerHTML, "<span>v2:2</span>", "state survived the edit");
      assertEquals(reloads, 0, "no signature change reported");
      assertEquals(fiberOf(V2).debugValues?.map((e) => e.value), ["count 2"]);

      // Control: an edit that adds a real cell IS a signature change (the guard is live).
      const V3 = (): VNode => {
        const [n] = useState(0);
        useState(0);
        return h("span", null, "v3:", String(n));
      };
      registerFamily(V3, "file:///app/Edit.tsx#Edit");
      createRoot(asAny(container)).render(h(V3, null));
      flushSync();
      assertEquals(reloads, 1);
    } finally {
      setFamilyMatch(null);
      setSignatureChangeHandler(null);
    }
  });
});

// ---- the snapshot + MCP ------------------------------------------------------

/** A snapshot body with one component whose single hook carries `debug`. */
function bodyWithDebug(debug: unknown): string {
  return JSON.stringify({
    url: "/",
    nodes: [{
      id: 1,
      name: "Big",
      key: null,
      props: { preview: "{}", type: "object" },
      hooks: [{ index: 0, kind: "state", value: { preview: "1", type: "number" }, debug }],
      contexts: [],
      children: [],
    }],
  });
}

/** How many `entries` levels a value nests. */
function depthOf(v: { entries?: Array<{ value: unknown }> } | undefined): number {
  const first = v?.entries?.[0]?.value as { entries?: Array<{ value: unknown }> } | undefined;
  return v?.entries ? 1 + depthOf(first) : 0;
}

Deno.test("snapshot: a huge debug value is capped like any hook value, strings redacted", () => {
  type Nested = { preview: string; type: string; entries?: Array<{ key: string; value: Nested }> };
  let deep: Nested = { preview: "leaf", type: "number" };
  for (let i = 0; i < 10; i++) {
    deep = { preview: "x", type: "array", entries: [{ key: "0", value: deep }] };
  }
  const huge = { ...deep, preview: "y".repeat(10_000) };
  const big = parseSnapshot(bodyWithDebug(huge))!.nodes[0].hooks[0].debug!;
  assert(big.preview.length <= 512, "preview clamped");
  assert(depthOf(big) <= 4, `entries depth capped (got ${depthOf(big)})`);

  // A page that sent string CONTENTS (an unredacted debug) never gets them stored.
  const leaked = { preview: '"hunter2"', type: "string", raw: "hunter2" };
  const stored = parseSnapshot(bodyWithDebug(leaked))!.nodes[0].hooks[0].debug!;
  assertEquals(stored.preview, "string(7)");
  assert(!JSON.stringify(stored).includes("hunter2"));
  // A debug that is not an object is dropped, not stored.
  assertEquals(parseSnapshot(bodyWithDebug("nope"))!.nodes[0].hooks[0].debug, undefined);
});

Deno.test("hookStateText: prints a cell's debug value (and several as a list)", () => {
  const snapshot: InspectSnapshot = {
    url: "/",
    at: Date.now(),
    truncated: false,
    nodes: [{
      id: 4,
      name: "Online",
      key: null,
      props: { preview: "{}", type: "object" },
      hooks: [
        {
          index: 0,
          kind: "state",
          value: { preview: "true", type: "boolean" },
          editable: true,
          debug: { preview: "string(6)", type: "string" },
        },
        {
          index: 1,
          kind: "state",
          value: { preview: "1", type: "number" },
          editable: true,
          debug: {
            preview: "Array(2)",
            type: "array",
            size: 2,
            entries: [
              { key: "0", value: { preview: "string(1)", type: "string" } },
              { key: "1", value: { preview: "2", type: "number" } },
            ],
          },
        },
        { index: 2, kind: "state", value: { preview: "0", type: "number" }, editable: true },
      ],
      contexts: [],
      children: [],
    }],
  };
  const text = hookStateText({ snapshot, ageMs: 10 }, "Online");
  assertStringIncludes(text, "  [0] state = true  debug=string(6)");
  assertStringIncludes(text, "  [1] state = 1  debug=[string(1), 2]");
  assert(!text.split("\n").find((l) => l.includes("[2]"))!.includes("debug="));
});

Deno.test("sink → dev server → MCP: the debug value arrives, its string contents do not", () => {
  withDev(() => {
    mount(h(Status, null));
    const api = installInspector()!;
    const stored = parseSnapshot(JSON.stringify(buildSnapshot(api)))!;
    const inspect = { snapshot: stored, ageMs: 1 };
    const text = hookStateText(inspect, "Status");
    assertStringIncludes(text, "debug=string(6)"); // "Online", redacted to its length
    assert(!text.includes('Online"'), "string contents never reach the agent");
  });
});

// ---- the panel ---------------------------------------------------------------

function queryAll(root: FakeNode, pred: (e: FakeElement) => boolean): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (n: FakeNode) => {
    if ((n as FakeElement).tagName !== undefined && pred(n as FakeElement)) {
      out.push(n as FakeElement);
    }
    for (const c of n.childNodes) walk(c);
  };
  walk(root);
  return out;
}

Deno.test("panel: the hook's detail shows a `debug` line", () => {
  const prevDev = g.__denextDev;
  const prevRaf = g.requestAnimationFrame;
  g.__denextDev = true;
  g.requestAnimationFrame = (cb: () => void) => {
    cb();
    return 0;
  };
  try {
    const doc = new FakeDocument();
    setDocument(asAny(doc));
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    createRoot(asAny(container)).render(h(Status, null));
    flushSync();
    const api = installInspector()!;
    mountPanel(api, asAny(doc));
    doc.dispatch("keydown", { ctrlKey: true, shiftKey: true, key: "d" });
    try {
      const row = queryAll(
        doc.body,
        (e) =>
          e.tagName === "DIV" && e.style.cssText.includes("cursor:pointer") &&
          e.textContent.includes("Status"),
      ).at(-1);
      assert(row, "Status has a tree row");
      row!.dispatch("click");
      const lines = queryAll(
        doc.body,
        (e) => e.tagName === "DIV" && e.textContent === 'debug"Online"',
      );
      assertEquals(lines.length, 1, "one debug line, under the custom hook's row");
    } finally {
      doc.dispatch("keydown", { ctrlKey: true, shiftKey: true, key: "d" });
    }
  } finally {
    g.__denextDev = prevDev;
    if (prevRaf === undefined) delete g.requestAnimationFrame;
    else g.requestAnimationFrame = prevRaf;
    clearComponentMeta();
  }
});
