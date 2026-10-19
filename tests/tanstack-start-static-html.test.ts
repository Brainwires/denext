// @denext/tanstack-start's static pages: a prerendered page is written with each streamed Suspense
// boundary's content in its placeholder (what denext's swap script does in the browser), so the
// exported file reads the same with JavaScript off and hydrates against the same DOM.

import { assertEquals } from "@std/assert";
import { inlineStreamedBoundaries } from "../packages/tanstack-start/src/static-html.ts";
import { prerenderPages } from "../packages/tanstack-start/src/prerender.ts";

const SWAP = "<script>(function(){/* swap */})();</script>";

Deno.test("tanstack-start static html: a boundary's content replaces its fallback", () => {
  const html = `<main><div data-dnx-b="dnx0"><p>Loading…</p></div></main>${SWAP}` +
    `<template data-dnx-r="dnx0" data-dnx-ms="3"><section id="posts">Posts</section></template>` +
    `</body></html>`;
  assertEquals(
    inlineStreamedBoundaries(html),
    `<main><div data-dnx-b="dnx0"><section id="posts">Posts</section></div></main>${SWAP}` +
      `</body></html>`,
  );
});

Deno.test("tanstack-start static html: nested boundaries, in either resolution order", () => {
  const expected = `<div data-dnx-b="dnx0"><div class="outer">` +
    `<div data-dnx-b="dnx1"><b>inner</b></div></div></div>`;
  // The outer boundary resolved first: its content brings the inner placeholder.
  const outerFirst = `<div data-dnx-b="dnx0">…</div>` +
    `<template data-dnx-r="dnx0"><div class="outer"><div data-dnx-b="dnx1"><i>…</i></div>` +
    `</div></template><template data-dnx-r="dnx1"><b>inner</b></template>`;
  assertEquals(inlineStreamedBoundaries(outerFirst), expected);
  // The inner one resolved first: its placeholder only exists once the outer is in place.
  const innerFirst = `<div data-dnx-b="dnx0">…</div>` +
    `<template data-dnx-r="dnx1"><b>inner</b></template>` +
    `<template data-dnx-r="dnx0"><div class="outer"><div data-dnx-b="dnx1"><i>…</i></div>` +
    `</div></template>`;
  assertEquals(inlineStreamedBoundaries(innerFirst), expected);
});

Deno.test("tanstack-start static html: scripts, nested templates and strays are kept intact", () => {
  // A fallback whose script mentions a closing div, and a template inside the content.
  const html = `<div data-dnx-b="dnx0"><div><script>x("</div></template>")</script></div></div>` +
    `<template data-dnx-r="dnx0"><template id="t"><div>a</div></template>` +
    `<script>y("</template>")</script></template>`;
  assertEquals(
    inlineStreamedBoundaries(html),
    `<div data-dnx-b="dnx0"><template id="t"><div>a</div></template>` +
      `<script>y("</template>")</script></div>`,
  );
  // A template with no placeholder (and a page with no boundaries) is left as it is.
  const stray = `<p>x</p><template data-dnx-r="dnx9"><b>y</b></template>`;
  assertEquals(inlineStreamedBoundaries(stray), stray);
  assertEquals(inlineStreamedBoundaries("<p>plain</p>"), "<p>plain</p>");
  // An unterminated template is not touched.
  const cut = `<div data-dnx-b="dnx0">…</div><template data-dnx-r="dnx0"><b>`;
  assertEquals(inlineStreamedBoundaries(cut), cut);
});

Deno.test("tanstack-start prerender: the written page has its boundaries in place", async () => {
  const files = new Map<string, string>();
  const streamed = `<!DOCTYPE html><html><body><div data-dnx-b="dnx0"></div>` +
    `<template data-dnx-r="dnx0"><h1>Ready</h1></template></body></html>`;
  await prerenderPages({
    options: { crawlLinks: false },
    pages: [{ path: "/" }, { path: "/data.json" }],
    routes: null,
    client: null,
    projectRoot: "/p",
    basePath: "",
    fetch: (request) =>
      Promise.resolve(
        new URL(request.url).pathname === "/data.json"
          ? new Response(streamed, { headers: { "content-type": "application/json" } })
          : new Response(streamed, { headers: { "content-type": "text/html; charset=utf-8" } }),
      ),
    write: (file, html) => Promise.resolve(void files.set(file, html)),
  });
  assertEquals(
    files.get("index.html"),
    `<!DOCTYPE html><html><body><div data-dnx-b="dnx0"><h1>Ready</h1></div></body></html>`,
  );
  // Not a page: written as it came.
  assertEquals([...files.values()].filter((v) => v === streamed).length, 1);
});
