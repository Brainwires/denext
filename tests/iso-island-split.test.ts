// Split islands on isomorphic (non-Flight) routes. The build points a `client:*` element whose
// component is imported only for directive elements at an `isoIslandChunk` stand-in and drops the
// import, so the component leaves the page bundle (src/build/iso-islands.ts). In the browser the
// stand-in renders as the island wrapper: nothing of the component loads until the strategy
// fires; then its chunk is imported and its children hydrate against the server DOM in the
// page's tree, with the page's context and the element's props.

import "./helpers/class-runtime.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { useContext, useLayoutEffect, useState } from "../src/runtime/hooks.ts";
import { useId } from "../src/runtime/hooks/use-id.ts";
import { createContext } from "../src/runtime/context.ts";
import { Component } from "../src/compat/react.ts";
import { createRoot, flushSync, hydrateRoot, setDocument } from "../src/client/reconciler.ts";
import { installIsoIslands, isoIslandChunk } from "../src/client/iso-island.ts";
import { resetLazyIslands, setLazyScheduler } from "../src/client/lazy-hydrate.ts";
import { setIslandRender } from "../src/client/fiber/render-component.ts";
import { setIslandHydration } from "../src/client/fiber/hydration.ts";
import { DomDocument, type DomEl, fireEventOn } from "../src/testing/dom.ts";
import type { VNode } from "../src/jsx/types.ts";
import { transformIsoIslands } from "../src/build/iso-islands.ts";
import { clientTransforms } from "../src/build/build-pipeline/transforms.ts";
import { computeBoundaryRoutes, resetModuleGraphCache } from "../src/build/module-graph.ts";
import { resolveProject } from "../src/build/paths.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { serverDom } from "./helpers/server-dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const Theme = createContext("light");

function Counter({ start, label }: { start: number; label: string }): VNode {
  const [n, setN] = useState(start);
  const theme = useContext(Theme);
  const id = useId();
  return h("button", { id, onClick: () => setN(n + 1) }, `${label} ${theme} ${n}`);
}

/** The page: a context provider, a handler of its own, and the island (`C`) with props. */
function Page(
  { C, strategy, onPage }: { C: unknown; strategy: string; onPage?: () => void },
): VNode {
  return h(
    Theme.Provider,
    { value: "dark" },
    h(
      "main",
      { onClick: onPage },
      h("h1", null, "page"),
      h(C as never, { [`client:${strategy}`]: true, start: 1, label: "c" }),
    ),
  );
}

/** A stand-in whose chunk the test resolves, counting imports. */
function chunk(component: unknown = Counter) {
  let resolve: (c: unknown) => void = () => {};
  const loaded = new Promise((r) => (resolve = r));
  let imports = 0;
  const C = isoIslandChunk(() => {
    imports++;
    return loaded;
  });
  return { C, imports: () => imports, land: () => resolve(component) };
}

/** A scheduler whose `visible` trigger the test fires. */
function manualVisible() {
  let fire: () => void = () => {};
  setLazyScheduler({
    idle: (cb) => cb(),
    visible: (_el, cb) => {
      fire = cb;
      return () => {};
    },
    media: (_q, cb) => {
      cb();
      return () => {};
    },
  });
  return () => fire();
}

const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/** Hydrate the server render of `Page` (with `Counter`) on the client with `C` in its place. */
async function hydrated(C: unknown, strategy: string, onPage?: () => void) {
  const html = await renderToString(h(Page, { C: Counter, strategy }));
  const { doc, container } = serverDom(html);
  setDocument(doc as Any);
  installIsoIslands();
  const mismatches: unknown[] = [];
  hydrateRoot(container as Any, h(Page, { C, strategy, onPage }), {
    onRecoverableError: (e: unknown) => mismatches.push(e),
  } as Any);
  flushSync();
  const main = container.children[0];
  const button = main.children[1].children[0] as DomEl;
  return { container, main, button, html, mismatches };
}

function teardown() {
  setIslandRender(null);
  setIslandHydration(null);
  resetLazyIslands();
  setLazyScheduler();
}

Deno.test("split client:visible: no import until visible, then hydrates the same nodes with the page's context", async () => {
  const fire = manualVisible();
  const { C, imports, land } = chunk();
  try {
    const { container, main, button, html, mismatches } = await hydrated(C, "visible");
    assertEquals(imports(), 0, "the page hydrated without importing the island's chunk");
    assertEquals(main.children[1].getAttribute("data-dnx-island"), "", "the wrapper is kept");
    fireEventOn(button, "click");
    flushSync();
    assertEquals(button.textContent, "c dark 1", "inert before its trigger");
    fire();
    assertEquals(imports(), 1, "the trigger imports the chunk");
    await tick();
    assertEquals(button.textContent, "c dark 1", "still inert while the chunk loads");
    land();
    await tick();
    assert(main.children[1].children[0] === button, "the server's <button> was adopted");
    assertEquals(container.innerHTML, html, "hydration changed nothing (props, context, useId)");
    fireEventOn(button, "click");
    flushSync();
    assertEquals(button.textContent, "c dark 2", "live once hydrated");
    assertEquals(mismatches, [], "no hydration mismatch");
  } finally {
    teardown();
  }
});

Deno.test("split client:interaction: the gesture waits for the chunk, then reaches the island once and the page once", async () => {
  manualVisible();
  const { C, imports, land } = chunk();
  let pageClicks = 0;
  try {
    const { button } = await hydrated(C, "interaction", () => pageClicks++);
    // The testing DOM has no dispatchEvent: replay through the same propagation.
    class Replayed {
      constructor(readonly type: string) {}
    }
    (button as Any).dispatchEvent = (e: Replayed) => (fireEventOn(button, e.type), true);
    fireEventOn(button, "click", { constructor: Replayed });
    flushSync();
    assertEquals(imports(), 1, "the interaction imports the chunk");
    assertEquals(pageClicks, 0, "held at the wrapper while the chunk loads");
    land();
    await tick();
    flushSync();
    assertEquals(button.textContent, "c dark 2", "the click reached the island's handler");
    assertEquals(pageClicks, 1, "and the page's handler, once");
  } finally {
    teardown();
  }
});

Deno.test("split client:load and client:only import their chunk after the page", async () => {
  for (const strategy of ["load", "only"]) {
    manualVisible();
    const { C, imports, land } = chunk();
    try {
      const html = await renderToString(h(Page, { C: Counter, strategy }));
      const { doc, container } = serverDom(html);
      setDocument(doc as Any);
      installIsoIslands();
      hydrateRoot(container as Any, h(Page, { C, strategy }));
      flushSync();
      assertEquals(imports(), 1, `${strategy}: imported once the page hydrated`);
      land();
      await tick();
      const wrapper = container.children[0].children[1];
      assertEquals(wrapper.children[0]?.textContent, "c dark 1", `${strategy}: live`);
    } finally {
      teardown();
    }
  }
});

Deno.test("a split client:load island's import starts with the page's render, before its commit", async () => {
  manualVisible();
  const { C, imports, land } = chunk();
  let atCommit = -1;
  // A sibling before the island: its layout effect runs before the island's own.
  function Probe(): VNode {
    useLayoutEffect(() => void (atCommit = imports()), []);
    return h("i", null);
  }
  const page = (c: unknown) =>
    h("main", null, h(Probe, null), h(c as never, { "client:load": true, start: 1, label: "c" }));
  try {
    const { doc, container } = serverDom(await renderToString(page(Counter)));
    setDocument(doc as Any);
    installIsoIslands();
    hydrateRoot(container as Any, page(C));
    flushSync();
    assertEquals(atCommit, 1, "the chunk was already being fetched when the page committed");
    land();
    await tick();
    assertEquals(container.children[0].children[1].children[0]?.textContent, "c light 1");
  } finally {
    teardown();
  }
});

Deno.test("a split island that mounts on the client alone renders once its chunk lands", async () => {
  const { C, imports, land } = chunk();
  try {
    const doc = new DomDocument();
    const container = doc.createElement("div");
    setDocument(doc as Any);
    installIsoIslands();
    createRoot(container as Any).render(h(Page, { C, strategy: "visible" }) as never);
    flushSync();
    const wrapper = container.children[0].children[1];
    assertEquals(wrapper.children.length, 0, "empty until the chunk lands");
    assertEquals(imports(), 1);
    land();
    await tick();
    flushSync();
    assertEquals(wrapper.children[0]?.textContent, "c dark 1");
  } finally {
    teardown();
  }
});

/** A class the server renders eagerly (no island wrapper). */
class Clicks extends Component<{ label: string }, { n: number }> {
  override state = { n: 0 };
  override render() {
    return h("button", { onClick: () => this.setState({ n: this.state.n + 1 }) }, [
      `${this.props.label} ${this.state.n}`,
    ]);
  }
}

Deno.test("a split class island the server rendered eagerly hydrates once its chunk lands", async () => {
  const { C, land } = chunk(Clicks);
  try {
    const html = await renderToString(h(Page, { C: Clicks, strategy: "visible" }));
    assert(!html.includes("data-dnx-island"), "the server rendered the class eagerly");
    const { doc, container } = serverDom(html);
    setDocument(doc as Any);
    installIsoIslands();
    hydrateRoot(container as Any, h(Page, { C, strategy: "visible" }));
    flushSync();
    const button = container.children[0].children[1] as DomEl;
    assertEquals(button.tagName, "BUTTON");
    land();
    await tick();
    flushSync();
    assert(container.children[0].children[1] === button, "the server's <button> was adopted");
    fireEventOn(button, "click");
    flushSync();
    assertEquals(button.textContent, "c 1");
  } finally {
    teardown();
  }
});

Deno.test("transformIsoIslands: a directive-only import becomes a chunk stand-in; others stay", async () => {
  const src = `import { useState } from "denext";
import Chart from "./chart.tsx";
import { Mixed } from "./mixed.tsx";
export default function Page() {
  const [n] = useState(0);
  return <main><Chart client:visible n={n}>x</Chart><Mixed client:idle /><Mixed /></main>;
}
`;
  const { code, changed, islands, split } = await transformIsoIslands(src);
  assert(changed);
  assertEquals(islands, 1);
  assertEquals(split, ["./chart.tsx"]);
  assertStringIncludes(
    code,
    `import { isoIslandChunk as __dnxIsoChunk } from "denext/iso-island";`,
  );
  assertStringIncludes(
    code,
    `const __DnxIso0 = /* @__PURE__ */ __dnxIsoChunk(() => import("./chart.tsx").then((m) => m["default"]));`,
  );
  assertStringIncludes(code, `<__DnxIso0 client:visible n={n}>x</__DnxIso0>`);
  assert(!code.includes(`import Chart from`), "the static import is dropped");
  assertStringIncludes(code, `<Mixed client:idle /><Mixed />`, "a mixed use stays in place");
  assertStringIncludes(code, `import { Mixed } from "./mixed.tsx";`);
  const none = await transformIsoIslands(`import { M } from "./m.tsx";\n<M client:idle />; M;\n`);
  assertEquals(none.changed, false, "nothing to split: the module is left as written");
});

Deno.test("clientTransforms: an isomorphic route's islands split; a module a Flight route reaches does not", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_iso_split_" }));
  const files: Record<string, string> = {
    "app/page.tsx": `import { useState } from "denext";
import { Chart } from "../components/chart.tsx";
export default function Page() {
  const [n] = useState(0);
  return <main><Chart client:visible n={n} /></main>;
}
`,
    "components/chart.tsx": `export function Chart({ n }: { n: number }) { return <p>{n}</p>; }\n`,
    "app/flight/page.tsx":
      `import { W } from "./w.tsx";\nexport default function F() { return <W />; }\n`,
    "app/flight/w.tsx": `"use client";
import { Chart } from "../../components/chart.tsx";
export function W() { return <Chart client:idle n={1} />; }
`,
  };
  try {
    for (const [name, src] of Object.entries(files)) {
      await Deno.mkdir(join(dir, name, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, name), src);
    }
    const paths = await resolveProject(dir);
    const manifest = await scanRoutes(paths.appDir);
    const flightRoutes = await computeBoundaryRoutes(paths.appDir, manifest.pages);
    assertEquals([...flightRoutes], ["/flight"]);
    const map = await clientTransforms({ projectDir: dir, paths, manifest, flightRoutes });
    const url = (p: string) => toFileUrl(join(dir, p)).href;
    assert(map[url("app/page.tsx")], "the isomorphic page's island was split");
    const code = await Deno.readTextFile(new URL(map[url("app/page.tsx")]));
    assertStringIncludes(code, `import(${JSON.stringify(url("components/chart.tsx"))})`);
    assertStringIncludes(code, "<__DnxIso0 client:visible");
    assertEquals(map[url("app/flight/w.tsx")], undefined, "a Flight route's module is left alone");
  } finally {
    resetModuleGraphCache();
    await Deno.remove(dir, { recursive: true });
  }
});
