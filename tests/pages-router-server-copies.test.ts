// A build with no App Router (a Pages Router app) records the server render's copies, as an App
// Router build does: the web target's platform files, `"use cache"` and inline `"use server"`
// functions. A compiled app has no startup compiler, so without the record its pages loaded as
// written — the plain file, uncached, no action reference — with nothing said
// (tests/integration/compile-compat.test.ts runs the binary).

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resolveProject } from "../src/build/paths.ts";
import { buildWithoutAppRouter } from "../src/build/build-pipeline/prepare.ts";
import { readBuildInfo } from "../src/build/prod-server/manifest.ts";
import { prodLoader } from "../src/build/prod-server/app.ts";
import { resetPlugins } from "../src/plugin/mod.ts";
import { removeTempDir } from "./helpers/temp.ts";

const FILES: Record<string, string> = {
  "deno.json": "{}\n",
  "denext.config.ts": "export default { cacheComponents: true };\n",
  "components/hello.ts": `export const hello = "plain";\n`,
  "components/hello.web.ts": `export const hello = "web";\n`,
  "lib/stamp.ts": `export async function stamp(): Promise<string> {
  "use cache";
  return crypto.randomUUID();
}
`,
  "lib/actions.ts": `export async function act(): Promise<number> {
  "use server";
  return 1;
}
`,
  "lib/greet.ts": `import { hello } from "../components/hello.ts";\nexport const greet = hello;\n`,
  "styles/site.css": ".a { color: red; }\n",
};

Deno.test("a build with no app/ records its server copies, and the production loader serves them", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_pages_copies_" }));
  resetPlugins();
  try {
    for (const [rel, src] of Object.entries(FILES)) {
      await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, rel), src);
    }
    const paths = await resolveProject(dir);
    await buildWithoutAppRouter(paths);
    const recorded = JSON.parse(await Deno.readTextFile(join(paths.outDir, "manifest.json")));
    const copies = recorded.serverCopies;
    assertEquals(copies.relocatable, true);
    assertEquals(copies.redirects["components/hello.ts"], "components/hello.web.ts");
    for (const m of ["lib/stamp.ts", "lib/actions.ts", "lib/greet.ts"]) {
      assert(copies.copies[m]?.startsWith("server-copies/"), `${m} has a copy`);
    }
    // No `css` record: the server render keeps the CSS import map (`buildServesCss` stays false).
    assertEquals("css" in copies, false);

    // No startup compiler (a compiled app): the record is enough.
    const load = await prodLoader(paths, await readBuildInfo(paths));
    const greet = await load(join(dir, "lib", "greet.ts")) as { greet: string };
    assertEquals(greet.greet, "web");
    const actions = await load(join(dir, "lib", "actions.ts")) as {
      act: { denextActionId?: unknown };
    };
    assertEquals(typeof actions.act.denextActionId, "string");
  } finally {
    resetPlugins();
    await removeTempDir(dir);
  }
});
