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

Deno.test("desktop package --regenerate-scripts: warns when the updater is used without extraPermissions.net", async () => {
  const cap = capture();
  const dir = await tempDir("denext_desktop_regen_updater_");
  try {
    await Deno.writeTextFile(
      join(dir, "desktop.ts"),
      'import { runDesktop } from "denext/desktop";\n' +
        'await runDesktop({ importMetaUrl: import.meta.url, updater: { feedUrl: "x", publicKey: "y" } });\n',
    );
    // No extraPermissions.net → the updater can't reach its feed host → warn.
    await Deno.writeTextFile(join(dir, "denext.config.ts"), "export default {};\n");
    await desktopCommand.run(makeCtx({
      positionals: ["package"],
      flags: { "regenerate-scripts": true },
      global: { cwd: dir },
    }));
  } finally {
    cap.restore();
  }
  assertStringIncludes(cap.errs.join("\n"), "self-updater");
  assertStringIncludes(cap.errs.join("\n"), "extraPermissions");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("desktop package --regenerate-scripts: no updater warning when extraPermissions.net is set", async () => {
  const cap = capture();
  const dir = await tempDir("denext_desktop_regen_updater_ok_");
  try {
    await Deno.writeTextFile(
      join(dir, "desktop.ts"),
      'import { runDesktop } from "denext/desktop";\n' +
        'await runDesktop({ importMetaUrl: import.meta.url, updater: { feedUrl: "x", publicKey: "y" } });\n',
    );
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      'export default { desktop: { extraPermissions: { net: ["updates.example.com"] } } };\n',
    );
    await desktopCommand.run(makeCtx({
      positionals: ["package"],
      flags: { "regenerate-scripts": true },
      global: { cwd: dir },
    }));
  } finally {
    cap.restore();
  }
  assert(!cap.errs.join("\n").includes("self-updater"), "no warning when net is declared");
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

Deno.test("desktop package --regenerate-scripts SECURITY: never writes through a symlinked script or .bak", async () => {
  if (Deno.build.os === "windows") return; // symlink creation needs privileges there
  const cap = capture();
  const dir = await tempDir("denext_desktop_regen_link_");
  const outside = await tempDir("denext_desktop_regen_outside_");
  try {
    await Deno.mkdir(join(dir, "scripts"));
    // A stale macOS script whose .bak is a symlink to a file OUTSIDE the project.
    await Deno.writeTextFile(join(dir, "scripts", "package-macos.ts"), "// attacker content\n");
    await Deno.writeTextFile(join(outside, "victim"), "precious\n");
    await Deno.symlink(join(outside, "victim"), join(dir, "scripts", "package-macos.ts.bak"));
    // The linux script itself is a symlink to an outside file.
    await Deno.writeTextFile(join(outside, "victim2"), "precious2\n");
    await Deno.symlink(join(outside, "victim2"), join(dir, "scripts", "package-linux.ts"));
    await desktopCommand.run(makeCtx({
      positionals: ["package"],
      flags: { "regenerate-scripts": true },
      global: { cwd: dir },
    }));
  } finally {
    cap.restore();
  }
  // Neither outside file was written.
  assertEquals(await Deno.readTextFile(join(outside, "victim")), "precious\n");
  assertEquals(await Deno.readTextFile(join(outside, "victim2")), "precious2\n");
  // The .bak is now a regular file holding the previous script; the linked script was skipped.
  assert(!(await Deno.lstat(join(dir, "scripts", "package-macos.ts.bak"))).isSymlink);
  assertStringIncludes(
    await Deno.readTextFile(join(dir, "scripts", "package-macos.ts.bak")),
    "// attacker content",
  );
  assertStringIncludes(cap.errs.join("\n"), "skipped");
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(outside, { recursive: true });
});

/** Run the `desktop` verb; returns the exit code (0 when it returned) plus captured output. */
async function runVerb(
  positionals: string[],
  dir: string,
  flags: Record<string, string | number | boolean> = {},
  rest: string[] = [],
): Promise<{ code: number; out: string; err: string; thrown?: unknown }> {
  const cap = capture();
  const exit = stubExit();
  let code = 0;
  let thrown: unknown;
  try {
    await desktopCommand.run(makeCtx({ positionals, flags, global: { cwd: dir }, rest }));
  } catch (e) {
    if (String(e).includes("__exit__")) code = exit.calls[0];
    else thrown = e;
  } finally {
    exit.restore();
    cap.restore();
  }
  return { code, out: cap.logs.join("\n"), err: cap.errs.join("\n"), thrown };
}

/** Run `fn` with env vars set (undefined = unset), restoring the previous values after. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]));
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, x] of Object.entries(v)) {
      x === undefined ? Deno.env.delete(k) : Deno.env.set(k, x);
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(prev);
  }
}

const STOCK = { DENEXT_DESKTOP_RUNTIME: "stock" };

Deno.test("desktop build exports the SPA to out/", async () => {
  const dir = await tempDir("denext_desktop_build_");
  try {
    const r = await runVerb(["build"], dir);
    assertEquals(r.code, 0, r.err);
    assertStringIncludes(r.out, "exporting SPA");
    assertStringIncludes(r.out, `Exported 0 page(s) to ${join(dir, "out")}`);
    assert(await exists(join(dir, "out")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop run: a failing export stops before any window is opened", async () => {
  const dir = await tempDir("denext_desktop_run_export_");
  try {
    await Deno.writeTextFile(join(dir, "desktop.ts"), "throw new Error('must not run');\n");
    await Deno.mkdir(join(dir, "app"));
    await Deno.writeTextFile(join(dir, "app", "page.ts"), 'throw new Error("page boom");\n');
    const r = await withEnv(STOCK, () => runVerb(["run"], dir));
    assert(r.thrown instanceof Error);
    assertStringIncludes(r.thrown.message, "denext: desktop export failed — page boom");
    assertStringIncludes(r.out, "exporting SPA");
    assert(!r.out.includes("Opening desktop window"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop run / dev: a bad desktop.app config fails with the verb's prefix", async () => {
  const dir = await tempDir("denext_desktop_bad_origin_");
  try {
    await Deno.writeTextFile(join(dir, "desktop.ts"), "export {};\n");
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      'export default { desktop: { app: { origin: "not a url" } } };\n',
    );
    const run = await withEnv(STOCK, () => runVerb(["run"], dir));
    assertEquals(run.code, 1);
    assertStringIncludes(run.err, "denext desktop run: ");
    assertStringIncludes(run.err, "desktop.app.origin");
    const dev = await withEnv(STOCK, () => runVerb(["dev"], dir));
    assertEquals(dev.code, 1);
    assertStringIncludes(dev.err, "denext desktop dev: ");
    assertStringIncludes(dev.err, "desktop.app.origin");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop dev: needs an entry and a loopback target (or --lan)", async () => {
  const dir = await tempDir("denext_desktop_dev_");
  try {
    let r = await runVerb(["dev"], dir);
    assertEquals(r.code, 1);
    assertStringIncludes(r.err, `no desktop entry at ${join(dir, "desktop.ts")}`);
    await Deno.writeTextFile(join(dir, "main-window.ts"), "export {};\n");
    r = await runVerb(["dev"], dir, { entry: "main-window.ts", host: "192.168.1.20" });
    assertEquals(r.code, 1);
    assertStringIncludes(r.err, 'refusing a non-loopback dev server target "192.168.1.20"');
    r = await runVerb(["dev"], dir, { entry: "main-window.ts", lan: true, host: "10.0.0.2" });
    assertEquals(r.code, 1);
    assertStringIncludes(r.err, "--lan picks the address itself; drop --host");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop dev: a desktop.preload that does not bundle fails before the dev server starts", async () => {
  const dir = await tempDir("denext_desktop_dev_preload_");
  try {
    await Deno.writeTextFile(join(dir, "desktop.ts"), "export {};\n");
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      'export default { desktop: { preload: "./missing-preload.ts" } };\n',
    );
    const r = await withEnv(STOCK, () => runVerb(["dev"], dir, { port: 47_311 }));
    assertEquals(r.code, 1);
    assertStringIncludes(r.err, "denext desktop dev:");
    assertStringIncludes(r.err, "missing-preload.ts");
    assert(!r.out.includes("dev server"), "the dev server was never started");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop package runs the target's script with the re-exec guards cleared and its exit code", async () => {
  const dir = await tempDir("denext_desktop_pkg_run_");
  try {
    await Deno.mkdir(join(dir, "scripts"));
    // The script records what it saw, then exits 3 (the verb must exit with the script's code).
    await Deno.writeTextFile(
      join(dir, "scripts", "package-linux.ts"),
      `await Deno.writeTextFile(${JSON.stringify(join(dir, "seen.json"))}, JSON.stringify({
  css: Deno.env.get("DENEXT_CSS_ACTIVE") ?? null,
  module: Deno.env.get("DENEXT_MODULE_ACTIVE") ?? null,
  verify: Deno.env.get("DENEXT_DESKTOP_RUNTIME_VERIFY") ?? null,
  attest: Deno.env.get("DENEXT_DESKTOP_RUNTIME_ATTEST") ?? null,
  args: Deno.args,
}));
Deno.exit(3);
`,
    );
    const r = await withEnv({
      DENEXT_CSS_ACTIVE: "1",
      DENEXT_MODULE_ACTIVE: "1",
      DENEXT_DESKTOP_RUNTIME_VERIFY: undefined,
      DENEXT_DESKTOP_RUNTIME_ATTEST: undefined,
    }, () =>
      runVerb(["package"], dir, {
        "target-os": "LINUX",
        "verify-runtime": true,
        "attest-runtime": true,
      }, ["--appimage"]));
    assertEquals(r.code, 3, r.err);
    assertStringIncludes(r.out, "packaging (linux)");
    const seen = JSON.parse(await Deno.readTextFile(join(dir, "seen.json")));
    assertEquals(seen, { css: null, module: null, verify: "1", attest: "1", args: ["--appimage"] });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop package --target-os macos is refused off macOS", async () => {
  if (Deno.build.os === "darwin") return; // the guard only exists off macOS
  const dir = await tempDir("denext_desktop_pkg_mac_");
  try {
    const r = await runVerb(["package"], dir, { "target-os": "macos" });
    assertEquals(r.code, 1);
    assertStringIncludes(r.err, "macOS packaging must run on macOS");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop add --list is dispatched from the desktop verb", async () => {
  const dir = await tempDir("denext_desktop_add_");
  try {
    const r = await runVerb(["add"], dir, { list: true });
    assertEquals(r.code, 0, r.err);
    assertStringIncludes(r.out, "secure-store");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name:
    "desktop dev: attaches to a running dev server, opens the window in proxy mode, ends with it",
  // The session listens for Ctrl-C for its whole life; that listener outlives this test.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await tempDir("denext_desktop_dev_attach_");
    const ac = new AbortController();
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} },
      () => new Response("dev"),
    );
    try {
      // An entry `deno desktop` refuses at once (it type-checks first), so no window ever opens:
      // the session must still end when the window process does, leaving the attached server up.
      await Deno.writeTextFile(join(dir, "desktop.ts"), 'const n: number = "not a number";\n');
      const r = await withEnv(
        STOCK,
        () => runVerb(["dev"], dir, { host: "127.0.0.1", port: server.addr.port }),
      );
      assertEquals(r.code, 0, r.err);
      assertStringIncludes(r.out, `http://127.0.0.1:${server.addr.port}`);
      assertEquals(await (await fetch(`http://127.0.0.1:${server.addr.port}/`)).text(), "dev");
    } finally {
      ac.abort();
      await server.finished;
      await Deno.remove(dir, { recursive: true });
    }
  },
});

/** Run `desktop add …` with `--json` / `--cwd` as global flags (as the CLI parser sets them). */
async function runAdd(
  dir: string,
  caps: string[],
  flags: Record<string, boolean> = {},
  json = false,
): Promise<{ code: number; out: string; err: string }> {
  const cap = capture();
  const exit = stubExit();
  let code = 0;
  try {
    await desktopCommand.run(
      makeCtx({ positionals: ["add", ...caps], flags, global: { cwd: dir, json } }),
    );
  } catch (e) {
    if (!String(e).includes("__exit__")) throw e;
    code = exit.calls[0];
  } finally {
    exit.restore();
    cap.restore();
  }
  return { code, out: cap.logs.join("\n"), err: cap.errs.join("\n") };
}

Deno.test("desktop add: --dry-run prints the diff and permissions, writes nothing; then it writes", async () => {
  const dir = await tempDir("denext_desktop_add_dry_");
  try {
    const dry = await runAdd(dir, ["clipboard"], { "dry-run": true });
    assertEquals(dry.code, 0, dry.err);
    assertStringIncludes(dry.out, "--dry-run (nothing changed)");
    assertStringIncludes(dry.out, "clipboard");
    assertEquals(await exists(join(dir, "denext.config.ts")), false);
    const real = await runAdd(dir, ["clipboard"]);
    assertEquals(real.code, 0, real.err);
    assertStringIncludes(await Deno.readTextFile(join(dir, "denext.config.ts")), "clipboard");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop add: --json reports the result; --list --json is the catalog; a bad name exits 1", async () => {
  const dir = await tempDir("denext_desktop_add_json_");
  try {
    const json = await runAdd(dir, ["device"], { "dry-run": true }, true);
    assertEquals(json.code, 0, json.err);
    const report = JSON.parse(json.out);
    assert(Array.isArray(report.added) && report.added.length === 1, json.out);
    const list = await runAdd(dir, [], { list: true }, true);
    const catalog = JSON.parse(list.out);
    assertEquals(catalog["secure-store"].key, "secureStore");
    const bad = await runAdd(dir, ["teleport"]);
    assertEquals(bad.code, 1);
    assertStringIncludes(bad.err, "denext desktop add: ");
    assertStringIncludes(bad.err, "teleport");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
