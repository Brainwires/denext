import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  buildBoundaryManifest,
  cachedGraphHas,
  clientGraphModules,
  clientIdFor,
  computeBoundaryRoutes,
  crawlLocalModules,
  exportListNames,
  importFunctionExports,
  isUnderFrameworkSrc,
  resetModuleGraphCache,
  routeEntryFiles,
  shortHash,
} from "../src/build/module-graph.ts";
import { SEPARATOR, toFileUrl } from "@std/path";
import { inChild } from "./helpers/isolated.ts";

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

Deno.test("exportsOf runs for server-action modules only; client islands are read statically", async () => {
  const app = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(app, "page.tsx"),
      `"use client"\nimport { save } from "./actions.ts";\nexport function A() {}\nexport { save as B }`,
    );
    await Deno.writeTextFile(
      join(app, "actions.ts"),
      `"use server"\nexport async function save() {}\nexport const LIMIT = 1;`,
    );
    const asked: string[] = [];
    const bm = await buildBoundaryManifest(app, [join(app, "page.tsx")], {
      exportsOf: (file) => {
        asked.push(file);
        return ["save"];
      },
    });
    // The island's names come from the static lexer — it was never imported/executed.
    const island = [...bm.client.values()][0];
    assertEquals(island.exports.sort(), ["A", "B"]);
    assertEquals(asked, [join(app, "actions.ts")], "exportsOf saw only the server module");
    const action = [...bm.server.values()][0];
    assertEquals(action.exports, ["save"]);
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

Deno.test("a route whose only interactive part is a live view is a Flight route", async () => {
  const app = await Deno.realPath(await Deno.makeTempDir());
  try {
    // The framework's own `denext/live` (it names `defineLiveView` too, and must not count).
    const live = new URL("../src/live.ts", import.meta.url).href;
    await Deno.mkdir(join(app, "view"));
    await Deno.mkdir(join(app, "plain"));
    await Deno.writeTextFile(
      join(app, "view", "counter.ts"),
      `import { defineLiveView } from "${live}";\n` +
        `export const Counter = defineLiveView({ id: "c", init: () => [0], update: (_m, n) => [n], view: () => null });\n`,
    );
    await Deno.writeTextFile(
      join(app, "view", "page.tsx"),
      `import { Counter } from "./counter.ts";\nexport default function Page() { return Counter({}); }\n`,
    );
    // A page that imports `denext/live` but renders no live view stays off Flight.
    await Deno.writeTextFile(
      join(app, "plain", "page.tsx"),
      `import { useSubscription } from "${live}";\nexport default function Page() { return String(useSubscription); }\n`,
    );
    const route = (dir: string) => ({
      routePath: `/${dir}`,
      filePath: join(app, dir, "page.tsx"),
      layoutChain: [] as string[],
      templateChain: [] as string[],
    });
    const flightRoutes = await computeBoundaryRoutes(app, [route("view"), route("plain")]);
    assert(flightRoutes.has("/view"), "a live-view-only route must ship the Flight entry");
    assertEquals(
      flightRoutes.has("/plain"),
      false,
      "a route with no live view ships no Live client",
    );
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("an interactive `use client` error boundary flags the route as Flight (no isomorphic layout leak)", async () => {
  const app = await Deno.makeTempDir();
  try {
    // The page and layout are pure server components; only error.tsx is a client
    // island. Before the fix, error/loading boundaries were absent from
    // routeEntryFiles, so the route was NOT a Flight route — it fell to the
    // isomorphic full-tree hydration path, which value-imports the server layout
    // chain and leaks its server-only imports (e.g. node:sqlite) into the browser.
    await Deno.writeTextFile(
      join(app, "page.tsx"),
      `export default function Page() { return null; }`,
    );
    await Deno.writeTextFile(
      join(app, "layout.tsx"),
      // A layout that (transitively) touches server-only code — the thing that
      // must never reach the client bundle.
      `import { DatabaseSync } from "node:sqlite";\n` +
        `const db = new DatabaseSync(":memory:");\n` +
        `export default function Layout({ children }) { return children; }`,
    );
    await Deno.writeTextFile(
      join(app, "error.tsx"),
      `"use client"\nexport default function Err({ reset }) { return reset; }`,
    );

    const route = {
      routePath: "/",
      filePath: join(app, "page.tsx"),
      layoutChain: [join(app, "layout.tsx")],
      templateChain: [] as string[],
      error: join(app, "error.tsx"),
      loading: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
    };

    // routeEntryFiles now includes the error boundary…
    const entryFiles = routeEntryFiles(route);
    assert(
      entryFiles.includes(join(app, "error.tsx")),
      "routeEntryFiles must include the error boundary",
    );

    // …so the boundary manifest discovers error.tsx as a client island…
    const bm = await buildBoundaryManifest(app, entryFiles);
    const errId = clientIdFor(app, toFileUrl(join(app, "error.tsx")).href);
    assert(bm.client.has(errId), "the error boundary must be in the boundary manifest");

    // …and the route is classified as Flight, keeping the server layout off the client.
    const flightRoutes = await computeBoundaryRoutes(app, [route]);
    assert(
      flightRoutes.has("/"),
      "a `use client` error boundary must flag the route as Flight",
    );
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

Deno.test("importFunctionExports includes a createChannel export (a non-function server ref)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ife_ch_" });
  try {
    const file = join(dir, "channels.ts");
    // A channel is a plain object carrying the well-known channel brand (Symbol.for), not a
    // function — but the client stub must still list it so `useChannel` can import it from a
    // "use server" module. A plain non-function export must stay excluded.
    await Deno.writeTextFile(
      file,
      `const BRAND = Symbol.for("denext.channel");\n` +
        `export const room = { denextChannelId: "", publish() {}, revoke() {}, [BRAND]: {} };\n` +
        `export const other = 42;\n` +
        `export function act() {}\n`,
    );
    const names = await importFunctionExports(file);
    assert(names.includes("room"), "the channel export is included despite not being a function");
    assert(names.includes("act"), "function exports still included");
    assert(!names.includes("other"), "an ordinary non-function export is still excluded");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("exportListNames parses an `export { … }` list body", () => {
  assertEquals(exportListNames(" a, b as c, default as X, "), ["a", "c", "X"]);
  // Type-only entries and malformed names are not runtime exports.
  assertEquals(exportListNames("type T, 1bad, ok"), ["ok"]);
});

Deno.test("crawlLocalModules follows RUNTIME import edges only — a type-only import ships no code", async () => {
  const app = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(app, "page.tsx"),
      `import type { Props } from "./types.ts";\nimport { label } from "./util.ts";\n` +
        `export default function Page(_p: Props) { return label; }`,
    );
    // A types module whose only import is a hooks-defining runtime module (as
    // `src/compat/react-types.ts` does for `Context<T>`): type-only, so unreachable at runtime.
    await Deno.writeTextFile(
      join(app, "types.ts"),
      `import type { State } from "./hooks.ts";\nexport interface Props { s?: State }`,
    );
    await Deno.writeTextFile(
      join(app, "hooks.ts"),
      `export type State = number;\nexport function useThing() { return 1; }`,
    );
    await Deno.writeTextFile(join(app, "util.ts"), `export const label = "x";`);
    const locals = await crawlLocalModules([join(app, "page.tsx")]);
    const names = locals.filter((p) => p.startsWith(app)).map((p) => p.slice(app.length + 1))
      .sort();
    assertEquals(names, ["page.tsx", "util.ts"], "types.ts and hooks.ts are type-only");
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("module graph cache: a crawl over a subset of an earlier crawl's entries spawns no deno info", async () => {
  const { denoInfoGraph, moduleGraphSpawnCount, resetModuleGraphCache } = await import(
    "../src/build/module-graph.ts"
  );
  const app = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.writeTextFile(join(app, "a.ts"), `import "./shared.ts"; export const a = 1;`);
    await Deno.writeTextFile(join(app, "b.ts"), `import "./only-b.ts"; export const b = 1;`);
    await Deno.writeTextFile(join(app, "shared.ts"), `export const s = 1;`);
    await Deno.writeTextFile(join(app, "only-b.ts"), `export const o = 1;`);
    resetModuleGraphCache();
    const before = moduleGraphSpawnCount();
    const union = await crawlLocalModules([join(app, "a.ts"), join(app, "b.ts")]);
    assertEquals(moduleGraphSpawnCount(), before + 1, "the union crawl spawns once");
    assertEquals(union.map((p) => p.slice(app.length + 1)).sort(), [
      "a.ts",
      "b.ts",
      "only-b.ts",
      "shared.ts",
    ]);
    // A subset request is served from the cached graph — and scoped to ITS roots only.
    const onlyA = await crawlLocalModules([join(app, "a.ts")]);
    assertEquals(moduleGraphSpawnCount(), before + 1, "no second spawn");
    assertEquals(onlyA.map((p) => p.slice(app.length + 1)).sort(), ["a.ts", "shared.ts"]);
    // The raw graph API agrees and reports resolved roots.
    const g = await denoInfoGraph([join(app, "b.ts")]);
    assertEquals(g.roots, [toFileUrl(join(app, "b.ts")).href]);
    assertEquals(moduleGraphSpawnCount(), before + 1);
    // A NAMED cache is independent: the CSS crawl (a different resolution) never reads the
    // default graph, and its own crawl doesn't feed it either.
    await denoInfoGraph([join(app, "a.ts")], { cache: "css" });
    assertEquals(moduleGraphSpawnCount(), before + 2, "named cache: its own crawl");
    await denoInfoGraph([join(app, "a.ts")], { cache: "css" });
    assertEquals(moduleGraphSpawnCount(), before + 2, "…then cached under that name");
    // After a reset the next request crawls again (the dev watcher's path).
    resetModuleGraphCache();
    await crawlLocalModules([join(app, "a.ts")]);
    assertEquals(moduleGraphSpawnCount(), before + 3);
  } finally {
    resetModuleGraphCache();
    await Deno.remove(app, { recursive: true });
  }
});

// The build manifest carries the boundary (project-relative paths) so the prod server skips the
// startup crawl; node_modules islands outside the project dir round-trip through `../`.
Deno.test("boundary manifest serializes to project-relative paths and back", async () => {
  const { deserializeBoundary, serializeBoundary } = await import("../src/build/module-graph.ts");
  // A real absolute root on this OS (`C:\repo` on Windows), so the paths are local ones.
  const repo = Deno.build.os === "windows" ? "C:\\repo" : "/repo";
  const url = (rel: string) => toFileUrl(join(repo, rel)).href;
  const project = join(repo, "apps", "web");
  const b = {
    client: new Map([
      ["c_a", { url: url("apps/web/components/a.tsx"), exports: ["A"] }],
      ["c_nm", { url: url("node_modules/vaul/dist/index.mjs"), exports: ["Drawer"] }],
    ]),
    server: new Map([["s_x", { url: url("apps/web/app/actions.ts"), exports: ["save"] }]]),
  };
  const s = serializeBoundary(b, project);
  // The manifest is `/`-separated on every OS.
  assertEquals(s.client.c_a.path, "components/a.tsx");
  assertEquals(s.client.c_nm.path, "../../node_modules/vaul/dist/index.mjs");
  const back = deserializeBoundary(JSON.parse(JSON.stringify(s)), project);
  assertEquals(back.client.get("c_nm")?.url, url("node_modules/vaul/dist/index.mjs"));
  assertEquals(back.server.get("s_x"), { url: url("apps/web/app/actions.ts"), exports: ["save"] });
});

Deno.test("cachedGraphHas: what a cached crawl of the project reached; null with none", async () => {
  resetModuleGraphCache();
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_graph_has_" }));
  try {
    await Deno.writeTextFile(join(dir, "a.ts"), `import "./b.ts";\n`);
    await Deno.writeTextFile(join(dir, "b.ts"), `export const b = 1;\n`);
    await Deno.writeTextFile(join(dir, "c.ts"), `export const c = 1;\n`);
    assertEquals(cachedGraphHas(join(dir, "b.ts"), dir), null, "nothing crawled yet");
    await crawlLocalModules([join(dir, "a.ts")]);
    assertEquals(cachedGraphHas(join(dir, "b.ts"), dir), true);
    assertEquals(cachedGraphHas(join(dir, "c.ts"), dir), false);
    assertEquals(cachedGraphHas(join(dir, "c.ts"), join(dir, "other")), null, "another project");
  } finally {
    resetModuleGraphCache();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("clientGraphModules: what a client bundle can contain — islands' graphs and whole-tree routes, never past a use server module", async () => {
  const app = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_client_graph_" }));
  const files: Record<string, string> = {
    // A Flight page: its data module is the server tree's only.
    "page.tsx": `import { Island } from "./Island.tsx";\nimport { load } from "./data.ts";\n` +
      `export default async function Page() { return [await load(), Island]; }\n`,
    "data.ts": `export async function load() { await 0; return "d"; }\n`,
    // The island's graph ships: a store, a lazily imported module and an action stub.
    "Island.tsx": `"use client"\nimport { useCounter } from "./store.ts";\n` +
      `import { save } from "./actions.ts";\n` +
      `export function Island() { void import("./lazy.ts"); return [useCounter, save]; }\n`,
    "store.ts": `import { helper } from "./helper.mts";\nexport const useCounter = helper;\n`,
    "helper.mts": `export const helper = 1;\n`,
    "lazy.ts": `export const lazy = 1;\n`,
    // A "use server" module and what only it imports stay out.
    "actions.ts": `"use server"\nimport { db } from "./db.ts";\n` +
      `export async function save() { await db(); }\n`,
    "db.ts": `export async function db() { await 0; }\n`,
    // A route hydrated whole: its tree ships, server-looking or not.
    "other.tsx":
      `import { util } from "./util.js";\nexport default function O() { return util; }\n`,
    "util.js": `export const util = 1;\n`,
  };
  try {
    for (const [name, src] of Object.entries(files)) {
      await Deno.writeTextFile(join(app, name), src);
    }
    const page = join(app, "page.tsx");
    const other = join(app, "other.tsx");
    const rel = (paths: string[]) => paths.map((p) => p.slice(app.length + 1));
    assertEquals(rel(await clientGraphModules([page, other], [other])), [
      "Island.tsx",
      "helper.mts",
      "lazy.ts",
      "other.tsx",
      "store.ts",
      "util.js",
    ]);
    // Without the whole-tree route, only the island's graph.
    assertEquals(rel(await clientGraphModules([page, other])), [
      "Island.tsx",
      "helper.mts",
      "lazy.ts",
      "store.ts",
    ]);
    assertEquals(await clientGraphModules([]), []);
  } finally {
    resetModuleGraphCache();
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test({
  name: "denoInfoGraph: returns once `deno info` exits while a process it left holds its output",
  // The stand-in `deno` is a shell script. On Windows the holder is a process another thread of
  // the test process spawned meanwhile (it inherits the pipe); the read is the same.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_graph_held_" });
    const pidFile = join(dir, "pid");
    const entry = join(dir, "entry.ts");
    await Deno.writeTextFile(entry, "export {};\n");
    // Prints a graph and exits, leaving a background process with its stdout and stderr open.
    const fake = join(dir, "fake-deno");
    await Deno.writeTextFile(
      fake,
      `#!/bin/sh\nsleep 120 &\necho $! > '${pidFile}'\n` +
        `printf '%s' '{"roots":[],"modules":[{"specifier":"x"}],"redirects":{}}'\n`,
    );
    await Deno.chmod(fake, 0o755);
    try {
      const t0 = Date.now();
      const { value } = await inChild<{ modules: number; roots: string[] }>({
        imports: `import { denoInfoGraph } from "@repo/src/build/module-graph.ts";`,
        body: `const g = await denoInfoGraph([${JSON.stringify(entry)}], { cache: false });\n` +
          `return { modules: g.info.modules.length, roots: g.roots };`,
        env: { DENO_BIN: fake },
        timeoutMs: 60_000,
      });
      assertEquals(value, { modules: 1, roots: [toFileUrl(entry).href] });
      assert(Date.now() - t0 < 60_000, `took ${Date.now() - t0} ms`);
    } finally {
      try {
        Deno.kill(Number((await Deno.readTextFile(pidFile)).trim()), "SIGKILL");
      } catch { /* gone, or never started */ }
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "denoInfoGraph: a `deno info` that never exits is killed at the deadline and the crawl fails",
  // The stand-in `deno` is a shell script.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_graph_stuck_" });
    const entry = join(dir, "entry.ts");
    await Deno.writeTextFile(entry, "export {};\n");
    const fake = join(dir, "fake-deno");
    await Deno.writeTextFile(fake, `#!/bin/sh\nexec sleep 120\n`);
    await Deno.chmod(fake, 0o755);
    try {
      const t0 = Date.now();
      const { value, stderr } = await inChild<string>({
        imports: `import { denoInfoGraph } from "@repo/src/build/module-graph.ts";`,
        body: `return await denoInfoGraph([${JSON.stringify(entry)}], ` +
          `{ cache: false, deadlineMs: 1_000 })` +
          `.then(() => "returned", (e) => String(e));`,
        env: { DENO_BIN: fake },
        timeoutMs: 60_000,
      });
      assert(value.includes("was still running after 1 s and was killed"), value);
      // Killed, retried once, killed again.
      assert(value.includes("stalled twice"), value);
      assert(stderr.includes("retrying once: deno info info --unstable-sloppy-imports"), stderr);
      assertEquals(stderr.split("retrying once").length, 2, stderr);
      assert(Date.now() - t0 < 60_000, `took ${Date.now() - t0} ms`);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "denoInfoGraph: concurrent crawls run one `deno info` at a time",
  // The stand-in `deno` is a shell script.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_graph_serial_" });
    const entries = [0, 1, 2, 3].map((i) => join(dir, `entry${i}.ts`));
    for (const e of entries) await Deno.writeTextFile(e, "export {};\n");
    // `mkdir` is atomic: a second `deno info` running at once finds the directory and records it.
    const fake = join(dir, "fake-deno");
    await Deno.writeTextFile(
      fake,
      `#!/bin/sh\nmkdir '${dir}/running' 2>/dev/null || echo x >> '${dir}/overlap'\n` +
        `echo x >> '${dir}/runs'\nsleep 0.3\nrmdir '${dir}/running' 2>/dev/null\n` +
        `printf '%s' '{"roots":[],"modules":[],"redirects":{}}'\n`,
    );
    await Deno.chmod(fake, 0o755);
    try {
      const { value } = await inChild<number>({
        imports: `import { denoInfoGraph } from "@repo/src/build/module-graph.ts";`,
        body: `const all = ${JSON.stringify(entries)}.map((e) => ` +
          `denoInfoGraph([e], { cache: false }));\n` +
          `return (await Promise.all(all)).length;`,
        env: { DENO_BIN: fake },
        timeoutMs: 60_000,
      });
      assertEquals(value, 4);
      assertEquals((await Deno.readTextFile(join(dir, "runs"))).trim().split("\n").length, 4);
      const overlap = await Deno.readTextFile(join(dir, "overlap")).catch(() => "");
      assertEquals(overlap, "", "two `deno info` children ran at once");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// `deno info` runs with stderr discarded (a quiet stderr pipe held for the crawl's whole life
// starves other children's reads on Windows); only a failed crawl runs again with stderr piped,
// for the error text. A fake `deno` logs how its stderr was opened (POSIX shell).
Deno.test({
  name: "deno info: stderr is discarded, and piped only on a re-run after a failure",
  ignore: Deno.build.os === "windows",
}, async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_fake_info_" }));
  try {
    const fake = join(dir, "deno");
    const log = join(dir, "log");
    await Deno.writeTextFile(
      fake,
      `#!/bin/sh\n` +
        `if [ /dev/fd/2 -ef /dev/null ]; then echo null >> "${log}"; else echo piped >> "${log}"; fi\n` +
        `if [ -f "${dir}/fail" ]; then echo "boom: the graph is broken" >&2; exit 3; fi\n` +
        `echo '{"roots":[],"modules":[],"redirects":{}}'\n`,
    );
    await Deno.chmod(fake, 0o755);
    await Deno.writeTextFile(join(dir, "a.ts"), "export const a = 1;\n");
    const { value } = await inChild<{ ok: string[]; failed: string; failLog: string[] }>({
      imports: `import { denoInfoGraph } from "@repo/src/build/module-graph.ts";`,
      env: { DENO_BIN: fake },
      body: `
        const read = async () => (await Deno.readTextFile(${
        JSON.stringify(log)
      })).trim().split("\\n");
        await denoInfoGraph([${JSON.stringify(join(dir, "a.ts"))}], { cache: false });
        const ok = await read();
        await Deno.remove(${JSON.stringify(log)});
        await Deno.writeTextFile(${JSON.stringify(join(dir, "fail"))}, "");
        const failed = await denoInfoGraph([${JSON.stringify(join(dir, "a.ts"))}], { cache: false })
          .then(() => "resolved", (e) => e.message);
        return { ok, failed, failLog: await read() };
      `,
    });
    assertEquals(value.ok, ["null"], "a clean crawl runs once, stderr discarded");
    assertEquals(value.failLog, ["null", "piped"], "a failed crawl runs again with stderr piped");
    assert(value.failed.startsWith("deno info failed (3):\n"), value.failed);
    assert(value.failed.includes("boom: the graph is broken"), value.failed);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
