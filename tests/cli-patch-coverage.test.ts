// Coverage for `src/cli/commands/patch.ts`: the verb's orchestration + console output on a
// temp project, patching the running framework itself (a local checkout → no network).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { patchCommand, patchCreate } from "../src/cli/commands/patch.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

async function project(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_patch_cli_" });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    `{ "imports": { "denext": "jsr:@denext/denext@^2" } }\n`,
  );
  return dir;
}

async function run(args: string[], global: Record<string, boolean> = {}): Promise<string> {
  const cap = capture();
  try {
    await patchCommand.run(makeCtx({ positionals: args, global }));
  } catch (err) {
    if (!String(err).includes("__exit__")) throw err; // the Deno.exit stub throws
  } finally {
    cap.restore();
  }
  return [...cap.logs, ...cap.errs].join("\n");
}

Deno.test("patch list on a project without patches says so (and --json gives [])", async () => {
  const dir = await project();
  try {
    assertStringIncludes(await run(["list", dir]), "no patches");
    assertEquals(JSON.parse(await run(["list", dir], { json: true })), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("patch edit denext → create denext → list → delete round-trips through the CLI", async () => {
  const dir = await project();
  try {
    const out = await run(["edit", "denext", "src/runtime/env-safe.ts", dir]);
    // The CLI prints the working copy as a native path (backslashes on Windows).
    assertStringIncludes(
      out,
      "edit " + join("patches", ".work", "denext", "src", "runtime", "env-safe.ts"),
    );
    const work = join(dir, "patches", ".work", "denext", "src", "runtime", "env-safe.ts");
    const src = await Deno.readTextFile(work);
    await Deno.writeTextFile(work, src + "\nexport const PATCH_MARKER = 1;\n");

    const created = await run(["create", "denext", dir]);
    assertStringIncludes(created, "✔ wrote " + join("patches", "denext+"));
    assertStringIncludes(created, "src/runtime/env-safe.ts");
    assertStringIncludes(created, "takes effect on the next start");
    const materialized = await Deno.readTextFile(
      join(dir, "patches", "denext", "src", "runtime", "env-safe.ts"),
    );
    assertStringIncludes(materialized, "PATCH_MARKER");
    const config = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    const key = Object.keys(config.imports).find((k) => k.endsWith("/src/runtime/env-safe.ts"));
    assert(key, "import map maps the framework file's URL");
    assertEquals(config.imports[key!], "./patches/denext/src/runtime/env-safe.ts");

    const listed = await run(["list", dir]);
    assertStringIncludes(listed, "1. denext@");
    assertStringIncludes(listed, "denext/src/runtime/env-safe.ts");
    assertStringIncludes(await run(["apply", dir]), "already in place");

    assertStringIncludes(await run(["delete", "1", dir]), "✔ removed denext@");
    assertStringIncludes(await run(["list", dir]), "no patches");
    const after = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assertEquals(Object.keys(after.imports), ["denext"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("patch create for a package that isn't installed fails with the node_modules hint", async () => {
  const dir = await project();
  const exit = stubExit();
  try {
    const out = await run(["create", "left-pad", dir]);
    assert(exit.calls.length > 0, "exits non-zero");
    assertStringIncludes(out, "not installed");
  } finally {
    exit.restore();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an unknown action exits with the verb list", async () => {
  const exit = stubExit();
  const cap = capture();
  try {
    await Promise.resolve(patchCommand.run(makeCtx({ positionals: ["frobnicate"] }))).catch(
      () => {},
    );
    assert(exit.calls.length > 0);
    assertStringIncludes(cap.errs.join("\n"), "create|list|delete|apply|edit");
  } finally {
    cap.restore();
    exit.restore();
  }
});

/**
 * A project with `left-pad@1.3.0` installed and edited, a pristine copy beside it (no network),
 * and `nodeModulesDir: "auto"` so the runtime can register the patch.
 */
async function editedNpmProject(): Promise<{ dir: string; pristine: string }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_patch_cli_npm_" });
  const pristine = join(dir, ".pristine");
  const installed = join(dir, "node_modules", "left-pad");
  const pkg = `{ "name": "left-pad", "version": "1.3.0" }\n`;
  const src = "module.exports = function leftPad(s) {\n  return s;\n};\n";
  for (const at of [pristine, installed]) {
    await Deno.mkdir(at, { recursive: true });
    await Deno.writeTextFile(join(at, "package.json"), pkg);
    await Deno.writeTextFile(join(at, "index.js"), src);
  }
  await Deno.writeTextFile(
    join(installed, "index.js"),
    src.replace("return s;", 'return "!" + s;'),
  );
  await Deno.writeTextFile(join(dir, "deno.json"), `{ "nodeModulesDir": "auto" }\n`);
  return { dir, pristine };
}

/** `patchCreate`'s console output. */
async function created(dir: string, opts: Parameters<typeof patchCreate>[2]): Promise<string> {
  const cap = capture();
  try {
    await patchCreate("left-pad", dir, opts);
  } finally {
    cap.restore();
  }
  return [...cap.logs, ...cap.errs].join("\n");
}

Deno.test("patch create <npm package> says when deno.json's patchedDependencies registers it", async () => {
  const { dir, pristine } = await editedNpmProject();
  const npmPristine = () => Promise.resolve(pristine);
  try {
    const out = await created(dir, { npmPristine, runtime: "3.0.0-denext.3" });
    assertStringIncludes(
      out,
      "✔ wrote " + join("patches", "left-pad+1.3.0.patch") + " (1 file(s)):",
    );
    assertStringIncludes(out, "re-applied to node_modules at every dev/build/start (idempotent).");
    assertStringIncludes(
      out,
      'registered as "left-pad@1.3.0" in deno.json "patchedDependencies" (patches/npm/): ' +
        "applied by the runtime on install too.",
    );
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))).patchedDependencies,
      { "left-pad@1.3.0": "patches/npm/left-pad+1.3.0.patch" },
    );
    // A runtime without patchedDependencies: the patch, and no registration line.
    const older = await created(dir, { npmPristine, runtime: "3.0.0-denext.2" });
    assertStringIncludes(older, "re-applied to node_modules");
    assert(!older.includes("registered as"), older);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
