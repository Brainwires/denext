// Per-module byte attribution from a source map (src/build/sourcemap-attribution.ts): the native
// path's `denext analyze --md` breakdown and the bundle tests' hoist detector read it.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  analyzeRequested,
  attributeBytes,
  nativeAnalyzeMeta,
  pruneUnreachable,
  recordAttribution,
} from "../src/build/sourcemap-attribution.ts";

/** Encode one Base64 VLQ value. */
function vlq(n: number): string {
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let v = n < 0 ? ((-n) << 1) | 1 : n << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}

Deno.test("attributeBytes: each span counts toward its segment's source, to the next segment", () => {
  // Line 0: "aaaa" from source 0 (col 0), "bb" from source 1 (col 4), "c" unmapped glue (col 6).
  // Line 1: "dddd" from source 1 again (the source index carries over lines).
  const code = "aaaabbc\ndddd";
  const mappings = [
    [vlq(0) + vlq(0) + vlq(0) + vlq(0), vlq(4) + vlq(1) + vlq(0) + vlq(0), vlq(2)].join(","),
    vlq(0) + vlq(0) + vlq(1) + vlq(0),
  ].join(";");
  const map = JSON.stringify({ version: 3, sources: ["a.ts", "b.ts"], mappings });
  assertEquals(Object.fromEntries(attributeBytes(code, map)), { "a.ts": 4, "b.ts": 6 });
});

Deno.test("attributeBytes: bytes are UTF-8, and a negative source delta goes back", () => {
  const code = "éé€x";
  const mappings = [
    vlq(0) + vlq(1) + vlq(0) + vlq(0), // "éé" (4 bytes) from source 1
    vlq(2) + vlq(-1) + vlq(0) + vlq(0), // "€x" (4 bytes) from source 0
  ].join(",");
  const map = JSON.stringify({ version: 3, sources: ["a.ts", "b.ts"], mappings });
  assertEquals(Object.fromEntries(attributeBytes(code, map)), { "b.ts": 4, "a.ts": 4 });
});

Deno.test("attributeBytes: an unreadable map attributes nothing", () => {
  assertEquals(attributeBytes("x", "not json").size, 0);
  assertEquals(attributeBytes("x", JSON.stringify({ mappings: "AAAA" })).size, 0);
  assertEquals(attributeBytes("x", JSON.stringify({ sources: [], mappings: 3 })).size, 0);
  // A segment whose source index has no `sources` entry.
  assertEquals(attributeBytes("x", JSON.stringify({ sources: [], mappings: "AAAA" })).size, 0);
});

Deno.test("pruneUnreachable: drops the chunks no entry reaches, by static or dynamic import", () => {
  const files = new Map([
    ["entry_0.js", `import{a}from"./chunk-A.js";const l=()=>import("./lazy-B.js");`],
    ["entry_1.js", `import"./chunk-A.js";`],
    ["chunk-A.js", `export const a=new URL("./asset-C.js",import.meta.url);`],
    ["lazy-B.js", `import{a}from"./chunk-A.js";`],
    ["asset-C.js", ``],
    // Its import() site was tree-shaken after splitting: nothing names it.
    ["class-runtime-D.js", `import{a}from"./chunk-A.js";`],
    ["orphan-E.js", `import"./class-runtime-D.js";`],
  ]);
  assertEquals(pruneUnreachable(files, ["entry_0.js", "entry_1.js"]).sort(), [
    "class-runtime-D.js",
    "orphan-E.js",
  ]);
  assertEquals([...files.keys()].sort(), [
    "asset-C.js",
    "chunk-A.js",
    "entry_0.js",
    "entry_1.js",
    "lazy-B.js",
  ]);
});

Deno.test("pruneUnreachable: removes nothing when an entry is missing", () => {
  const files = new Map([["chunk-A.js", ""], ["x.js", ""]]);
  assertEquals(pruneUnreachable(files, ["entry.js"]), []);
  assertEquals(files.size, 2);
});

Deno.test("nativeAnalyzeMeta: recorded chunks by name, renamed entries by code, labelled", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_native_meta_" });
  try {
    const project = join(dir, "app");
    const framework = join(dir, "fw");
    const client = join(project, ".denext", "client");
    await Deno.mkdir(client, { recursive: true });
    await Deno.writeTextFile(join(client, "chunk-ZZ.js"), "chunk code");
    await Deno.writeTextFile(join(client, "index.js"), "entry code (renamed)");
    await Deno.writeTextFile(join(client, "other.js"), "never recorded");
    await Deno.writeTextFile(join(client, "notes.txt"), "not js");
    recordAttribution(
      "chunk-ZZ.js",
      "chunk code",
      new Map([[join(framework, "src", "client", "x.ts"), 7], ["jsr:@std/path/mod.ts", 2]]),
    );
    recordAttribution(
      "entry_0.js",
      "entry code (renamed)",
      new Map([[join(project, "page.tsx"), 5]]),
    );
    assertEquals(await nativeAnalyzeMeta(client, project, framework), {
      outputs: {
        "chunk-ZZ.js": {
          inputs: {
            "denext/src/client/x.ts": { bytesInOutput: 7 },
            "jsr:@std/path/mod.ts": { bytesInOutput: 2 },
          },
        },
        "index.js": { inputs: { "page.tsx": { bytesInOutput: 5 } } },
      },
    });
    assertEquals(await nativeAnalyzeMeta(join(dir, "missing"), project, framework), undefined);
    assertEquals(
      await nativeAnalyzeMeta(framework.replace("fw", "app"), project, framework),
      undefined,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("analyzeRequested: DENEXT_ANALYZE=1 only", () => {
  const prior = Deno.env.get("DENEXT_ANALYZE");
  try {
    Deno.env.set("DENEXT_ANALYZE", "1");
    assertEquals(analyzeRequested(), true);
    Deno.env.set("DENEXT_ANALYZE", "0");
    assertEquals(analyzeRequested(), false);
  } finally {
    if (prior === undefined) Deno.env.delete("DENEXT_ANALYZE");
    else Deno.env.set("DENEXT_ANALYZE", prior);
  }
});
