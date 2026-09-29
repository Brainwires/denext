// VirtualList on the server and at the edges of the client: SSR renders the first window
// (initialScrollIndex / anchor-end aware) laid out at physical 0 so it paints without script;
// hydration adopts the server rows without a mismatch and without moving them; the auto-memo
// compiler path keeps the list live; and an app that never imports the list bundles none of it.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import * as esbuild from "esbuild";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { hydrateRoot, setDocument } from "../src/client/reconciler.ts";
import { act, render } from "../src/testing/mod.ts";
import { fireEventOn, walkElements } from "../src/testing/dom.ts";
import type { DomEl } from "../src/testing/dom.ts";
import { transformModule } from "../src/build/compiler.ts";
import { VirtualList } from "../src/client/virtual/virtual-list.ts";
import { VirtualController } from "../src/client/virtual/controller.ts";
import { px } from "../src/client/virtual/shared.ts";
import type { VirtualListProps } from "../src/client/virtual/types.ts";
import { FakeDocument, type FakeElement } from "./helpers/dom.ts";

type Row = { id: string; text: string };
const rows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, text: `row ${i}` }));
const list = <T>(props: VirtualListProps<T>): VNode =>
  h(
    VirtualList as unknown as (p: Record<string, unknown>) => VNode,
    props as unknown as Record<string, unknown>,
  );

/** Row indices in server markup, in order. */
const ssrIndices = (html: string): number[] =>
  [...html.matchAll(/data-index="(\d+)"/g)].map((m) => Number(m[1]));

Deno.test("SSR: renders the first window at initialScrollIndex, laid out at physical 0 (J1, C2, T32)", async () => {
  const html = await renderToString(list({
    data: rows(10_000),
    getItemSize: () => 30,
    viewportSize: 300,
    initialScrollIndex: 5000,
    renderItem: (r: Row) => h("span", null, r.text),
  }));
  const idx = ssrIndices(html);
  assert(
    idx.includes(5000) && idx.includes(5009),
    `the target window is in the markup (${idx[0]}…)`,
  );
  // The overscan rows before the target sit at a negative margin, so with scrollTop 0 (no
  // script) the first row shown is row 5000.
  const margin = Number(/margin-top:(-?[\d.]+)px/.exec(html)![1]);
  const before = idx.indexOf(5000);
  assertEquals(margin + before * 30, 0, "row 5000 is at physical 0");
  assert(before * 30 <= 300, "at most one viewport of overscan rows precede the target");
  assertStringIncludes(html, 'role="list"');
  assertStringIncludes(html, 'aria-setsize="10000"');
  assertEquals(html.includes("until-found"), false, "find stubs are client-only");
});

Deno.test("SSR: anchor end renders the last rows (chat)", async () => {
  const html = await renderToString(list({
    data: rows(500),
    anchor: "end",
    getItemSize: () => 40,
    viewportSize: 400,
    renderItem: (r: Row) => h("span", null, r.text),
  }));
  const idx = ssrIndices(html);
  assert(idx.includes(499) && idx.includes(490), `the end of the thread (${idx.join(",")})`);
  assert(!idx.includes(0), "not the start");
});

// ---- hydration ------------------------------------------------------------------------------

/** Parse denext's own SSR markup into the fake DOM (tags, quoted attributes, text). */
function parseInto(doc: FakeDocument, parent: FakeElement, html: string): void {
  const stack: FakeElement[] = [parent];
  const re =
    /<\/([a-z0-9-]+)>|<([a-z0-9-]+)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:="[^"]*")?)*)\s*>|([^<]+)/g;
  const decode = (s: string) =>
    s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  for (const m of html.matchAll(re)) {
    if (m[1]) stack.pop();
    else if (m[2]) {
      const el = doc.createElement(m[2]);
      for (const a of (m[3] ?? "").matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g)) {
        el.setAttribute(a[1], decode(a[2] ?? ""));
      }
      stack[stack.length - 1].appendChild(el);
      stack.push(el);
    } else if (m[4]) stack[stack.length - 1].appendChild(doc.createTextNode(decode(m[4])));
  }
}

Deno.test("hydration: adopts the server rows with no mismatch and no visual move (J1, T32)", async () => {
  const props = {
    data: rows(10_000),
    getItemSize: () => 30,
    viewportSize: 300,
    initialScrollIndex: 5000,
    renderItem: (r: Row) => h("span", null, r.text),
  };
  const html = await renderToString(list(props));
  const doc = new FakeDocument();
  const container = doc.createElement("div");
  parseInto(doc, container, html);
  const scroller = container.childNodes[0] as FakeElement & { scrollTop?: number };
  const win = (): FakeElement =>
    walkElementsFake(container).find((e) => e.getAttribute("role") === "list")!;
  const rowEl = (i: number) =>
    walkElementsFake(container).find((e) => e.getAttribute("data-index") === String(i));
  const server5000 = rowEl(5000);
  const visualTop = () =>
    marginTop(win()) + offsetInWindow(win(), 5000) - (scroller.scrollTop ?? 0);
  assertEquals(visualTop(), 0, "server markup shows row 5000 at the top");

  const warnings: string[] = [];
  const warn = console.warn;
  const error = console.error;
  console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
  console.error = (...a: unknown[]) => warnings.push(a.join(" "));
  (globalThis as { __denextDev?: boolean }).__denextDev = true;
  setDocument(doc as never);
  let root: { unmount(): void } | undefined;
  try {
    await act(() => {
      root = hydrateRoot(container as never, list(props)) as unknown as { unmount(): void };
    });
  } finally {
    console.warn = warn;
    console.error = error;
    delete (globalThis as { __denextDev?: boolean }).__denextDev;
  }
  assertEquals(warnings.filter((w) => /hydrat|mismatch/i.test(w)), [], "no hydration mismatch");
  assert(rowEl(5000) === server5000, "the server's row element was adopted, not re-created");
  assertEquals(scroller.scrollTop, 150_000, "the real scroll offset was reconciled");
  assertEquals(visualTop(), 0, "row 5000 did not move");
  await act(() => root!.unmount());
});

Deno.test("hydration: the server's inner size equals the client's first render (variable hints, no budget-dependent seeding)", async () => {
  // Variable exact sizes over ≤ 50k rows: hint seeding must not run before hydration, or the
  // server and client would lay out different totals depending on how fast each seeded.
  const size = (i: number) => 20 + (i % 7) * 13;
  const props = {
    data: rows(40_000),
    getItemSize: (_r: Row, i: number) => size(i),
    viewportSize: 300,
    renderItem: (r: Row) => h("span", null, r.text),
  };
  const html = await renderToString(list(props));
  const serverInner = /data-vl-inner[^>]*style="[^"]*height:([\d.]+)px/.exec(html) ??
    /style="[^"]*height:([\d.]+)px[^"]*"[^>]*data-vl-inner/.exec(html);
  assert(serverInner, "the server markup carries the inner size");
  // The client's first render on a slow device: its render-phase sizes (what the inner style
  // is rendered from) with a clock that advances 50 ms per read — any time-budgeted seeding in
  // the render would stop at once and lay out a different total than the server did.
  const perf = globalThis.performance;
  let t = 0;
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: { now: () => (t += 50) },
  });
  let clientFirst: number;
  try {
    const ctl = new VirtualController<Row>("flow");
    ctl.sync(props as never);
    clientFirst = ctl.core.physicalSize();
  } finally {
    Object.defineProperty(globalThis, "performance", { configurable: true, value: perf });
  }
  assertEquals(
    px(clientFirst),
    `${serverInner[1]}px`,
    "the client's first render lays out the same size",
  );
  const doc = new FakeDocument();
  const container = doc.createElement("div");
  parseInto(doc, container, html);
  const inner = () =>
    walkElementsFake(container).find((e) => e.getAttribute("data-vl-inner") !== null)!;
  const serverHeight = /height:\s*([\d.]+)px/.exec(inner().getAttribute("style") ?? "")![1];
  const warnings: string[] = [];
  const warn = console.warn;
  const error = console.error;
  console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
  console.error = (...a: unknown[]) => warnings.push(a.join(" "));
  (globalThis as { __denextDev?: boolean }).__denextDev = true;
  setDocument(doc as never);
  let root: { unmount(): void } | undefined;
  try {
    await act(() => {
      root = hydrateRoot(container as never, list(props)) as unknown as { unmount(): void };
    });
  } finally {
    console.warn = warn;
    console.error = error;
    delete (globalThis as { __denextDev?: boolean }).__denextDev;
  }
  assertEquals(serverHeight, serverInner[1]);
  assertEquals(warnings.filter((w) => /hydrat|mismatch/i.test(w)), [], "no hydration mismatch");
  // After the commit the hints are applied (exact total), so the size may now differ.
  const total = Array.from({ length: 40_000 }, (_, i) => size(i)).reduce((a, b) => a + b, 0);
  const after = Number(/height:\s*([\d.]+)px/.exec(inner().getAttribute("style") ?? "")![1]);
  assertEquals(after, total, "every hint applied after the commit");
  await act(() => root!.unmount());
});

function walkElementsFake(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const visit = (n: FakeElement) => {
    for (const c of n.childNodes) {
      if ((c as FakeElement).tagName) {
        out.push(c as FakeElement);
        visit(c as FakeElement);
      }
    }
  };
  visit(root);
  return out;
}

function marginTop(el: FakeElement): number {
  const m = /margin-top:\s*(-?[\d.]+)px/.exec(el.getAttribute("style") ?? "");
  return m ? Number(m[1]) : 0;
}

/** A row's offset inside the flow window (30 px rows). */
function offsetInWindow(win: FakeElement, index: number): number {
  let y = 0;
  for (const c of win.childNodes) {
    const el = c as FakeElement;
    if (el.getAttribute?.("data-index") === String(index)) return y;
    y += 30;
  }
  return NaN;
}

// ---- auto-memo compiler ------------------------------------------------------------------------

Deno.test("React Compiler / auto-memo: a compiled parent keeps the list live (A7, T31)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_vlist_compiler_" });
  try {
    const source = `import { useState, VirtualList } from "denext";
export function App() {
  const [n, setN] = useState(5);
  const data = Array.from({ length: n }, (_, i) => ({ id: "k" + i, text: "row " + i }));
  return (
    <div>
      <button onClick={() => setN(n + 1000)}>more</button>
      <VirtualList data={data} getItemSize={() => 20} viewportSize={200} renderItem={(r) => <span>{r.text}</span>} />
    </div>
  );
}
`;
    const path = join(dir, "app.tsx");
    const { code, changed } = await transformModule(source, toFileUrl(path).href);
    assert(changed, "the compiler memoized something");
    assertStringIncludes(code, "_dnxUseMemoCache(");
    await Deno.writeTextFile(path, code);
    const mod = await import(toFileUrl(path).href);
    const screen = await render(h(mod.App, null));
    const idx = () =>
      walkElements(screen.container as DomEl).filter((e) => e.getAttribute("data-vl-row") !== null)
        .map((e) => Number(e.getAttribute("data-index")));
    assertEquals(idx(), [0, 1, 2, 3, 4]);
    await screen.fireEvent.click(screen.getByRole("button"));
    assert(idx().length > 5 && idx().length < 40, "new data rendered, still virtualized");
    // The list's own state (scroll range) keeps updating under the compiled parent.
    const scroller = walkElements(screen.container as DomEl).find((e) =>
      e.getAttribute("data-denext-virtual-list") !== null
    )!;
    (scroller as unknown as { scrollTop: number }).scrollTop = 20 * 500;
    await act(() => fireEventOn(scroller, "scroll"));
    assert(idx().includes(500), "no stale virtual items after a scroll");
    await screen.unmount();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- tree-shaking --------------------------------------------------------------------------------

const MOD = new URL("../mod.ts", import.meta.url).pathname;

/** Bundle `entry` source (importing from the real `mod.ts`); bare specifiers stay external. */
async function bundle(entry: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_vlist_shake_" });
  try {
    const file = join(dir, "entry.ts");
    await Deno.writeTextFile(file, entry);
    const result = await esbuild.build({
      entryPoints: [file],
      bundle: true,
      write: false,
      format: "esm",
      treeShaking: true,
      minify: false,
      logLevel: "silent",
      plugins: [{
        name: "externals",
        setup(b) {
          b.onResolve({ filter: /^[^./]/ }, (args) => ({ path: args.path, external: true }));
        },
      }],
    });
    return new TextDecoder().decode(result.outputFiles![0].contents);
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("tree-shaking: an app that does not import VirtualList bundles none of it", async () => {
  const without = await bundle(
    `import { useState } from ${JSON.stringify(MOD)};\nglobalThis.x = useState;\n`,
  );
  for (const marker of ["data-denext-virtual-list", "data-vl-row", "until-found", "RecyclePool"]) {
    assertEquals(
      without.includes(marker),
      false,
      `"${marker}" leaked into a bundle that never imports the list`,
    );
  }
  const withList = await bundle(
    `import { VirtualList } from ${JSON.stringify(MOD)};\nglobalThis.x = VirtualList;\n`,
  );
  assertStringIncludes(
    withList,
    "data-denext-virtual-list",
    "positive control: importing it bundles it",
  );
});
