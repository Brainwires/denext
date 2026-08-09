// `denext create` scaffolding: the generated file set/content, and that the
// generated app actually type-checks against the framework.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { scaffoldFiles, scaffoldProject } from "../../src/build/scaffold.ts";

Deno.test("scaffoldFiles: plain project", () => {
  const files = scaffoldFiles({ dir: "/x" });
  const paths = files.map((f) => f.path).sort();
  assertEquals(paths, [
    ".gitignore",
    "app/layout.tsx",
    "app/page.tsx",
    "deno.json",
    "public/styles.css",
  ]);
  const denoJson = files.find((f) => f.path === "deno.json")!.content;
  assertStringIncludes(denoJson, "jsr:@denext/denext");
  assertStringIncludes(denoJson, '"jsxImportSource": "denext"');
  assert(!files.some((f) => f.path === "denext.config.ts"), "no config without options");
});

Deno.test("scaffoldFiles: tailwind wires globals import + input + config", () => {
  const files = scaffoldFiles({ dir: "/x", tailwind: true });
  const paths = files.map((f) => f.path);
  assert(paths.includes("styles/tailwind.css"));
  assert(paths.includes("denext.config.ts"));
  assert(!paths.includes("public/styles.css"), "tailwind replaces the static stylesheet");
  assertStringIncludes(
    files.find((f) => f.path === "app/layout.tsx")!.content,
    'import "./globals.css"',
  );
  assertStringIncludes(files.find((f) => f.path === "denext.config.ts")!.content, "tailwind:");
});

Deno.test("scaffoldFiles: src-dir + compiler", () => {
  const files = scaffoldFiles({ dir: "/x", srcDir: true, compiler: true });
  const paths = files.map((f) => f.path);
  assert(paths.includes("src/app/page.tsx"));
  assert(paths.includes("src/app/layout.tsx"));
  assertStringIncludes(
    files.find((f) => f.path === "denext.config.ts")!.content,
    "experimental: { compiler: true }",
  );
});

Deno.test("scaffoldFiles: src-dir + tailwind writes output under src/app", () => {
  const files = scaffoldFiles({ dir: "/x", srcDir: true, tailwind: true });
  const config = files.find((f) => f.path === "denext.config.ts")!.content;
  // The compiled output must live where the layout imports it from (src/app).
  assertStringIncludes(config, 'output: "src/app/globals.css"');
  assertStringIncludes(
    files.find((f) => f.path === "src/app/layout.tsx")!.content,
    'import "./globals.css"',
  );
  // Generated output is gitignored.
  assertStringIncludes(files.find((f) => f.path === ".gitignore")!.content, "src/app/globals.css");
});

Deno.test("scaffoldProject refuses a non-empty directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_scaffold_" });
  try {
    await Deno.writeTextFile(join(dir, "existing.txt"), "x");
    let threw = false;
    try {
      await scaffoldProject({ dir });
    } catch {
      threw = true;
    }
    assert(threw, "should refuse to scaffold into a non-empty dir");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("init scaffolds into an existing dir but won't overwrite existing files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_init_" });
  try {
    // A pre-existing unrelated file (e.g. a git repo's README) is fine for init.
    await Deno.writeTextFile(join(dir, "README.md"), "# my project\n");
    const written = await scaffoldProject({ dir, allowExisting: true });
    assert(written.includes("app/page.tsx"));
    assertEquals(await Deno.readTextFile(join(dir, "README.md")), "# my project\n");

    // A second init must refuse (deno.json now exists).
    let threw = false;
    try {
      await scaffoldProject({ dir, allowExisting: true });
    } catch {
      threw = true;
    }
    assert(threw, "init must refuse to overwrite an existing generated file");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a scaffolded app type-checks against the framework", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_scaffold_" });
  try {
    await scaffoldProject({ dir });
    // The generated deno.json points at the (unpublished) JSR package; rewrite its
    // imports to this repo's local files so `deno check` can resolve them.
    const repo = fromFileUrl(new URL("../../", import.meta.url));
    const denoJson = {
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "denext",
        lib: ["deno.window", "deno.unstable", "dom", "dom.iterable", "dom.asynciterable"],
      },
      imports: {
        "denext": join(repo, "mod.ts"),
        "denext/jsx-runtime": join(repo, "src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": join(repo, "src/jsx/jsx-runtime.ts"),
        "denext/server": join(repo, "src/server/mod.ts"),
        "denext/client": join(repo, "src/client/mod.ts"),
      },
    };
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify(denoJson, null, 2));

    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "check",
        "--config",
        join(dir, "deno.json"),
        join(dir, "app", "page.tsx"),
        join(dir, "app", "layout.tsx"),
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      out.code,
      0,
      `generated app failed type-check:\n${new TextDecoder().decode(out.stderr)}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
