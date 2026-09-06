// Stage 4b guard: the RSC/Flight boundary is preserved in next-compat mode. A
// compat route that reaches a `"use client"` island must render its Server
// Components (incl. an ASYNC data-fetching one) server-side only and hydrate just
// the island — never re-run server code on the client. This is a FAST proxy for
// the full real-npm E2E (tests/e2e/next-compat-*): it uses only React specifiers
// (no npm packages), so it runs on every PR and catches a regression in the
// island-identity / server-code-elision path in seconds.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import {
  buildNextCompatFlightEntry,
  buildNextCompatModules,
} from "../../src/build/next-compat-build.ts";
import {
  createNextCompatServerLoader,
  loadBundleRef,
  splitBundleRef,
} from "../../src/build/next-compat-loader.ts";
import { defaultLoader } from "../../src/server/mod.ts";
import { stopNextCompat } from "../../src/build/next-compat.ts";
import {
  type BoundaryManifest,
  buildBoundaryManifest,
  clientIdFor,
} from "../../src/build/module-graph.ts";
import { renderToHtmlFlight, serializeFlight } from "../../src/jsx/render-to-html-flight.ts";
import { tagClientExports } from "../../src/runtime/client-reference.ts";

type Fixture = {
  dir: string;
  appDir: string;
  islandPath: string;
  pagePath: string;
  configPath: string;
  outDir: string;
  clientDir: string;
};

async function writeFixture(dir: string): Promise<Fixture> {
  const appDir = join(dir, "app");
  const componentsDir = join(dir, "components");
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ nodeModulesDir: "auto", imports: {} }),
  );
  await Deno.mkdir(appDir, { recursive: true });
  await Deno.mkdir(componentsDir, { recursive: true });

  // A "use client" island (named export, NO default — the common island shape).
  const islandPath = join(componentsDir, "counter.tsx");
  await Deno.writeTextFile(
    islandPath,
    `"use client";
import { createElement as h, useState } from "react";
export function Counter() {
  const [n] = useState(0);
  return h("button", null, "ISLAND_COUNT:" + n);
}
`,
  );
  // An ASYNC data-fetching Server Component page that renders the island.
  const pagePath = join(appDir, "page.tsx");
  await Deno.writeTextFile(
    pagePath,
    `import { createElement as h } from "react";
import { Counter } from "../components/counter.tsx";
async function load() {
  await Promise.resolve();
  return "SERVER_ONLY_MARKER_XYZZY";
}
export default async function Page() {
  const data = await load();
  return h("main", null, h("p", null, data), h(Counter, null));
}
`,
  );

  const configPath = join(dir, "deno.json");
  const outDir = join(dir, ".denext");
  const clientDir = join(outDir, "client");
  await Deno.mkdir(clientDir, { recursive: true });
  return { dir, appDir, islandPath, pagePath, configPath, outDir, clientDir };
}

async function discoverBoundary(fx: Fixture): Promise<BoundaryManifest> {
  // Boundary discovery finds the island via the import-graph crawl + directive.
  // (Enumerate exports from source rather than importing — the island's bare
  // `react` import isn't in this bare test config; real apps alias it via the
  // migrated deno.json, so the prod/dev path uses `importFunctionExports`.)
  const boundary = await buildBoundaryManifest(fx.appDir, [fx.pagePath], {
    exportsOf: async (p) => {
      const src = await Deno.readTextFile(p);
      return [...src.matchAll(/export\s+function\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    },
  });
  assertEquals(boundary.client.size, 1, "one client island discovered");
  return boundary;
}

async function buildCompat(fx: Fixture, boundary: BoundaryManifest): Promise<Map<string, string>> {
  const moduleMap = await buildNextCompatModules({
    projectDir: fx.dir,
    configPath: fx.configPath,
    outDir: fx.outDir,
    modules: [fx.pagePath, fx.islandPath],
  });
  await buildNextCompatFlightEntry({
    projectDir: fx.dir,
    configPath: fx.configPath,
    outDir: fx.outDir,
    clientDir: fx.clientDir,
    boundary,
    flightFile: "flight.js",
  });
  return moduleMap;
}

async function tagIsland(
  fx: Fixture,
  boundary: BoundaryManifest,
  moduleMap: Map<string, string>,
): Promise<void> {
  // Tag through the compat loader — exactly what the prod/dev server does before rendering.
  // The page bundle and the island resolve to the SAME module inside the single keyed server
  // bundle, so tagging the loader's namespace tags the very instance the page renders.
  const load = createNextCompatServerLoader(defaultLoader, { moduleMap });
  const islandRef = [...boundary.client.values()][0];
  const islandMod = await load(fromFileUrl(islandRef.url)) as Record<string, unknown>;
  tagClientExports(islandMod, clientIdFor(fx.appDir, toFileUrl(fx.islandPath).href));
  void fx;
}

async function renderPageBundle(pageBundle: string): Promise<{ html: string; payload: string }> {
  // Render the page compat bundle through the SOURCE Flight renderer (the prod
  // path: source renderer + compat-bundled components, one dispatcher on
  // globalThis). The async Server Component must render server-side; the island
  // must appear only as a REFERENCE in the Flight payload.
  const pageMod = await loadBundleRef(defaultLoader, pageBundle) as {
    default: (p: unknown) => unknown;
  };
  const tree = await (pageMod.default as (p: unknown) => Promise<unknown>)({});
  const { html, flight } = await renderToHtmlFlight(tree as never);
  return { html, payload: serializeFlight(flight) };
}

function assertServerSideRender(html: string, payload: string, clientId: string): void {
  // Server component ran on the server (its data is in the HTML)...
  assertStringIncludes(html, "SERVER_ONLY_MARKER_XYZZY");
  // ...and the island is a client REFERENCE (not expanded server-side).
  assertStringIncludes(payload, `"i":"${clientId}#Counter"`);
  // The server-only marker must NOT leak into the Flight payload — the payload
  // carries host nodes + island references, and the island's rendered HTML, but
  // the async server function's marker text appears as page-rendered text once.
  assert(
    !payload.includes("load(") && !payload.includes("Promise.resolve"),
    "server component source must not be in the Flight payload",
  );
}

async function assertFlightClientBundle(clientDir: string, clientId: string): Promise<void> {
  // The flight CLIENT bundle registers the island's client id, contains the
  // island code, and NEVER the server-only marker or npm React.
  const flightJs = await Deno.readTextFile(join(clientDir, "flight.js"));
  assertStringIncludes(flightJs, `"${clientId}"`, "flight bundle registers the island id");
  // Islands are code-split: the island's code is in its own chunk, loaded on demand.
  let all = "";
  for await (const e of Deno.readDir(clientDir)) {
    if (e.isFile && e.name.endsWith(".js")) all += await Deno.readTextFile(join(clientDir, e.name));
  }
  assertStringIncludes(all, "ISLAND_COUNT", "island code is in a client chunk");
  assert(
    !all.includes("SERVER_ONLY_MARKER_XYZZY"),
    "server-only code must NOT be in the client flight bundle",
  );
  assert(
    !/react\.development|react\.production|__SECRET_INTERNALS_DO_NOT_USE/.test(all),
    "flight bundle must be denext's React, not npm React",
  );
}

Deno.test("next-compat Flight: async Server Component stays server-side; island hydrates", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_nc_flight_" });
  try {
    const fx = await writeFixture(dir);
    const boundary = await discoverBoundary(fx);
    const moduleMap = await buildCompat(fx, boundary);

    // Page and island are namespaces of ONE server bundle (`<bundle>#<key>`), so the page's
    // reference to the island and the tagged island are the same module by construction.
    const pageBundle = moduleMap.get(fx.pagePath)!;
    const islandBundle = moduleMap.get(fx.islandPath)!;
    assert(pageBundle && islandBundle, "page + island each have a compat ref");
    assertEquals(splitBundleRef(pageBundle).bundle, splitBundleRef(islandBundle).bundle);
    assert(splitBundleRef(islandBundle).key, "keyed ref");

    await tagIsland(fx, boundary, moduleMap);
    const { html, payload } = await renderPageBundle(pageBundle);
    const clientId = clientIdFor(fx.appDir, toFileUrl(fx.islandPath).href);
    assertServerSideRender(html, payload, clientId);
    await assertFlightClientBundle(fx.clientDir, clientId);
  } finally {
    await stopNextCompat().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
