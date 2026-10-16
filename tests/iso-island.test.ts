// Per-island hydration on the isomorphic (non-Flight) path. The server renders a `client:*`
// component element inside the island wrapper; the page hydrates around it (adopting the wrapper,
// leaving its server DOM alone), and when the strategy fires the island's children hydrate
// against that DOM in the same tree: the same nodes, the page's context, and for
// `client:interaction` the very event that triggered it reaches the island's handler.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { renderShell } from "../src/jsx/render-to-stream.ts";
import { useContext, useId, useState } from "../src/runtime/hooks.ts";
import { createContext } from "../src/runtime/context.ts";
import { createRoot, flushSync, hydrateRoot, setDocument } from "../src/client/reconciler.ts";
import { installIsoIslands } from "../src/client/iso-island.ts";
import { resetLazyIslands, setLazyScheduler } from "../src/client/lazy-hydrate.ts";
import { setIslandRender } from "../src/client/fiber/render-component.ts";
import { setIslandHydration } from "../src/client/fiber/hydration.ts";
import { DomDocument, type DomEl, fireEventOn } from "../src/testing/dom.ts";
import type { VNode } from "../src/jsx/types.ts";
import type { PageRoute } from "../src/router/manifest.ts";
import { appUsesIsoIslands, generateRouteEntry } from "../src/build/bundle.ts";
import { join } from "@std/path";

// deno-lint-ignore no-explicit-any
type Any = any;

const Theme = createContext("light");

function Counter({ start, label }: { start: number; label: string }): VNode {
  const [n, setN] = useState(start);
  const theme = useContext(Theme);
  const id = useId();
  return h("button", { id, onClick: () => setN(n + 1) }, `${label} ${theme} ${n}`);
}

function Page(
  { strategy, other = {} }: { strategy: string; other?: Record<string, unknown> },
): VNode {
  return h(
    Theme.Provider,
    { value: "dark" },
    h(
      "main",
      null,
      h("h1", null, "page"),
      h(Counter, { [`client:${strategy}`]: true, start: 1, label: "c", ...other }),
    ),
  );
}

Deno.test("server: a client:* component renders inside the island wrapper, the directive stripped", async () => {
  const html = await renderToString(h(Page, { strategy: "visible" }));
  assertStringIncludes(
    html,
    '<div data-dnx-island="" data-dnx-strategy="visible" style="display:contents"><button id=',
  );
  assert(!html.includes("client:"), "the directive never reaches the markup");
  assertStringIncludes(html, ">c dark 1</button></div>");
  const media = await renderToString(
    h(Page, { strategy: "media", other: { "client:media": "(min-width: 9px)" } }),
  );
  assertStringIncludes(media, 'data-dnx-strategy-param="(min-width: 9px)"');
  const only = await renderToString(h(Page, { strategy: "only" }));
  assertStringIncludes(
    only,
    '<div data-dnx-island="" data-dnx-strategy="only" style="display:contents"></div>',
  );
  const streamed = await renderShell(h(Page, { strategy: "idle" }), null);
  assertStringIncludes(streamed.shell, 'data-dnx-strategy="idle"');
});

/** Build `html` (the server render) as testing-DOM nodes under a container. */
function serverDom(html: string): { doc: DomDocument; container: DomEl } {
  const doc = new DomDocument();
  const container = doc.createElement("div");
  // A tiny markup reader: the server output here is elements, attributes and text only.
  const stack: DomEl[] = [container];
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/g)) {
    const top = stack[stack.length - 1];
    if (m[4] !== undefined) {
      top.appendChild(doc.createTextNode(m[4].replace(/&amp;/g, "&")) as never);
    } else if (m[1]) stack.pop();
    else {
      const el = doc.createElement(m[2]);
      for (const a of m[3].matchAll(/([\w:-]+)="([^"]*)"/g)) el.setAttribute(a[1], a[2]);
      top.appendChild(el as never);
      stack.push(el);
    }
  }
  return { doc, container };
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
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

async function hydrated(strategy: string) {
  const html = await renderToString(h(Page, { strategy }));
  const { doc, container } = serverDom(html);
  setDocument(doc as Any);
  installIsoIslands();
  const mismatches: unknown[] = [];
  hydrateRoot(container as Any, h(Page, { strategy }), {
    onRecoverableError: (e: unknown) => mismatches.push(e),
  } as Any);
  flushSync();
  const button = container.children[0].children[1].children[0] as DomEl;
  return { container, button, html, mismatches };
}

function teardown() {
  setIslandRender(null);
  setIslandHydration(null);
  resetLazyIslands();
  setLazyScheduler();
}

Deno.test("client:visible: inert until visible, then hydrates the same nodes with the page's context", async () => {
  const fire = manualVisible();
  try {
    const { container, button, html, mismatches } = await hydrated("visible");
    assertEquals(button.tagName, "BUTTON");
    fireEventOn(button, "click");
    flushSync();
    assertEquals(button.textContent, "c dark 1", "no handler before the island hydrates");
    fire();
    await tick();
    const after = container.children[0].children[1].children[0];
    assert(after === button, "the server's <button> was adopted, not replaced");
    assertEquals(
      container.innerHTML.replace(/<\/?div[^>]*>/g, ""),
      html.replace(/<\/?div[^>]*>/g, ""),
      "hydration changed nothing (useId and the context agree)",
    );
    fireEventOn(button, "click");
    flushSync();
    assertEquals(button.textContent, "c dark 2", "live once hydrated");
    assertEquals(mismatches, [], "no hydration mismatch, in the page or the island");
  } finally {
    teardown();
  }
});

Deno.test("client:interaction: the event that triggers hydration reaches the island's handler", async () => {
  manualVisible();
  try {
    const { button } = await hydrated("interaction");
    fireEventOn(button, "click");
    flushSync();
    assertEquals(button.textContent, "c dark 2", "one click: hydrated, then handled");
  } finally {
    teardown();
  }
});

Deno.test("client:load hydrates after the page; client:only mounts on the client alone", async () => {
  manualVisible();
  try {
    const { button } = await hydrated("load");
    await tick();
    fireEventOn(button, "click");
    flushSync();
    assertEquals(button.textContent, "c dark 2");
  } finally {
    teardown();
  }
  manualVisible();
  try {
    const html = await renderToString(h(Page, { strategy: "only" }));
    const { doc, container } = serverDom(html);
    setDocument(doc as Any);
    installIsoIslands();
    hydrateRoot(container as Any, h(Page, { strategy: "only" }));
    flushSync();
    const wrapper = container.children[0].children[1];
    assertEquals(wrapper.children.length, 0, "nothing server-rendered");
    await tick();
    assertEquals(wrapper.children[0]?.textContent, "c dark 1", "mounted after the page");
  } finally {
    teardown();
  }
});

Deno.test("a client:* component that mounts on the client alone renders at once, in the wrapper", () => {
  try {
    const doc = new DomDocument();
    const container = doc.createElement("div");
    setDocument(doc as Any);
    installIsoIslands();
    createRoot(container as Any).render(h(Page, { strategy: "visible" }) as never);
    flushSync();
    const wrapper = container.children[0].children[1];
    assertEquals(wrapper.getAttribute("data-dnx-island"), "");
    assertEquals(wrapper.children[0].textContent, "c dark 1");
  } finally {
    teardown();
  }
});

Deno.test("the route entry installs the island runtime only when the app writes a directive", async () => {
  const route = {
    kind: "page",
    pattern: [],
    routePath: "/",
    filePath: "/app/page.tsx",
    layoutChain: [],
    templateChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
  } as unknown as PageRoute;
  assert(generateRouteEntry(route, { usesIsoIslands: true }).includes("installIsoIslands();"));
  assert(!generateRouteEntry(route).includes("installIsoIslands"));
  const dir = await Deno.makeTempDir({ prefix: "denext_iso_scan_" });
  try {
    await Deno.mkdir(join(dir, "app"));
    await Deno.writeTextFile(join(dir, "app", "page.tsx"), "export default () => <main />;");
    assertEquals(await appUsesIsoIslands(dir), false);
    await Deno.writeTextFile(
      join(dir, "app", "page.tsx"),
      "export default () => <main><Chart client:visible /></main>;",
    );
    assertEquals(await appUsesIsoIslands(dir), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
