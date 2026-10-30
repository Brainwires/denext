// `denext migrate` carries pnpm's and Bun's npm patches (`patchedDependencies`) into deno.json's
// `patchedDependencies` (src/build/migrate-patches.ts): the copies under `patches/npm/` in the form
// the runtime reads, the review items for what it can't apply, the gate on the pinned runtime,
// a hand-authored deno.json, and `migrate --check` listing them without writing. Fixtures:
// tests/fixtures/migrate-patches/{pnpm,bun}.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import { carryPackageManagerPatches, convertPatch } from "../src/build/migrate-patches.ts";
import { migrateProject } from "../src/build/migrate.ts";
import { checkMigration } from "../src/build/migrate-check.ts";
import { dryRunMigration } from "../src/build/migrate-io.ts";
import { migrateCommand } from "../src/cli/commands/migrate.ts";
import { capture, makeCtx } from "./_cli-coverage-helpers.ts";

const FIXTURES = fromFileUrl(new URL("./fixtures/migrate-patches/", import.meta.url));
const RUNTIME = "3.0.0-denext.3";

/** A temp copy of a fixture (real path); the caller removes it. */
async function fixture(name: "pnpm" | "bun"): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_migrate_patches_" }));
  await copy(join(FIXTURES, name), dir, { overwrite: true });
  // A repository root, so the pnpm-workspace.yaml lookup stops here.
  await Deno.mkdir(join(dir, ".git"));
  return dir;
}

const read = (path: string) => Deno.readTextFile(path);

Deno.test("convertPatch: git patches pass as they are; node_modules paths and plain diffs convert", () => {
  const git =
    "diff --git a/index.js b/index.js\nindex 1..2 100644\n--- a/index.js\n+++ b/index.js\n" +
    "@@ -1 +1 @@\n-a\n+b\n";
  assertEquals(convertPatch(git, "x"), { body: git, converted: false });
  // A plain unified diff under node_modules/<pkg>/ gains its diff --git line, paths relative.
  assertEquals(
    convertPatch(
      "--- a/node_modules/@s/u/lib/m.js\t2026-01-01\n+++ b/node_modules/@s/u/lib/m.js\n@@ -1 +1 @@\n-a\n+b\n",
      "@s/u",
    ),
    {
      body:
        "diff --git a/lib/m.js b/lib/m.js\n--- a/lib/m.js\n+++ b/lib/m.js\n@@ -1 +1 @@\n-a\n+b\n",
      converted: true,
    },
  );
  // A git header under node_modules converts too.
  const nm = convertPatch(
    "diff --git a/node_modules/x/a.js b/node_modules/x/a.js\n--- a/node_modules/x/a.js\n" +
      "+++ b/node_modules/x/a.js\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n\\ No newline at end of file\n",
    "x",
  );
  assertEquals(
    nm,
    {
      body: "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n" +
        "\\ No newline at end of file\n",
      converted: true,
    },
  );
  // A removed line that reads like a header stays hunk content.
  const tricky = "--- a/i.js\n+++ b/i.js\n@@ -1,2 +1,2 @@\n--- old\n++++ new\n x\n";
  assertEquals(convertPatch(tricky, "i"), {
    body: "diff --git a/i.js b/i.js\n" + tricky,
    converted: false,
  });
  // What the runtime's applier can't do.
  const reason = (text: string) => (convertPatch(text, "x") as { reason?: string }).reason;
  assertEquals(
    reason("diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+x\n"),
    "it adds or deletes a file",
  );
  assertEquals(reason("--- a/n\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n"), "it adds or deletes a file");
  assertEquals(
    reason("diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b\n"),
    "it renames or copies a file",
  );
  assertEquals(
    reason("diff --git a/i.png b/i.png\nGIT binary patch\nliteral 1\n"),
    "it changes a binary file",
  );
  assertEquals(reason("Binary files a/i.png and b/i.png differ\n"), "it changes a binary file");
});

Deno.test("carryPackageManagerPatches: pnpm (package.json + pnpm-workspace.yaml) into deno.json", async () => {
  const dir = await fixture("pnpm");
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), `{\n  "imports": {}\n}\n`);
    const r = await carryPackageManagerPatches(dir, { runtime: RUNTIME });
    assert(r);
    assertEquals(r.action, "written");
    assertEquals(r.carried.map((c) => [c.key, c.source, c.from, c.to, c.converted]), [
      [
        "left-pad@1.3.0",
        "pnpm",
        "patches/left-pad@1.3.0.patch",
        "patches/npm/left-pad+1.3.0.patch",
        false,
      ],
      ["is-odd", "pnpm", "patches/is-odd.patch", "patches/npm/is-odd+any.patch", false],
      [
        "@scope/util@^2.1.0",
        "pnpm",
        "patches/@scope__util.patch",
        "patches/npm/@scope+util+_2.1.0.patch",
        true,
      ],
    ]);
    assertEquals(r.review, []);
    // package.json's declaration wins over pnpm-workspace.yaml's for the same key.
    assertEquals(
      JSON.parse(await read(join(dir, "deno.json"))).patchedDependencies,
      {
        "left-pad@1.3.0": "patches/npm/left-pad+1.3.0.patch",
        "is-odd": "patches/npm/is-odd+any.patch",
        "@scope/util@^2.1.0": "patches/npm/@scope+util+_2.1.0.patch",
      },
    );
    // A git patch is copied byte for byte (index lines included: the runtime takes them).
    assertEquals(
      await read(join(dir, "patches/npm/left-pad+1.3.0.patch")),
      await read(join(dir, "patches/left-pad@1.3.0.patch")),
    );
    assertStringIncludes(
      await read(join(dir, "patches/npm/@scope+util+_2.1.0.patch")),
      "diff --git a/lib/main.js b/lib/main.js\n--- a/lib/main.js\n+++ b/lib/main.js\n",
    );
    assertStringIncludes(r.lines[0], "patchedDependencies for 3 pnpm patch(es)");
    assert(r.lines.some((l) => l.includes("(paths made package-relative)")), r.lines.join("\n"));
    // A re-run leaves deno.json as it is.
    const before = await read(join(dir, "deno.json"));
    await carryPackageManagerPatches(dir, { runtime: RUNTIME });
    assertEquals(await read(join(dir, "deno.json")), before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("carryPackageManagerPatches: Bun's, with a deletion left for review", async () => {
  const dir = await fixture("bun");
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
    const r = await carryPackageManagerPatches(dir, { runtime: RUNTIME });
    assert(r);
    assertEquals(r.carried.map((c) => [c.key, c.source]), [["left-pad@1.3.0", "bun"]]);
    assertEquals(r.review.map((c) => [c.key, c.source, c.from]), [
      ["kleur@4.1.5", "bun", "patches/kleur@4.1.5.patch"],
    ]);
    assertStringIncludes(r.review[0].reason, "it adds or deletes a file");
    assertStringIncludes(r.review[0].reason, "denext patch create");
    assertEquals(JSON.parse(await read(join(dir, "deno.json"))).patchedDependencies, {
      "left-pad@1.3.0": "patches/npm/left-pad+1.3.0.patch",
    });
    assertEquals(
      await Deno.stat(join(dir, "patches/npm/kleur+4.1.5.patch")).then(() => true, () => false),
      false,
    );
    assert(r.lines.some((l) => l.startsWith("not carried: kleur@4.1.5")), r.lines.join("\n"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("carryPackageManagerPatches: an older runtime carries nothing; a kept deno.json gets a snippet", async () => {
  const dir = await fixture("bun");
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
    for (const runtime of [null, "3.0.0-denext.2"]) {
      const r = await carryPackageManagerPatches(dir, { runtime });
      assertEquals(r?.action, "unsupported");
      assertEquals(r?.carried, []);
      assertEquals(r?.review.length, 2);
      assertStringIncludes(r!.lines[0], "doesn't apply patchedDependencies");
    }
    assertEquals(await read(join(dir, "deno.json")), "{}\n");
    // A hand-authored deno.json: copies made, the entries reported to add by hand.
    const manual = await carryPackageManagerPatches(dir, { runtime: RUNTIME, edit: false });
    assertEquals(manual?.action, "manual");
    assertEquals(JSON.parse(manual!.snippet!), {
      patchedDependencies: { "left-pad@1.3.0": "patches/npm/left-pad+1.3.0.patch" },
    });
    assertEquals(await read(join(dir, "deno.json")), "{}\n");
    // No deno.json at all: the same.
    await Deno.remove(join(dir, "deno.json"));
    assertEquals((await carryPackageManagerPatches(dir, { runtime: RUNTIME }))?.action, "manual");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("carryPackageManagerPatches: none declared, an unreadable patch, a key deno.json maps already", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_migrate_patches_" }));
  try {
    await Deno.mkdir(join(dir, ".git"));
    assertEquals(await carryPackageManagerPatches(dir, { runtime: RUNTIME }), null);
    await Deno.writeTextFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    assertEquals(await carryPackageManagerPatches(dir, { runtime: RUNTIME }), null);
    await Deno.writeTextFile(join(dir, "package.json"), "{ not json");
    assertEquals(await carryPackageManagerPatches(dir, { runtime: RUNTIME }), null);
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ patchedDependencies: { "a@1.0.0": "gone.patch", "b@1.0.0": "b.patch" } }),
    );
    await Deno.writeTextFile(join(dir, "b.patch"), "--- a/b.js\n+++ b/b.js\n@@ -1 +1 @@\n-x\n+y\n");
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ patchedDependencies: { "b@1.0.0": "mine.patch" } }),
    );
    const r = await carryPackageManagerPatches(dir, { runtime: RUNTIME });
    assertEquals(r?.review.map((x) => x.key), ["a@1.0.0", "b@1.0.0"]);
    assertStringIncludes(r!.review[0].reason, "gone.patch could not be read");
    assertStringIncludes(r!.review[1].reason, 'already maps it to "mine.patch"');
    assertEquals(JSON.parse(await read(join(dir, "deno.json"))).patchedDependencies, {
      "b@1.0.0": "mine.patch",
    });
    // Nothing carryable at all.
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ patchedDependencies: { "a@1.0.0": "gone.patch" } }),
    );
    const none = await carryPackageManagerPatches(dir, { runtime: RUNTIME });
    assertEquals(none?.action, "written");
    assertStringIncludes(none!.lines[0], "no Bun patch could be carried");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("carryPackageManagerPatches: an app inside a pnpm workspace reads the root's yaml", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_migrate_patches_" }));
  try {
    await Deno.mkdir(join(root, ".git"));
    await Deno.mkdir(join(root, "apps", "web"), { recursive: true });
    await Deno.mkdir(join(root, "patches"));
    await Deno.writeTextFile(
      join(root, "pnpm-workspace.yaml"),
      'packages: ["apps/*"]\npatchedDependencies:\n  "q@1.0.0": patches/q.patch\n',
    );
    await Deno.writeTextFile(
      join(root, "patches", "q.patch"),
      "diff --git a/q.js b/q.js\n--- a/q.js\n+++ b/q.js\n@@ -1 +1 @@\n-x\n+y\n",
    );
    const app = join(root, "apps", "web");
    await Deno.writeTextFile(join(app, "deno.json"), "{}\n");
    const r = await carryPackageManagerPatches(app, { runtime: RUNTIME });
    assertEquals(r?.carried.map((c) => [c.key, c.from, c.to]), [
      ["q@1.0.0", "../../patches/q.patch", "patches/npm/q+1.0.0.patch"],
    ]);
    assertEquals(JSON.parse(await read(join(app, "deno.json"))).patchedDependencies, {
      "q@1.0.0": "patches/npm/q+1.0.0.patch",
    });
    // An unparsable yaml declares nothing.
    await Deno.writeTextFile(join(root, "pnpm-workspace.yaml"), "patchedDependencies: [\n");
    assertEquals(await carryPackageManagerPatches(app, { runtime: RUNTIME }), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("denext migrate: a pnpm Next app's patches land in deno.json; --check lists them, writes nothing", async () => {
  const dir = await fixture("pnpm");
  try {
    const before = await read(join(dir, "package.json"));
    const report = await checkMigration(dir);
    const patchItems = report.review.filter((f) => f.item.startsWith("npm patch: "));
    assertEquals(patchItems.map((f) => f.item), [
      "npm patch: left-pad@1.3.0",
      "npm patch: is-odd",
      "npm patch: @scope/util@^2.1.0",
    ]);
    assertStringIncludes(patchItems[0].reason, "registered in deno.json's patchedDependencies");
    assert(
      report.changes.some((c) =>
        c.path === "patches/npm/left-pad+1.3.0.patch" && c.action === "create"
      ),
      JSON.stringify(report.changes),
    );
    assertEquals(
      await Deno.stat(join(dir, "patches/npm")).then(() => true, () => false),
      false,
      "--check writes nothing",
    );
    // The dry run and the real run agree.
    const { result } = await dryRunMigration(dir, () => migrateProject(dir));
    assertEquals(result.patches?.carried.length, 3);
    const r = await migrateProject(dir);
    assertEquals(r.patches?.action, "written");
    const deno = JSON.parse(await read(join(dir, "deno.json")));
    assertEquals(Object.keys(deno.patchedDependencies), [
      "left-pad@1.3.0",
      "is-odd",
      "@scope/util@^2.1.0",
    ]);
    assert(deno["//"], "still migrate's own deno.json");
    assertEquals(await read(join(dir, "package.json")), before, "package.json untouched");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext migrate --check: a Bun app's deletion patch is a review item", async () => {
  const dir = await fixture("bun");
  try {
    const report = await checkMigration(dir);
    const kleur = report.review.find((f) => f.item === "npm patch: kleur@4.1.5");
    assert(kleur, JSON.stringify(report.review));
    assertStringIncludes(kleur.reason, "patches/kleur@4.1.5.patch: it adds or deletes a file");
    assertEquals(report.verdict, "review");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext migrate (CLI): prints the carried patches and the ones left for review", async () => {
  const dir = await fixture("bun");
  const cap = capture();
  try {
    await migrateCommand.run(makeCtx({ positionals: [dir] }));
  } finally {
    cap.restore();
  }
  try {
    const out = cap.logs.join("\n");
    assertStringIncludes(out, "⚠️  deno.json: patchedDependencies for 1 Bun patch(es)");
    assertStringIncludes(
      out,
      "      left-pad@1.3.0: patches/left-pad@1.3.0.patch → patches/npm/left-pad+1.3.0.patch",
    );
    assertStringIncludes(out, "      not carried: kleur@4.1.5 (patches/kleur@4.1.5.patch)");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
