// `denext export` keeps a page's islands and resumable markup, and a page whose only client
// code is deferred islands loads the small deferred boot instead of the Flight entry, which it
// imports on the first island trigger (src/build/flight-boot.ts).

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { staticExport } from "../src/build/export.ts";

/** Scaffold a throwaway app in `dir`: a deno.json aliasing `denext` to this checkout + `app/` files. */
async function scaffoldApp(dir: string, files: Record<string, string>) {
  const root = new URL("../", import.meta.url).href;
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
  for (const [name, src] of Object.entries(files)) {
    const path = join(dir, "app", name);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, src);
  }
}

/** The files `file` loads before anything runs: itself and its static imports, transitively. */
async function staticClosure(dir: string, file: string, seen = new Set<string>()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const code = await Deno.readTextFile(join(dir, file));
  for (
    const m of code.matchAll(/\b(?:import|export)\s*(?:[^"'();=]*?\bfrom\s*)?["']\.\/([^"']+)["']/g)
  ) {
    await staticClosure(dir, m[1], seen);
  }
  return seen;
}

/** Total bytes of `files` under `dir`. */
async function bytes(dir: string, files: Iterable<string>): Promise<number> {
  let n = 0;
  for (const f of files) n += (await Deno.stat(join(dir, f))).size;
  return n;
}

const TOGGLE = `"use client";
import { useState } from "denext";
export function Toggle({ label }: { label: string }) {
  const [n, setN] = useState(0);
  return <button type="button" id="toggle" onClick={() => setN(n + 1)}>{label} {n}</button>;
}
`;

Deno.test("staticExport: islands and resumable markup survive, and the entry defers the runtime", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_islands_export_" });
  try {
    await scaffoldApp(dir, {
      "toggle.tsx": TOGGLE,
      // A resumable route with one interaction island, like a static transcript page.
      "page.tsx": `import { Toggle } from "./toggle.tsx";
export const resumable = true;
export default function Page() {
  return <main><h1>Transcript</h1><Toggle client:interaction label="details" /></main>;
}
`,
      // A route that hydrates an island on load: it needs the runtime at once.
      "eager/page.tsx": `import { Toggle } from "../toggle.tsx";
export default function Eager() {
  return <main><Toggle client:load label="now" /></main>;
}
`,
    });
    const result = await staticExport(dir);
    assertEquals(result.pages, 2);

    const html = await Deno.readTextFile(join(result.outDir, "index.html"));
    // The island is carved out with its strategy, its handler host stamped, its Flight in the
    // islands payload, and the page root left out (null): nothing hydrates up front.
    assertMatch(html, /<div data-dnx-island data-dnx-id="[^"]+" data-dnx-strategy="interaction"/);
    assertStringIncludes(html, `data-dnx-h="click"`);
    assertStringIncludes(html, `<script id="__denext_islands" type="application/json">`);
    assertStringIncludes(html, `"i":"`); // the island's client reference
    assertStringIncludes(
      html,
      `<script id="__denext_flight" type="application/json">null</script>`,
    );
    // The page loads the deferred boot, not the Flight entry; the client:load page keeps it.
    assertStringIncludes(html, `<script type="module" src="/_denext/client/flight-boot.js">`);
    const eagerHtml = await Deno.readTextFile(join(result.outDir, "eager", "index.html"));
    assertStringIncludes(eagerHtml, `data-dnx-strategy="load"`);
    assertStringIncludes(eagerHtml, `<script type="module" src="/_denext/client/flight.js">`);

    // The boot loads nothing up front (no static import) and is a couple of KB; flight.js, which
    // it imports on demand, carries the client runtime and exports the promise the boot awaits.
    const clientDir = join(result.outDir, "_denext", "client");
    const boot = await Deno.readTextFile(join(clientDir, "flight-boot.js"));
    assertEquals([...await staticClosure(clientDir, "flight-boot.js")], ["flight-boot.js"]);
    assert(boot.length < 3_000, `flight-boot.js is ${boot.length} B`);
    assertStringIncludes(boot, `import("./flight.js")`);
    for (const s of ["data-dnx-island", "data-dnx-h", "interaction", "visible", "idle", "media"]) {
      assertStringIncludes(boot, s);
    }
    const runtime = await bytes(clientDir, await staticClosure(clientDir, "flight.js"));
    assert(runtime > 40_000, `flight.js carries the client runtime (${runtime} B)`);
    assertMatch(await Deno.readTextFile(join(clientDir, "flight.js")), /export\s*\{[^}]*\bready\b/);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
