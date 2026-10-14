// `denext <deno verb>` and `denext <script>`: every Deno verb denext does not own runs on denext's
// Deno exactly like `denext deno <verb>`, a script runs as `deno run`, a listed project verb shadows
// a Deno verb (with a notice), and an unknown verb keeps its did-you-mean — now over Deno's verbs
// too. Unit tests over the pure pieces, then the real CLI as a subprocess.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { buildRegistry } from "../src/cli/register.ts";
import { denoForwardFor, denoVerbArgs, verbatimFrom } from "../src/cli/deno-forward.ts";
import {
  DENO_VERBS,
  forwardedDenoVerbs,
  isDenoVerb,
  isForwardableDenoVerb,
  isScriptTarget,
  shadowNotice,
} from "../src/cli/deno-verbs.ts";
import { denoPathEnv } from "../src/cli/deno-path.ts";
import { makeCompletionsCommand } from "../src/cli/commands/completions.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const CLI = join(ROOT, "cli.ts");
const DENO_JSON = join(ROOT, "deno.json");

// --- the verb list and the script rule ------------------------------------------------------

Deno.test("Deno verbs: every name is Deno's; help is never forwarded", () => {
  assert(isDenoVerb("compile") && isDenoVerb("help") && isDenoVerb("x"));
  assert(!isDenoVerb("dev") && !isDenoVerb("job"));
  assert(isForwardableDenoVerb("compile"));
  assert(!isForwardableDenoVerb("help"));
  const forwarded = forwardedDenoVerbs((name) => name === "test").map((v) => v.name);
  assert(!forwarded.includes("test") && !forwarded.includes("help"));
  assert(forwarded.includes("compile") && forwarded.includes("bench") && forwarded.includes("run"));
  assertEquals(new Set(DENO_VERBS.map((v) => v.name)).size, DENO_VERBS.length);
});

Deno.test("isScriptTarget: script extensions, URLs and existing path-shaped files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_script_target_" });
  try {
    await Deno.writeTextFile(join(dir, "tool"), "#!/usr/bin/env -S deno run\n");
    await Deno.mkdir(join(dir, "app"));
    for (const yes of ["main.ts", "a/b.tsx", "x.mjs", "y.cjs", "z.mts", "w.jsx", "v.js"]) {
      assert(isScriptTarget(yes, dir), yes);
    }
    for (const url of ["https://deno.land/x.ts", "jsr:@std/http/file-server", "npm:cowsay"]) {
      assert(isScriptTarget(url, dir), url);
    }
    assert(isScriptTarget("./tool", dir), "an existing path-shaped file");
    assert(isScriptTarget(join(dir, "tool"), dir), "an absolute existing file");
    assert(!isScriptTarget("./app", dir), "a directory is not a script");
    assert(!isScriptTarget("./missing", dir), "a missing extensionless path is not a script");
    assert(!isScriptTarget("tool", dir), "a bare word is a verb, never a script");
    assert(!isScriptTarget("buidl", dir));
    assert(!isScriptTarget("--flag.ts", dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denoForwardFor: Deno verbs verbatim, scripts as run, --cwd applied, others null", () => {
  const cwd = "/work";
  assertEquals(
    denoForwardFor(["compile", "--output", "x", "--config", "c.json", "main.ts"], {
      name: "compile",
      index: 0,
    }, cwd),
    { args: ["compile", "--output", "x", "--config", "c.json", "main.ts"], cwd },
  );
  assertEquals(
    denoForwardFor(["--cwd", "app", "-q", "bench", "--json"], { name: "bench", index: 3 }, cwd),
    { args: ["bench", "-q", "--json"], cwd: join(cwd, "app") },
  );
  assertEquals(
    denoForwardFor(["main.ts", "--port", "1"], { name: "main.ts", index: 0 }, cwd),
    { args: ["run", "main.ts", "--port", "1"], cwd },
  );
  assertEquals(denoForwardFor(["help"], { name: "help", index: 0 }, cwd), null);
  assertEquals(denoForwardFor(["buidl"], { name: "buidl", index: 0 }, cwd), null);
  assertEquals(
    verbatimFrom(["--cwd=sub", "task", "build", "--quiet"], 1, cwd),
    { args: ["task", "build", "--quiet"], cwd: join(cwd, "sub") },
  );
});

Deno.test("leading global flags land after the Deno subcommand, where Deno accepts them", () => {
  const cwd = "/work";
  const script = (argv: string[], index: number) =>
    denoForwardFor(argv, { name: argv[index], index }, cwd)?.args;
  // `deno --config x task p` is an error; `deno task --config x p` is not.
  assertEquals(verbatimFrom(["--config", "deno.json", "task", "p"], 2, cwd).args, [
    "task",
    "--config",
    "deno.json",
    "p",
  ]);
  assertEquals(verbatimFrom(["--config=deno.json", "task", "p"], 1, cwd).args, [
    "task",
    "--config=deno.json",
    "p",
  ]);
  // `--verbose` is denext's alone.
  assertEquals(verbatimFrom(["--verbose", "task", "p"], 1, cwd).args, ["task", "p"]);
  // A script: run flags and --config go after `run`; `deno run` has no --json.
  assertEquals(script(["--json", "m.ts"], 1), ["run", "m.ts"]);
  assertEquals(script(["-A", "m.ts"], 1), ["run", "-A", "m.ts"]);
  assertEquals(script(["--config", "deno.json", "m.ts", "x"], 2), [
    "run",
    "--config",
    "deno.json",
    "m.ts",
    "x",
  ]);
  assertEquals(script(["--verbose", "-q", "m.ts"], 2), ["run", "-q", "m.ts"]);
  // A Deno verb: same rule, --json kept (`denext --json lint` → `deno lint --json`).
  assertEquals(
    denoForwardFor(["--json", "--verbose", "outdated"], { name: "outdated", index: 2 }, cwd)?.args,
    ["outdated", "--json"],
  );
});

Deno.test("denoVerbArgs: `denext [globals] deno …` is verbatim after `deno`", () => {
  const cwd = "/work";
  assertEquals(denoVerbArgs(["--cwd", "app", "deno", "fmt", "--quiet"], 2, cwd), {
    args: ["fmt", "--quiet"],
    cwd: join(cwd, "app"),
  });
  assertEquals(denoVerbArgs(["deno", "--config", "c.json", "check"], 0, cwd).args, [
    "--config",
    "c.json",
    "check",
  ]);
  assertEquals(denoVerbArgs(["--config", "c.json", "deno", "check", "x.ts"], 2, cwd).args, [
    "check",
    "--config",
    "c.json",
    "x.ts",
  ]);
  assertEquals(denoVerbArgs(["-q", "deno", "--version"], 1, cwd).args, ["--version", "-q"]);
});

// --- the registry: did-you-mean, help, completions ------------------------------------------

Deno.test("an unknown verb names itself and suggests over denext + Deno verbs", () => {
  const reg = buildRegistry();
  const out = reg.parse(["--cwd", "x", "compil"], DENO_VERBS.map((v) => v.name));
  assert(out.kind === "error");
  assertEquals(out.unknownVerb, { name: "compil", index: 2 });
  assertEquals(out.suggestion, "denext compile");
  const near = reg.parse(["buidl"], DENO_VERBS.map((v) => v.name));
  assert(near.kind === "error");
  assertEquals(near.suggestion, "denext build");
});

Deno.test("help lists forwarded Deno verbs in their own section, minus claimed names", () => {
  const reg = buildRegistry();
  const forwarded = forwardedDenoVerbs((name) => reg.get(name) !== undefined).map((v) => v.name);
  const help = reg.formatHelp("0.0.0", [{ name: "bench", summary: "Project bench" }], forwarded);
  const section = help.slice(help.indexOf("Deno commands"));
  assertStringIncludes(section, "compile");
  assertStringIncludes(section, "denext deno <command>");
  // A denext built-in and a project verb are not Deno's here.
  assert(!/\btest\b,?/.test(section.split("\n")[1] ?? ""), "test is denext's");
  assert(!section.includes(" bench"), "the project's bench shadows Deno's");
  assertStringIncludes(help, "Project bench");
  // Without forwarded verbs the section is absent.
  assert(!reg.formatHelp("0.0.0").includes("Deno commands"));
});

Deno.test("completions offer the forwarded Deno verbs once, after denext's", async () => {
  const reg = buildRegistry();
  const completions = makeCompletionsCommand(reg);
  for (const shell of ["bash", "zsh", "fish"]) {
    const cap = capture();
    const exit = stubExit();
    try {
      await completions.run(makeCtx({ positionals: [shell] }));
    } catch (e) {
      assertStringIncludes(String(e), "__exit__0");
    } finally {
      exit.restore();
      cap.restore();
    }
    const script = cap.logs.join("\n");
    assertStringIncludes(script, "compile");
    assertStringIncludes(script, "bench");
    if (shell === "bash") {
      const words = script.match(/compgen -W "([^"]*)"/)?.[1].split(" ") ?? [];
      assertEquals(words.filter((w) => w === "test").length, 1, "test is listed once");
      assert(words.includes("x") && words.includes("job") && !words.includes("help"));
    }
    if (shell === "zsh") assertStringIncludes(script, "'compile:deno compile: Compile");
  }
});

Deno.test("shadowNotice names the verb and how to reach Deno's", () => {
  const notice = shadowNotice("compile");
  assertStringIncludes(notice, '"compile"');
  assertStringIncludes(notice, "`denext deno compile`");
  assert(!notice.includes("\n"), "one line");
});

// --- the PATH shim --------------------------------------------------------------------------

Deno.test("denoPathEnv: only denext's toolchain directory is put first as it is", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext_path_rule_" });
  try {
    const exe = Deno.build.os === "windows" ? "deno.exe" : "deno";
    const delimiter = Deno.build.os === "windows" ? ";" : ":";
    const cacheRoot = join(root, "denext-deno");
    const toolchainDir = join(cacheRoot, "2.9.7-denext.15", "target");
    await Deno.mkdir(toolchainDir, { recursive: true });
    await Deno.writeTextFile(join(toolchainDir, exe), "toolchain");
    // A stock Deno in a directory full of other tools (`/usr/bin`, `~/.deno/bin`).
    const stockDir = join(root, "bin");
    await Deno.mkdir(stockDir);
    await Deno.writeTextFile(join(stockDir, exe), "stock");
    await Deno.writeTextFile(join(stockDir, "node"), "node");
    const userPath = [join(root, "nvm"), join(root, "usr")].join(delimiter);
    const env = (name: string) => (name === "PATH" ? userPath : undefined);
    const opts = { env, cacheRoot };

    // The toolchain binary: its own cache directory goes first.
    assertEquals(await denoPathEnv(join(toolchainDir, exe), opts), {
      PATH: `${toolchainDir}${delimiter}${userPath}`,
    });
    // Stock Deno: never its directory (that would put its `node` ahead of nvm's) — a shim.
    const stock = await denoPathEnv(join(stockDir, exe), opts);
    const first = stock.PATH.split(delimiter)[0];
    assert(first !== stockDir, "the stock directory is not prepended");
    assert(first.startsWith(join(cacheRoot, "path-shims")), first);
    assertEquals(stock.PATH.slice(first.length + 1), userPath, "the rest of PATH is unchanged");
    assertEquals(await Deno.readTextFile(join(first, exe)), "stock");
    // Already what PATH resolves `deno` to: nothing changes at all.
    const already = (
      name: string,
    ) => (name === "PATH" ? `${stockDir}${delimiter}${userPath}` : undefined);
    assertEquals(await denoPathEnv(join(stockDir, exe), { env: already, cacheRoot }), {});
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("denoPathEnv: a bare or foreign path is left alone", async () => {
  const env = (name: string) => (name === "PATH" ? "/usr/bin:/bin" : undefined);
  if (Deno.build.os !== "windows") {
    assertEquals(
      await denoPathEnv("C:\\deno\\deno.exe", { env: () => "C:\\Windows", os: "windows" }),
      {},
      "a path that is not absolute on this host is left alone",
    );
  }
  assertEquals(await denoPathEnv("deno", { env, os: "linux" }), {}, "a bare name is the PATH");
});

Deno.test("denoPathEnv: a renamed binary gets a shim directory whose deno is it", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext_path_shim_" });
  try {
    const target = join(root, "deno-2.9.7");
    await Deno.writeTextFile(target, "binary");
    const env = (name: string) => (name === "PATH" ? "/usr/bin" : undefined);
    const exe = Deno.build.os === "windows" ? "deno.exe" : "deno";
    const shimRoot = join(root, "shims");
    const first = await denoPathEnv(target, { env, shimRoot });
    const delimiter = Deno.build.os === "windows" ? ";" : ":";
    const [dir, rest] = first.PATH.split(delimiter);
    assertEquals(rest, "/usr/bin");
    assert(dir.startsWith(shimRoot), dir);
    assertEquals(await Deno.readTextFile(join(dir, exe)), "binary");
    // Idempotent: the second call keeps the same directory.
    assertEquals(await denoPathEnv(target, { env, shimRoot }), first);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- through the real CLI -------------------------------------------------------------------

/** Run the CLI as a subprocess; `env` is added to this process's environment. */
async function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", DENO_JSON, CLI, ...args],
    cwd,
    env: { DENEXT_DENO: "stock", NO_COLOR: "1", ...env },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return { code, out: decoder.decode(stdout), err: decoder.decode(stderr) };
}

Deno.test("`denext eval …` runs Deno's eval, exit code passed through", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_forward_" });
  try {
    const ok = await runCli(["eval", "console.log(6 * 7)"], dir);
    assertEquals(ok.code, 0, ok.err);
    assertEquals(ok.out.trim(), "42");
    const failed = await runCli(["eval", "Deno.exit(7)"], dir);
    assertEquals(failed.code, 7);
    const sub = join(dir, "sub");
    await Deno.mkdir(sub);
    const moved = await runCli(["--cwd", "sub", "eval", "console.log(Deno.cwd())"], dir);
    assertEquals(moved.code, 0, moved.err);
    assertEquals(await Deno.realPath(moved.out.trim()), await Deno.realPath(sub));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("`denext main.ts a b` is `deno run main.ts a b`", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_script_" });
  try {
    await Deno.writeTextFile(join(dir, "main.ts"), "console.log(JSON.stringify(Deno.args));\n");
    const res = await runCli(["main.ts", "a", "--b"], dir);
    assertEquals(res.code, 0, res.err);
    assertEquals(res.out.trim(), '["a","--b"]');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a version or help flag before `task` / `deno` is denext's", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_version_" });
  try {
    const version = await runCli(["--version", "task"], dir);
    assertEquals(version.code, 0, version.err);
    assert(version.out.startsWith("denext "), version.out);
    const help = await runCli(["--help", "deno"], dir);
    assertEquals(help.code, 0, help.err);
    assertStringIncludes(help.out, "denext deno");
    // After leading globals, `deno` still takes every token verbatim.
    const quiet = await runCli(["--cwd", ".", "deno", "eval", "--quiet", "console.log(5)"], dir);
    assertEquals(quiet.code, 0, quiet.err);
    assertEquals(quiet.out.trim(), "5");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a typo is never run: did-you-mean over denext and Deno verbs", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_typo_" });
  try {
    const res = await runCli(["compil", "x.ts"], dir);
    assertEquals(res.code, 1);
    assertStringIncludes(res.err, 'unknown command "compil"');
    assertStringIncludes(res.err, "Did you mean `denext compile`?");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a listed project verb shadows a Deno verb, with one notice on stderr", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_shadow_" });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      'export default { commands: [{ name: "bench", summary: "Mine", ' +
        'run: () => console.log("project bench") }] };\n',
    );
    // Not yet listed by `denext commands`: Deno's bench runs, the config is never imported.
    const unlisted = await runCli(["bench"], dir);
    assert(!unlisted.out.includes("project bench"), unlisted.out);
    assertStringIncludes(unlisted.err, "`denext commands`");
    assertEquals((await runCli(["commands", "--timeout", "30000"], dir)).code, 0);
    const res = await runCli(["bench"], dir);
    assertEquals(res.code, 0, res.err);
    assertEquals(res.out.trim(), "project bench");
    const notices = res.err.split("\n").filter((line) => line.includes("shadows Deno's"));
    assertEquals(notices.length, 1, res.err);
    assertStringIncludes(notices[0], "`denext deno bench`");
    // Once per state of the project's config files, not on every run.
    const again = await runCli(["bench"], dir);
    assertEquals(again.code, 0, again.err);
    assert(!again.err.includes("shadows Deno's"), again.err);
    // A changed config file makes the listing stale: Deno's again until it is re-listed.
    await Deno.writeTextFile(join(dir, "deno.json"), '{ "tasks": {} }');
    const stale = await runCli(["bench"], dir);
    assert(!stale.out.includes("project bench"), stale.out);
    assertEquals((await runCli(["commands", "--timeout", "30000"], dir)).code, 0);
    const changed = await runCli(["bench"], dir);
    assertEquals(changed.out.trim(), "project bench");
    assertStringIncludes(changed.err, "shadows Deno's");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "`denext task` is deno task; every deno inside it is the Deno denext chose",
  // The fixture symlinks the Deno binary, which Windows allows only with a privilege.
  ignore: Deno.build.os === "windows",
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_task_" });
  try {
    // A binary not named `deno` (as a DENEXT_DENO override may be), with no `deno` on the user's
    // PATH, gets a PATH shim, so a process the task starts that looks `deno` up finds it.
    const renamed = join(dir, "bin", "deno-denext");
    await Deno.mkdir(dirname(renamed));
    await Deno.symlink(Deno.execPath(), renamed);
    const probe = 'const sep = Deno.build.os === "windows" ? ";" : ":"; ' +
      'const dirs = (Deno.env.get("PATH") ?? "").split(sep); ' +
      'const hit = dirs.map((d) => d + "/deno").find((f) => { try { return Deno.statSync(f).isFile; } catch { return false; } }); ' +
      'console.log(hit ? Deno.realPathSync(hit) : "none"); ' +
      "console.log(Deno.args.join(' '))";
    await Deno.writeTextFile(join(dir, "probe.ts"), probe);
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ tasks: { probe: "deno run -A probe.ts" } }),
    );
    const res = await runCli(["task", "probe", "--quiet", "x"], dir, {
      DENEXT_DENO: renamed,
      PATH: "/usr/bin:/bin",
    });
    assertEquals(res.code, 0, res.err);
    const [found, args] = res.out.trim().split("\n").slice(-2);
    // The task's own arguments arrive verbatim — `--quiet` included.
    assertEquals(args, "--quiet x");
    // A `deno` looked up on PATH inside the task is the binary denext chose.
    assertEquals(found, await Deno.realPath(Deno.execPath()));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- the merged verbs: info, the wrappers' global flags, `--` -------------------------------

Deno.test("info: no argument or a directory is denext's facts; a module is Deno's info", async () => {
  const { infoCommand } = await import("../src/cli/commands/doctor.ts");
  const dir = await Deno.makeTempDir({ prefix: "denext_info_" });
  try {
    await Deno.writeTextFile(join(dir, "mod.ts"), "export const x = 1;\n");
    const facts = capture();
    try {
      await infoCommand.run(makeCtx({ rest: [dir], global: { json: true } }));
    } finally {
      facts.restore();
    }
    assertEquals(JSON.parse(facts.logs.join("\n")).projectDir, dir);

    // A module goes to `deno info` (stdout inherited), which exits 0 for a local file.
    const exit = stubExit();
    try {
      await infoCommand.run(makeCtx({ rest: ["mod.ts"], global: { cwd: dir } }));
    } catch (e) {
      assertStringIncludes(String(e), "__exit__0");
    } finally {
      exit.restore();
    }
    assertEquals(exit.calls, [0]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denoGlobalArgs hands back the global flags Deno also has", async () => {
  const { denoGlobalArgs } = await import("../src/cli/shared.ts");
  const ctx = makeCtx({ global: { config: "deno.jsonc", quiet: true, json: true, verbose: true } });
  assertEquals(denoGlobalArgs(ctx), ["--config", "deno.jsonc", "--quiet"]);
  assertEquals(denoGlobalArgs(ctx, { json: true }), [
    "--config",
    "deno.jsonc",
    "--quiet",
    "--json",
  ]);
});

Deno.test("a forwarding verb keeps `--` so script arguments stay the script's", () => {
  const out = buildRegistry().parse(["test", "a.test.ts", "--", "--seed", "1"]);
  assert(out.kind === "run");
  assertEquals(out.ctx.rest, ["a.test.ts", "--", "--seed", "1"]);
  const dev = buildRegistry().parse(["routes", ".", "--", "x"]);
  assert(dev.kind === "run");
  assertEquals(dev.ctx.rest, ["x"], "a non-forwarding verb still drops it");
});

Deno.test("real verbs: a leading -- (a task runner's) is ignored unless the verb forwards", () => {
  const reg = buildRegistry();
  for (
    const [argv, flag, value] of [
      [["start", "--", "--port", "4000"], "port", 4000],
      [["dev", "--", "--port", "4100", "--host", "0.0.0.0"], "host", "0.0.0.0"],
      [["build", "--", "--json"], "json", true],
      [["routes", "--", "--json"], "json", true],
    ] as const
  ) {
    const out = reg.parse([...argv]);
    assert(out.kind === "run", argv.join(" "));
    assertEquals(out.ctx.flags[flag], value, argv.join(" "));
    assertEquals(out.ctx.rest, [], argv.join(" "));
  }
  // Forwarding verbs keep today's meaning: the separator goes to Deno.
  for (const verb of ["test", "task", "fmt"]) {
    const out = reg.parse([verb, "--", "--seed", "1"]);
    assert(out.kind === "run", verb);
    assertEquals(out.ctx.rest, ["--", "--seed", "1"], verb);
  }
});

Deno.test("a relative DENEXT_DENO resolves against the starting directory", async () => {
  const { resolveDenoToolchain } = await import("../src/build/deno-toolchain.ts");
  const { relative } = await import("@std/path");
  const dir = await Deno.makeTempDir({ prefix: "denext_rel_deno_" });
  try {
    const bin = join(dir, "deno-custom");
    await Deno.writeTextFile(bin, "");
    const rel = relative(Deno.cwd(), bin);
    const choice = await resolveDenoToolchain({
      env: (name) => (name === "DENEXT_DENO" ? rel : undefined),
    });
    assert(choice.kind === "toolchain", JSON.stringify(choice));
    assertEquals(choice.deno, bin, "an absolute path, so a child in another cwd still finds it");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
