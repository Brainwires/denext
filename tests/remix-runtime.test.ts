// The `denext/remix` compat runtime — the layer that lets a migrated Remix app run on
// denext. These tests render the runtime through denext's own SSR (`renderToString`) to
// prove the data model works end-to-end: a loader runs, its data reaches `useLoaderData`,
// `useMatches` sees the chain, `<Link>` maps `to`→`href`, and the server helpers
// (`json`/`redirect`/`runLoader`/`remixMeta`) behave.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { h } from "../mod.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import {
  Link,
  RemixRouteProvider,
  useLoaderData,
  useMatches,
  useParams,
} from "../src/compat/remix/client.ts";
import { json, redirect, remixMeta, RemixRoute, runLoader } from "../src/compat/remix/server.ts";

Deno.test("useLoaderData reads the data the provider threads across the boundary", async () => {
  function Child() {
    const data = useLoaderData<{ message: string }>();
    const params = useParams();
    return h("p", null, `${data.message} @ ${params.city ?? "-"}`);
  }
  const tree = h(RemixRouteProvider, {
    id: "concerts/[city]:page",
    loaderData: { message: "Welcome" },
    params: { city: "berlin" },
    children: h(Child, null),
  });
  const html = await renderToString(tree);
  assertStringIncludes(html, "Welcome @ berlin");
});

Deno.test("useMatches exposes the route chain (outermost first)", async () => {
  function Leaf() {
    const matches = useMatches();
    return h("p", null, matches.map((m) => m.id).join(" / "));
  }
  const tree = h(RemixRouteProvider, {
    id: "root:layout",
    loaderData: null,
    params: {},
    children: h(RemixRouteProvider, {
      id: "concerts:page",
      loaderData: null,
      params: {},
      children: h(Leaf, null),
    }),
  });
  const html = await renderToString(tree);
  assertStringIncludes(html, "root:layout / concerts:page");
});

Deno.test("Link maps Remix `to` to denext `href`", async () => {
  const html = await renderToString(h(Link, { to: "/about" }, "About"));
  assertStringIncludes(html, `href="/about"`);
  assertStringIncludes(html, "About");
});

Deno.test("RemixRoute runs the loader and threads its data into the client boundary", async () => {
  function Page() {
    const data = useLoaderData<{ n: number }>();
    return h("span", null, `n=${data.n}`);
  }
  // The generated `page.client.tsx` default: a boundary that receives loaderData as a prop
  // and composes the provider + user component (so the data crosses the Flight boundary).
  const Route = (props: { id: string; loaderData: unknown; params: Record<string, string> }) =>
    h(RemixRouteProvider, { ...props, children: h(Page, null) });
  const loader = () => json({ n: 42 });
  const vnode = await RemixRoute({ id: "x:page", loader, Route, params: {} });
  const html = await renderToString(vnode);
  assertStringIncludes(html, "n=42");
});

Deno.test("runLoader unwraps json() and honors a redirect()", async () => {
  // A plain value passes through.
  assertEquals(await runLoader(() => ({ a: 1 }), {}), { a: 1 });
  // json() is unwrapped to its parsed body.
  assertEquals(await runLoader(() => json({ b: 2 }), {}), { b: 2 });
  // A returned redirect() throws denext's control-flow signal.
  await assertRejects(() => runLoader(() => redirect("/login"), {}));
});

Deno.test("remixMeta maps Remix descriptors to denext Metadata", async () => {
  const meta = () => [
    { title: "Concerts" },
    { name: "description", content: "All shows" },
    { property: "og:type", content: "website" },
  ];
  const gen = remixMeta(meta, undefined)!;
  const md = await gen({ params: {}, searchParams: new URLSearchParams() });
  assertEquals(md.title, "Concerts");
  assertEquals(md.description, "All shows");
  assert(md.meta?.["og:type"] === "website");
});
