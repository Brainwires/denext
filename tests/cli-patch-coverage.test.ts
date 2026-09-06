// Coverage for `src/cli/commands/patch.ts`: the verb's orchestration + console output on a
// temp project, patching the running framework itself (a local checkout → no network).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { patchCommand } from "../src/cli/commands/patch.ts";
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
    assertStringIncludes(out, "edit patches/.work/denext/src/runtime/env-safe.ts");
    const work = join(dir, "patches", ".work", "denext", "src", "runtime", "env-safe.ts");
    const src = await Deno.readTextFile(work);
    await Deno.writeTextFile(work, src + "\nexport const PATCH_MARKER = 1;\n");

    const created = await run(["create", "denext", dir]);
    assertStringIncludes(created, "✔ wrote patches/denext+");
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
