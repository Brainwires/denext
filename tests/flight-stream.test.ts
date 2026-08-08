import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToFlightStream } from "../src/jsx/render-to-flight-stream.ts";
import { streamToString } from "../src/jsx/render-to-stream.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import type { VNode } from "../src/jsx/types.ts";

function Island(): VNode {
  return h("button", { class: "i" }, "island");
}
const mod = { Island };
tagClientExports(mod as Record<string, unknown>, "c_isl");

async function Slow(): Promise<VNode> {
  await Promise.resolve();
  return h("p", null, "slow-content", h(Island, {}));
}

Deno.test("renderToFlightStream streams HTML shell then fills the Flight payload", async () => {
  const tree = h(
    "main",
    null,
    h("h1", null, "shell"),
    h(Suspense, { fallback: h("span", null, "loading"), children: h(Slow, {}) }),
  );

  const html = await streamToString(renderToFlightStream(tree));

  // Streamed HTML: the shell + fallback placeholder, then the streamed real
  // content template + swap script.
  assertStringIncludes(html, "<h1>shell</h1>");
  assertStringIncludes(html, `data-dnx-b="dnx0"`); // boundary placeholder
  assertStringIncludes(html, "loading"); // fallback shown first
  assertStringIncludes(html, `<template data-dnx-r="dnx0">`); // streamed content
  assertStringIncludes(html, "slow-content");

  // The trailing Flight island exists and has NO unfilled holes; the boundary's
  // client island is present as a reference.
  const m = /<script id="__denext_flight"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert(m, "flight island present");
  const flight = JSON.parse(m![1]);
  const json = JSON.stringify(flight);
  assert(!json.includes(`"$":"$"`), "no unfilled Suspense holes remain");
  assertStringIncludes(json, "c_isl#Island"); // client ref survived into flight
  // Root is <main> with the resolved boundary spliced in.
  assertEquals(flight.$, "h");
  assertEquals(flight.t, "main");
});
