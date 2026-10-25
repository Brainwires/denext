// A true JSX owner stack: a dev build compiles JSX to `jsxDEV` (esbuild's `jsxDev`, Deno's
// `react-jsxdev`), which records each element's owner — the component rendering when it was
// made — and its source. `captureOwnerStack()` and the DevTools owner stack then follow the
// owner chain (a component passed as `children` through a wrapper is owned by the component
// that wrote it, not the wrapper), naming the line each owner wrote the JSX on. Production
// compiles to `jsx`, which records nothing.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { join } from "@std/path";
import { h, jsx, jsxDEV } from "../src/jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../src/jsx/types.ts";
import { captureOwnerStack } from "../src/compat/react.ts";
import { render } from "../src/testing/mod.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import {
  getInspectorTree,
  getOwnerStack,
  type InspectNode,
} from "../src/client/devtools-inspect.ts";
import { installOwnerStack } from "../src/client/owner-stack.ts";
import { makeDom } from "./helpers/dom.ts";
import { createUnbundledState } from "../src/build/dev-unbundled/state.ts";
import { transform } from "../src/build/dev-unbundled/transform.ts";
import { prepareConfig } from "../src/build/bundle.ts";

// deno-lint-ignore no-explicit-any
const asAny = (v: unknown): any => v;

type DevGlobal = { __denextDev?: boolean };

/** Run `fn` with `__denextDev` set as given (and the dev recorder installed when on). */
async function withDev<T>(on: boolean, fn: () => Promise<T> | T): Promise<T> {
  const g = globalThis as DevGlobal;
  const prev = g.__denextDev;
  if (on) g.__denextDev = true;
  else delete g.__denextDev;
  installOwnerStack(true);
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete g.__denextDev;
    else g.__denextDev = prev;
  }
}

/** What a dev build passes as `jsxDEV`'s `source`. */
const at = (lineNumber: number, columnNumber = 5) => ({
  fileName: "app/page.tsx",
  lineNumber,
  columnNumber,
});

/** `jsxDEV` the way a dev build calls it (no key, dynamic children). */
function dev(type: unknown, props: Record<string, unknown>, line: number): VNode {
  return jsxDEV(asAny(type), asAny(props), undefined, false, at(line), undefined);
}

/**
 * Page renders Layout with Child as its children (the KL case): Child's owner is Page, which
 * wrote `<Child />`, not Layout, which only placed it. Child records its owner stack.
 */
function ownerTree(seen: Array<string | null>) {
  function Child(): VNode {
    seen.push(captureOwnerStack());
    return dev("span", { children: "child" }, 3);
  }
  function Layout({ children }: { children?: VNodeChildren }): VNode {
    return dev("main", { children }, 8);
  }
  function Page(): VNode {
    return dev(Layout, { children: dev(Child, {}, 13) }, 12);
  }
  function App(): VNode {
    return dev(Page, {}, 17);
  }
  return { App, Child, Layout, Page };
}

Deno.test("captureOwnerStack: a jsxDEV element's stack is its JSX owners, with the call sites", async () => {
  await withDev(true, async () => {
    const seen: Array<string | null> = [];
    const { App } = ownerTree(seen);
    // The root element is made outside any render: it has no owner, so the chain ends at App.
    const screen = await render(dev(App, {}, 1));
    screen.unmount();
    assert(seen.length > 0, "Child rendered");
    // Layout rendered Child but did not write it: React's owner stack skips it.
    assertEquals(
      seen[0],
      "\n    at Page (app/page.tsx:13:5)\n    at App (app/page.tsx:17:5)",
    );
  });
});

Deno.test("captureOwnerStack: an h() element is owned by the render that made it", async () => {
  await withDev(true, async () => {
    const seen: Array<string | null> = [];
    function Child(): VNode {
      seen.push(captureOwnerStack());
      return h("span", null);
    }
    function Icon(): VNode {
      seen.push(captureOwnerStack());
      return h("i", null);
    }
    function Layout(
      { children, icon }: { children?: VNodeChildren; icon?: VNodeChildren },
    ): VNode {
      return h("main", null, icon, h("section", null, children));
    }
    function Page(): VNode {
      return h(Layout, { icon: h(Icon, null) }, [h(Child, { key: "c" })]);
    }
    function App(): VNode {
      return h("div", null, h(Page, null));
    }
    const screen = await render(h(App, null));
    screen.unmount();
    // Layout placed Child and Icon but Page wrote them (as children and as a prop), as React's
    // owner stack says; the root element was made outside any render, so the chain ends at App.
    assertEquals(seen.slice(0, 2), ["\n    at Page\n    at App", "\n    at Page\n    at App"]);
  });
});

Deno.test("captureOwnerStack: a jsxDEV owner is kept, and h() elements stay unowned in production", async () => {
  await withDev(true, async () => {
    const seen: Array<string | null> = [];
    function Child(): VNode {
      seen.push(captureOwnerStack());
      return h("span", null);
    }
    function Wrapper({ children }: { children?: VNodeChildren }): VNode {
      return h("div", null, children);
    }
    function Page(): VNode {
      // written with jsxDEV: its owner (Page) is recorded at creation, not re-stamped by Wrapper
      return h(Wrapper, null, dev(Child, {}, 7));
    }
    const screen = await render(h(Page, null));
    screen.unmount();
    assertEquals(seen[0], "\n    at Page (app/page.tsx:7:5)");
  });
  await withDev(true, async () => {
    // A frozen element can't take an owner: it renders, and keeps the render-parent fallback.
    const seen: Array<string | null> = [];
    function Leaf(): VNode {
      seen.push(captureOwnerStack());
      return h("b", null);
    }
    function Holder(): VNode {
      return Object.freeze(h(Leaf, null));
    }
    const screen = await render(h(Holder, null));
    screen.unmount();
    assertEquals(seen[0], "\n    at Holder");
  });
  await withDev(false, async () => {
    let made: VNode | null = null;
    function Page(): VNode {
      made = h("span", null);
      return made;
    }
    const screen = await render(h(Page, null));
    screen.unmount();
    assert(made && !("_owner" in made), "no owner is recorded outside development");
  });
});

Deno.test("jsxDEV records nothing in production, and jsx never does", async () => {
  await withDev(false, () => {
    const el = jsxDEV("div", {}, undefined, false, at(1), undefined);
    assert(!("_owner" in el) && !("_source" in el), "no dev fields outside development");
  });
  await withDev(true, () => {
    const el = jsx("div", {});
    assert(!("_owner" in el), "the production factory records no owner");
    const devEl = jsxDEV("div", { id: "x" }, undefined, false, at(4), undefined);
    assertStrictEquals(asAny(devEl)._owner, null); // made outside a render
    assertEquals(asAny(devEl)._source, at(4));
    // Non-enumerable: props spreads and JSON never see them.
    assertEquals(Object.keys(devEl).includes("_owner"), false);
    assertEquals(JSON.parse(JSON.stringify(devEl)).props, { id: "x" });
  });
});

function findNode(nodes: InspectNode[], name: string): InspectNode | undefined {
  for (const n of nodes) {
    if (n.name === name) return n;
    const hit = findNode(n.children, name);
    if (hit) return hit;
  }
  return undefined;
}

Deno.test("DevTools owner stack: the JSX owners with their call sites", async () => {
  await withDev(true, () => {
    const { App } = ownerTree([]);
    const { doc, container } = makeDom();
    setDocument(asAny(doc));
    const root = createRoot(asAny(container));
    root.render(dev(App, {}, 1));
    flushSync();
    const child = findNode(getInspectorTree(), "Child");
    assert(child, "Child is in the tree");
    const stack = getOwnerStack(child.id);
    assertEquals(stack.map((o) => o.name), ["Page", "App"]);
    assertEquals(stack[0].callSite, { file: "app/page.tsx", line: 13, column: 5 });
    root.unmount();
  });
});

Deno.test("dev builds compile JSX to jsxDEV with the source; production does not", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-jsxdev-" }));
  try {
    const file = join(dir, "Card.tsx");
    await Deno.writeTextFile(file, `export function Card() {\n  return <div>card</div>;\n}\n`);
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: { "denext/jsx-runtime": "./rt.ts" },
      }),
    );
    // The unbundled dev loop's per-module transform.
    const st = createUnbundledState({
      projectDir: dir,
      appDir: dir,
      configPath: join(dir, "deno.json"),
      outDir: join(dir, "out"),
    });
    const out = (await transform(st, file)).code;
    assert(out.includes("jsxDEV("), out);
    assert(/lineNumber:\s*2/.test(out), "the element's source line is passed");
    // A dev `deno bundle` compiles react-jsxdev and can resolve its runtime; a build does not.
    const merged = async (dev: boolean) => {
      const tmp = await Deno.makeTempDir({ dir });
      return JSON.parse(
        await Deno.readTextFile(
          await prepareConfig(tmp, { configPath: join(dir, "deno.json"), dev }),
        ),
      );
    };
    const devConfig = await merged(true);
    assertEquals(devConfig.compilerOptions.jsx, "react-jsxdev");
    assertEquals(
      devConfig.imports["denext/jsx-dev-runtime"],
      devConfig.imports["denext/jsx-runtime"],
    );
    assertEquals((await merged(false)).compilerOptions.jsx, "react-jsx");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
