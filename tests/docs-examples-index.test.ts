// Drift check for the generated examples index (site/app/docs/examples/examples.json)
// against the `examples/` directories themselves, plus unit tests of the README/config
// readers in scripts/gen-examples-index.ts.

import { assert, assertEquals } from "@std/assert";
import {
  arrayBody,
  CATEGORIES,
  configTags,
  EXAMPLE_CATEGORY,
  type ExampleEntry,
  generateExamplesIndex,
  isCompatEntry,
  OUT,
  plainText,
  readmeSummary,
  runCommands,
  runsFromRoot,
  stripComments,
  topLevelCalls,
  truncate,
} from "../scripts/gen-examples-index.ts";

Deno.test("docs: examples.json is regenerated from examples/*", async () => {
  // Adding, removing or re-describing an example (its README H1/first paragraph, or the
  // plugins/mode in its denext.config.ts) without regenerating fails here.
  assertEquals(
    await Deno.readTextFile(OUT),
    generateExamplesIndex(),
    "examples.json is stale — run `deno task docs:examples` and commit",
  );
});

Deno.test("examples.json lists exactly the example directories that have a README", async () => {
  // Stated directly (the regeneration check above implies it): an example directory with a
  // README and no entry fails, and so does an entry whose directory or README is gone.
  const { examples } = JSON.parse(await Deno.readTextFile(OUT)) as { examples: ExampleEntry[] };
  const root = new URL("../examples/", import.meta.url);
  const withReadme: string[] = [];
  for (const e of Deno.readDirSync(root)) {
    if (!e.isDirectory || e.name.startsWith("_") || e.name.startsWith(".")) continue;
    try {
      if (Deno.statSync(new URL(`${e.name}/README.md`, root)).isFile) withReadme.push(e.name);
    } catch { /* no README */ }
  }
  assertEquals(
    examples.filter((e) => e.hasReadme).map((e) => e.name),
    withReadme.sort(),
  );
});

Deno.test("every example has a docs category, and every category is used", async () => {
  const { examples } = JSON.parse(await Deno.readTextFile(OUT)) as { examples: ExampleEntry[] };
  const ids = new Set(CATEGORIES.map((c) => c.id));
  for (const e of examples) assert(ids.has(e.category), `${e.name}: unknown category`);
  for (const id of ids) assert(examples.some((e) => e.category === id), `category ${id} is empty`);
  // A category line for an example that no longer exists is dead weight.
  const names = new Set(examples.map((e) => e.name));
  for (const name of Object.keys(EXAMPLE_CATEGORY)) {
    assert(names.has(name), `EXAMPLE_CATEGORY lists ${name}, which is not an example`);
  }
});

Deno.test("runCommands: the run section's shell block, its inline steps, else the first runnable block", () => {
  // A fenced block under a run heading wins over an earlier runnable block elsewhere.
  assertEquals(
    runCommands(
      "# x\n\n```sh\ndeno task build\n```\n\n## Run it\n\n```sh\ndeno task dev\n```\n",
    ),
    "deno task dev",
  );
  // A non-shell fence (a code sample) is never a run block.
  assertEquals(runCommands("## Run\n\n```ts\ndeno task dev\n```\n"), null);
  // A run section written as prose: its inline commands, in order (only the FIRST run section).
  assertEquals(
    runCommands(
      "## Setup\n\n1. `cd examples/x && deno install`\n2. `deno task dev` → open it.\n\n" +
        "## Try it\n\n`deno task other`\n",
    ),
    "cd examples/x && deno install\ndeno task dev",
  );
  // No run heading: the first block that starts something.
  assertEquals(
    runCommands("# x\n\n```sh\nls\n```\n\n```bash\ndeno task example:x\n```\n"),
    "deno task example:x",
  );
  // A run heading with nothing runnable under it: no commands (the generator uses `deno task dev`),
  // even when a later section has a runnable block.
  assertEquals(
    runCommands("## Run\n\nOpen the page.\n\n## Other\n\n```sh\ndeno task dev\n```\n"),
    null,
  );
  assertEquals(runCommands(""), null);
});

Deno.test("runsFromRoot: root tasks and repo paths run from the repo root", () => {
  assert(runsFromRoot("deno task example:game --dev"));
  assert(runsFromRoot("deno run -A cli.ts migrate examples/effect"));
  assert(runsFromRoot("cd examples/islands\ndeno task dev"));
  assert(!runsFromRoot("deno task dev\ndeno task build && deno task start"));
});

Deno.test("every indexed example points at the repo and carries a title", async () => {
  const { examples } = JSON.parse(await Deno.readTextFile(OUT)) as { examples: ExampleEntry[] };
  assert(examples.length > 20, "the repo has 20+ examples");
  assertEquals([...examples].map((e) => e.name).sort(), examples.map((e) => e.name), "sorted");
  for (const e of examples) {
    assertEquals(e.url, `https://github.com/Brainwires/denext/tree/main/examples/${e.name}`);
    assert(e.title.length > 0, `${e.name} has no title`);
    assert(!/[`]|\*\*|\]\(/.test(e.blurb), `${e.name} blurb still carries Markdown syntax`);
  }
});

Deno.test("config tags come from the config TEXT, never from importing it", () => {
  assertEquals(configTags(""), []);
  assertEquals(
    configTags(`export default { mode: "spa", compatibilityMode: true };`),
    ["spa", "compat"],
  );
  assertEquals(
    configTags(`import { openapi } from "@denext/openapi";
      export default { plugins: [openapi({ info: { title: "x" } }), htmx()] };`),
    ["plugin:openapi", "plugin:htmx"],
  );
  // A commented-out plugin (or a mode named only in prose) must not become a tag.
  assertEquals(
    configTags(`export default {
      // plugins: [pagesRouter()] — try mode: "spa" instead
      /* compatibilityMode: true */
      plugins: [],
    };`),
    [],
  );
});

Deno.test("a serve.ts that drives the next-compat build layer tags the example compat", async () => {
  assert(
    isCompatEntry(`import { serveCompat } from "../_shared/serve-compat.ts";\nserveCompat({});`),
  );
  assert(isCompatEntry(`const [p] = await buildNextCompatPages({ projectDir: dir });`));
  assert(!isCompatEntry(`// serveCompat({}) is what the compat examples do\nDeno.serve(handler);`));
  assert(!isCompatEntry(""));
  const { examples } = JSON.parse(await Deno.readTextFile(OUT)) as { examples: ExampleEntry[] };
  const byName = new Map(examples.map((e) => [e.name, e.tags]));
  assert(byName.get("next-compat")?.includes("compat"), "next-compat is tagged compat");
  assert(
    byName.get("next-compat-recharts")?.includes("compat"),
    "recharts example is tagged compat",
  );
  assert(!byName.get("notes")?.includes("compat"), "a native example is not");
});

Deno.test("stripComments keeps strings and drops comments", () => {
  assertEquals(
    stripComments(`const a = "http://x"; // gone\n/* also gone */ const b = 1;`),
    `const a = "http://x"; \n const b = 1;`,
  );
});

Deno.test("arrayBody bracket-matches nested arrays", () => {
  assertEquals(arrayBody("{ plugins: [a(), [b]] }", "plugins"), "a(), [b]");
  assertEquals(arrayBody("{ mode: 1 }", "plugins"), null);
});

Deno.test("topLevelCalls ignores calls nested inside an argument", () => {
  assertEquals(topLevelCalls("a({ x: b() }), c()"), ["a", "c"]);
  assertEquals(topLevelCalls(""), []);
});

Deno.test("plainText strips inline Markdown", () => {
  assertEquals(
    plainText("A [link](http://x) and `code`\nand **bold** and _em_."),
    "A link and code and bold and em.",
  );
  assertEquals(plainText("![shot](a.png) after"), "shot after");
});

Deno.test("readmeSummary takes the H1 and the first prose paragraph", () => {
  assertEquals(
    readmeSummary("# `spa` example\n\n> a note\n\nA **client-only** app.\n\nMore.\n"),
    { title: "spa example", blurb: "A client-only app." },
  );
  // A README with no H1 (or no prose under it) yields empties — the caller falls back to the name.
  assertEquals(readmeSummary("just prose\n"), { title: "", blurb: "" });
  assertEquals(readmeSummary("# Only a heading\n"), { title: "Only a heading", blurb: "" });
});

Deno.test("truncate cuts at a sentence, then at a word", () => {
  assertEquals(truncate("Short enough.", 40), "Short enough.");
  assertEquals(
    truncate("One sentence here. And a much longer second one that overflows.", 40),
    "One sentence here.",
  );
  // A `.` inside a path is not a sentence boundary, and an unbreakable lead falls back to a word cut.
  assertEquals(
    truncate("It compiles styles/tailwind.css into the output directory now.", 40),
    "It compiles styles/tailwind.css into…",
  );
});
