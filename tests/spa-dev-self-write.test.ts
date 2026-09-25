// Regression: the SPA dev rebuild loop. With the SPA entry at the project root (T3's
// apps/mobile in reactNative mode), the dev watcher watches the root, and every build's CSS
// graph crawl rewrote the project's own `deno.json` twice (strip the css→shim redirects the CLI
// injected, then restore). Each write bumped the generation, so every build scheduled the next
// one and pages hit 404s on pruned chunks. The build's own writes must not count as edits; a
// real edit to the same file still must.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resolveProject } from "../src/build/paths.ts";
import { createSpaDevState, getUnbundledCss } from "../src/build/spa/dev-state.ts";
import { watch } from "../src/build/spa/dev-watch.ts";
import { isSelfWrite, recordSelfWrite, writeManagedFile } from "../src/build/self-writes.ts";

/** Wait past the watcher's 60 ms debounce and the FS event latency. */
const settle = () => new Promise((r) => setTimeout(r, 700));

/** A root-entry SPA whose deno.json carries the css→shim redirects the CLI injects. */
async function rootEntrySpa(): Promise<{ dir: string; config: string; original: string }> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-spa-loop-" }));
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    'export default { mode: "spa", spa: { entry: "main.tsx" } };\n',
  );
  await Deno.writeTextFile(join(dir, "main.tsx"), 'import "./a.css";\nconsole.log("hi");\n');
  await Deno.writeTextFile(join(dir, "a.css"), "body { color: red; }\n");
  const original = JSON.stringify(
    { imports: { [`file://${dir}/a.css`]: `file://${dir}/.denext/css-shims/a.css.js` } },
    null,
    2,
  ) + "\n";
  const config = join(dir, "deno.json");
  await Deno.writeTextFile(config, original);
  return { dir, config, original };
}

Deno.test({
  name: "SPA dev: the build's own deno.json writes do not bump the generation; an edit does",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { dir, config, original } = await rootEntrySpa();
    const controller = new AbortController();
    try {
      const paths = await resolveProject(dir);
      const st = createSpaDevState({ paths, signal: controller.signal, unbundled: false });
      watch(st);
      await settle(); // let the watcher attach before the first build writes

      // Two builds, each crawling the CSS graph (strip + restore of deno.json).
      await getUnbundledCss(st);
      st.unbundledCssGen = -1;
      await getUnbundledCss(st);
      await settle();
      assertEquals(st.generation, 0, "the build's own writes were taken for edits");
      assertEquals(await Deno.readTextFile(config), original, "deno.json is restored verbatim");

      // A developer's edit to the same file is still an edit.
      await Deno.writeTextFile(config, original.replace("{", '{\n  "lock": false,'));
      await settle();
      assertEquals(st.generation > 0, true, "a real deno.json edit must still rebuild");
    } finally {
      controller.abort();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test("writeManagedFile skips an unchanged file and records its writes", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = join(dir, "x.json");
    assertEquals(isSelfWrite(file), false, "never written, never ignored");
    assertEquals(await writeManagedFile(file, "a"), true);
    assertEquals(await writeManagedFile(file, "a"), false, "same content: no write");
    assertEquals(isSelfWrite(file), true);
    await Deno.writeTextFile(file, "user edit");
    assertEquals(isSelfWrite(file), false, "content denext never wrote is an edit");
    recordSelfWrite(file, "user edit");
    assertEquals(isSelfWrite(file), true);
    await Deno.remove(file);
    assertEquals(isSelfWrite(file), false, "a removed file is reported");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
