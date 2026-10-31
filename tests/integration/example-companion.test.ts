// examples/companion (Loopy) exported, as `denext desktop run` exports it before opening the
// window: the page server-renders Loopy folded away (it springs up once the client runs), ships
// the companion's client bundle and the stylesheet. Built from a private copy
// (tests/helpers/example-copy.ts) with the copy's own `deno task export`: the page imports
// `denext/desktop/*`, which only the example's import map names. The unit tests are
// tests/examples-companion.test.ts.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { walk } from "@std/fs";
import { runBounded } from "../helpers/bounded-command.ts";
import { copyExample } from "../helpers/example-copy.ts";
import { CHILD_DEADLINE_MS } from "../helpers/isolated.ts";

Deno.test("examples/companion: exports Loopy's page, its client bundle and its stylesheet", async () => {
  const dir = await copyExample("companion");
  const run = await runBounded(Deno.execPath(), ["task", "export"], {
    cwd: dir,
    timeoutMs: CHILD_DEADLINE_MS,
  });
  assert(run.success, `deno task export failed:\n${run.output}`);
  const outDir = join(dir, "out");
  const html = await Deno.readTextFile(join(outDir, "index.html"));
  assertStringIncludes(html, "<title>Loopy</title>");
  assertMatch(html, /<svg class="loopy" data-state="hidden"[^>]*aria-label="Loopy"/);
  assertStringIncludes(html, 'href="/styles.css"');
  // Only Loopy and its buttons catch clicks before a bubble opens; the empty bubble row and the
  // room beside Loopy let them through (lib/window-setup.ts follows the marked elements).
  const marked = [...html.matchAll(/<(\w+)([^>]*)>/g)]
    .filter(([, , attrs]) => attrs.includes("data-loopy-hit"))
    .map(([, tag, attrs]) => `${tag}.${/class="([^"]*)"/.exec(attrs)?.[1] ?? ""}`);
  assertEquals(marked, ["div.squash", "nav.controls"]);
  const css = await Deno.readTextFile(join(outDir, "styles.css"));
  for (const state of ["appear", "blink", "think", "point", "celebrate", "dismiss"]) {
    assertStringIncludes(css, `[data-state="${state}"]`, `a ${state} move`);
  }
  let bundled = false;
  for await (const entry of walk(join(outDir, "_denext"), { exts: [".js"] })) {
    const text = await Deno.readTextFile(entry.path);
    if (text.includes("/_loopy/reply") && text.includes("Fold up")) bundled = true;
  }
  assert(bundled, "the client bundle holds the companion");
});
