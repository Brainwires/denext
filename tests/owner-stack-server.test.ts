// `captureOwnerStack()` during a server render: the dev server installs the server owner stack,
// so a Server Component (or a component the SSR pass renders) gets React's owner stack — the JSX
// owners, nearest first, with the call site when `jsxDEV` recorded it. Without the install
// (production) and outside development it returns `null`, as React's does.

import { assertEquals, assertStrictEquals } from "@std/assert";
import { h, jsxDEV } from "../src/jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../src/jsx/types.ts";
import { captureOwnerStack } from "../src/compat/react.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { renderToFlight } from "../src/jsx/render-to-flight.ts";
import { installServerOwnerStack } from "../src/server/owner-stack.ts";

// deno-lint-ignore no-explicit-any
const asAny = (v: unknown): any => v;

/** Run `fn` with `__denextDev` as given and the server owner stack installed or not. */
async function withServerOwners<T>(
  dev: boolean,
  installed: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  const g = globalThis as { __denextDev?: boolean };
  const prev = g.__denextDev;
  if (dev) g.__denextDev = true;
  else delete g.__denextDev;
  installServerOwnerStack(installed);
  try {
    return await fn();
  } finally {
    installServerOwnerStack(false);
    if (prev === undefined) delete g.__denextDev;
    else g.__denextDev = prev;
  }
}

/** Page renders Layout with Child as its children: Child's owner is Page, not Layout. */
function hTree(seen: Array<string | null>) {
  function Child(): VNode {
    seen.push(captureOwnerStack());
    return h("span", null, "child");
  }
  function Layout({ children }: { children?: VNodeChildren }): VNode {
    return h("main", null, children);
  }
  function Page(): VNode {
    return h(Layout, null, h(Child, null));
  }
  function App(): VNode {
    return h(Page, null);
  }
  return App;
}

Deno.test("server captureOwnerStack: h() elements are owned by the component that returned them", async () => {
  const seen: Array<string | null> = [];
  const html = await withServerOwners(true, true, () => renderToString(h(hTree(seen), null)));
  assertEquals(html, "<main><span>child</span></main>");
  assertEquals(seen, ["\n    at Page\n    at App"]);
});

Deno.test("server captureOwnerStack: null without the dev install, and outside development", async () => {
  const seen: Array<string | null> = [];
  await withServerOwners(true, false, () => renderToString(h(hTree(seen), null)));
  await withServerOwners(false, true, () => renderToString(h(hTree(seen), null)));
  assertEquals(seen, [null, null]);
  assertStrictEquals(captureOwnerStack(), null);
});

Deno.test("server captureOwnerStack: jsxDEV call sites, across an await in an async Server Component", async () => {
  const at = (lineNumber: number) => ({ fileName: "app/page.tsx", lineNumber, columnNumber: 5 });
  const dev = (type: unknown, props: Record<string, unknown>, line: number): VNode =>
    jsxDEV(asAny(type), asAny(props), undefined, false, at(line), undefined);
  const seen: Array<string | null> = [];
  function Leaf(): VNode {
    seen.push(captureOwnerStack());
    return dev("b", { children: "x" }, 2);
  }
  async function Data(): Promise<VNode> {
    await Promise.resolve();
    seen.push(captureOwnerStack());
    return dev(Leaf, {}, 7);
  }
  function Page(): VNode {
    return dev(Data, {}, 11);
  }
  await withServerOwners(true, true, () => renderToFlight(h(Page, null)));
  assertEquals(seen, [
    "\n    at Page (app/page.tsx:11:5)",
    "\n    at Data (app/page.tsx:7:5)\n    at Page (app/page.tsx:11:5)",
  ]);
});

Deno.test("server captureOwnerStack: a keyed component's output keeps its owner", async () => {
  const seen: Array<string | null> = [];
  function Leaf(): VNode {
    seen.push(captureOwnerStack());
    return h("i", null);
  }
  function Row(): VNode {
    return h(Leaf, null);
  }
  function List(): VNode {
    return h("ul", null, [h(Row, { key: "a" })]);
  }
  await withServerOwners(true, true, () => renderToFlight(h(List, null)));
  assertEquals(seen, ["\n    at Row\n    at List"]);
});
