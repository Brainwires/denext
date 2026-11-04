// `denext generate app <name>`: another app in a `denext create --monorepo` workspace
// (src/build/generate-app.ts) — its files, the root's member list and task, the workspace's pin.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { generateArtifact } from "../src/build/generate.ts";
import { scaffoldMonorepo } from "../src/build/scaffold-monorepo.ts";
import { VERSION } from "../mod.ts";
import { removeTempDir } from "./helpers/temp.ts";

/** A fresh monorepo (no .vscode), its root dir. */
async function monorepo(): Promise<string> {
  const dir = join(await Deno.makeTempDir({ prefix: "denext_gen_app_" }), "acme");
  await scaffoldMonorepo({ dir, vscode: false });
  return dir;
}

Deno.test("generate app: apps/<name> importing the shared packages, listed in the workspace", async () => {
  const dir = await monorepo();
  try {
    // The workspace pins an older denext than this CLI: the new app follows the workspace.
    const rootPath = join(dir, "deno.json");
    const pinned = (await Deno.readTextFile(rootPath)).replaceAll(`^${VERSION}`, "^4.0.0");
    await Deno.writeTextFile(rootPath, pinned);
    const { written, skipped } = await generateArtifact(dir, "app", "admin");
    assertEquals(skipped, []);
    for (const rel of ["apps/admin/deno.json", "apps/admin/app/page.tsx", "deno.json"]) {
      assert(written.includes(join(dir, rel)), `${rel} not in ${written.join(", ")}`);
    }
    const root = JSON.parse(await Deno.readTextFile(rootPath));
    assertEquals(root.workspace, [
      "./apps/web",
      "./packages/ui",
      "./packages/shared",
      "./apps/admin",
    ]);
    assertEquals(root.tasks["dev:admin"], "deno task --cwd apps/admin dev");
    const app = await Deno.readTextFile(join(dir, "apps/admin/deno.json"));
    assertStringIncludes(app, '"denext": "jsr:@denext/denext@^4.0.0"');
    assert(!app.includes(`^${VERSION}`), app);
    assert(!app.includes('"unstable"'), "a member leaves the root-only fields to the root");
    const page = await Deno.readTextFile(join(dir, "apps/admin/app/page.tsx"));
    assertStringIncludes(page, 'from "@acme/ui"');
    // Again: the app's files exist (skipped), the root keeps one entry.
    const again = await generateArtifact(dir, "app", "admin");
    assert(again.skipped.includes(join(dir, "apps/admin/app/page.tsx")));
    const after = JSON.parse(await Deno.readTextFile(rootPath));
    assertEquals(after.workspace.filter((m: string) => m === "./apps/admin").length, 1);
  } finally {
    await removeTempDir(join(dir, ".."));
  }
});

Deno.test("generate app: a glob member already covering apps/<name> is not listed twice", async () => {
  // Deno refuses a workspace that names a member twice ("Cannot specify a workspace member
  // twice"), so adding `./apps/admin` beside `./apps/*` broke the whole workspace.
  const dir = await monorepo();
  try {
    const rootPath = join(dir, "deno.json");
    const root = JSON.parse(await Deno.readTextFile(rootPath));
    root.workspace = ["./apps/*", "./packages/*"];
    await Deno.writeTextFile(rootPath, JSON.stringify(root, null, 2) + "\n");
    await generateArtifact(dir, "app", "admin");
    const after = JSON.parse(await Deno.readTextFile(rootPath));
    assertEquals(after.workspace, ["./apps/*", "./packages/*"]);
    assertEquals(after.tasks["dev:admin"], "deno task --cwd apps/admin dev");
  } finally {
    await removeTempDir(join(dir, ".."));
  }
});

Deno.test("generate app: --dry-run previews and writes nothing", async () => {
  const dir = await monorepo();
  try {
    const before = await Deno.readTextFile(join(dir, "deno.json"));
    const { written, preview } = await generateArtifact(dir, "app", "docs", { dryRun: true });
    assert(written.includes(join(dir, "apps/docs/app/page.tsx")));
    assert(preview?.some((f) => f.path === join(dir, "deno.json") && f.contents.includes("docs")));
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), before);
    await assertRejects(() => Deno.stat(join(dir, "apps/docs")), Deno.errors.NotFound);
  } finally {
    await removeTempDir(join(dir, ".."));
  }
});

Deno.test("generate app: a commented root config keeps its comments", async () => {
  const dir = await monorepo();
  try {
    const rootPath = join(dir, "deno.json");
    const text = await Deno.readTextFile(rootPath);
    await Deno.writeTextFile(rootPath, `// the workspace\n${text}`);
    await generateArtifact(dir, "app", "admin");
    const after = await Deno.readTextFile(rootPath);
    assert(after.startsWith("// the workspace\n"), after);
    assertStringIncludes(after, '"./apps/admin"');
    assertStringIncludes(after, '"dev:admin": "deno task --cwd apps/admin dev"');
  } finally {
    await removeTempDir(join(dir, ".."));
  }
});

Deno.test("generate app: refuses a bad name, a non-workspace and one without shared packages", async () => {
  const dir = await monorepo();
  const plain = await Deno.makeTempDir({ prefix: "denext_gen_app_plain_" });
  try {
    await assertRejects(
      () => generateArtifact(dir, "app", "Admin"),
      Error,
      'denext: generate app: "Admin" is not an app name',
    );
    await Deno.writeTextFile(join(plain, "deno.json"), "{}\n");
    await assertRejects(() => generateArtifact(plain, "app", "admin"), Error, 'no "workspace"');
    await Deno.writeTextFile(join(plain, "deno.json"), JSON.stringify({ workspace: ["./a"] }));
    await assertRejects(
      () => generateArtifact(plain, "app", "admin"),
      Error,
      "no <scope>/ui and <scope>/shared packages",
    );
    await Deno.remove(join(plain, "deno.json"));
    await assertRejects(() => generateArtifact(plain, "app", "admin"), Error, "no deno.json");
  } finally {
    await removeTempDir(join(dir, ".."));
    await removeTempDir(plain);
  }
});
