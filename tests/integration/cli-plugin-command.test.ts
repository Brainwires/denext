// Proves the two project-verb seams end-to-end, through the real `denext` binary:
// a plugin's `addCommand` (discovered when the first parse hits an unknown command)
// and the `commands:` shorthand in denext.config.ts (no plugin at all). Also that the
// verbs that must enumerate EVERY command — `--help` and `completions` — load them
// eagerly, so a project verb is discoverable and not just dispatchable.

import { assert, assertStringIncludes } from "@std/assert";
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

Deno.test("`--help` lists a `commands:` verb under Project commands", async () => {
  const dir = await project("denext_config_help_", COMMANDS_CONFIG);
  try {
    // `--cwd=<dir>` (not `--cwd <dir>`): with no verb, a bare `<dir>` token would be
    // read as the verb — the parser resolves the verb before any global flag value.
    const { code, out, err } = await runCli(["--help", `--cwd=${dir}`]);
    assert(code === 0, `expected exit 0, got ${code}. stderr:\n${err}`);
    assertStringIncludes(out, "Project commands:");
    assertStringIncludes(out, "denext seed");
    assertStringIncludes(out, "load fixture data");
    // Built-ins stay in their own table, above it.
    assert(out.indexOf("denext dev") < out.indexOf("Project commands:"));
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
