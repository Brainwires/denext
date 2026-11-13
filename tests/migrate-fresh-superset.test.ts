// `denext migrate --from fresh` for what used to be left to the user: files that already exist
// (merged where that is safe), `main.ts`'s island registrations, the `fresh({ … })` options of a
// Vite config, Fresh plugins, other Vite plugins and `new App({ basePath })`. The reference is
// Fresh's own behaviour (packages/fresh and packages/plugin-vite at the 2.3.3 tag).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { migrateProject } from "../src/build/migrate.ts";
import { appendMissingLines, appendModule } from "../src/build/migrate-fresh.ts";

type Tree = Record<string, string | Record<string, unknown>>;

const REPO = fromFileUrl(new URL("..", import.meta.url));

async function withTree<T>(files: Tree, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_fresh_superset_" }));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const path = join(dir, rel);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, typeof body === "string" ? body : JSON.stringify(body));
    }
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const read = (dir: string, rel: string) => Deno.readTextFile(join(dir, rel));
const exists = (dir: string, rel: string) =>
  Deno.stat(join(dir, rel)).then(() => true, () => false);

/** The smallest Fresh 2 app. */
const BASE: Tree = {
  "deno.json": { imports: { fresh: "jsr:@fresh/core@^2.3.3", preact: "npm:preact@^10.27.2" } },
  "routes/index.tsx": "export default function Home() { return <p>home</p>; }\n",
};

Deno.test("appendMissingLines / appendModule: what can merge safely", () => {
  assertEquals(appendMissingLines("User-agent: *\n", "User-agent: *\n"), null);
  assertEquals(
    appendMissingLines("User-agent: *\nDisallow: /a\n", "User-agent: *\nDisallow: /b\n"),
    "User-agent: *\nDisallow: /a\n\nDisallow: /b\n",
  );
  assertEquals(
    appendModule('import "./a.ts";\nconst x = 1;\n', "document.title = 'y';\n"),
    "import \"./a.ts\";\nconst x = 1;\n\n// From client.ts (the Fresh app's Vite client entry):\ndocument.title = 'y';\n",
  );
  assertEquals(appendModule("const x = 1;\n", "const x = 2;\n"), null, "a clashing name");
  assertEquals(appendModule('import { y } from "./y.ts";\n', 'import y from "./z.ts";\n'), null);
  assertEquals(appendModule("same();\n", "same();\n"), "same();\n", "already there");
});

Deno.test("migrate: static/ files over existing public/ files — identical dropped, robots.txt merged, a real conflict kept", async () => {
  await withTree({
    ...BASE,
    "static/logo.svg": "<svg/>",
    "public/logo.svg": "<svg/>",
    "static/robots.txt": "User-agent: *\nDisallow: /admin\n",
    "public/robots.txt": "User-agent: *\nSitemap: /sitemap.xml\n",
    "static/styles.css": ".a { color: red; }\n",
    "public/styles.css": ".a { color: blue; }\n",
  }, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
    const f = r.fresh!;
    assertEquals(await exists(dir, "static/logo.svg"), false, "an identical copy is dropped");
    assertEquals(
      await read(dir, "public/robots.txt"),
      "User-agent: *\nSitemap: /sitemap.xml\n\nDisallow: /admin\n",
    );
    assertEquals(await exists(dir, "static/robots.txt"), false);
    assert(f.review.some((x) => x.item === "static/robots.txt"));
    // The real conflict: left in static/, both kept, reported.
    assertEquals(await read(dir, "public/styles.css"), ".a { color: blue; }\n");
    assertEquals(await read(dir, "static/styles.css"), ".a { color: red; }\n");
    assertEquals(f.wontMigrate.filter((x) => x.item.startsWith("static/")).map((x) => x.item), [
      "static/styles.css",
    ]);
  });
});

Deno.test("migrate: client.ts's code appends to an existing instrumentation-client.ts unless a name clashes", async () => {
  await withTree({
    ...BASE,
    "vite.config.ts":
      'import { fresh } from "@fresh/plugin-vite";\nexport default { plugins: [fresh()] };\n',
    "client.ts": 'import "./assets/a.css";\nconsole.log("client");\n',
    "assets/a.css": ".a{}\n",
    "instrumentation-client.ts": 'console.log("mine");\n',
  }, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
    const merged = await read(dir, "instrumentation-client.ts");
    assertStringIncludes(merged, 'console.log("mine");');
    assertStringIncludes(merged, 'console.log("client");');
    assertEquals(await exists(dir, "client.ts"), false);
    assert(!r.fresh!.wontMigrate.some((x) => x.item === "client.ts"));
  });
  await withTree({
    ...BASE,
    "vite.config.ts":
      'import { fresh } from "@fresh/plugin-vite";\nexport default { plugins: [fresh()] };\n',
    "client.ts": "const boot = 1;\nconsole.log(boot);\n",
    "instrumentation-client.ts": "const boot = 2;\n",
  }, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
    assert(r.fresh!.wontMigrate.some((x) => x.item === "client.ts"));
    assertEquals(await read(dir, "instrumentation-client.ts"), "const boot = 2;\n");
  });
});

Deno.test("migrate: a generated file the user already wrote identically is not reported", async () => {
  await withTree(BASE, async (dir) => {
    await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
    // The user takes over the page, keeping its content but dropping the generated header.
    const page = await read(dir, "app/page.tsx");
    await Deno.writeTextFile(
      join(dir, "app/page.tsx"),
      page.replace(/^\/\/ generated[^\n]*\n/, ""),
    );
    const again = await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
    assertEquals(again.fresh!.wontMigrate.filter((x) => x.item === "app/page.tsx"), []);
    await Deno.writeTextFile(join(dir, "app/page.tsx"), "export default () => null;\n");
    const third = await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
    assert(third.fresh!.wontMigrate.some((x) => x.item === "app/page.tsx"));
  });
});
