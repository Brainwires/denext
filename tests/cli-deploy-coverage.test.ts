// Coverage for `src/cli/commands/deploy.ts`: the `--list` providers path, the
// dry-run plan (with --skip-build so no production build is triggered and no network
// call is made), and the two entrypoint-resolution exit branches. The deploy engine is
// covered in cli-deploy.test.ts — here we drive the CLI verb.

import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { deployCommand } from "../src/cli/commands/deploy.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

Deno.test("deploy --list prints the available providers", async () => {
  const cap = capture();
  try {
    await deployCommand.run(makeCtx({ flags: { list: true } }));
  } finally {
    cap.restore();
  }
  const out = cap.logs.join("\n");
  assertStringIncludes(out, "Deploy providers");
  assertStringIncludes(out, "deno-deploy");
});

Deno.test("deploy --dry-run --skip-build prints a plan without building or deploying", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_deploy_cli_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  await Deno.writeTextFile(join(dir, "main.ts"), "Deno.serve(() => new Response('ok'));\n");
  const cap = capture();
  const exit = stubExit();
  try {
    await deployCommand.run(makeCtx({
      positionals: [dir],
      flags: { entry: "main.ts", "skip-build": true, "dry-run": true, project: "demo" },
    }));
  } finally {
    exit.restore();
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  const out = cap.logs.join("\n");
  assertStringIncludes(out, "denext deploy");
  assertStringIncludes(out, "deno-deploy");
  // A dry run never builds and never exits.
  assert(!out.includes("Building for production"), "skip-build suppresses the build");
  assert(exit.calls.length === 0, "a dry run does not exit non-zero");
});

Deno.test("deploy errors when no entrypoint can be found", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_deploy_noentry_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  const cap = capture();
  const exit = stubExit();
  try {
    await deployCommand.run(makeCtx({ positionals: [dir] }));
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  assert(exit.calls.includes(1));
  assertStringIncludes(cap.errs.join("\n"), "no deploy entrypoint");
});

Deno.test("deploy errors when the given entrypoint is missing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_deploy_badentry_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  const cap = capture();
  const exit = stubExit();
  try {
    await deployCommand.run(makeCtx({ positionals: [dir], flags: { entry: "nope.ts" } }));
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  assert(exit.calls.includes(1));
  assertStringIncludes(cap.errs.join("\n"), "entrypoint not found");
});
