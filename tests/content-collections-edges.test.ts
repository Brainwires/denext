// @denext/content-collections: the edges the main suite doesn't walk — the glob loader's file
// kinds and failures, the generated types' import specifier, the CLI command's defaults (console
// IO, `--cwd`, the build lock, the singular messages), and the runtime store's fallbacks (no
// store, the root async-context bridge, an MDX entry that isn't in the store or has no component).

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { glob } from "../packages/content-collections/config.ts";
import { generateContentTypes } from "../packages/content-collections/codegen.ts";
import { createContentCommand } from "../packages/content-collections/command.ts";
import { contentCollections } from "../packages/content-collections/mod.ts";
import type { PluginContext, PluginPrepareContext } from "../src/plugin/mod.ts";
import {
  clearContentCache,
  getCollection,
  getEntry,
  renderContent,
  setContentStorePath,
} from "../packages/content-collections/runtime.ts";
import type { CommandContext } from "../src/cli/command.ts";
import { stubExit } from "./_cli-coverage-helpers.ts";

const CONFIG_URL = new URL("../packages/content-collections/config.ts", import.meta.url).href;

function ctxFor(cwd: string | undefined, positionals: string[]): CommandContext {
  return {
    positionals,
    flags: {},
    global: { cwd, json: false, verbose: false, quiet: false },
    rest: [],
  } as CommandContext;
}

Deno.test("glob loader: every file kind, an array pattern, a malformed file and a missing base", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-content-glob-" });
  try {
    const base = join(dir, "content");
    await Deno.mkdir(base, { recursive: true });
    await Deno.writeTextFile(join(base, "plain.md"), "# No frontmatter\n");
    await Deno.writeTextFile(join(base, "empty.yaml"), "");
    await Deno.writeTextFile(join(base, "null.json"), "null");
    await Deno.writeTextFile(join(base, "data.json"), `{"a": 1}`);
    await Deno.writeTextFile(join(base, "bad.json"), "{nope");
    await Deno.writeTextFile(join(base, "notes.txt"), "plain");
    const entries = await glob({ pattern: ["**/*.md", "**/*.{yaml,json,txt}"], base: "content" })
      .load({ projectRoot: dir });
    const byId = new Map(entries.map((e) => [e.id, e]));
    assertEquals(byId.get("plain")!.data, {});
    assertEquals(byId.get("plain")!.body, "# No frontmatter\n");
    assertEquals(byId.get("empty")!.data, {});
    assertEquals(byId.get("null")!.data, {});
    assertEquals(byId.get("data")!.data, { a: 1 });
    assert(byId.get("bad")!.error, "a malformed file is flagged, not thrown");
    assertEquals(byId.get("notes")!.body, "plain");
    assertEquals(await glob({ pattern: "**/*", base: "missing" }).load({ projectRoot: dir }), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generateContentTypes: the config import is relative to the output dir", () => {
  assertStringIncludes(
    generateContentTypes("/app/.denext", "/app/content.config.ts"),
    `"../content.config.ts"`,
  );
  assertStringIncludes(
    generateContentTypes("/app/.denext", "/app/.denext/content.config.ts"),
    `"./content.config.ts"`,
  );
});

Deno.test("denext content: console IO, the --cwd default, the build lock and singular messages", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-content-cli-" });
  const logs: string[] = [];
  const errors: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (l: string) => logs.push(l);
  console.error = (l: string) => errors.push(l);
  const exit = stubExit();
  const cwd = Deno.cwd();
  try {
    const spec = createContentCommand();
    // The project dir comes from --cwd (or the current directory), not the positional.
    assertEquals(spec.moduleDir!(ctxFor(dir, ["build"])), dir);
    assertEquals(spec.moduleDir!(ctxFor(undefined, [])), cwd);
    const locks = (spec as unknown as { locks: (c: CommandContext) => unknown }).locks;
    assertEquals(locks(ctxFor(dir, [])), { projectDir: dir, buildDir: "exclusive" });
    assertEquals(locks(ctxFor(undefined, [])), { projectDir: cwd, buildDir: "exclusive" });

    // No content.config.ts: the default IO reports on the console and exits 1.
    await assertRejects(async () => await spec.run(ctxFor(dir, ["build"])), Error, "__exit__1");
    assertEquals(exit.calls, [1]);
    assert(errors.some((l) => l.includes("no content.config.ts")));

    // One collection, one entry and one diagnostic (from a loader, so no file path).
    await Deno.writeTextFile(join(dir, "only.md"), "# Only\n");
    await Deno.writeTextFile(
      join(dir, "content.config.ts"),
      `import { defineCollection, defineContentConfig, glob } from ${JSON.stringify(CONFIG_URL)};
export default defineContentConfig({ collections: {
  one: defineCollection({ loader: glob({ pattern: "only.md", base: "." }) }),
  broken: defineCollection({ loader: { name: "x", load() { throw "down"; } } }),
} });
`,
    );
    // No positional: the action defaults to build.
    await spec.run(ctxFor(dir, []));
    assert(logs.includes("  one: 1 entry"), logs.join("\n"));
    assert(errors.some((l) => l === "  ✗ broken/: loader failed: down"), errors.join("\n"));
    await assertRejects(async () => await spec.run(ctxFor(dir, ["validate"])), Error, "__exit__1");
    assert(errors.includes("content: 1 invalid entry"), errors.join("\n"));
  } finally {
    exit.restore();
    console.log = log;
    console.error = error;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runtime: the default store path, a missing store, the root-context bridge and MDX lookups", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-content-runtime-" });
  const bridge = globalThis as { __denextInRootContext?: <R>(fn: () => R) => R };
  let bridged = 0;
  try {
    // No override: the store under <cwd>/.denext, which has no such collection.
    setContentStorePath(null);
    assertEquals(await getCollection("nothing" as never), []);
    // A store path with nothing there: every collection is empty.
    setContentStorePath(join(dir, "missing.json"));
    assertEquals(await getCollection("nothing" as never), []);

    // A store read through the root async-context bridge when the server installed one.
    bridge.__denextInRootContext = (fn) => {
      bridged++;
      return fn();
    };
    const outDir = join(dir, ".denext");
    await Deno.mkdir(join(outDir, "content", "docs"), { recursive: true });
    await Deno.writeTextFile(
      join(outDir, "content-data.json"),
      JSON.stringify({
        docs: [
          { id: "a", data: {}, body: "<b>x</b>", format: "md", markdown: { html: "sanitize" } },
          { id: "m", data: {}, body: "# M", format: "mdx" },
        ],
      }),
    );
    // The compiled module has no default export (and the entry no `v`, so `?v=0`).
    await Deno.writeTextFile(join(outDir, "content", "docs", "m.js"), "export const x = 1;\n");
    setContentStorePath(join(outDir, "content-data.json"));
    const docs = await getCollection("docs" as never);
    assertEquals(docs.length, 2);
    assert(bridged > 0, "the store load ran through the bridge");
    const a = (await getEntry("docs" as never, "a"))!;
    assertEquals(a.markdown, { html: "sanitize" });
    const m = (await getEntry("docs" as never, "m"))!;
    await assertRejects(() => renderContent(m), Error, "has no default MDX component export");
    // An MDX entry that isn't in the store can't be located.
    await assertRejects(
      () => renderContent({ ...m, id: "ghost", slug: "ghost" }),
      Error,
      `entry "ghost" is not in the built store`,
    );
  } finally {
    delete bridge.__denextInRootContext;
    setContentStorePath(null);
    clearContentCache();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("contentCollections prepare step: one entry in one collection, and a path-less diagnostic", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-content-prepare-" });
  const logs: string[] = [];
  const errors: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (l: string) => logs.push(l);
  console.error = (l: string) => errors.push(l);
  try {
    let prepare: ((c: PluginPrepareContext) => void | Promise<void>) | undefined;
    const ctx = {
      addPrepareStep: (fn: (c: PluginPrepareContext) => void | Promise<void>) => (prepare = fn),
      addCommand: () => {},
    } as unknown as PluginContext;
    contentCollections().setup(ctx);
    const run = () =>
      prepare!({ projectRoot: dir, appDir: dir, outDir: join(dir, ".denext"), config: {} });
    await Deno.writeTextFile(join(dir, "only.md"), "# Only\n");
    const config = (extra: string) =>
      `import { defineCollection, defineContentConfig, glob } from ${JSON.stringify(CONFIG_URL)};
export default defineContentConfig({ collections: {
  one: defineCollection({ loader: glob({ pattern: "only.md", base: "." }) }),${extra}
} });
`;
    await Deno.writeTextFile(join(dir, "content.config.ts"), config(""));
    await run();
    assert(logs.includes("denext content: 1 entry in 1 collection"), logs.join("\n"));
    await Deno.writeTextFile(
      join(dir, "content.config.mts"),
      config(`\n  broken: defineCollection({ loader: { name: "x", load() { throw "down"; } } }),`),
    );
    await Deno.remove(join(dir, "content.config.ts"));
    await run();
    assert(errors.includes("  ✗ broken/: loader failed: down"), errors.join("\n"));
  } finally {
    console.log = log;
    console.error = error;
    await Deno.remove(dir, { recursive: true });
  }
});
