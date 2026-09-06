import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { bundleSourceFiles, generateFlightEntry } from "../src/build/bundle.ts";
import type { BoundaryManifest } from "../src/build/module-graph.ts";

// Bundling shells out to `deno bundle`; give it room.
Deno.test("flight bundle contains client code but NOT server-component code", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_flightbundle_" });
  try {
    const root = new URL("../", import.meta.url).pathname; // repo root
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": `${root}mod.ts`,
          "denext/jsx-runtime": `${root}src/jsx/jsx-runtime.ts`,
          "denext/client": `${root}src/client/mod.ts`,
        },
      }),
    );
    // A client island (goes into the bundle).
    const clientPath = join(dir, "Widget.tsx");
    await Deno.writeTextFile(
      clientPath,
      `"use client"\nexport function Widget(){ return <span>CLIENT_MARKER</span>; }\n`,
    );
    // A server component holding a secret; it is NOT imported by any client
    // module, so it must never appear in the client bundle.
    await Deno.writeTextFile(
      join(dir, "page.tsx"),
      `import { Widget } from "./Widget.tsx";\n` +
        `const DB_SECRET = "SUPER_SECRET_TOKEN_9animal";\n` +
        `export default function Page(){ return <div>{DB_SECRET}<Widget/></div>; }\n`,
    );

    const boundary: BoundaryManifest = {
      client: new Map([["c_widget", { url: toFileUrl(clientPath).href, exports: ["Widget"] }]]),
      server: new Map(),
    };

    // Islands are code-split: the entry holds the loader map, the island's code lands in its
    // own chunk. Check across every emitted file.
    const out = await bundleSourceFiles(generateFlightEntry(boundary), {
      configPath: join(dir, "deno.json"),
    });
    const all = [...out.files.values()].join("\n");
    const entry = out.files.get(out.entry)!;

    // Client code is present (in a chunk); server-only secret is provably absent everywhere.
    assertStringIncludes(all, "CLIENT_MARKER");
    assert(!all.includes("SUPER_SECRET_TOKEN_9animal"), "server secret leaked into bundle");
    assertStringIncludes(entry, "c_widget"); // registry wiring present in the entry
    assert(!entry.includes("CLIENT_MARKER"), "the island is not inlined into the entry");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// The Live WebSocket transport is gated out of a Flight app that never uses a live
// feature (build-time `usesLive`), and kept when it does. Asserted on the generated
// entry SOURCE — the transport bytes live behind the `denext/live` import.
const emptyBoundary = (): BoundaryManifest => ({ client: new Map(), server: new Map() });

Deno.test("flight entry: usesLive=false omits the Live import + transport wiring", () => {
  const src = generateFlightEntry(emptyBoundary(), false, false, false);
  assert(!src.includes("denext/live"), "must not import denext/live");
  assert(!src.includes("configureLive"), "must not call configureLive");
  assert(!src.includes("denext#Live"), "must not register the Live ref");
  // `navigate` is imported only for configureLive's refresh — dropped with it.
  assert(!/\bnavigate\b/.test(src), "must not import the unused navigate");
  // The soft-nav parser is always wired (any Flight route soft-navigates).
  assertStringIncludes(src, "setFlightParser");
});

Deno.test("flight entry: usesLive=true keeps the Live import + transport wiring", () => {
  const src = generateFlightEntry(emptyBoundary(), false, false, true);
  assertStringIncludes(src, `from "denext/live"`);
  assertStringIncludes(src, "configureLive");
  assertStringIncludes(src, "denext#Live");
  assertStringIncludes(src, "navigate");
});

// memo()/forwardRef() exports are non-callable objects; the server tags them as client refs, so
// the generated entry must register them too or the reference has nothing to hydrate against.
Deno.test("flight entry: registers memo/forwardRef element objects as well as functions", () => {
  const src = generateFlightEntry(emptyBoundary(), false, false, false);
  assert(src.includes('typeof v === "function"'), src);
  assert(src.includes('typeof v === "object" && v.$$typeof'), src);
});

Deno.test("flightClientIds collects every referenced client id, nested props included", async () => {
  const { flightClientIds } = await import("../src/client/flight-client.ts");
  const flight = {
    $: "h",
    t: "main",
    p: { slot: { $: "c", i: "c_slot#Chip", p: {}, c: [] } },
    c: [
      {
        $: "c",
        i: "c_widget#Widget",
        p: { nested: [{ $: "c", i: "c_deep#D", p: {}, c: [] }] },
        c: [],
      },
      ["text", { $: "c", i: "c_widget#Other", p: {}, c: [] }],
    ],
  };
  assertEquals([...flightClientIds(flight)].sort(), ["c_deep", "c_slot", "c_widget"]);
  assertEquals(flightClientIds(null).size, 0);
});

Deno.test("generateFlightEntry imports instrumentation-client first when the project has one", () => {
  const boundary: BoundaryManifest = { client: new Map(), server: new Map() } as BoundaryManifest;
  const src = generateFlightEntry(
    boundary,
    false,
    false,
    false,
    "/proj/instrumentation-client.tsx",
  );
  assertEquals(src.split("\n")[1], 'import "file:///proj/instrumentation-client.tsx";');
  assert(!generateFlightEntry(boundary, false, false, false).includes("instrumentation-client"));
});
