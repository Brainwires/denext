// An unhandled page error with no `error.tsx` / `global-error.tsx` answers a minimal HTML page,
// as Next.js serves its default error page (up to 4.5.0 it was `text/plain` "Internal Server
// Error"). The page says nothing about the error (redacted; the server log has it under the
// request id); a request that doesn't take HTML still gets the plain text.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/server/app.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";

function manifest(): RouteManifest {
  return {
    pages: [{
      kind: "page",
      pattern: parsePattern("x"),
      routePath: "/x",
      filePath: "page.tsx",
      layoutChain: [],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
      templateChain: [],
    }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
}

const app = () =>
  createApp({
    getManifest: () => Promise.resolve(manifest()),
    load: () =>
      Promise.resolve({
        default: () => {
          throw new Error("SECRET_DETAIL");
        },
      }),
  });

Deno.test("the default 500 is an HTML page for a browser, and leaks nothing", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const res = await app()(
      new Request("http://localhost/x", { headers: { accept: "text/html,*/*;q=0.8" } }),
    );
    assertEquals(res.status, 500);
    assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
    const id = res.headers.get("x-request-id");
    assert(id, "x-request-id");
    const html = await res.text();
    assert(html.startsWith("<!DOCTYPE html>"), html);
    assertStringIncludes(html, "<title>500 — Internal Server Error</title>");
    assertStringIncludes(html, "<h1>500</h1>");
    assertStringIncludes(html, id, "the id the log line carries");
    assert(!html.includes("SECRET_DETAIL"), html);

    const plain = await app()(new Request("http://localhost/x", { headers: { accept: "*/*" } }));
    assertEquals(plain.status, 500);
    assertEquals(plain.headers.get("content-type"), "text/plain; charset=utf-8");
    assertEquals(await plain.text(), "Internal Server Error");
  } finally {
    console.error = original;
  }
});
