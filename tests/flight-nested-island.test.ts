// A nested island (a tagged client component rendered INSIDE another island's output) must not
// have its children walked for Flight: those children are client-authored, and an untagged
// client component among them (radix's forwardRef `Dialog.Content`, a module-private helper)
// would be invoked as a server component — outside its provider. shadcn/ui's site failed with
// "`DialogContent` must be used within `Dialog`" on every page.

import { assert, assertStringIncludes } from "@std/assert";
import { createContext, forwardRef, useContext } from "../mod.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToHtmlFlight } from "../src/jsx/render-to-html-flight.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import type { VNodeChildren } from "../src/jsx/types.ts";

const Ctx = createContext<string | null>(null);

// Module-private client helpers (NOT exported → never tagged).
function Private() {
  const v = useContext(Ctx);
  if (v == null) throw new Error("`Private` must be used within `Outer`");
  return h("span", null, `private:${v}`);
}
const Wrapped = forwardRef((_props: Record<never, never>, _ref: unknown) => {
  // deno-lint-ignore denext/hooks-in-component -- a forwardRef render function is a component
  const v = useContext(Ctx);
  if (v == null) throw new Error("`Wrapped` must be used within `Outer`");
  return h("i", null, `wrapped:${v}`);
  // deno-lint-ignore no-explicit-any
}) as any;

// Exported, tagged client components: Inner is rendered by Outer WITH client-authored children.
function Inner(props: { children?: VNodeChildren }) {
  return h("div", { class: "inner" }, props.children);
}
function Outer() {
  return h(Ctx.Provider, { value: "ok" }, h(Inner, null, h(Private, null), h(Wrapped, null)));
}
tagClientExports({ Inner, Outer } as Record<string, unknown>, "c_nested");

function Page() {
  return h("main", null, h(Outer, null));
}

Deno.test("a nested island's client-authored children are SSR'd, never invoked for Flight", async () => {
  const { html, flight } = await renderToHtmlFlight(h(Page, null));
  assertStringIncludes(html, "private:ok");
  assertStringIncludes(html, "wrapped:ok");
  // The page Flight references the top-level island only.
  const text = JSON.stringify(flight);
  assertStringIncludes(text, "c_nested#Outer");
  assert(!text.includes("c_nested#Inner"), "the nested island contributes no Flight of its own");
});

// A server component nested inside an island's children (the Flight-only walk) may render
// Suspense with a suspending child (shadcn's `<ComponentPreview>` inside a `<Tabs>` island:
// `React.lazy` demos). The walk must resolve the suspension like every other renderer instead
// of surfacing the raw pending Promise as an unhandled error.
Deno.test("the Flight-only children walk resolves Suspense + lazy server subtrees", async () => {
  const { lazy, Suspense } = await import("../mod.ts");
  const Demo = () => h("b", null, "demo");
  const LazyDemo = lazy(() => Promise.resolve({ default: Demo }));
  // Server component: renders Suspense around a lazy component.
  function Preview() {
    return h("div", null, h(Suspense, { fallback: h("i", null, "loading") }, h(LazyDemo, null)));
  }
  // Client island whose CHILDREN are server-authored (the page passes <Preview/> in).
  function Tabs(props: { children?: VNodeChildren }) {
    return h("section", null, props.children);
  }
  tagClientExports({ Tabs } as Record<string, unknown>, "c_tabs");
  const { html, flight } = await renderToHtmlFlight(
    h("main", null, h(Tabs, null, h(Preview, null))),
  );
  assertStringIncludes(html, "<b>demo</b>");
  assertStringIncludes(JSON.stringify(flight), "demo");
});

// An island may itself suspend: a `React.lazy` component exported from a "use client" module,
// or an island calling `use()` at its top level — with no <Suspense> above it in the server
// tree (Next's app router always has a root boundary). The island and the root act as the
// boundary instead of leaking the raw pending Promise.
Deno.test("a suspending island (lazy export / top-level use) renders without a Suspense above", async () => {
  const { lazy, use } = await import("../mod.ts");
  const Demo = () => h("b", null, "lazy-island");
  const LazyIsland = lazy(() => Promise.resolve({ default: Demo }));
  const data = Promise.resolve("used");
  function Using() {
    const v = use(data);
    return h("i", null, v);
  }
  tagClientExports({ LazyIsland, Using } as Record<string, unknown>, "c_susp");
  const { html } = await renderToHtmlFlight(h("main", null, h(LazyIsland, null), h(Using, null)));
  assertStringIncludes(html, "<b>lazy-island</b>");
  assertStringIncludes(html, "<i>used</i>");
});
