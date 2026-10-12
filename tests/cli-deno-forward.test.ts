// `denext <deno verb>` and `denext <script>`: every Deno verb denext does not own runs on denext's
// Deno exactly like `denext deno <verb>`, a script runs as `deno run`, a project verb shadows a
// Deno verb (with a notice), and an unknown verb keeps its did-you-mean — now over Deno's verbs
// too. Unit tests over the pure pieces, then the real CLI as a subprocess.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { buildRegistry } from "../src/cli/register.ts";
import { denoForwardFor, verbatimFrom } from "../src/cli/deno-forward.ts";
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
    { args: ["-q", "bench", "--json"], cwd: join(cwd, "app") },
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

Deno.test("denoPathEnv: a binary named deno puts its own directory first", async () => {
  const env = (name: string) => (name === "PATH" ? "/usr/bin:/bin" : undefined);
  assertEquals(await denoPathEnv("/opt/denext/2.9.7/deno", { env, os: "linux" }), {
    PATH: "/opt/denext/2.9.7:/usr/bin:/bin",
  });
  assertEquals(
    await denoPathEnv("C:\\deno\\deno.exe", { env: () => "C:\\Windows", os: "windows" }),
    {},
    "a non-absolute path on this host is left alone",
  );
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

Deno.test("a project verb shadows a Deno verb, with one notice on stderr", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_shadow_" });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      'export default { commands: [{ name: "bench", summary: "Mine", ' +
        'run: () => console.log("project bench") }] };\n',
    );
    const res = await runCli(["bench"], dir);
    assertEquals(res.code, 0, res.err);
    assertEquals(res.out.trim(), "project bench");
    const notices = res.err.split("\n").filter((line) => line.includes("shadows Deno's"));
    assertEquals(notices.length, 1, res.err);
    assertStringIncludes(notices[0], "`denext deno bench`");
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
    // A binary not named `deno` (as a DENEXT_DENO override may be) gets a PATH shim, so a process
    // the task starts that looks `deno` up on PATH finds it.
    const renamed = join(dir, "bin", "deno-denext");
    await Deno.mkdir(dirname(renamed));
    await Deno.symlink(Deno.execPath(), renamed);
    const probe = 'const p = Deno.env.get("PATH") ?? ""; ' +
      'console.log(p.split(Deno.build.os === "windows" ? ";" : ":")[0]); ' +
      "console.log(Deno.args.join(' '))";
    await Deno.writeTextFile(join(dir, "probe.ts"), probe);
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ tasks: { probe: "deno run -A probe.ts" } }),
    );
    const res = await runCli(["task", "probe", "--quiet", "x"], dir, { DENEXT_DENO: renamed });
    assertEquals(res.code, 0, res.err);
    const [first, args] = res.out.trim().split("\n").slice(-2);
    // The task's own arguments arrive verbatim — `--quiet` included.
    assertEquals(args, "--quiet x");
    const shimmed = join(first, "deno");
    assertEquals(await Deno.realPath(shimmed), await Deno.realPath(Deno.execPath()));
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
  const dev = buildRegistry().parse(["routes", "--", "x"]);
  assert(dev.kind === "run");
  assertEquals(dev.ctx.rest, ["x"], "a non-forwarding verb still drops it");
});
