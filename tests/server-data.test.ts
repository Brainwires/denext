import { assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import { permanentRedirect, redirect } from "../src/runtime/error-boundary.ts";
import { cookies, headers } from "../src/server/request-context.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useOptimistic, useState } from "../src/runtime/hooks.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

function appOf(page: () => VNode) {
  const manifest: RouteManifest = {
    pages: [{
      kind: "page",
      pattern: parsePattern(""),
      routePath: "/",
      filePath: "page.tsx",
      layoutChain: [],
      templateChain: [],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
    }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
  return createApp({
    getManifest: () => manifest,
    load: () => Promise.resolve({ default: page }),
  });
}

Deno.test("redirect() from a page issues a 307 with Location", async () => {
  const res = await appOf(() => redirect("/login"))(
    new Request("http://localhost/"),
  );
  await res.body?.cancel();
  assertEquals(res.status, 307);
  assertEquals(res.headers.get("location"), "/login");
});

Deno.test("permanentRedirect() issues a 308", async () => {
  const res = await appOf(() => permanentRedirect("/new"))(
    new Request("http://localhost/"),
  );
  await res.body?.cancel();
  assertEquals(res.status, 308);
  assertEquals(res.headers.get("location"), "/new");
});

Deno.test("headers() reads the current request headers", async () => {
  const app = appOf(() => h("p", null, headers().get("x-test") ?? "none"));
  const res = await app(
    new Request("http://localhost/", { headers: { "x-test": "yo" } }),
  );
  assertStringIncludes(await res.text(), "<p>yo</p>");
});

Deno.test("cookies() reads request cookies and writes Set-Cookie", async () => {
  const app = appOf(() => {
    const c = cookies();
    c.set("visited", "1", { httpOnly: true });
    return h("p", null, c.get("session") ?? "anon");
  });
  const res = await app(
    new Request("http://localhost/", { headers: { cookie: "session=abc" } }),
  );
  const body = await res.text();
  assertStringIncludes(body, "<p>abc</p>");
  const setCookie = res.headers.get("set-cookie") ?? "";
  assertStringIncludes(setCookie, "visited=1");
  assertStringIncludes(setCookie, "HttpOnly");
});

Deno.test("cookies()/headers() throw outside a request context", () => {
  let threw = false;
  try {
    headers();
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("useOptimistic shows the optimistic value and resets on state change", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  function C(): VNode {
    const [base, setBase] = useState(0);
    const [opt, addOpt] = useOptimistic(base, (cur: number, n: number) => cur + n);
    return h("div", null, [
      h("output", null, String(opt)),
      h("button", { onClick: () => addOpt(5) }, "opt"),
      h("button", { onClick: () => setBase(100) }, "commit"),
    ]);
  }
  createRoot(asEl(container)).render(h(C, null));
  const div = container.childNodes[0] as FakeElement;
  assertEquals((div.childNodes[0] as FakeElement).textContent, "0");

  // Optimistic update.
  (div.childNodes[1] as FakeElement).dispatch("click");
  flushSync();
  assertEquals((div.childNodes[0] as FakeElement).textContent, "5");

  // Committing the real state resets the optimistic value to the new base.
  (div.childNodes[2] as FakeElement).dispatch("click");
  flushSync();
  assertEquals((div.childNodes[0] as FakeElement).textContent, "100");
});
