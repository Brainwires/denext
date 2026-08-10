// React 19 `use(Context)` — the context overload of `use()`. It reads the nearest
// provided value like `useContext`, works under SSR and on the client, and (unlike
// useContext) may be called conditionally.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createContext, use } from "../mod.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { createRoot, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const Theme = createContext("light");

Deno.test("use(Context) reads the provided value (SSR)", async () => {
  function Label(): VNode {
    return h("span", null, use(Theme));
  }
  const html = await renderToString(
    h(Theme.Provider, { value: "dark" }, h(Label, null)),
  );
  assertEquals(html, "<span>dark</span>");
});

Deno.test("use(Context) falls back to the default value (SSR)", async () => {
  function Label(): VNode {
    return h("span", null, use(Theme));
  }
  const html = await renderToString(h(Label, null));
  assertEquals(html, "<span>light</span>");
});

Deno.test("use(Context) works on the client", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  function Label(): VNode {
    return h("span", null, use(Theme));
  }
  createRoot(container as Any).render(
    h(Theme.Provider, { value: "dark" }, h(Label, null)),
  );
  assertEquals(container.innerHTML, "<span>dark</span>");
});

Deno.test("use(Context) may be called conditionally", async () => {
  function Label({ show }: { show: boolean }): VNode {
    if (!show) return h("span", null, "hidden");
    const theme = use(Theme);
    return h("span", null, theme);
  }
  const shown = await renderToString(
    h(Theme.Provider, { value: "dark" }, h(Label, { show: true })),
  );
  assertEquals(shown, "<span>dark</span>");
  const hidden = await renderToString(h(Label, { show: false }));
  assertEquals(hidden, "<span>hidden</span>");
});
