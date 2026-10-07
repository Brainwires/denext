// The copy compiler in dev (`DevCopies`): an edited module and every module that imports it load
// as copies named by their content, so an edit reaches the whole importer chain; an unchanged
// module keeps its URL (one module instance) across generations, and each module keeps at most
// two copies on disk however many edits it takes.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { createUseCacheLoaders, DevCopies } from "../src/build/use-cache-loader.ts";

async function project(files: Record<string, string>): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_uc_dev_" }));
  for (const [name, src] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), src);
  }
  return dir;
}

/** One generation's compiler over `dev`: the URL each module would be imported by. */
function generation(dir: string, dev: DevCopies) {
  const urls: string[] = [];
  const [load] = createUseCacheLoaders([(u) => {
    urls.push(u);
    return import(u);
  }], { projectDir: dir, cacheDir: join(dir, ".denext", "server-cache", "dev"), dev });
  return async (rel: string) => {
    urls.length = 0;
    const mod = await load(join(dir, rel)) as Record<string, unknown>;
    return { mod, url: urls[0] };
  };
}

const FILES = {
  "app/page.ts": `import { label } from "./ui/label.ts";\nimport { other } from "./other.ts";\n` +
    `export const text = () => label + other;\n`,
  "app/ui/label.ts": `export const label = "ONE";\n`,
  "app/other.ts": `export const other = "-OTHER";\n`,
  "app/unrelated.ts": `export const unrelated = 1;\n`,
};

Deno.test("dev copies: nothing edited loads every module as itself", async () => {
  const dir = await project(FILES);
  try {
    const dev = new DevCopies(dir);
    const load = generation(dir, dev);
    const { url, mod } = await load("app/page.ts");
    assertEquals(url, toFileUrl(join(dir, "app/page.ts")).href);
    assertEquals((mod.text as () => string)(), "ONE-OTHER");
    assertEquals(dev.size, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dev copies: an edit reaches the importer chain only, under a content-named URL", async () => {
  const dir = await project(FILES);
  try {
    const dev = new DevCopies(dir);
    assertEquals((await generation(dir, dev)("app/page.ts")).mod.text instanceof Function, true);
    await Deno.writeTextFile(join(dir, "app/ui/label.ts"), `export const label = "TWO";\n`);
    dev.markEdited([join(dir, "app/ui/label.ts"), join(dir, "app/styles.css")]);
    const gen1 = generation(dir, dev);
    const page1 = await gen1("app/page.ts");
    assertEquals((page1.mod.text as () => string)(), "TWO-OTHER", "the page renders the edit");
    assert(page1.url.includes("/.denext/server-cache/dev/uc_"), page1.url);
    // The sibling and an unrelated module keep their original URL (and instance).
    assertEquals((await gen1("app/other.ts")).url, toFileUrl(join(dir, "app/other.ts")).href);
    assertEquals(
      (await gen1("app/unrelated.ts")).url,
      toFileUrl(join(dir, "app/unrelated.ts")).href,
    );
    assertEquals(dev.size, 2, "the edited module and the page are copied; a stylesheet is not");

    // A later generation with no further edit names the same copies: no new module instance.
    const page2 = await generation(dir, dev)("app/page.ts");
    assertEquals(page2.url, page1.url);
    assertEquals(page2.mod, page1.mod, "the same instance");

    // A second edit: a new URL, the new text.
    await Deno.writeTextFile(join(dir, "app/ui/label.ts"), `export const label = "THREE";\n`);
    dev.markEdited([join(dir, "app/ui/label.ts")]);
    const page3 = await generation(dir, dev)("app/page.ts");
    assertNotEquals(page3.url, page1.url);
    assertEquals((page3.mod.text as () => string)(), "THREE-OTHER");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dev copies: many edits keep at most two copies per module", async () => {
  const dir = await project(FILES);
  try {
    const dev = new DevCopies(dir);
    const label = join(dir, "app/ui/label.ts");
    for (let i = 0; i < 25; i++) {
      await Deno.writeTextFile(label, `export const label = "E${i}";\n`);
      dev.markEdited([label]);
      const { mod } = await generation(dir, dev)("app/page.ts");
      assertEquals((mod.text as () => string)(), `E${i}-OTHER`);
    }
    // Pruning is fire-and-forget: let the removals land.
    await new Promise((r) => setTimeout(r, 50));
    const files = [...Deno.readDirSync(join(dir, ".denext/server-cache/dev"))].map((e) => e.name);
    assertEquals(dev.size, 4, "two modules × two copies");
    assert(files.length <= 4, `${files.length} copies on disk: ${files}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dev copies: an import cycle through an edited module copies consistently", async () => {
  const dir = await project({
    "app/a.ts": `import { b } from "./b.ts";\nexport const a = () => "A" + b();\n`,
    "app/b.ts":
      `import { a } from "./a.ts";\nexport const b = () => "B";\nexport const viaA = () => a();\n`,
  });
  try {
    const dev = new DevCopies(dir);
    await Deno.writeTextFile(
      join(dir, "app/b.ts"),
      `import { a } from "./a.ts";\nexport const b = () => "B2";\nexport const viaA = () => a();\n`,
    );
    dev.markEdited([join(dir, "app/b.ts")]);
    const load = generation(dir, dev);
    const a = await load("app/a.ts");
    assertEquals((a.mod.a as () => string)(), "AB2");
    const b = await load("app/b.ts");
    assertEquals((b.mod.viaA as () => string)(), "AB2", "b's copy imports a's copy");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
