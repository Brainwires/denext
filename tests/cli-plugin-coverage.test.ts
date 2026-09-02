// Coverage for `src/cli/commands/plugin.ts`: the `list` action (no config, empty
// config, and a config with a wired plugin) plus the argument-validation exit branches
// (unknown action, missing package). The `add`/`remove` actions shell out to `deno
// add`/`deno remove` and are exercised elsewhere; here we drive the pure paths.

import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { pluginCommand } from "../src/cli/commands/plugin.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

Deno.test("plugin list reports no config when none is present", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_plugin_none_" });
  const cap = capture();
  try {
    await pluginCommand.run(makeCtx({ positionals: ["list"], global: { cwd: dir } }));
  } finally {
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  assertStringIncludes(cap.logs.join("\n"), "No denext.config.* found");
});

Deno.test("plugin list reports an empty plugins array", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_plugin_empty_" });
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    `export default { plugins: [] };\n`,
  );
  const cap = capture();
  try {
    await pluginCommand.run(makeCtx({ positionals: ["list"], global: { cwd: dir } }));
  } finally {
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  assertStringIncludes(cap.logs.join("\n"), "No plugins wired up");
});

Deno.test("plugin list enumerates a wired plugin", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_plugin_one_" });
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    `import { htmx } from "@denext/htmx";\nexport default { plugins: [htmx()] };\n`,
  );
  const cap = capture();
  try {
    await pluginCommand.run(makeCtx({ positionals: ["list"], global: { cwd: dir } }));
  } finally {
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  const out = cap.logs.join("\n");
  assertStringIncludes(out, "plugin(s) in");
  assertStringIncludes(out, "htmx()");
});

Deno.test("plugin rejects an unknown action", async () => {
  const cap = capture();
  const exit = stubExit();
  try {
    await pluginCommand.run(makeCtx({ positionals: ["frobnicate"] }));
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
  }
  assert(exit.calls.includes(1));
  assertStringIncludes(cap.errs.join("\n"), "unknown action");
});

Deno.test("plugin add without a package errors", async () => {
  const cap = capture();
  const exit = stubExit();
  try {
    await pluginCommand.run(makeCtx({ positionals: ["add"] }));
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
  }
  assert(exit.calls.includes(1));
  assertStringIncludes(cap.errs.join("\n"), "missing package");
});
