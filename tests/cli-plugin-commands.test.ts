// Project-contributed CLI verbs: the `commands:` shorthand in denext.config.ts and the
// plugin `addCommand` seam, as merged into the CLI registry by `loadPluginCommands`.
// These lock in the three invariants the CLI depends on: core verbs always win a name
// collision, discovery is budgeted (a plugin's `setup` is arbitrary user code), and the
// registry is never left half-populated when the budget or the config blows up.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { CommandRegistry, type CommandSpec } from "../src/cli/command.ts";
import { loadPluginCommands } from "../src/cli/plugin-commands.ts";
import { buildRegistry } from "../src/cli/register.ts";
import { resetPlugins } from "../src/plugin/mod.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";

/** Run `fn` against a throwaway project whose denext.config.ts is `source`. */
async function withProject(source: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_commands_" });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
    await Deno.writeTextFile(join(dir, "denext.config.ts"), source);
    await fn(dir);
  } finally {
    resetPlugins();
    await Deno.remove(dir, { recursive: true });
  }
}

/** A config exporting one `commands:` entry named `name`. */
function commandsConfig(name: string): string {
  return `export default {
  commands: [{
    name: ${JSON.stringify(name)},
    summary: "a project verb",
    run: () => console.log("ran ${name}"),
  }],
};
`;
}

Deno.test("a `commands:` entry registers as a project-sourced verb", async () => {
  await withProject(commandsConfig("seed"), async (dir) => {
    const reg = buildRegistry();
    const result = await loadPluginCommands(reg, dir);
    assertEquals(result, { loaded: 1, timedOut: false });
    const spec = reg.get("seed");
    assert(spec, "the project verb was registered");
    assertEquals(spec.source, "project");
    assertEquals(spec.summary, "a project verb");
  });
});

Deno.test("a built-in verb wins a `commands:` name collision", async () => {
  await withProject(commandsConfig("dev"), async (dir) => {
    const reg = buildRegistry();
    const core = reg.get("dev");
    const result = await loadPluginCommands(reg, dir);
    assertEquals(result.loaded, 0);
    // Same object as before: the core verb was never replaced or shadowed.
    assertEquals(reg.get("dev"), core);
    assertEquals(reg.get("dev")?.source, undefined);
  });
});

Deno.test("plugin `addCommand` verbs are stamped source: plugin", async () => {
  const config = `export default {
  plugins: [{
    name: "demo-plugin",
    setup(ctx) {
      ctx.addCommand({ name: "greet", summary: "demo plugin verb", run: () => {} });
    },
  }],
};
`;
  await withProject(config, async (dir) => {
    const reg = buildRegistry();
    assertEquals((await loadPluginCommands(reg, dir)).loaded, 1);
    assertEquals(reg.get("greet")?.source, "plugin");
  });
});

Deno.test("a project with neither commands nor plugins registers nothing", async () => {
  await withProject("export default {};\n", async (dir) => {
    const reg = buildRegistry();
    assertEquals(await loadPluginCommands(reg, dir), { loaded: 0, timedOut: false });
  });
});

Deno.test("discovery gives up on its budget when a plugin setup hangs", async () => {
  const config = `export default {
  plugins: [{ name: "hangs", setup: () => new Promise(() => {}) }],
  commands: [{ name: "seed", summary: "never gets registered", run: () => {} }],
};
`;
  await withProject(config, async (dir) => {
    const reg = buildRegistry();
    const before = reg.names().length;
    const result = await loadPluginCommands(reg, dir, { timeoutMs: 50 });
    assertEquals(result, { loaded: 0, timedOut: true });
    // All-or-nothing: even the config verb that resolved fine stays out.
    assertEquals(reg.names().length, before);
    assertEquals(reg.get("seed"), undefined);
  });
});

Deno.test("a config that throws degrades to an error result, not a throw", async () => {
  await withProject(`throw new Error("boom");\n`, async (dir) => {
    const reg = buildRegistry();
    const result = await loadPluginCommands(reg, dir);
    assertEquals(result.loaded, 0);
    assertEquals(result.timedOut, false);
    assert(result.error, "the failure is reported, not thrown");
  });
});

Deno.test("validateDenextConfig field-scopes a malformed commands entry", () => {
  const bad = [
    [{ name: "Seed", summary: "s", run: () => {} }, "`commands[0].name`"],
    [{ name: "seed", summary: "", run: () => {} }, "`commands[0].summary`"],
    [{ name: "seed", summary: "s" }, "`commands[0].run`"],
    ["seed", "`commands[0]`"],
  ] as const;
  for (const [entry, field] of bad) {
    const error = assertThrows(
      () => validateDenextConfig({ commands: [entry] } as never),
      Error,
    );
    assertStringIncludes(error.message, "invalid denext.config:");
    assertStringIncludes(error.message, field);
  }
  assertThrows(
    () => validateDenextConfig({ commands: {} } as never),
    Error,
    "`commands` must be an array",
  );
});

Deno.test("validateDenextConfig rejects duplicate command names", () => {
  const entry = { name: "seed", summary: "s", run: () => {} };
  const error = assertThrows(
    () => validateDenextConfig({ commands: [entry, { ...entry }] }),
    Error,
  );
  assertStringIncludes(error.message, "`commands[1].name`");
  assertStringIncludes(error.message, "duplicates an earlier");
  // The valid shape stays valid.
  validateDenextConfig({ commands: [entry] });
});

Deno.test("formatHelp lists project verbs in their own section", () => {
  const spec = (name: string, source?: CommandSpec["source"]): CommandSpec => ({
    name,
    summary: `${name} summary`,
    ...(source ? { source } : {}),
    run: () => {},
  });
  const reg = new CommandRegistry();
  reg.register(spec("dev"));
  const core = reg.formatHelp("9.9.9");
  assert(!core.includes("Project commands:"), "no section without project verbs");

  reg.register(spec("seed", "project"));
  reg.register(spec("greet", "plugin"));
  const help = reg.formatHelp("9.9.9");
  assertStringIncludes(help, "Project commands:");
  assertStringIncludes(help, "denext seed");
  assertStringIncludes(help, "denext greet");
  // Project verbs come after the built-in table, not inside it.
  assert(
    help.indexOf("denext dev") < help.indexOf("Project commands:"),
    "built-ins are listed first",
  );
  assert(
    help.indexOf("Project commands:") < help.indexOf("denext seed"),
    "project verbs sit under their own heading",
  );
});
