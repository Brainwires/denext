// `denext export` of a next-compat app with a client island: the Flight bundle must be the compat
// (esbuild, react→denext) one, as `denext build` makes it. The native one (`deno bundle` of the
// source islands) cannot resolve an island's bare `react` import (nothing maps it outside the
// compat bundle), and for an npm island would bundle the library's own React and Next's real
// `next/*` modules — the export of examples/clerk failed exactly there.

import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { staticExport } from "../../src/build/export.ts";
import { stopNextCompat } from "../../src/build/next-compat.ts";

/** A compat app: a Server Component page rendering a `"use client"` island that imports react. */
async function writeFixture(dir: string): Promise<void> {
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ nodeModulesDir: "auto", imports: {} }),
  );
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    "export default { compatibilityMode: true };\n",
  );
  await Deno.mkdir(join(dir, "app"), { recursive: true });
  await Deno.mkdir(join(dir, "components"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "components", "counter.tsx"),
    `"use client";
import { createElement as h, useState } from "react";
export function Counter() {
  const [n, setN] = useState(0);
  return h("button", { onClick: () => setN(n + 1) }, "EXPORT_ISLAND:" + n);
}
`,
  );
  await Deno.writeTextFile(
    join(dir, "app", "page.tsx"),
    `import { createElement as h } from "react";
import { Counter } from "../components/counter.tsx";
export default function Page() {
  return h("main", null, h("p", null, "EXPORT_SERVER_TEXT"), h(Counter, null));
}
`,
  );
}

Deno.test({
  name:
    "export (next-compat): the Flight bundle is the compat one, and the island hydrates from it",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_nc_export_" });
  try {
    await writeFixture(dir);
    const result = await staticExport(dir);
    const html = await Deno.readTextFile(join(result.outDir, "index.html"));
    assertStringIncludes(html, "EXPORT_SERVER_TEXT");
    assertStringIncludes(html, "EXPORT_ISLAND:0");
    assertStringIncludes(html, "/_denext/client/flight.js");
    const client = join(result.outDir, "_denext", "client");
    const flight = await Deno.readTextFile(join(client, "flight.js"));
    // The island is registered by its client id and loaded from a compat chunk.
    assert(/c_[a-z0-9]+/.test(flight), "the Flight entry registers the island");
    let islandChunk = "";
    for await (const e of Deno.readDir(client)) {
      if (!e.isFile || !e.name.endsWith(".js")) continue;
      const text = await Deno.readTextFile(join(client, e.name));
      if (text.includes("EXPORT_ISLAND:")) islandChunk = text;
    }
    assert(islandChunk, "the island's code is in the client bundle");
    // Server-only code stays on the server.
    for await (const e of Deno.readDir(client)) {
      if (!e.isFile || !e.name.endsWith(".js")) continue;
      const text = await Deno.readTextFile(join(client, e.name));
      assert(!text.includes("EXPORT_SERVER_TEXT"), `${e.name} carries server-component code`);
    }
  } finally {
    await stopNextCompat();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
