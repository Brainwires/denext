// `--help` placement, the verbs help lists, and the footer's directory. A help flag BEFORE the verb used to
// be dropped with everything else ahead of the verb — so `denext --help build` RAN build —
// and a bare directory after `--help` was read as an unknown verb. The parser now resolves
// both to help, skips a valued global flag's value when finding the verb, and the CLI picks
// the footer's directory from `--cwd`, else the non-verb token, else the process cwd.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { buildRegistry } from "../src/cli/register.ts";

const CLI = fromFileUrl(new URL("../cli.ts", import.meta.url));
const DENO_JSON = fromFileUrl(new URL("../deno.json", import.meta.url));
const FOOTER = "Project verbs: run `denext commands`";

/** The command name a help outcome targets (`undefined` for top-level help). */
function helpTarget(argv: string[]): string | undefined {
  const out = buildRegistry().parse(argv);
  assertEquals(out.kind, "help", `${argv.join(" ")} should be help, got ${out.kind}`);
  return out.kind === "help" ? out.command?.name : undefined;
}

Deno.test("--help / -h before a verb is that verb's help (it never runs it)", () => {
  assertEquals(helpTarget(["--help", "build"]), "build");
  assertEquals(helpTarget(["-h", "build"]), "build");
  assertEquals(helpTarget(["--help", "probe"]), "doctor", "an alias resolves to its verb");
});

Deno.test("--help after the verb is unchanged", () => {
  assertEquals(helpTarget(["build", "--help"]), "build");
  assertEquals(helpTarget(["build", "-h"]), "build");
  assertEquals(helpTarget(["help", "build"]), "build");
});

Deno.test("--help with a non-verb token (a directory) is top-level help, not an error", () => {
  assertEquals(helpTarget(["--help", "./app"]), undefined);
  assertEquals(helpTarget(["-h", "/tmp/some/project"]), undefined);
  assertEquals(helpTarget(["--help"]), undefined);
});

Deno.test("a valued global flag's value is not mistaken for the verb", () => {
  assertEquals(helpTarget(["--cwd", "./app", "--help"]), undefined);
  assertEquals(helpTarget(["--cwd=./app", "--help"]), undefined);
  assertEquals(helpTarget(["--config", "x.json", "--help", "dev"]), "dev");
  assertEquals(helpTarget(["help", "--cwd", "./app", "build"]), "build");
});

Deno.test("a global flag before the verb reaches the command", () => {
  const out = buildRegistry().parse(["--cwd", "./app", "--json", "info"]);
  assert(out.kind === "run", `expected run, got ${out.kind}`);
  assertEquals(out.command.name, "info");
  assertEquals(out.ctx.global.cwd, "./app");
  assertEquals(out.ctx.global.json, true);
  assertEquals(out.ctx.positionals, [], "the --cwd value is not a positional");
});

Deno.test("an unknown verb with no help flag still errors with a suggestion", () => {
  const out = buildRegistry().parse(["buidl"]);
  assert(out.kind === "error", `expected error, got ${out.kind}`);
  assertStringIncludes(out.message, 'unknown command "buidl"');
  assertEquals(out.suggestion, "denext build");
});

Deno.test("--version / -v still print the version, before a verb too", () => {
  const reg = buildRegistry();
  assertEquals(reg.parse(["--version"]).kind, "version");
  assertEquals(reg.parse(["-v"]).kind, "version");
  assertEquals(reg.parse(["version"]).kind, "version");
  assertEquals(reg.parse(["-v", "build"]).kind, "version");
});

// --- through the real binary --------------------------------------------------------

/** Run the CLI (against the framework's deno.json) and capture exit code + streams. */
async function runCli(
  args: string[],
  cwd?: string,
): Promise<{ code: number; out: string; err: string }> {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", DENO_JSON, CLI, ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return { code, out: decoder.decode(stdout), err: decoder.decode(stderr) };
}

/** Two throwaway dirs: a denext project (has denext.config.ts) and a plain directory. */
async function withDirs(
  fn: (dirs: { project: string; plain: string }) => Promise<void>,
): Promise<void> {
  const project = await Deno.makeTempDir({ prefix: "denext_help_project_" });
  const plain = await Deno.makeTempDir({ prefix: "denext_help_plain_" });
  try {
    await Deno.writeTextFile(join(project, "deno.json"), "{}");
    await Deno.writeTextFile(join(project, "denext.config.ts"), "export default {};\n");
    await fn({ project, plain });
  } finally {
    await Deno.remove(project, { recursive: true });
    await Deno.remove(plain, { recursive: true });
  }
}

Deno.test("`denext --help <dir>` prints top-level help, footer only for a project", async () => {
  await withDirs(async ({ project, plain }) => {
    const inProject = await runCli(["--help", project]);
    assertEquals(inProject.code, 0, inProject.err);
    assertStringIncludes(inProject.out, "Usage: denext <command> [options]");
    assertStringIncludes(inProject.out, FOOTER);
    // The positional wins over the process cwd: a plain dir named from inside a project.
    const notProject = await runCli(["--help", plain], project);
    assertEquals(notProject.code, 0, notProject.err);
    assertStringIncludes(notProject.out, "Usage: denext <command> [options]");
    assert(!notProject.out.includes(FOOTER), "a plain directory gets no project footer");
  });
});

Deno.test("`denext --cwd <dir> --help` and `--cwd=<dir> -h` read that directory", async () => {
  await withDirs(async ({ project }) => {
    for (const args of [["--cwd", project, "--help"], [`--cwd=${project}`, "-h"]]) {
      const res = await runCli(args);
      assertEquals(res.code, 0, res.err);
      assertStringIncludes(res.out, "Usage: denext <command> [options]");
      assertStringIncludes(res.out, FOOTER);
    }
  });
});

Deno.test("`denext --help build` prints build's help and does not build", async () => {
  await withDirs(async ({ project }) => {
    const res = await runCli(["--help", "build", "--cwd", project], project);
    assertEquals(res.code, 0, res.err);
    assertStringIncludes(res.out, "denext build — Build for production");
    assert(!res.out.includes(FOOTER), "a verb's own help carries no project footer");
    for (const artifact of [".denext", "out", "dist"]) {
      const made = await Deno.stat(join(project, artifact)).then(() => true, () => false);
      assert(!made, `--help must not build (found ${artifact}/)`);
    }
  });
});

Deno.test("an unknown verb still exits 1 with a did-you-mean", async () => {
  await withDirs(async ({ plain }) => {
    const res = await runCli(["buidl"], plain);
    assertEquals(res.code, 1);
    assertStringIncludes(res.err, 'unknown command "buidl"');
    assertStringIncludes(res.err, "Did you mean `denext build`?");
  });
});

Deno.test("--help lists the verbs the last `denext commands` run found, while they hold", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_help_verbs_" });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      'export default { commands: [{ name: "seed", summary: "Load fixtures", run: () => {} }] };\n',
    );
    // Before any discovery, help points at the verb that does it.
    const cold = await runCli(["--help", dir]);
    assertStringIncludes(cold.out, FOOTER);
    assert(!cold.out.includes("Load fixtures"), "nothing is listed before a discovery");

    const listed = await runCli(["commands", "--cwd", dir]);
    assertEquals(listed.code, 0, listed.err);
    const cache = JSON.parse(await Deno.readTextFile(join(dir, ".denext", "commands.json")));
    assertEquals(cache.verbs, [{ name: "seed", summary: "Load fixtures" }]);

    const warm = await runCli(["--help", dir]);
    assertEquals(warm.code, 0, warm.err);
    assertStringIncludes(warm.out, "Project commands:");
    assertStringIncludes(warm.out, "seed");
    assertStringIncludes(warm.out, "Load fixtures");
    assertStringIncludes(warm.out, "what `denext commands` last found here");

    // A change to a file the verb set depends on makes the listing untrustworthy again.
    await Deno.writeTextFile(join(dir, "deno.json"), '{ "tasks": {} }');
    const stale = await runCli(["--help", dir]);
    assert(!stale.out.includes("Load fixtures"), "a stale listing is not printed");
    assertStringIncludes(stale.out, FOOTER);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a project verb never shadows a built-in in the help table", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_help_shadow_" });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      'export default { commands: [{ name: "dev", summary: "Mine", run: () => {} }] };\n',
    );
    await runCli(["commands", "--cwd", dir]);
    const res = await runCli(["--help", dir]);
    assert(!res.out.includes("Mine"), "a built-in's name is never listed as a project verb");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
