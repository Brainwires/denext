// Proves the two project-verb seams end-to-end, through the real `denext` binary:
// a plugin's `addCommand` (discovered when the first parse hits an unknown command)
// and the `commands:` shorthand in denext.config.ts (no plugin at all). Also where each
// listing stands on discovery: `denext commands` and `completions` enumerate project verbs
// (so they are discoverable, not just dispatchable), while `--help` deliberately imports
// nothing and points at `denext commands` instead.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { join } from "@std/path";

const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));

/** Run the CLI with `args` and capture its exit code and streams. */
async function runCli(
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", CLI, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return { code, out: decoder.decode(stdout), err: decoder.decode(stderr) };
}

/** A throwaway project dir; `config` (when given) becomes its denext.config.ts. */
async function project(prefix: string, config?: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix });
  await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({}));
  if (config) await Deno.writeTextFile(join(dir, "denext.config.ts"), config);
  return dir;
}

// A plugin whose setup contributes a `greet` verb. No denext import needed — the
// plugin shape is just { name, setup }, and the command is a CommandSpec.
const PLUGIN_CONFIG = `export default {
  plugins: [{
    name: "demo-plugin",
    setup(ctx) {
      ctx.addCommand({
        name: "greet",
        summary: "demo plugin verb",
        run: (c) => console.log("GREET_OK:" + (c.positionals[0] ?? "world")),
      });
    },
  }],
};
`;

// The shorthand: a verb declared straight in the config, with NO plugin.
const COMMANDS_CONFIG = `export default {
  commands: [{
    name: "seed",
    summary: "load fixture data",
    run: (c) => console.log("SEED_OK:" + (c.positionals[0] ?? "all")),
  }],
};
`;

Deno.test("a plugin-contributed CLI verb is discovered and dispatched", async () => {
  const dir = await project("denext_plugin_cmd_", PLUGIN_CONFIG);
  try {
    const { code, out, err } = await runCli(["greet", "denext", "--cwd", dir]);
    assert(code === 0, `expected exit 0, got ${code}. stderr:\n${err}`);
    assertStringIncludes(out, "GREET_OK:denext");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an unknown verb with no plugin still errors cleanly", async () => {
  const dir = await project("denext_plugin_none_");
  try {
    const { code, err } = await runCli(["notacommand", "--cwd", dir]);
    assert(code === 1, `expected exit 1, got ${code}`);
    assertStringIncludes(err, "unknown command");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a `commands:` verb dispatches with no plugin at all", async () => {
  const dir = await project("denext_config_cmd_", COMMANDS_CONFIG);
  try {
    const { code, out, err } = await runCli(["seed", "posts", "--cwd", dir]);
    assert(code === 0, `expected exit 0, got ${code}. stderr:\n${err}`);
    assertStringIncludes(out, "SEED_OK:posts");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("`--help` does not load project code — it points at `denext commands`", async () => {
  const dir = await project("denext_config_help_", COMMANDS_CONFIG);
  try {
    // `--cwd=<dir>` (not `--cwd <dir>`): with no verb, a bare `<dir>` token would be
    // read as the verb — the parser resolves the verb before any global flag value.
    const { code, out, err } = await runCli(["--help", `--cwd=${dir}`]);
    assert(code === 0, `expected exit 0, got ${code}. stderr:\n${err}`);
    // Discovering `seed` would mean importing denext.config.ts and running every plugin
    // setup() just to print a table; help refuses and says where to look instead.
    assert(!out.includes("Project commands:"), "help imports nothing, so it lists nothing");
    assert(!out.includes("denext seed"), "the project verb is not in the help table");
    assertStringIncludes(out, "Project verbs: run `denext commands`");
    assertStringIncludes(out, "denext commands");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("`--help` outside a denext project prints no project footer", async () => {
  const dir = await project("denext_no_config_");
  try {
    const { code, out } = await runCli(["--help", `--cwd=${dir}`]);
    assert(code === 0, `expected exit 0, got ${code}`);
    assert(!out.includes("Project verbs:"), "nothing to point at without a config");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("`denext commands` lists the project's verbs, in text and as JSON", async () => {
  const dir = await project("denext_commands_verb_", COMMANDS_CONFIG);
  try {
    const text = await runCli(["commands", "--cwd", dir]);
    assert(text.code === 0, `expected exit 0, got ${text.code}. stderr:\n${text.err}`);
    assertStringIncludes(text.out, "Project commands (1):");
    assertStringIncludes(text.out, "denext seed");
    assertStringIncludes(text.out, "load fixture data");
    assertStringIncludes(text.out, "[denext.config.ts]");

    const json = await runCli(["commands", "--json", "--cwd", dir]);
    assert(json.code === 0, `expected exit 0, got ${json.code}. stderr:\n${json.err}`);
    const listing = JSON.parse(json.out) as {
      core: { name: string }[];
      project: { name: string; source: string; summary: string; runnable: boolean }[];
      timedOut: boolean;
      error?: string;
    };
    assertEquals(listing.timedOut, false);
    assertEquals(listing.error, undefined);
    assertEquals(
      listing.project,
      [{
        name: "seed",
        source: "project",
        summary: "load fixture data",
        flags: [],
        positionals: [],
        runnable: true,
      }] as unknown as typeof listing.project,
    );
    assert(listing.core.some((c) => c.name === "dev"), "the built-ins travel too");
    // A project verb can never shadow a built-in, so `commands` itself stays core.
    assert(listing.core.some((c) => c.name === "commands"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a plugin that leaks a handle cannot keep a listing alive", async () => {
  // `setup` starts an hour-long interval and never clears it: before the listing verbs exited
  // explicitly, `denext --help` and `denext completions` in this project never terminated.
  const dir = await project(
    "denext_leaky_plugin_",
    `export default {
  plugins: [{ name: "leaky", setup: () => { setInterval(() => {}, 3600e3); } }],
  commands: [{ name: "seed", summary: "load fixture data", run: () => {} }],
};
`,
  );
  try {
    for (
      const args of [["--help", `--cwd=${dir}`], ["completions", "zsh", "--cwd", dir], [
        "commands",
        "--cwd",
        dir,
      ]]
    ) {
      const started = performance.now();
      const { code } = await runCli(args);
      const elapsed = performance.now() - started;
      assertEquals(code, 0, `\`denext ${args.join(" ")}\` exited ${code}`);
      assert(elapsed < 20_000, `\`denext ${args.join(" ")}\` took ${Math.round(elapsed)} ms`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("`completions` enumerates a `commands:` verb", async () => {
  const dir = await project("denext_config_comp_", COMMANDS_CONFIG);
  try {
    const { code, out, err } = await runCli(["completions", "bash", "--cwd", dir]);
    assert(code === 0, `expected exit 0, got ${code}. stderr:\n${err}`);
    assertStringIncludes(out, "_denext_complete()");
    assertStringIncludes(out, "seed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
