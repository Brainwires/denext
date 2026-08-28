import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  buildBoundaryManifest,
  clientIdFor,
  computeBoundaryRoutes,
  crawlLocalModules,
  importFunctionExports,
  isUnderFrameworkSrc,
  routeEntryFiles,
  shortHash,
} from "../src/build/module-graph.ts";
import { SEPARATOR, toFileUrl } from "@std/path";

Deno.test("shortHash is stable and deterministic", () => {
  assertEquals(shortHash("a/b/c.tsx"), shortHash("a/b/c.tsx"));
  assert(shortHash("a") !== shortHash("b"));
});

Deno.test("Tier3: framework-src exclusion matches on a path-segment boundary", () => {
  const S = SEPARATOR;
  const fwSrc = `${S}repo${S}denext${S}src`;
  // Framework internals under src/ are excluded…
  assert(isUnderFrameworkSrc(fwSrc, fwSrc), "the src dir itself");
  assert(isUnderFrameworkSrc(`${fwSrc}${S}server${S}app.ts`, fwSrc), "a nested module");
  // …but a sibling that merely starts with "src" is NOT (the bare-prefix bug).
  assertEquals(
    isUnderFrameworkSrc(`${S}repo${S}denext${S}src-app${S}page.tsx`, fwSrc),
    false,
    "a sibling `src-app/` must still have its boundaries discovered",
  );
  assertEquals(
    isUnderFrameworkSrc(`${S}repo${S}denext${S}srcery.ts`, fwSrc),
    false,
    "a sibling file prefixed with `src` is not framework-internal",
  );
});

Deno.test("crawl + classify discovers a use client leaf imported by a server page", async () => {
  const app = await Deno.makeTempDir();
  try {
    // A server page importing a client island that itself imports a shared util.
    await Deno.writeTextFile(
      join(app, "page.tsx"),
      `"use server"\nimport { Button } from "./Button.tsx";\n` +
        `export default function Page() { return Button; }`,
    );
    await Deno.writeTextFile(
      join(app, "Button.tsx"),
      `"use client"\nimport { label } from "./util.ts";\n` +
        `export function Button() { return label; }`,
    );
    await Deno.writeTextFile(
      join(app, "util.ts"),
      `export const label = "x";`, // undirected/shared
    );

    const entry = join(app, "page.tsx");

    // Crawl reaches all three app modules (plus framework internals, filtered by
    // restricting to paths under the app dir here).
    const locals = await crawlLocalModules([entry]);
    const names = locals
      .filter((p) => p.startsWith(app))
      .map((p) => p.slice(app.length + 1))
      .sort();
    assertEquals(names, ["Button.tsx", "page.tsx", "util.ts"]);

    // Classification: page -> server, Button -> client, util -> neither.
    const bm = await buildBoundaryManifest(app, [entry]);
    const clientUrls = [...bm.client.values()].map((r) => r.url);
    const serverUrls = [...bm.server.values()].map((r) => r.url);
    assertEquals(clientUrls, [toFileUrl(join(app, "Button.tsx")).href]);
    assertEquals(serverUrls, [toFileUrl(join(app, "page.tsx")).href]);
    // util.ts (undirected) is in neither map.
    assertEquals(bm.client.size + bm.server.size, 2);

    // The client id is the derived stable id.
    const expectedId = clientIdFor(app, toFileUrl(join(app, "Button.tsx")).href);
    assert(bm.client.has(expectedId));
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("exportsOf populates ref export names when provided", async () => {
  const app = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(app, "page.tsx"),
      `"use client"\nexport function A() {}\nexport function B() {}`,
    );
    const bm = await buildBoundaryManifest(app, [join(app, "page.tsx")], {
      exportsOf: () => ["A", "B"],
    });
    const ref = [...bm.client.values()][0];
    assertEquals(ref.exports, ["A", "B"]);
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("H1: a client island imported only by a layout is discovered (not just page files)", async () => {
  const app = await Deno.makeTempDir();
  try {
    // The page has NO island; the layout imports the client island. A page-only
    // crawl would miss it — the fix crawls the route's full entry set.
    await Deno.writeTextFile(
      join(app, "page.tsx"),
      `"use server"\nexport default function Page() { return null; }`,
    );
    await Deno.writeTextFile(
      join(app, "layout.tsx"),
      `import { Toggle } from "./Toggle.tsx";\n` +
        `export default function Layout({ children }) { return [Toggle, children]; }`,
    );
    await Deno.writeTextFile(
      join(app, "Toggle.tsx"),
      `"use client"\nexport function Toggle() { return null; }`,
    );

    const route = {
      routePath: "/",
      filePath: join(app, "page.tsx"),
      layoutChain: [join(app, "layout.tsx")],
      templateChain: [] as string[],
    };

    // routeEntryFiles includes the layout, so the island is found…
    const full = await buildBoundaryManifest(app, routeEntryFiles(route));
    const toggleId = clientIdFor(app, toFileUrl(join(app, "Toggle.tsx")).href);
    assert(full.client.has(toggleId), "layout-only island must be in the boundary manifest");

    // …whereas the old page-files-only crawl would have missed it (regression guard).
    const pageOnly = await buildBoundaryManifest(app, [join(app, "page.tsx")]);
    assert(
      !pageOnly.client.has(toggleId),
      "page-only crawl misses the layout island (the bug this fix closes)",
    );

    // And the route is correctly classified as needing Flight.
    const flightRoutes = await computeBoundaryRoutes(app, [route]);
    assert(flightRoutes.has("/"), "a layout-only island must flag the route as Flight");
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("importFunctionExports falls back to a static read when a module throws at eval", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ife_" });
  try {
    // A module that throws at module-eval (an npm default-import interop failure looks
    // like this: `styled.div` where `styled` came back as the namespace). Executing it to
    // read exports is impossible; the static fallback must still return the export names.
    const file = join(dir, "boom.tsx");
    await Deno.writeTextFile(
      file,
      `const styled: any = {};\n` +
        `export const Container = styled.div\`color:red\`;\n` + // TypeError: styled.div is not a function
        `export function Widget() { return null; }\n` +
        `export default Widget;\n`,
    );
    const names = await importFunctionExports(file);
    // Static extraction returns every export name (a superset of the function exports).
    assert(names.includes("default"), "default export found statically");
    assert(names.includes("Container"), "named const export found statically");
    assert(names.includes("Widget"), "named function export found statically");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("importFunctionExports returns runtime function exports when the module loads", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ife_ok_" });
  try {
    const file = join(dir, "ok.tsx");
    await Deno.writeTextFile(
      file,
      `export function A() {}\nexport const B = 1;\nexport default function C() {}\n`,
    );
    const names = await importFunctionExports(file);
    // Runtime path filters to functions: A and C (default), NOT the numeric B.
    assert(names.includes("A"));
    assert(names.includes("default"));
    assert(!names.includes("B"), "non-function export excluded on the runtime path");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
