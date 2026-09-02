// Coverage for `src/cli/commands/generate.ts`: the command's `run` (kind validation,
// name requirement, docker's optional name, the written/skipped output, and the
// "everything already existed" non-zero exit). The codegen engine itself is covered
// separately in cli-generate.test.ts — here we drive the CLI verb.

import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { generateCommand } from "../src/cli/commands/generate.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

async function project(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_gen_cli_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  await Deno.mkdir(join(dir, "app"), { recursive: true });
  return dir;
}

Deno.test("generate scaffolds a page and prints the written path", async () => {
  const dir = await project();
  const cap = capture();
  try {
    await generateCommand.run(makeCtx({ positionals: ["page", "dashboard", dir] }));
  } finally {
    cap.restore();
  }
  try {
    const out = cap.logs.join("\n");
    assertStringIncludes(out, "+ ");
    assertStringIncludes(out, "page.tsx");
    assert((await Deno.stat(join(dir, "app/dashboard/page.tsx"))).isFile);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generate docker needs no name", async () => {
  const dir = await project();
  const cap = capture();
  try {
    await generateCommand.run(makeCtx({ positionals: ["docker", "", dir] }));
  } finally {
    cap.restore();
  }
  try {
    assertStringIncludes(cap.logs.join("\n"), "Dockerfile");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generate rejects an unknown kind", async () => {
  const cap = capture();
  const exit = stubExit();
  try {
    await generateCommand.run(makeCtx({ positionals: ["widget", "Foo"] }));
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
  }
  assert(exit.calls.includes(1));
  assertStringIncludes(cap.errs.join("\n"), "unknown kind");
});

Deno.test("generate requires a name for a named kind", async () => {
  const cap = capture();
  const exit = stubExit();
  try {
    await generateCommand.run(makeCtx({ positionals: ["component"] }));
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
  }
  assert(exit.calls.includes(1));
  assertStringIncludes(cap.errs.join("\n"), "missing name");
});

Deno.test("generate exits non-zero when every target already exists", async () => {
  const dir = await project();
  // First run writes the component; second run finds it and skips everything → exit 1.
  const cap0 = capture();
  try {
    await generateCommand.run(makeCtx({ positionals: ["component", "Card", dir] }));
  } finally {
    cap0.restore();
  }
  const cap = capture();
  const exit = stubExit();
  try {
    await generateCommand.run(makeCtx({ positionals: ["component", "Card", dir] }));
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  assert(exit.calls.includes(1));
  assertStringIncludes(cap.logs.join("\n"), "exists, skipped");
});
