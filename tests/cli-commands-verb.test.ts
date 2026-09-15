// `denext commands` — the verb that lists a project's own CLI verbs. It is the ONE place
// project-verb discovery legitimately runs in-process (`denext --help` no longer does, and
// `denext ui` shells out to this verb), so these cover the listing it builds, the degraded
// paths, and the one invariant that keeps a leaked plugin handle from hanging a CLI call:
// the verb always exits.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { listAllCommands, makeCommandsCommand } from "../src/cli/commands/commands.ts";
import { buildRegistry } from "../src/cli/register.ts";
import type { CommandContext } from "../src/cli/command.ts";
import { resetPlugins } from "../src/plugin/mod.ts";

/** Run `fn` against a throwaway project whose denext.config.ts is `source`. */
async function withProject(source: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_commands_verb_" });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
    await Deno.writeTextFile(join(dir, "denext.config.ts"), source);
    await fn(dir);
  } finally {
    resetPlugins();
    await Deno.remove(dir, { recursive: true });
  }
}

/** The `commands:` shorthand: a project verb with no plugin at all. */
const SEED_CONFIG = `export default {
  commands: [{
    name: "seed",
    summary: "load fixture data",
    usage: "  denext seed [table]",
    flags: [{ name: "force", type: "boolean", help: "Overwrite" }],
    positionals: [{ name: "table", help: "Which table" }],
    run: () => {},
  }],
};
`;

/** A parsed invocation, as the CLI framework builds one. */
function ctx(dir: string, over: Partial<CommandContext> = {}): CommandContext {
  return {
    positionals: [],
    flags: {},
    global: { cwd: dir, json: false, verbose: false, quiet: false } as CommandContext["global"],
    rest: [],
    ...over,
  };
}

/** Drive the verb with console + `Deno.exit` stubbed (it always exits, never returns). */
async function invoke(dir: string, over: Partial<CommandContext> = {}): Promise<{
  out: string;
  codes: number[];
}> {
  const logs: string[] = [];
  const original = console.log;
  const originalExit = Deno.exit;
  const codes: number[] = [];
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  Deno.exit = ((code?: number): never => {
    codes.push(code ?? 0);
    throw new Error("__exit__");
  }) as typeof Deno.exit;
  try {
    await makeCommandsCommand(buildRegistry()).run(ctx(dir, over));
  } catch (error) {
    assert(String(error).includes("__exit__"), `unexpected throw: ${error}`);
  } finally {
    console.log = original;
    Deno.exit = originalExit;
  }
  return { out: logs.join("\n"), codes };
}

Deno.test("listAllCommands splits the registry into built-ins and the project's own verbs", async () => {
  await withProject(SEED_CONFIG, async (dir) => {
    const listing = await listAllCommands(buildRegistry(), dir);
    assertEquals(listing.timedOut, false);
    assertEquals(listing.error, undefined);
    assertEquals(listing.project, [{
      name: "seed",
      source: "project",
      summary: "load fixture data",
      usage: "  denext seed [table]",
      flags: [{ name: "force", type: "boolean", help: "Overwrite" }],
      positionals: [{ name: "table", help: "Which table" }],
      runnable: true,
    }]);
    const core = listing.core.map((info) => info.name);
    assert(core.includes("dev") && core.includes("commands"));
    assert(listing.core.every((info) => info.source === "core" && !info.runnable));
  });
});

Deno.test("a plugin `addCommand` verb is stamped plugin, and a required positional is not runnable", async () => {
  const config = `export default {
  plugins: [{
    name: "demo",
    setup(ctx) {
      ctx.addCommand({
        name: "greet",
        summary: "demo plugin verb",
        positionals: [{ name: "who", help: "Who", required: true }],
        run: () => {},
      });
    },
  }],
};
`;
  await withProject(config, async (dir) => {
    const listing = await listAllCommands(buildRegistry(), dir);
    assertEquals(listing.project.length, 1);
    assertEquals(listing.project[0].source, "plugin");
    assertEquals(listing.project[0].runnable, false);
  });
});

Deno.test("a project verb can never shadow a built-in", async () => {
  await withProject(SEED_CONFIG.replace('"seed"', '"dev"'), async (dir) => {
    const listing = await listAllCommands(buildRegistry(), dir);
    assertEquals(listing.project, []);
    assertEquals(listing.core.find((info) => info.name === "dev")?.summary, "Start the dev server");
  });
});

Deno.test("a plugin setup that hangs degrades to timedOut, not a hang", async () => {
  const config = `export default {
  plugins: [{ name: "hangs", setup: () => new Promise(() => {}) }],
  commands: [{ name: "seed", summary: "never listed", run: () => {} }],
};
`;
  await withProject(config, async (dir) => {
    const listing = await listAllCommands(buildRegistry(), dir, 50);
    assertEquals(listing.timedOut, true);
    assertEquals(listing.project, []);
    assert(listing.core.length > 0, "the built-ins are unaffected");
  });
});

Deno.test("a config that throws is reported in the listing, not thrown", async () => {
  await withProject(`throw new Error("boom");\n`, async (dir) => {
    const listing = await listAllCommands(buildRegistry(), dir);
    assertEquals(listing.timedOut, false);
    assertStringIncludes(listing.error ?? "", "boom");
  });
});

Deno.test("the verb prints a human listing and always exits", async () => {
  await withProject(SEED_CONFIG, async (dir) => {
    const { out, codes } = await invoke(dir);
    assertStringIncludes(out, "Project commands (1):");
    assertStringIncludes(out, "denext seed");
    assertStringIncludes(out, "load fixture data");
    assertStringIncludes(out, "[denext.config.ts]");
    assertStringIncludes(out, "Built-in commands (");
    assertStringIncludes(out, "Run `denext <command> --help`");
    // A plugin `setup` may have left a timer or a watcher open; the verb never waits on it.
    assertEquals(codes, [0]);
  });
});

Deno.test("the verb says so plainly when the project contributes nothing", async () => {
  await withProject("export default {};\n", async (dir) => {
    const { out, codes } = await invoke(dir);
    assertStringIncludes(out, "Project commands: none");
    assertStringIncludes(out, "denext.dev/docs/plugins#project-commands");
    assertEquals(codes, [0]);
  });
});

Deno.test("--json prints the listing document the UI consumes", async () => {
  await withProject(SEED_CONFIG, async (dir) => {
    const { out, codes } = await invoke(dir, {
      global: { cwd: dir, json: true, verbose: false, quiet: false } as CommandContext["global"],
    });
    assertEquals(codes, [0]);
    // Pretty-printed, so the document opens and closes on bare brace lines — which is how
    // `src/ui/features/commands.ts` lifts it out of the child's combined output.
    assert(out.startsWith("{\n"), out.slice(0, 40));
    assert(out.trimEnd().endsWith("\n}"));
    const listing = JSON.parse(out) as { project: { name: string }[]; timedOut: boolean };
    assertEquals(listing.timedOut, false);
    assertEquals(listing.project[0].name, "seed");
  });
});

Deno.test("--timeout overrides the discovery budget and is reported in the notice", async () => {
  const config = `export default {
  plugins: [{ name: "hangs", setup: () => new Promise(() => {}) }],
};
`;
  await withProject(config, async (dir) => {
    const started = performance.now();
    const { out, codes } = await invoke(dir, { flags: { timeout: 60 } });
    // The property under test is "exits at all despite a leaked one-hour interval" — the
    // 1.5 s discovery budget is what makes that true. The wall-clock ceiling is loose on
    // purpose: under the full parallel test run a cold `deno run` of the CLI alone can take
    // tens of seconds, and a tight bound here turned that load into a flake (43 s observed).
    assert(
      performance.now() - started < 120_000,
      "the leaky plugin did not keep the process alive",
    );
    assertStringIncludes(out, "plugin setup exceeded 0.1 s");
    assertEquals(codes, [0]);
  });
});

Deno.test("the verb records a complete listing for --help, and a degraded one not at all", async () => {
  await withProject(SEED_CONFIG, async (dir) => {
    await invoke(dir);
    const cache = JSON.parse(await Deno.readTextFile(join(dir, ".denext", "commands.json")));
    assertEquals(cache.verbs, [{ name: "seed", summary: "load fixture data" }]);
    assertEquals(typeof cache.fingerprint, "string");
  });
});
