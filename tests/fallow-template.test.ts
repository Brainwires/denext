// `denext fallow init` / src/build/fallow-template.ts: adding the fallow gate to an existing
// project — files only when missing, tasks spliced into deno.json(c) without losing its
// comments, .gitignore lines appended once, a dry run that writes nothing.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { addFallow, FALLOW_VERSION, fallowTasks } from "../src/build/fallow-template.ts";
import { fallowCommand } from "../src/cli/commands/fallow.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

const JSONC = `{
  // the app's own tasks
  "tasks": {
    "dev": "deno run -A jsr:@denext/denext/cli dev .",
    // a hand-written one wins
    "fallow": "fallow"
  }
}
`;

async function project(denoJson = "deno.json", source = '{ "tasks": {} }\n'): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_fallow_init_" });
  await Deno.writeTextFile(join(dir, denoJson), source);
  return dir;
}

Deno.test("addFallow writes the gate files, splices the tasks and extends .gitignore", async () => {
  const dir = await project("deno.jsonc", JSONC);
  try {
    await Deno.writeTextFile(join(dir, ".gitignore"), ".denext/"); // no trailing newline
    const { written, skipped } = await addFallow(dir);
    for (
      const p of [
        "fallow.toml",
        ".githooks/pre-commit",
        "scripts/coverage-to-istanbul.ts",
        "AGENTS.md",
        "CLAUDE.md",
        "deno.jsonc",
        ".gitignore",
      ]
    ) {
      assert(written.includes(p), `expected ${p} in ${written}`);
    }
    assertEquals(skipped, []);
    const jsonc = await Deno.readTextFile(join(dir, "deno.jsonc"));
    assertStringIncludes(jsonc, "// the app's own tasks", "comments survive the splice");
    assertStringIncludes(jsonc, '// a hand-written one wins\n    "fallow": "fallow",');
    assertStringIncludes(jsonc, `"fallow:audit": "${fallowTasks()["fallow:audit"]}"`);
    assertStringIncludes(jsonc, '"hooks:install": "git config core.hooksPath .githooks"');
    assertEquals(
      await Deno.readTextFile(join(dir, ".gitignore")),
      ".denext/\ncoverage/\n.fallow/\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("addFallow is idempotent and never overwrites a file", async () => {
  const dir = await project();
  try {
    await Deno.writeTextFile(join(dir, "fallow.toml"), "# ours\n");
    await Deno.writeTextFile(join(dir, ".gitignore"), "coverage\n.fallow/\n");
    const first = await addFallow(dir);
    assert(first.skipped.includes("fallow.toml"));
    assert(first.skipped.includes(".gitignore"), "`coverage` already covers coverage/");
    assertEquals(await Deno.readTextFile(join(dir, "fallow.toml")), "# ours\n");
    const before = await Deno.readTextFile(join(dir, "deno.json"));
    const second = await addFallow(dir);
    assertEquals(second.written, []);
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("addFallow dry run plans without writing", async () => {
  const dir = await project();
  try {
    const { written } = await addFallow(dir, { dryRun: true });
    assert(written.includes("fallow.toml") && written.includes("deno.json"));
    const entries: string[] = [];
    for await (const e of Deno.readDir(dir)) entries.push(e.name);
    assertEquals(entries, ["deno.json"]);
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), '{ "tasks": {} }\n');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("addFallow refuses a directory without a deno.json", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_fallow_init_" });
  try {
    await assertRejects(() => addFallow(dir), Error, "no deno.json");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext fallow init prints what it wrote; an unknown action exits 1", async () => {
  const dir = await project();
  const cap = capture();
  const exit = stubExit();
  try {
    await fallowCommand.run(makeCtx({ positionals: ["init", dir] }));
    await fallowCommand.run(makeCtx({ positionals: ["init", dir], flags: { "dry-run": true } }));
    try {
      await fallowCommand.run(makeCtx({ positionals: ["setup", dir] }));
    } catch (e) {
      assertStringIncludes(String(e), "__exit__1");
    }
  } finally {
    exit.restore();
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  const out = cap.logs.join("\n");
  assertStringIncludes(out, "+ fallow.toml");
  assertStringIncludes(out, "already present: fallow.toml");
  assertStringIncludes(out, "deno task hooks:install");
  assert(exit.calls.includes(1));
  assertStringIncludes(cap.errs.join("\n"), 'unknown action "setup"');
  assertStringIncludes(fallowCommand.usage ?? "", `npm:fallow@${FALLOW_VERSION}`);
});
