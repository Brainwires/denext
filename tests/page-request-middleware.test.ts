// `pageRequestMiddlewareOf`: the page pipeline runs a page module's request middleware only
// when the module exports a function under `__denextRequestMiddleware`; anything else (no
// module, a non-object module, a missing or non-function export) means "no middleware".

import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  PAGE_REQUEST_MIDDLEWARE_EXPORT,
  type PageRequestMiddleware,
  pageRequestMiddlewareOf,
} from "../src/server/page-request-middleware.ts";

Deno.test("page request middleware: the export name is the generated seam", () => {
  assertEquals(PAGE_REQUEST_MIDDLEWARE_EXPORT, "__denextRequestMiddleware");
});

Deno.test("page request middleware: a function export is returned as is", async () => {
  const middleware: PageRequestMiddleware = ({ render }) => render();
  const mod = { default: () => null, [PAGE_REQUEST_MIDDLEWARE_EXPORT]: middleware };
  const found = pageRequestMiddlewareOf(mod);
  assertStrictEquals(found, middleware);
  const response = await found!({
    request: new Request("http://localhost/"),
    params: {},
    render: () => Promise.resolve(new Response("page")),
    recover: () => Promise.resolve(new Response("error", { status: 500 })),
  });
  assertEquals(await response.text(), "page");
});

Deno.test("page request middleware: no module or a non-object module has none", () => {
  for (const mod of [undefined, null, 0, "", false]) {
    assertStrictEquals(pageRequestMiddlewareOf(mod), undefined);
  }
  for (const mod of ["module", 42, true, Symbol("mod")]) {
    assertStrictEquals(pageRequestMiddlewareOf(mod), undefined);
  }
});

Deno.test("page request middleware: a missing or non-function export is ignored", () => {
  assertStrictEquals(pageRequestMiddlewareOf({ default: () => null }), undefined);
  for (const value of [null, "fn", 1, {}, [() => {}]]) {
    assertStrictEquals(
      pageRequestMiddlewareOf({ [PAGE_REQUEST_MIDDLEWARE_EXPORT]: value }),
      undefined,
    );
  }
});
