// The framework's fixed-name client bundles (the Flight entry, its deferred boot, the
// global-error entry) have namespaced names, so a route whose id matches the old names (`/flight`,
// `/flight-boot`, `/global-error`) keeps its own bundle instead of overwriting, or being
// overwritten by, the framework's. A dynamic segment that would spell a reserved id exactly is
// refused at build time.

import { assert, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { build } from "../../src/build/build.ts";
import { serveEphemeral } from "../../src/build/prod-server.ts";
import {
  assertNoReservedRouteIds,
  FLIGHT_BUNDLE_FILE,
  RESERVED_BUNDLE_IDS,
} from "../../src/build/build-pipeline/context.ts";
import { FLIGHT_BOOT_FILE } from "../../src/build/flight-boot.ts";
import { routeId } from "../../src/build/paths.ts";

/** A page that calls a hook itself: a whole-route client bundle, `<routeId>.js`. */
const hookPage = (marker: string) =>
  `import { useState } from "denext";
export default function Page() {
  const [n, setN] = useState(0);
  return <button type="button" onClick={() => setN(n + 1)}>{"${marker}:" + n}</button>;
}
`;

async function writeFixture(dir: string): Promise<void> {
  const root = new URL("../../", import.meta.url).href;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": `${root}mod.ts`,
        "denext/jsx-runtime": `${root}src/jsx/jsx-runtime.ts`,
        "denext/server": `${root}src/server/mod.ts`,
        "denext/client": `${root}src/client/mod.ts`,
      },
    }),
  );
  for (const d of ["app/flight", "app/flight-boot"]) {
    await Deno.mkdir(join(dir, d), { recursive: true });
  }
  await Deno.writeTextFile(
    join(dir, "app", "layout.tsx"),
    `export default function RootLayout({ children }: { children: unknown }) {
  return <html><body>{children}</body></html>;
}
`,
  );
  // The home page has a deferred Flight island, so the build writes the Flight entry and its boot.
  await Deno.writeTextFile(
    join(dir, "app", "counter.tsx"),
    `"use client";
import { useState } from "denext";
export function Counter() {
  const [n, setN] = useState(0);
  return <button type="button" onClick={() => setN(n + 1)}>{"ISLAND_MARKER:" + n}</button>;
}
`,
  );
  await Deno.writeTextFile(
    join(dir, "app", "page.tsx"),
    `import { Counter } from "./counter.tsx";
export default function Home() {
  return <main><Counter client:visible /></main>;
}
`,
  );
  await Deno.writeTextFile(join(dir, "app", "flight", "page.tsx"), hookPage("FLIGHT_ROUTE"));
  await Deno.writeTextFile(join(dir, "app", "flight-boot", "page.tsx"), hookPage("BOOT_ROUTE"));
}

Deno.test({
  name: "native build: /flight and /flight-boot routes keep their bundles beside the Flight entry",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_reserved_bundles_" });
  try {
    await writeFixture(dir);
    await build(dir);
    const client = join(dir, ".denext", "client");
    const read = (name: string) => Deno.readTextFile(join(client, name));
    const flightRoute = await read("flight.js");
    assertStringIncludes(flightRoute, "FLIGHT_ROUTE", "the /flight route's bundle was overwritten");
    assert(!flightRoute.includes("ISLAND_MARKER"), "flight.js holds the Flight entry");
    assertStringIncludes(await read("flight-boot.js"), "BOOT_ROUTE");
    // The Flight entry (or a chunk it imports) carries the island; its boot imports the entry.
    assertStringIncludes(await read(FLIGHT_BOOT_FILE), `import("./${FLIGHT_BUNDLE_FILE}")`);
    const entry = await read(FLIGHT_BUNDLE_FILE);
    assert(!entry.includes("FLIGHT_ROUTE"), "the Flight entry holds the /flight route");
    const server = await serveEphemeral(dir);
    try {
      const html = await (await fetch(`${server.origin}/flight`)).text();
      assertStringIncludes(html, "FLIGHT_ROUTE:0");
      assertStringIncludes(html, "/_denext/client/flight.js");
      const home = await (await fetch(`${server.origin}/`)).text();
      assert(
        home.includes(`/_denext/client/${FLIGHT_BOOT_FILE}`) ||
          home.includes(`/_denext/client/${FLIGHT_BUNDLE_FILE}`),
        "the home page boots the Flight entry by its namespaced name",
      );
    } finally {
      await server.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("a dynamic segment that spells a reserved bundle id is refused", () => {
  for (const id of RESERVED_BUNDLE_IDS) {
    // `[x]` becomes `_x_`: the segment `[<id without its outer underscores>]` spells it.
    const routePath = `/[${id.slice(1, -1)}]`;
    assert(routeId(routePath) === id, `${routePath} → ${routeId(routePath)}`);
    assertThrows(
      () => assertNoReservedRouteIds(["/ok", routePath], routeId),
      Error,
      `bundle id "${id}"`,
    );
  }
  assertNoReservedRouteIds(["/flight", "/global-error", "/flight-boot"], routeId);
});
