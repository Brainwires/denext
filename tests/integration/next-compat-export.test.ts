// `denext export` of a next-compat app with a client island: the Flight bundle must be the compat
// (esbuild, react→denext) one, as `denext build` makes it. The native one (`deno bundle` of the
// source islands) cannot resolve an island's bare `react` import (nothing maps it outside the
// compat bundle), and for an npm island would bundle the library's own React and Next's real
// `next/*` modules — the export of examples/clerk failed exactly there.

import { assert, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { build } from "../../src/build/build.ts";
import { staticExport } from "../../src/build/export.ts";
import { stopNextCompat } from "../../src/build/next-compat.ts";
import { compatModuleMapFromManifest, loadBundleRef } from "../../src/build/next-compat-loader.ts";

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

Deno.test({
  name: "export (next-compat): a previous `denext build`'s server bundle still loads afterwards",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  // The desktop and mobile package scripts run `deno task export` in a project that may hold a
  // `denext build`. The export used to rebuild the compat server bundle into `.denext/server/`
  // with its own module list (no middleware): `denext start` then failed with `compat server
  // bundle .denext/server/app.js has no module export "m<i>"` until the next build.
  const dir = await Deno.makeTempDir({ prefix: "denext_nc_export_build_" });
  try {
    await writeFixture(dir);
    await Deno.writeTextFile(
      join(dir, "middleware.ts"),
      "export function middleware(_req: Request) {\n  return undefined;\n}\n",
    );
    await build(dir);
    const outDir = join(dir, ".denext");
    const bundle = join(outDir, "server", "app.js");
    const built = await Deno.readTextFile(bundle);
    await staticExport(dir);
    const manifest = JSON.parse(await Deno.readTextFile(join(outDir, "manifest.json")));
    const refs = compatModuleMapFromManifest(dir, outDir, manifest.compatServerModules);
    assert(refs.size > 0, "the build mapped its server modules");
    assert([...refs.keys()].some((src) => src.endsWith("middleware.ts")), "middleware is bundled");
    // A fresh module instance, as `denext start` loads it (the build already imported the bundle).
    const fresh = (path: string) => import(`${toFileUrl(path).href}?after-export`);
    for (const ref of refs.values()) await loadBundleRef(fresh, ref);
    assert(await Deno.readTextFile(bundle) === built, "the export rewrote the build's bundle");
  } finally {
    await stopNextCompat();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
