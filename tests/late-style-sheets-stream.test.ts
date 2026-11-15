// React Native mode's late style sheets (src/server/late-style-sheets.ts) find each streamed
// boundary with the streaming tokenizer: a `<template data-dnx-r>` split across two chunks still
// gets its rules ahead of it, and the same text inside a script is not taken for a boundary.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { streamLateStyleSheets } from "../src/server/late-style-sheets.ts";

const REGISTRY = Symbol.for("denext.serverStyleSheets");
const SHEET_ID = "react-native-stylesheet";
const encoder = new TextEncoder();

/** Register a sheet whose text is `rules()`; the returned function undoes it. */
function register(rules: () => string[]): () => void {
  const g = globalThis as Record<symbol, unknown>;
  const prev = g[REGISTRY];
  g[REGISTRY] = new Map([[SHEET_ID, () => ({ id: SHEET_ID, textContent: rules().join("\n") })]]);
  return () => {
    if (prev === undefined) delete g[REGISTRY];
    else g[REGISTRY] = prev;
  };
}

Deno.test("late style sheets: a boundary template split across chunks still gets its rules ahead of it", async () => {
  const rules = ['[stylesheet-group="2"]{}', ".r-a{color:red}"];
  const unregister = register(() => rules);
  try {
    const shell = `<html><head><style id="${SHEET_ID}">${rules.join("\n")}</style></head><body>`;
    const hole = '<template data-dnx-r="b0"><p>late</p></template>';
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    const reader = streamLateStyleSheets(source, shell).getReader();
    controller.enqueue(encoder.encode(shell + hole.slice(0, 6)));
    await reader.read();
    // The boundary rendered: its module added a rule, then the rest of its template streamed.
    rules.push(".r-b{color:blue}");
    controller.enqueue(encoder.encode(hole.slice(6) + "</body></html>"));
    controller.close();
    let rest = "";
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      rest += new TextDecoder().decode(r.value);
    }
    const block = rest.indexOf("data-dnx-rules");
    assert(block >= 0, `no rules block: ${rest}`);
    assert(block < rest.indexOf("<template data-dnx-r="), "the rules go ahead of the boundary");
    assertStringIncludes(rest, ".r-b{color:blue}");
    assertEquals(rest.includes(".r-a{color:red}"), false, "a rule the head sent is not resent");
  } finally {
    unregister();
  }
});

Deno.test("late style sheets: boundary text inside a script is not taken for a boundary", async () => {
  const rules = [".r-a{color:red}"];
  const unregister = register(() => rules);
  try {
    const shell = `<html><head></head><body>`;
    rules.push(".r-b{color:blue}");
    const doc = shell + `<script>var t = '<template data-dnx-r="x">';</script></body></html>`;
    const out = await new Response(
      streamLateStyleSheets(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode(doc));
            c.close();
          },
        }),
        shell,
      ),
    ).text();
    assertEquals(out, doc);
  } finally {
    unregister();
  }
});
