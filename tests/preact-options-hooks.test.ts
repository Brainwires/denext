// Preact's `options` hooks the reconciler calls: `_render` / `__r`, `diffed`, `_commit` / `__c`,
// `unmount`, `debounceRendering` and `requestAnimationFrame` — at the points Preact 10's diff
// calls them (src/diff/index.js: `options._render` before a component renders, `options.diffed`
// once a vnode's subtree is diffed, children first; src/diff/index.js `unmount()`: the hook
// before the children, then the cleanups; src/component.js `enqueueRender`:
// `(options.debounceRendering || defer)(process)`; hooks/src/index.js `afterPaint`:
// `(options.requestAnimationFrame || afterNextFrame)(flushAfterPaintEffects)`).

import { assert, assertEquals } from "@std/assert";
import { setDocument } from "../src/client/reconciler.ts";
import { DomDocument } from "../src/testing/dom.ts";
import { act } from "../src/client/mod.ts";
import { render } from "../src/compat/preact/compat.ts";
import { h } from "../src/compat/preact/mod.ts";
import { useEffect, useState } from "../src/compat/preact/hooks.ts";
import { options } from "../src/compat/preact/options.ts";

function container(): Element {
  const doc = new DomDocument();
  setDocument(doc as unknown as Parameters<typeof setDocument>[0]);
  return doc.createElement("div") as unknown as Element;
}

/** The name a vnode logs under: its tag, its component's name, or `#text`. */
function nameOf(vnode: unknown): string {
  const t = (vnode as { type?: unknown } | null)?.type;
  if (typeof t === "string") return t;
  if (typeof t === "function") return t.name;
  return "#text";
}

/** Set some options hooks for one test, restoring the object after. */
async function withOptions(hooks: Record<string, unknown>, fn: () => Promise<void>): Promise<void> {
  const o = options as Record<string, unknown>;
  Object.assign(o, hooks);
  try {
    await fn();
  } finally {
    for (const k of Object.keys(hooks)) delete o[k];
  }
}

Deno.test("options._render / __r runs before each component render; diffed after its DOM, children first", async () => {
  const log: string[] = [];
  const el = container();
  function Item({ n }: { n: number }) {
    log.push(`render Item${n}`);
    return h("li", null, `i${n}`);
  }
  function List() {
    log.push("render List");
    return h("ul", null, h(Item, { n: 1 }), h(Item, { n: 2 }));
  }
  await withOptions({
    __r: (v: unknown) => log.push(`__r ${nameOf(v)}`),
    diffed: (v: unknown) => {
      if (nameOf(v) === "List") log.push(`diffed List (dom: ${el.innerHTML.length > 0})`);
      else if (nameOf(v) !== "#text") log.push(`diffed ${nameOf(v)}`);
    },
    __c: (v: unknown, q: unknown[]) => log.push(`__c ${Array.isArray(q)}${v ? "" : " no root"}`),
  }, async () => {
    await act(() => {
      render(h(List, null), el);
    });
  });
  assertEquals(log, [
    "__r List",
    "render List",
    "__r Item",
    "render Item1",
    "__r Item",
    "render Item2",
    "diffed li",
    "diffed Item",
    "diffed li",
    "diffed Item",
    "diffed ul",
    "diffed List (dom: true)",
    "__c true",
  ]);
});

// Preact runs a component's hook cleanups inside its own `options.unmount` before the children's;
// denext keeps React's cleanup order (children first), so the hook sees every removed vnode
// parent first, and the cleanups follow.
Deno.test("options.unmount: each removed vnode, parent before child", async () => {
  const log: string[] = [];
  const el = container();
  function Leaf() {
    useEffect(() => () => {
      log.push("cleanup Leaf");
    }, []);
    return h("b", null, "x");
  }
  let hide: () => void = () => {};
  function App() {
    const [show, setShow] = useState(true);
    hide = () => setShow(false);
    return h("div", null, show ? h("section", null, h(Leaf, null)) : null);
  }
  await act(() => {
    render(h(App, null), el);
  });
  await withOptions({
    unmount: (v: unknown) => {
      if (nameOf(v) !== "#text") log.push(`unmount ${nameOf(v)}`);
    },
  }, async () => {
    await act(() => hide());
  });
  assertEquals(log, ["unmount section", "unmount Leaf", "unmount b", "cleanup Leaf"]);
  assertEquals(el.innerHTML, "<div></div>");
});

Deno.test("options.debounceRendering schedules an update's render", async () => {
  const el = container();
  const queued: Array<() => void> = [];
  let bump: () => void = () => {};
  function Counter() {
    const [n, setN] = useState(0);
    bump = () => setN((v) => v + 1);
    return h("p", null, `n${n}`);
  }
  await act(() => {
    render(h(Counter, null), el);
  });
  await withOptions({ debounceRendering: (cb: () => void) => queued.push(cb) }, async () => {
    bump();
    await new Promise((r) => setTimeout(r, 5));
    assertEquals(el.innerHTML, "<p>n0</p>"); // not rendered until the hook runs the callback
    assertEquals(queued.length, 1);
    queued.shift()!();
    assertEquals(el.innerHTML, "<p>n1</p>");
  });
});

Deno.test("options.requestAnimationFrame schedules the useEffect flush", async () => {
  const el = container();
  const frames: Array<() => void> = [];
  const ran: string[] = [];
  function Effectful() {
    useEffect(() => {
      ran.push("effect");
    }, []);
    return h("i", null);
  }
  await withOptions({ requestAnimationFrame: (cb: () => void) => frames.push(cb) }, async () => {
    render(h(Effectful, null), el);
    await new Promise((r) => setTimeout(r, 5));
    assertEquals(el.innerHTML, "<i></i>");
    assertEquals(ran, []); // waiting for the frame
    assert(frames.length >= 1);
    for (const f of frames.splice(0)) f();
    assertEquals(ran, ["effect"]);
  });
});
