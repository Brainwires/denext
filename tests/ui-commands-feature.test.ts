// `denext ui` → `/commands`: the project-command panel. Covers both discovery seams
// (`commands:` in denext.config.ts and a plugin's `addCommand`), the degraded paths (a plugin
// `setup` that hangs, a config that throws), the run gate (unknown verb, built-in verb,
// read-only), and the two run transports (SSE frames for ui.js, a JSON envelope for a machine).
//
// Nothing here spawns a subprocess: the panel's runner is swapped through its `@internal` seam,
// so `denext --help` and every verb run are answered in-process.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  commandsPanel,
  listCommands,
  parseCoreVerbs,
  setCommandBudget,
  setCommandRunner,
  type UiCommandInfo,
  type UiCommandRunner,
} from "../src/ui/features/commands.ts";
import type { UiContext } from "../src/ui/html.ts";
import { resetPlugins } from "../src/plugin/mod.ts";
import { startUiServer } from "../src/ui/server.ts";
import { deriveCsrf, UI_COOKIE, UI_CSRF_HEADER } from "../src/ui/security.ts";

/** What the stubbed `denext --help` answers with — the real table's shape, cut short. */
const HELP = `denext 9.9.9 — one power tool for all of React

Usage: denext <command> [options]

Commands:
  denext dev           Start the dev server
  denext build         Build for production
  denext doctor        Diagnose the project

Project commands:
  denext seed          a project verb

Global options:
  --json               Machine-readable output where supported
`;

/** A runner that answers `--help` with {@linkcode HELP} and any verb run with `lines`. */
function stubRunner(lines: string[] = ["running…"], code = 0, seen?: string[][]): UiCommandRunner {
  return (argv, opts) => {
    seen?.push(argv);
    const isHelp = argv.includes("--help");
    for (const line of isHelp ? HELP.split("\n") : lines) opts.onLine?.(line);
    return Promise.resolve(isHelp ? 0 : code);
  };
}

/** A `commands:` config declaring `greet`, plus whatever extra source the test needs. */
const GREET_CONFIG = `export default {
  commands: [{
    name: "greet",
    summary: "say hello",
    usage: "  denext greet",
    flags: [{ name: "loud", type: "boolean", help: "Shout it" }],
    run: () => console.log("hi"),
  }],
};
`;

/** A plugin contributing the same verb through `addCommand` (the second seam). */
const PLUGIN_CONFIG = `export default {
  plugins: [{
    name: "demo-plugin",
    setup(ctx) {
      ctx.addCommand({
        name: "greet",
        summary: "demo plugin verb",
        positionals: [{ name: "who", help: "Who to greet" }],
        run: () => {},
      });
    },
  }],
};
`;

/** Run `fn` against a throwaway project whose denext.config.ts is `config`. */
async function withProject(config: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_commands_" });
  const previousRunner = setCommandRunner(stubRunner());
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
    await Deno.writeTextFile(join(dir, "denext.config.ts"), config);
    await fn(dir);
  } finally {
    setCommandRunner(previousRunner);
    resetPlugins();
    await Deno.remove(dir, { recursive: true });
  }
}

/** A feature context, as the kernel builds one. */
function ctx(dir: string, over: Partial<UiContext> = {}): UiContext {
  return {
    dir,
    url: new URL("http://127.0.0.1:5177/commands"),
    method: "GET",
    readOnly: false,
    csrf: "test-csrf",
    json: false,
    fragment: false,
    events: new Set(),
    ...over,
  };
}

/** A POST body carrying `verb`. */
function runBody(verb: string): FormData {
  const form = new FormData();
  form.set("verb", verb);
  return form;
}

/** The `/api/commands` payload for `dir`. */
async function payload(dir: string): Promise<{
  ok: boolean;
  timedOut: boolean;
  error?: string;
  commands: UiCommandInfo[];
}> {
  const res = await commandsPanel(
    new Request("http://127.0.0.1/api/commands"),
    ctx(dir, {
      json: true,
    }),
  );
  return await res.json();
}

Deno.test("a `commands:` verb is listed under Project commands with a Run button", async () => {
  await withProject(GREET_CONFIG, async (dir) => {
    const res = await commandsPanel(new Request("http://127.0.0.1/commands"), ctx(dir));
    assertEquals(res.status, 200);
    const body = await res.text();
    assertStringIncludes(body, "<!doctype html>");
    assertStringIncludes(body, "Project commands");
    assertStringIncludes(body, "denext greet");
    assertStringIncludes(body, "say hello");
    assertStringIncludes(body, "--loud");
    assertStringIncludes(body, 'value="greet"');
    assertStringIncludes(body, "denext.dev/docs/plugins#project-commands");
    // Built-ins parsed from the CLI's own help, kept out of the way.
    assertStringIncludes(body, "<details><summary>Built-in (3)");
    assertStringIncludes(body, "denext dev");
    // The panel is walkable with JavaScript off: a real form, carrying the CSRF field.
    assertStringIncludes(body, '<form method="post" action="/commands">');
    assertStringIncludes(body, 'name="_csrf" value="test-csrf"');
  });
});

Deno.test("a plugin `addCommand` verb is listed under Plugin commands", async () => {
  await withProject(PLUGIN_CONFIG, async (dir) => {
    const { commands } = await payload(dir);
    const greet = commands.find((command) => command.name === "greet");
    assert(greet, "the plugin verb was discovered");
    assertEquals(greet.source, "plugin");
    assertEquals(greet.summary, "demo plugin verb");
    assertEquals(greet.positionals, [{ name: "who", help: "Who to greet" }]);
    // An optional positional still leaves it runnable.
    assertEquals(greet.runnable, true);

    const res = await commandsPanel(new Request("http://127.0.0.1/commands"), ctx(dir));
    const body = await res.text();
    assertStringIncludes(body, "Plugin commands");
    assertStringIncludes(body, "demo plugin verb");
    assertStringIncludes(body, "Who to greet");
  });
});

Deno.test("the JSON twin describes every verb, its schema and whether it can be run", async () => {
  await withProject(GREET_CONFIG, async (dir) => {
    const body = await payload(dir);
    assertEquals(body.ok, true);
    assertEquals(body.timedOut, false);
    assertEquals(body.error, undefined);
    const names = body.commands.map((command) => command.name);
    assertEquals(names, ["dev", "build", "doctor", "greet"]);
    const greet = body.commands[3];
    assertEquals(greet, {
      name: "greet",
      source: "project",
      summary: "say hello",
      usage: "  denext greet",
      flags: [{ name: "loud", type: "boolean", help: "Shout it" }],
      positionals: [],
      runnable: true,
    });
    // Built-ins are listed for reference only — the UI never dispatches one.
    assertEquals(body.commands[0], {
      name: "dev",
      source: "core",
      summary: "Start the dev server",
      flags: [],
      positionals: [],
      runnable: false,
    });
  });
});

Deno.test("a plugin setup that hangs degrades to the built-ins with a named notice", async () => {
  const config = `export default {
  plugins: [{ name: "hangs", setup: () => new Promise(() => {}) }],
  commands: [{ name: "greet", summary: "never listed", run: () => {} }],
};
`;
  await withProject(config, async (dir) => {
    const previousBudget = setCommandBudget(50);
    try {
      const started = performance.now();
      const list = await listCommands(dir);
      assert(performance.now() - started < 2000, "the panel answers within the budget");
      assertEquals(list.timedOut, true);
      assertEquals(list.commands.map((command) => command.name), ["dev", "build", "doctor"]);

      const res = await commandsPanel(new Request("http://127.0.0.1/commands"), ctx(dir));
      const body = await res.text();
      assertStringIncludes(body, "Plugin setup exceeded 0.1 s — project verbs not listed");
      assertStringIncludes(body, "denext dev", "built-in verbs survive the timeout");
      assertEquals((await payload(dir)).timedOut, true);
    } finally {
      setCommandBudget(previousBudget);
    }
  });
});

Deno.test("a config that throws is reported on the page, not swallowed", async () => {
  await withProject(`throw new Error("boom");\n`, async (dir) => {
    const body = await payload(dir);
    assertEquals(body.timedOut, false);
    assert(body.error, "the failure travels in the envelope");
    assertStringIncludes(body.error, "boom");

    const res = await commandsPanel(new Request("http://127.0.0.1/commands"), ctx(dir));
    assertStringIncludes(await res.text(), "denext.config.ts could not be read");
  });
});

Deno.test("running an unknown verb is refused", async () => {
  await withProject(GREET_CONFIG, async (dir) => {
    const res = await commandsPanel(
      new Request("http://127.0.0.1/commands", { method: "POST" }),
      ctx(dir, { method: "POST", form: runBody("rm -rf /") }),
    );
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.ok, false);
    assertStringIncludes(body.reason, `unknown command "rm -rf /"`);
    assertEquals(body.runnable, ["greet"]);
  });
});

Deno.test("running a built-in verb from the browser is refused", async () => {
  await withProject(GREET_CONFIG, async (dir) => {
    const res = await commandsPanel(
      new Request("http://127.0.0.1/commands", { method: "POST" }),
      ctx(dir, { method: "POST", form: runBody("dev") }),
    );
    assertEquals(res.status, 400);
    assertStringIncludes((await res.json()).reason, "built-in verb");
  });
});

Deno.test("read-only refuses to run a verb — a verb may write anything", async () => {
  await withProject(GREET_CONFIG, async (dir) => {
    const res = await commandsPanel(
      new Request("http://127.0.0.1/commands", { method: "POST" }),
      ctx(dir, { method: "POST", readOnly: true, form: runBody("greet") }),
    );
    assertEquals(res.status, 403);
    assertStringIncludes((await res.json()).reason, "read-only");
  });
});

Deno.test("running a verb streams its output and an exit frame", async () => {
  await withProject(GREET_CONFIG, async (dir) => {
    const seen: string[][] = [];
    setCommandRunner(stubRunner(["hello from greet", "second line"], 0, seen));
    const events = new Set<ReadableStreamDefaultController<Uint8Array>>();
    const res = await commandsPanel(
      new Request("http://127.0.0.1/commands", { method: "POST" }),
      ctx(dir, { method: "POST", fragment: true, form: runBody("greet"), events }),
    );
    assertEquals(res.status, 200);
    assertStringIncludes(res.headers.get("content-type") ?? "", "text/event-stream");
    const stream = await res.text();
    assertStringIncludes(stream, "data: hello from greet\n\n");
    assertStringIncludes(stream, "data: second line\n\n");
    assertStringIncludes(stream, "data: — exited 0\n\n");
    // The verb ran through this framework's own CLI, as argv, pinned to the project.
    const run = seen.find((argv) => argv.includes("greet"));
    assert(run, "the verb was spawned");
    assertEquals(run.slice(0, 2), ["run", "-A"]);
    assertStringIncludes(run[2], "cli.ts");
    assertEquals(run.slice(3), ["greet", "--cwd", dir]);
  });
});

Deno.test("a machine client gets the run as a JSON envelope", async () => {
  await withProject(GREET_CONFIG, async (dir) => {
    setCommandRunner(stubRunner(["nope"], 2));
    const res = await commandsPanel(
      new Request("http://127.0.0.1/api/commands", { method: "POST" }),
      ctx(dir, { method: "POST", json: true, form: runBody("greet") }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: false, verb: "greet", code: 2, output: ["nope"] });
  });
});

Deno.test("with JavaScript off the run answers with the panel and the captured output", async () => {
  await withProject(GREET_CONFIG, async (dir) => {
    setCommandRunner(stubRunner(["plain post"]));
    const res = await commandsPanel(
      new Request("http://127.0.0.1/commands", { method: "POST" }),
      ctx(dir, { method: "POST", form: runBody("greet") }),
    );
    assertEquals(res.status, 200);
    const body = await res.text();
    assertStringIncludes(body, "<!doctype html>");
    assertStringIncludes(body, "plain post\n— exited 0</pre>");
  });
});

Deno.test("parseCoreVerbs reads the built-in table and stops at the project section", () => {
  const specs = parseCoreVerbs(HELP);
  assertEquals(specs.map((spec) => spec.name), ["dev", "build", "doctor"]);
  assertEquals(specs[0].summary, "Start the dev server");
  assertEquals(parseCoreVerbs(""), []);
  // A repeated row (two help runs concatenated) never double-registers a verb.
  assertEquals(parseCoreVerbs(HELP + HELP).length, 3);
});

Deno.test("the panel is reachable through the kernel, and read-only stops the mutation", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_commands_srv_" });
  const previousRunner = setCommandRunner(stubRunner());
  await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
  await Deno.writeTextFile(join(dir, "denext.config.ts"), GREET_CONFIG);
  const server = await startUiServer({ dir, port: 0, readOnly: true });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { cookie: `${UI_COOKIE}=${server.token}` };
  try {
    const page = await fetch(`${base}/commands`, { headers });
    assertEquals(page.status, 200);
    assertStringIncludes(await page.text(), "Project commands");

    const run = await fetch(`${base}/commands`, {
      method: "POST",
      headers: { ...headers, origin: base, [UI_CSRF_HEADER]: await deriveCsrf(server.token) },
      body: runBody("greet"),
    });
    assertEquals(run.status, 403);
    assertStringIncludes((await run.json()).reason, "read-only");
  } finally {
    await server.shutdown();
    setCommandRunner(previousRunner);
    resetPlugins();
    await Deno.remove(dir, { recursive: true });
  }
});
