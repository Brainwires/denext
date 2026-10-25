// A migrated Fresh app (tests/helpers/fresh-parity-app.ts), built for production and served by
// `denext start`: its `.env` secret reaches neither the client bundle nor the page, though an
// island names it through `import.meta.env` (only the public variable does, through the page's
// public-env island); `main.ts`'s app wrapper renders; and a partial request answers with the
// page's Flight payload, its `<Partial>` region a client component whose navigation code ships.
// The browser half (a button and a link swapping the regions) is
// tests/e2e/fresh-partials.e2e.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startCliServer } from "../e2e/harness.ts";
import { buildInChild } from "../helpers/bounded-build.ts";
import { PUBLIC_VALUE, SECRET_VALUE, writeFreshParityApp } from "../helpers/fresh-parity-app.ts";

/** Every `.js` file under `dir`, concatenated. */
async function allJs(dir: string): Promise<string> {
  let out = "";
  for await (const e of Deno.readDir(dir)) {
    const path = join(dir, e.name);
    if (e.isDirectory) out += await allJs(path);
    else if (e.name.endsWith(".js")) out += await Deno.readTextFile(path);
  }
  return out;
}

Deno.test({
  name: "a migrated Fresh app builds: no secret in the bundle or page, partial requests answer",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-fresh-parity-" }));
  try {
    await writeFreshParityApp(dir);
    await buildInChild(dir);
    const js = await allJs(join(dir, ".denext", "client"));
    assertEquals(js.includes(SECRET_VALUE), false, "the secret is not in the client bundle");
    assertStringIncludes(js, "fresh-partial", "the partial navigation code ships");
    assertStringIncludes(js, "BASE_URL", "the island reads denext/fresh/env");

    const server = await startCliServer(dir, 120_000);
    try {
      const home = await fetch(server.origin + "/");
      const html = await home.text();
      assertEquals(home.status, 200);
      assertStringIncludes(html, '<div id="wrapper">', "main.ts's app wrapper renders");
      assertStringIncludes(html, `${PUBLIC_VALUE} ${PUBLIC_VALUE} undefined`);
      assertEquals(html.includes(SECRET_VALUE), false, "the secret is not in the page");
      const island = /id="__denext_public_env"[^>]*>([^<]*)</.exec(html)?.[1] ?? "{}";
      assertEquals(JSON.parse(island).FRESH_PUBLIC_GREETING, PUBLIC_VALUE);
      assert(!island.includes("PARITY_SECRET_TOKEN"));

      const full = await fetch(server.origin + "/parts/recipe", { redirect: "manual" });
      await full.body?.cancel();
      assertEquals(full.status, 302, "a full request to a partial-only route redirects");
      const nav = await fetch(server.origin + "/parts/recipe?fresh-partial=true", {
        headers: { "x-denext-nav": "1" },
      });
      assertEquals(nav.headers.get("x-denext-flight"), "1");
      const flight = JSON.stringify(JSON.parse(await nav.text()).flight);
      assertStringIncludes(flight, "#Partial", "the region is a client component");
      assertStringIncludes(flight, "Lemonade");
    } finally {
      await server.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
