// WS2: the small missing Next-16 surface — `next/form` <Form>, plus the
// `next/server` (after/connection) and `next/link` (useLinkStatus) exports.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToString } from "../src/jsx/render-to-string.ts";
import Form from "../src/compat/next/form.ts";
import { after, connection } from "../src/compat/next/server.ts";
import { useLinkStatus } from "../src/compat/next/link.ts";
import { h } from "../src/jsx/jsx-runtime.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("next/form: string action renders a GET form (works without JS)", async () => {
  const html = await renderToString(
    h(Form as Any, { action: "/search", className: "sf" }, h("input", { name: "q" })),
  );
  assertStringIncludes(html, "<form");
  assertStringIncludes(html, 'action="/search"');
  assertStringIncludes(html, 'method="get"');
  assertStringIncludes(html, 'class="sf"'); // extra attributes forwarded
  assertStringIncludes(html, 'name="q"'); // children rendered
});

Deno.test("next/form: function action renders a plain form (no method=get injected)", async () => {
  const serverAction = (_fd: FormData) => {};
  const html = await renderToString(
    h(Form as Any, { action: serverAction }, h("button", { type: "submit" }, "Go")),
  );
  assertStringIncludes(html, "<form");
  assert(!html.includes('method="get"'), "server-action form is not forced to GET");
  assertStringIncludes(html, "Go");
});

Deno.test("next/server re-exports after() and connection()", () => {
  assertEquals(typeof after, "function");
  assertEquals(typeof connection, "function");
});

Deno.test("next/link re-exports useLinkStatus", () => {
  assertEquals(typeof useLinkStatus, "function");
});
