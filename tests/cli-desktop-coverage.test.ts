// Coverage for `src/cli/commands/desktop.ts`: the argument-validation and
// missing-file exit branches of the `desktop` verb (unknown action, unsupported
// target OS, missing packaging script, missing desktop entry). The `build`/`run`
// happy paths perform a full static export + `deno desktop` spawn and are exercised by
// the desktop e2e/integration suites; here we cover the pure guard logic.

import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { desktopCommand } from "../src/cli/commands/desktop.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

async function tempDir(prefix: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  return dir;
}

Deno.test("desktop rejects an unknown action", async () => {
  const cap = capture();
  const exit = stubExit();
  const dir = await tempDir("denext_desktop_action_");
  try {
    await desktopCommand.run(makeCtx({ positionals: ["frobnicate"], global: { cwd: dir } }));
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  assert(exit.calls.includes(1));
  assertStringIncludes(cap.errs.join("\n"), "unknown action");
});

Deno.test("desktop package rejects an unsupported target OS", async () => {
  const cap = capture();
  const exit = stubExit();
  const dir = await tempDir("denext_desktop_os_");
  try {
    await desktopCommand.run(makeCtx({
      positionals: ["package"],
      flags: { "target-os": "solaris" },
      global: { cwd: dir },
    }));
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  assert(exit.calls.includes(1));
  assertStringIncludes(cap.errs.join("\n"), "macos | linux | windows");
});

Deno.test("desktop package errors when the packaging script is missing", async () => {
  const cap = capture();
  const exit = stubExit();
  const dir = await tempDir("denext_desktop_script_");
  try {
    await desktopCommand.run(makeCtx({
      positionals: ["package"],
      flags: { "target-os": "linux" },
      global: { cwd: dir },
    }));
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  assert(exit.calls.includes(1));
  assertStringIncludes(cap.errs.join("\n"), "no packaging script");
});

Deno.test("desktop run errors when no desktop entry exists", async () => {
  const cap = capture();
  const exit = stubExit();
  const dir = await tempDir("denext_desktop_entry_");
  try {
    await desktopCommand.run(makeCtx({ positionals: ["run"], global: { cwd: dir } }));
  } catch (e) {
    assertStringIncludes(String(e), "__exit__1");
  } finally {
    exit.restore();
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  assert(exit.calls.includes(1));
  assertStringIncludes(cap.errs.join("\n"), "no desktop entry");
});
