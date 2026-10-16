import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  bundleAnalysisLines,
  type BundleChunk,
  type BundleMetafile,
  bundleReportMarkdown,
  bundleRoleLines,
  bundleSummaryLines,
  chunkImports,
  chunkRoles,
  classifyChunk,
  readClientChunks,
} from "../src/build/bundle-report.ts";

Deno.test("bundleSummaryLines: a fully-static app reports 0 KB", () => {
  const lines = bundleSummaryLines(5, 5, []);
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], "5 route(s), 5 ship 0 KB JS");
  assertStringIncludes(lines[0], "client JS 0.0 KB in 0 chunk(s)");
});

Deno.test("bundleSummaryLines: reports the total and the largest chunks first", () => {
  const lines = bundleSummaryLines(3, 1, [
    { name: "a.js", bytes: 1024 },
    { name: "runtime.js", bytes: 4096 },
    { name: "b.js", bytes: 2048 },
  ]);
  assertStringIncludes(lines[0], "3 route(s), 1 ship 0 KB JS");
  assertStringIncludes(lines[0], "client JS 7.0 KB in 3 chunk(s)");
  assertStringIncludes(lines[1], "runtime.js — 4.0 KB"); // largest first
  assertStringIncludes(lines[2], "b.js — 2.0 KB");
});

Deno.test("bundleAnalysisLines: 0-JS app is celebrated, not an empty table", () => {
  const lines = bundleAnalysisLines([]);
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], "0 KB");
});

Deno.test("bundleAnalysisLines: ranks by gzip, shows share%, bars, and raw·gz totals", () => {
  const lines = bundleAnalysisLines([
    { name: "small.js", bytes: 2048, gzip: 512 },
    { name: "runtime.js", bytes: 8192, gzip: 3072 },
  ]);
  // Header carries both totals (10 KB raw, 3.5 KB gz) and the chunk count.
  assertStringIncludes(lines[0], "10.0 KB raw");
  assertStringIncludes(lines[0], "3.5 KB gz");
  assertStringIncludes(lines[0], "2 chunk(s)");
  // Ranked by gzip: the runtime chunk (3 KB gz) comes before small (0.5 KB gz).
  const runtimeRow = lines.findIndex((l) => l.includes("runtime.js"));
  const smallRow = lines.findIndex((l) => l.includes("small.js"));
  assert(runtimeRow < smallRow, "larger gzip chunk must rank first");
  // The largest chunk's bar is fully filled; every row shows a share% and raw·gz.
  assertStringIncludes(lines[runtimeRow], "█");
  assertStringIncludes(lines[runtimeRow], "%");
  assertStringIncludes(lines[runtimeRow], "gz");
});

Deno.test("classifyChunk: shared runtime, islands, and entries by name prefix", () => {
  assertEquals(classifyChunk("chunk-IIJ7TUI2.js"), "shared");
  assertEquals(classifyChunk("island-EVBKRLN4.js"), "island");
  assertEquals(classifyChunk("index.js"), "entry");
  assertEquals(classifyChunk("blog___slug_.js"), "entry");
  assertEquals(classifyChunk("flight.js"), "entry");
  assertEquals(classifyChunk("lazy-VUOUC2XY.js"), "on-demand");
  assertEquals(classifyChunk("class-runtime-Q2ZQ7A3B.js"), "on-demand");
  assertEquals(classifyChunk("momentum-scroll-DT2RLQSK.js"), "on-demand");
  assertEquals(classifyChunk("nav-document-MLG7FNHP.js"), "on-demand");
});

Deno.test("bundleRoleLines: isolates the shared-runtime subtotal (the budget target)", () => {
  const lines = bundleRoleLines([
    { name: "chunk-A.js", bytes: 52_000, gzip: 18_000 },
    { name: "chunk-B.js", bytes: 1_400, gzip: 700 },
    { name: "index.js", bytes: 1_700, gzip: 1_000 },
    { name: "island-X.js", bytes: 300 },
  ]);
  assertEquals(lines[0], "By role:");
  const shared = lines.find((l) => l.includes("shared runtime"))!;
  // The two chunk-*.js sum to 53.4 KB raw / 18.7 KB gz — reported as one subtotal.
  assertStringIncludes(shared, "52.1 KB raw · 18.3 KB gz");
  assertStringIncludes(shared, "2 chunks");
  const entries = lines.find((l) => l.includes("route entries"))!;
  assertStringIncludes(entries, "1 chunk)");
  // A group whose chunks lack a .gz sibling reports raw only (no "gz").
  const islands = lines.find((l) => l.includes("islands"))!;
  assert(!islands.includes("gz"), "island group with no gzip sizes shows raw only");
});

Deno.test("bundleRoleLines: a 0-JS app has no role section", () => {
  assertEquals(bundleRoleLines([]), []);
});

Deno.test("bundleReportMarkdown: chunk table + role section (no metafile)", () => {
  const md = bundleReportMarkdown([
    { name: "chunk-abc.js", bytes: 40000, gzip: 14000 },
    { name: "island-x.js", bytes: 8000, gzip: 3000 },
  ]).join("\n");
  assertStringIncludes(md, "# Bundle report");
  assertStringIncludes(md, "| Chunk | Role | Raw | Gzip | % |");
  assertStringIncludes(md, "`chunk-abc.js`");
  assertStringIncludes(md, "shared runtime");
  assertStringIncludes(md, "## By role");
  // No metafile → no per-module section.
  assert(!md.includes("Top modules per chunk"));
});

Deno.test("bundleReportMarkdown: per-module breakdown when a metafile is given", () => {
  const metafile: BundleMetafile = {
    outputs: {
      ".denext/client/chunk-abc.js": {
        inputs: {
          "app/node_modules/lucide-react/dist/esm/x.js": { bytesInOutput: 18000 },
          "app/page.tsx": { bytesInOutput: 400 },
        },
      },
    },
  };
  const md = bundleReportMarkdown([{ name: "chunk-abc.js", bytes: 40000, gzip: 14000 }], metafile)
    .join("\n");
  assertStringIncludes(md, "## Top modules per chunk");
  assertStringIncludes(md, "### `chunk-abc.js`");
  // node_modules prefix trimmed to a readable label, biggest module first.
  assertStringIncludes(md, "`lucide-react/dist/esm/x.js`");
  const iconAt = md.indexOf("lucide-react");
  const pageAt = md.indexOf("page.tsx");
  assert(iconAt >= 0 && iconAt < pageAt, "modules are ordered by bytes, largest first");
});

Deno.test("bundleReportMarkdown: 0-JS app", () => {
  assertStringIncludes(bundleReportMarkdown([]).join("\n"), "ships **0 KB**");
});

// The Lustre spike's shape: a library chunk only client components (islands) import must not be
// reported as the shared runtime every interactive route pays for.
const ISLAND_GRAPH: BundleChunk[] = [
  {
    name: "__denext_flight__.js",
    bytes: 4_000,
    imports: ["chunk-RT.js"],
    lazyImports: ["lustre-counter-AAAAAAAA.js", "register-counter-BBBBBBBB.js", "lazy-CCCCCCCC.js"],
  },
  { name: "chunk-RT.js", bytes: 59_000, imports: [] },
  { name: "lustre-counter-AAAAAAAA.js", bytes: 900, imports: ["chunk-GLUE.js", "chunk-RT.js"] },
  { name: "register-counter-BBBBBBBB.js", bytes: 700, imports: ["chunk-LUSTRE.js"] },
  { name: "chunk-GLUE.js", bytes: 536, imports: ["chunk-LUSTRE.js"] },
  { name: "chunk-LUSTRE.js", bytes: 55_210, imports: [] },
  { name: "lazy-CCCCCCCC.js", bytes: 2_000, imports: ["chunk-LAZY.js"] },
  { name: "chunk-LAZY.js", bytes: 800, imports: [] },
];

Deno.test("chunkRoles: a chunk only islands reach is an island chunk, not shared runtime", () => {
  const roles = chunkRoles(ISLAND_GRAPH);
  assertEquals(roles.get("chunk-RT.js"), "shared"); // the flight entry imports it
  assertEquals(roles.get("chunk-LUSTRE.js"), "island"); // only client components reach it
  assertEquals(roles.get("chunk-GLUE.js"), "island");
  assertEquals(roles.get("chunk-LAZY.js"), "on-demand"); // only the framework's lazy- chunk
  assertEquals(roles.get("__denext_flight__.js"), "entry");
  assertEquals(roles.get("lustre-counter-AAAAAAAA.js"), "entry");
  // A shared chunk an island also imports stays shared once any route entry reaches it.
  const both = chunkRoles([
    { name: "page.js", bytes: 1, imports: ["chunk-X.js"], lazyImports: ["isl-DDDDDDDD.js"] },
    { name: "isl-DDDDDDDD.js", bytes: 1, imports: ["chunk-X.js"] },
    { name: "chunk-X.js", bytes: 1, imports: [] },
  ]);
  assertEquals(both.get("chunk-X.js"), "shared");
  // Without import data (sizes only), every chunk-* is still shared runtime by name.
  const named = chunkRoles(ISLAND_GRAPH.map(({ name, bytes }) => ({ name, bytes })));
  assertEquals(named.get("chunk-LUSTRE.js"), "shared");
});

Deno.test("bundleRoleLines / markdown: an island-only chunk is counted under islands", () => {
  const lines = bundleRoleLines(ISLAND_GRAPH);
  const shared = lines.find((l) => l.includes("shared runtime"))!;
  assertStringIncludes(shared, "(1 chunk)");
  assertStringIncludes(lines.find((l) => l.includes("islands"))!, "(2 chunks)");
  const md = bundleReportMarkdown(ISLAND_GRAPH).join("\n");
  assertStringIncludes(md, "| `chunk-LUSTRE.js` | islands |");
  assertStringIncludes(md, "| `chunk-RT.js` | shared runtime |");
});

Deno.test("chunkImports / readClientChunks: static and dynamic sibling imports from emitted code", async () => {
  assertEquals(
    chunkImports(
      `import{a as b}from"./chunk-X.js";import"./chunk-Y.js";export*from './chunk-Z.js';` +
        `const m=()=>import("./counter-ABCDEFGH.js");import"https://cdn/x.js";import"./sub/y.js";`,
    ),
    {
      imports: ["chunk-X.js", "chunk-Y.js", "chunk-Z.js"],
      lazyImports: ["counter-ABCDEFGH.js"],
    },
  );
  const dir = await Deno.makeTempDir({ prefix: "denext_chunks_" });
  try {
    await Deno.writeTextFile(
      join(dir, "page.js"),
      `import"./chunk-A.js";import("./isl-EEEEEEEE.js")`,
    );
    await Deno.writeTextFile(join(dir, "chunk-A.js"), "export const a=1;");
    const chunks = (await readClientChunks(dir)).sort((x, y) => x.name.localeCompare(y.name));
    assertEquals(chunks.map((c) => [c.name, c.imports, c.lazyImports]), [
      ["chunk-A.js", [], []],
      ["page.js", ["chunk-A.js"], ["isl-EEEEEEEE.js"]],
    ]);
    assertEquals(chunks[0].bytes, 17);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
