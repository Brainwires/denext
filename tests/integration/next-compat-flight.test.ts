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
import { redirectBoundaryToCompat } from "../../src/build/next-compat-loader.ts";
import { stopNextCompat } from "../../src/build/next-compat.ts";
import { buildBoundaryManifest, clientIdFor } from "../../src/build/module-graph.ts";
import { renderToHtmlFlight, serializeFlight } from "../../src/jsx/render-to-html-flight.ts";
import { tagClientExports } from "../../src/runtime/client-reference.ts";
import { h } from "../../src/jsx/jsx-runtime.ts";

Deno.test("next-compat Flight: async Server Component stays server-side; island hydrates", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_nc_flight_" });
  const appDir = join(dir, "app");
  const componentsDir = join(dir, "components");
  try {
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

    // Boundary discovery finds the island via the import-graph crawl + directive.
    // (Enumerate exports from source rather than importing — the island's bare
    // `react` import isn't in this bare test config; real apps alias it via the
    // migrated deno.json, so the prod/dev path uses `importFunctionExports`.)
    const boundary = await buildBoundaryManifest(appDir, [pagePath], {
      exportsOf: async (p) => {
        const src = await Deno.readTextFile(p);
        return [...src.matchAll(/export\s+function\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]);
      },
    });
    assertEquals(boundary.client.size, 1, "one client island discovered");

    const moduleMap = await buildNextCompatModules({
      projectDir: dir,
      configPath,
      outDir,
      modules: [pagePath, islandPath],
    });
    await buildNextCompatFlightEntry({
      projectDir: dir,
      configPath,
      outDir,
      clientDir,
      boundary,
      flightFile: "flight.js",
    });

    // The island is bundled as its OWN entry (a separate module → shared runtime
    // chunk), never inlined into the page bundle. This is what makes identity hold.
    const pageBundle = moduleMap.get(pagePath)!;
    const islandBundle = moduleMap.get(islandPath)!;
    assert(pageBundle && islandBundle, "page + island each have a compat bundle");

    // Redirect the boundary ref to the compat island bundle, then tag it — exactly
    // what the prod/dev server does before rendering. The page bundle imports the
    // island through the same shared chunk, so tagging the compat bundle's export
    // tags the very instance the page renders.
    redirectBoundaryToCompat(boundary, moduleMap);
    const islandRef = [...boundary.client.values()][0];
    assertEquals(
      islandRef.url,
      toFileUrl(islandBundle).href,
      "boundary ref redirected to the compat island bundle",
    );
    const islandMod = await import(islandRef.url) as Record<string, unknown>;
    tagClientExports(islandMod, clientIdFor(appDir, toFileUrl(islandPath).href));

    // Render the page compat bundle through the SOURCE Flight renderer (the prod
    // path: source renderer + compat-bundled components, one dispatcher on
    // globalThis). The async Server Component must render server-side; the island
    // must appear only as a REFERENCE in the Flight payload.
    const pageMod = await import(toFileUrl(pageBundle).href) as {
      default: (p: unknown) => unknown;
    };
    const tree = await (pageMod.default as (p: unknown) => Promise<unknown>)({});
    const { html, flight } = await renderToHtmlFlight(tree as never);

    // Server component ran on the server (its data is in the HTML)...
    assertStringIncludes(html, "SERVER_ONLY_MARKER_XYZZY");
    // ...and the island is a client REFERENCE (not expanded server-side).
    const clientId = clientIdFor(appDir, toFileUrl(islandPath).href);
    const payload = serializeFlight(flight);
    assertStringIncludes(payload, `"i":"${clientId}#Counter"`);
    // The server-only marker must NOT leak into the Flight payload — the payload
    // carries host nodes + island references, and the island's rendered HTML, but
    // the async server function's marker text appears as page-rendered text once.
    assert(
      !payload.includes("load(") && !payload.includes("Promise.resolve"),
      "server component source must not be in the Flight payload",
    );

    // The flight CLIENT bundle registers the island's client id, contains the
    // island code, and NEVER the server-only marker or npm React.
    const flightJs = await Deno.readTextFile(join(clientDir, "flight.js"));
    assertStringIncludes(flightJs, `"${clientId}"`, "flight bundle registers the island id");
    assertStringIncludes(flightJs, "ISLAND_COUNT", "island code is in the flight bundle");
    assert(
      !flightJs.includes("SERVER_ONLY_MARKER_XYZZY"),
      "server-only code must NOT be in the client flight bundle",
    );
    assert(
      !/react\.development|react\.production|__SECRET_INTERNALS_DO_NOT_USE/.test(flightJs),
      "flight bundle must be denext's React, not npm React",
    );
  } finally {
    await stopNextCompat().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
