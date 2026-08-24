// Tests for Pages Router navigation options: the `queryFromSearch` parser that
// backs shallow routing, and the widened `push`/`replace(url, as?, options?)`
// signature. The full shallow soft-navigation (URL/query swap without a data
// fetch) is exercised by the browser e2e (tests/e2e/pages-router.e2e.test.ts).

import { assert, assertEquals } from "@std/assert";
import { queryFromSearch } from "../packages/pages-router/src/client-runtime.ts";
import { createServerRouter } from "../packages/pages-router/router.ts";

Deno.test("queryFromSearch: single value → string, repeated → array", () => {
  assertEquals(queryFromSearch(new URLSearchParams("q=hello")), { q: "hello" });
  assertEquals(queryFromSearch(new URLSearchParams("tag=a&tag=b&page=2")), {
    tag: ["a", "b"],
    page: "2",
  });
});

Deno.test("queryFromSearch: empty search → empty object", () => {
  assertEquals(queryFromSearch(new URLSearchParams("")), {});
});

Deno.test("router push/replace accept (url, as, options) without throwing", async () => {
  const router = createServerRouter({ route: "/search", query: {}, asPath: "/search" });
  // On the server these are no-ops, but the widened signature must type-check and
  // resolve — proving shallow/scroll options are accepted by the router surface.
  assertEquals(await router.push("/search?q=b", "/search?q=b", { shallow: true }), true);
  assertEquals(await router.replace("/search?q=c", undefined, { scroll: false }), true);
  assert(typeof router.push === "function");
});
