// @denext/content-collections: the glob loader + frontmatter parsing, the build (validation,
// store, generated types), and the server-only runtime query API. A temp project whose
// content.config.ts imports the package by absolute file URL (so no import map / no zod needed).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { glob } from "../packages/content-collections/config.ts";
import { buildContent, discoverContentConfig } from "../packages/content-collections/build.ts";
import { createContentCommand } from "../packages/content-collections/command.ts";
import { contentCollections } from "../packages/content-collections/mod.ts";
import type { CommandContext } from "../src/cli/command.ts";
import type { PluginBuildContext, PluginContext } from "../src/plugin/mod.ts";
import {
  clearContentCache,
  getCollection,
  getEntry,
  setContentStorePath,
} from "../packages/content-collections/runtime.ts";

const CONFIG_URL =
  toFileUrl(new URL("../packages/content-collections/config.ts", import.meta.url).pathname).href;

/** A temp project: three blog posts (one invalid, one draft) + a content.config.ts. */
async function makeProject(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext-content-" });
  const blog = join(dir, "content", "blog");
  await Deno.mkdir(blog, { recursive: true });
  await Deno.writeTextFile(
    join(blog, "hello.md"),
    `---\ntitle: Hello\ndraft: false\n---\n# Hi\nbody text\n`,
  );
  await Deno.writeTextFile(
    join(blog, "nested/deep.md"),
    `---\ntitle: Deep\ndraft: true\n---\nnested body\n`,
  )
    .catch(async () => {
      await Deno.mkdir(join(blog, "nested"), { recursive: true });
      await Deno.writeTextFile(
        join(blog, "nested/deep.md"),
        `---\ntitle: Deep\ndraft: true\n---\nnested body\n`,
      );
    });
  // Invalid: `title` missing.
  await Deno.writeTextFile(join(blog, "bad.md"), `---\nsubtitle: oops\n---\nno title\n`);
  // A content.config.ts that uses a hand-rolled Standard Schema requiring a string `title`.
  await Deno.writeTextFile(
    join(dir, "content.config.ts"),
    `import { defineCollection, defineContentConfig, glob } from ${JSON.stringify(CONFIG_URL)};
const schema = {
  "~standard": {
    version: 1, vendor: "test",
    validate(v) {
      const o = v ?? {};
      if (typeof o.title !== "string") return { issues: [{ message: "title is required", path: ["title"] }] };
      return { value: { title: o.title, draft: o.draft === true } };
    },
  },
};
export default defineContentConfig({
  collections: { blog: defineCollection({ loader: glob({ pattern: "**/*.md", base: "content/blog" }), schema }) },
});
`,
  );
  return dir;
}

Deno.test("glob loader reads markdown frontmatter + body and derives ids", async () => {
  const dir = await makeProject();
  try {
    const loader = glob({ pattern: "**/*.md", base: "content/blog" });
    const entries = (await loader.load({ projectRoot: dir })).sort((a, b) =>
      a.id.localeCompare(b.id)
    );
    const ids = entries.map((e) => e.id);
    assert(ids.includes("hello"));
    assert(ids.includes("nested/deep")); // nested path → slash id, extension stripped
    const hello = entries.find((e) => e.id === "hello")!;
    assertEquals(hello.data.title, "Hello");
    assertEquals(hello.data.draft, false);
    assertStringIncludes(hello.body ?? "", "body text");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("buildContent validates entries, drops invalid ones, and writes the store + types", async () => {
  const dir = await makeProject();
  try {
    const outDir = join(dir, ".denext");
    const report = await buildContent({ projectRoot: dir, outDir });
    assertEquals(report.configured, true);
    // hello + nested/deep are valid; bad.md fails (no title).
    assertEquals(report.counts.blog, 2);
    assertEquals(report.ok, false);
    assertEquals(report.diagnostics.length, 1);
    assertEquals(report.diagnostics[0].id, "bad");
    assertStringIncludes(report.diagnostics[0].messages[0], "title");

    const store = JSON.parse(await Deno.readTextFile(join(outDir, "content-data.json")));
    assertEquals(store.blog.length, 2);
    assert(store.blog.every((e: { data: { title: string } }) => typeof e.data.title === "string"));

    const types = await Deno.readTextFile(join(outDir, "content.ts"));
    assertStringIncludes(types, `import type * as cfg from "../content.config.ts";`);
    assertStringIncludes(types, `declare module "@denext/content-collections/runtime"`);
    assertStringIncludes(types, `config: (typeof cfg)["default"];`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("buildContent: a malformed file is a per-file diagnostic, not a whole-build failure", async () => {
  const dir = await makeProject();
  try {
    // A file with broken YAML frontmatter — `extractYaml` THROWS on this. It must not abort the
    // build (which would empty every collection); the valid entries still build.
    await Deno.writeTextFile(
      join(dir, "content", "blog", "broken.md"),
      `---\ntitle: : not valid yaml : x\n  bad indent\n---\nbody\n`,
    );
    const outDir = join(dir, ".denext");
    const report = await buildContent({ projectRoot: dir, outDir });
    // hello + nested/deep still build; broken.md and bad.md are reported, not fatal.
    assertEquals(report.counts.blog, 2, "valid entries still build despite the malformed file");
    const broken = report.diagnostics.find((d) => d.id === "broken");
    assert(broken, "the malformed file is reported as a diagnostic");
    assert(broken.filePath, "the diagnostic names the file");
    const store = JSON.parse(await Deno.readTextFile(join(outDir, "content-data.json")));
    assertEquals(store.blog.length, 2, "the store is written (not empty)");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("discoverContentConfig returns null when the app has no content.config.ts", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-nocontent-" });
  try {
    assertEquals(await discoverContentConfig(dir), null);
    const report = await buildContent({ projectRoot: dir, outDir: join(dir, ".denext") });
    assertEquals(report.configured, false);
    assertEquals(report.ok, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runtime getCollection / getEntry read the built store, typed as CollectionEntry", async () => {
  const dir = await makeProject();
  try {
    const outDir = join(dir, ".denext");
    await buildContent({ projectRoot: dir, outDir });
    setContentStorePath(join(outDir, "content-data.json"));
    clearContentCache();

    const all = await getCollection("blog");
    assertEquals(all.length, 2);
    // Each entry carries id, slug (= id), data, and body.
    const hello = await getEntry("blog", "hello");
    assert(hello);
    assertEquals(hello.slug, "hello");
    assertEquals(hello.data.title, "Hello");
    assertStringIncludes(hello.body ?? "", "body text");

    // A filter narrows the result.
    const published = await getCollection("blog", (e) => e.data.draft !== true);
    assertEquals(published.map((e) => e.id), ["hello"]);

    // A missing entry is undefined.
    assertEquals(await getEntry("blog", "nope"), undefined);

    // getCollection returns a FRESH array: mutating it must not corrupt the shared cache.
    const first = await getCollection("blog");
    first.reverse();
    first.push({} as (typeof first)[number]);
    const second = await getCollection("blog");
    assertEquals(second.length, 2, "a later read is unaffected by the caller's mutation");
    assertEquals(second.map((e) => e.id), ["hello", "nested/deep"], "original order preserved");
  } finally {
    setContentStorePath(null);
    clearContentCache();
    await Deno.remove(dir, { recursive: true });
  }
});

/** A captured IO for the CLI command. */
function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  let code = -1;
  return {
    io: {
      log: (l: string) => out.push(l),
      error: (l: string) => err.push(l),
      exit: (c: number) => (code = c),
    },
    out,
    err,
    exit: () => code,
  };
}

/** A CommandContext for `denext content <action>` in `dir`. */
function cmdCtx(dir: string, action: string): CommandContext {
  return {
    positionals: [action],
    flags: {},
    global: { cwd: dir, json: false, verbose: false, quiet: false },
    rest: [],
  };
}

Deno.test("denext content: build prints counts, list prints ids, validate exits 1 on a bad entry", async () => {
  const dir = await makeProject();
  try {
    // build — prints the per-collection count and the diagnostic for bad.md.
    const b = captureIo();
    await createContentCommand(b.io).run(cmdCtx(dir, "build"));
    assert(b.out.some((l) => l.includes("blog: 2")));
    assert(b.err.some((l) => l.includes("bad")));

    // list — prints each collection and its ids.
    const l = captureIo();
    await createContentCommand(l.io).run(cmdCtx(dir, "list"));
    assert(l.out.some((line) => line.startsWith("blog (")));
    assert(l.out.some((line) => line.trim() === "hello"));

    // validate — exits 1 because bad.md fails its schema.
    const v = captureIo();
    await createContentCommand(v.io).run(cmdCtx(dir, "validate"));
    assertEquals(v.exit(), 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext content: no content.config.ts errors and exits 1", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-nocontent-cli-" });
  try {
    const c = captureIo();
    await createContentCommand(c.io).run(cmdCtx(dir, "build"));
    assertEquals(c.exit(), 1);
    assert(c.err.some((l) => l.includes("no content.config.ts")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("contentCollections plugin registers a prepare step + command; the step builds the store", async () => {
  const dir = await makeProject();
  try {
    let prepare: ((c: PluginBuildContext) => void | Promise<void>) | undefined;
    let commandName = "";
    const ctx = {
      addPrepareStep: (fn: (c: PluginBuildContext) => void | Promise<void>) => (prepare = fn),
      addCommand: (c: { name: string }) => (commandName = c.name),
    } as unknown as PluginContext;
    contentCollections().setup(ctx);
    assertEquals(commandName, "content");
    assert(prepare, "a prepare step must be registered");
    // Running it builds the store (this project has one invalid entry → the diagnostics branch).
    const outDir = join(dir, ".denext");
    await prepare!({ projectRoot: dir, appDir: dir, outDir, config: {} });
    const store = JSON.parse(await Deno.readTextFile(join(outDir, "content-data.json")));
    assertEquals(store.blog.length, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
