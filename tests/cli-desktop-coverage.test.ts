// Coverage for `src/cli/commands/desktop.ts`: the argument-validation and
// missing-file exit branches of the `desktop` verb (unknown action, unsupported
// target OS, missing packaging script, missing desktop entry). The `build`/`run`
// happy paths perform a full static export + `deno desktop` spawn and are exercised by
// the desktop e2e/integration suites; here we cover the pure guard logic.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { desktopCommand } from "../src/cli/commands/desktop.ts";
import { scaffoldFiles } from "../src/build/scaffold.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

/** The current scaffold template for a package script, by basename. */
function templateFor(name: string): string {
  const f = scaffoldFiles({ dir: "/x", desktop: true })
    .find((f) => f.path === `scripts/${name}`);
  if (!f) throw new Error(`no scaffold template for ${name}`);
  return f.content;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

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

Deno.test("desktop package --regenerate-scripts: creates, .bak-updates a stale script, keeps a current one", async () => {
  const cap = capture();
  const dir = await tempDir("denext_desktop_regen_");
  const macos = templateFor("package-macos.ts");
  const linux = templateFor("package-linux.ts");
  const windows = templateFor("package-windows.ts");
  try {
    await Deno.mkdir(join(dir, "scripts"));
    // A stale macOS script (the old `-A` form) → must be backed up and rewritten.
    await Deno.writeTextFile(
      join(dir, "scripts", "package-macos.ts"),
      "// old script\nconst cmd = ['deno', 'desktop', '-A'];\n",
    );
    // An already-current linux script → must be left untouched (no .bak).
    await Deno.writeTextFile(join(dir, "scripts", "package-linux.ts"), linux);
    // windows script absent → must be created.
    await desktopCommand.run(makeCtx({
      positionals: ["package"],
      flags: { "regenerate-scripts": true },
      global: { cwd: dir },
    }));
  } finally {
    cap.restore();
  }
  // macOS: rewritten to the template, previous content in the .bak.
  assertEquals(await Deno.readTextFile(join(dir, "scripts", "package-macos.ts")), macos);
  assertStringIncludes(
    await Deno.readTextFile(join(dir, "scripts", "package-macos.ts.bak")),
    "// old script",
  );
  // linux: unchanged, and NO .bak (identical files are never backed up).
  assertEquals(await Deno.readTextFile(join(dir, "scripts", "package-linux.ts")), linux);
  assert(
    !(await exists(join(dir, "scripts", "package-linux.ts.bak"))),
    "no .bak for an identical file",
  );
  // windows: created.
  assertEquals(await Deno.readTextFile(join(dir, "scripts", "package-windows.ts")), windows);
  // The report names each disposition.
  const out = cap.logs.join("\n");
  assertStringIncludes(out, "updated");
  assertStringIncludes(out, "unchanged");
  assertStringIncludes(out, "created");
  await Deno.remove(dir, { recursive: true });
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
