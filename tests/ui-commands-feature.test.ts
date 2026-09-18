// `denext ui` → `/commands`: the project-command panel. Its ONE discovery path is a
// `denext commands --json` subprocess, so these cover parsing that listing, the degraded paths
// (a child that times out, a config the child could not read, output with no listing in it), the
// shared in-flight promise that makes concurrent loads spawn one child, the run gate (unknown
// verb, built-in verb, read-only), the two run transports (SSE frames for ui.js, a JSON
// envelope for a machine), and the typed run form: one control per declared flag and
// positional, and the argv the server builds from what it posts — every value its own element,
// nothing the verb does not declare, and no positional that could pass for a flag.
//
// Nothing here spawns a subprocess: the panel's runner is swapped through its `@internal` seam,
// so the discovery child and every verb run are answered in-process.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  commandsPanel,
  listCommands,
  parseListing,
  setCommandBudget,
  setCommandRunner,
  type UiCommandInfo,
  type UiCommandRunner,
} from "../src/ui/features/commands.ts";
import type { UiContext } from "../src/ui/html.ts";
import { startUiServer } from "../src/ui/server.ts";
import { UI_CSRF_HEADER } from "../src/ui/security.ts";
import { uiHandshake } from "./helpers/ui-session.ts";

/** The three built-ins the stubbed `denext commands --json` reports. */
const CORE: UiCommandInfo[] = [
  {
    name: "dev",
    source: "core",
    summary: "Start the dev server",
    flags: [],
    positionals: [],
    runnable: false,
  },
  {
    name: "build",
    source: "core",
    summary: "Build for production",
    flags: [],
    positionals: [],
    runnable: false,
  },
  {
    name: "doctor",
    source: "core",
    summary: "Diagnose the project",
    flags: [],
    positionals: [],
    runnable: false,
  },
];

/** The `greet` project verb, as the CLI's listing describes it. */
const GREET: UiCommandInfo = {
  name: "greet",
  source: "project",
  summary: "say hello",
  usage: "  denext greet",
  flags: [{ name: "loud", type: "boolean", help: "Shout it" }],
  positionals: [],
  runnable: true,
};

/** The same verb as a plugin would contribute it, with an optional positional. */
const PLUGIN_GREET: UiCommandInfo = {
  name: "greet",
  source: "plugin",
  summary: "demo plugin verb",
  flags: [],
  positionals: [{ name: "who", help: "Who to greet" }],
  runnable: true,
};

/** A listing document, printed exactly as `denext commands --json` prints one. */
function listing(project: UiCommandInfo[], over: Record<string, unknown> = {}): string {
  return JSON.stringify({ core: CORE, project, timedOut: false, ...over }, null, 2);
}

/** What the stubbed discovery child prints, per test. */
let discovery = listing([GREET]);

/**
 * A runner that answers the discovery child with {@linkcode discovery} (preceded by the kind of
 * stderr noise Deno itself emits, which the parser must step over) and any verb run with
 * `lines`.
 */
function stubRunner(lines: string[] = ["running…"], code = 0, seen?: string[][]): UiCommandRunner {
  return (argv, opts) => {
    seen?.push(argv);
    const isDiscovery = argv.includes("commands") && argv.includes("--json");
    const out = isDiscovery
      ? ["Download https://jsr.io/@std/path", ...discovery.split("\n")]
      : lines;
    for (const line of out) opts.onLine?.(line);
    return Promise.resolve(isDiscovery ? 0 : code);
  };
}

/** Run `fn` against a throwaway project dir, with `document` as the child's listing. */
async function withProject(document: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_commands_" });
  const previousDiscovery = discovery;
  discovery = document;
  const previousRunner = setCommandRunner(stubRunner());
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
    await fn(dir);
  } finally {
    discovery = previousDiscovery;
    setCommandRunner(previousRunner);
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

Deno.test("a project verb is listed under Project commands with a Run button", async () => {
  await withProject(listing([GREET]), async (dir) => {
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
    // Built-ins the child reported, kept out of the way.
    assertStringIncludes(body, "<details><summary>Built-in (3)");
    assertStringIncludes(body, "denext dev");
    // The panel is walkable with JavaScript off: a real form, carrying the CSRF field.
    assertStringIncludes(body, '<form method="post" action="/commands">');
    assertStringIncludes(body, 'name="_csrf" value="test-csrf"');
  });
});

Deno.test("a plugin `addCommand` verb is listed under Plugin commands", async () => {
  await withProject(listing([PLUGIN_GREET]), async (dir) => {
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

Deno.test("discovery is ONE `denext commands --json` child — no project code in this process", async () => {
  await withProject(listing([GREET]), async (dir) => {
    const seen: string[][] = [];
    setCommandRunner(stubRunner([], 0, seen));
    await listCommands(dir);
    assertEquals(seen.length, 1, "exactly one subprocess answers a discovery");
    const argv = seen[0];
    assertEquals(argv.slice(0, 2), ["run", "-A"]);
    assertStringIncludes(argv[2], "cli.ts");
    assertEquals(argv.slice(3), ["commands", "--json", "--timeout", "1500", "--cwd", dir]);
  });
});

Deno.test("concurrent discoveries share one child and every one of them sees the verb", async () => {
  await withProject(listing([GREET]), async (dir) => {
    const seen: string[][] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = stubRunner([], 0, seen);
    setCommandRunner(async (argv, opts) => {
      await gate;
      return await inner(argv, opts);
    });
    const all = Array.from({ length: 8 }, () => listCommands(dir));
    release();
    const lists = await Promise.all(all);
    assertEquals(seen.length, 1, "eight overlapping requests spawned one child");
    for (const list of lists) {
      assert(list.commands.some((info) => info.name === "greet"), "every waiter got the verb");
    }
  });
});

Deno.test("the JSON twin describes every verb, its schema and whether it can be run", async () => {
  await withProject(listing([GREET]), async (dir) => {
    const body = await payload(dir);
    assertEquals(body.ok, true);
    assertEquals(body.timedOut, false);
    assertEquals(body.error, undefined);
    const names = body.commands.map((command) => command.name);
    assertEquals(names, ["dev", "build", "doctor", "greet"]);
    assertEquals(body.commands[3], GREET);
    // Built-ins are listed for reference only — the UI never dispatches one.
    assertEquals(body.commands[0], CORE[0]);
  });
});

Deno.test("a plugin setup that hangs degrades to the built-ins with a named notice", async () => {
  await withProject(listing([], { timedOut: true }), async (dir) => {
    const previousBudget = setCommandBudget(100);
    try {
      const list = await listCommands(dir);
      assertEquals(list.timedOut, true);
      assertEquals(list.commands.map((command) => command.name), ["dev", "build", "doctor"]);

      const res = await commandsPanel(new Request("http://127.0.0.1/commands"), ctx(dir));
      const body = await res.text();
      assertStringIncludes(body, "Plugin setup exceeded 0.1 s — project verbs not");
      assertStringIncludes(body, "Built-in verbs are unaffected");
      assertStringIncludes(body, "denext dev", "built-in verbs survive the timeout");
      assertEquals((await payload(dir)).timedOut, true);
    } finally {
      setCommandBudget(previousBudget);
    }
  });
});

Deno.test("a degraded listing is never cached — the next request re-discovers", async () => {
  await withProject(listing([], { timedOut: true }), async (dir) => {
    const seen: string[][] = [];
    setCommandRunner(stubRunner([], 0, seen));
    await listCommands(dir);
    await listCommands(dir);
    assertEquals(seen.length, 2, "a timed-out discovery is retried");
    // A good answer, on the other hand, is reused for a few seconds.
    discovery = listing([GREET]);
    await listCommands(dir);
    const after = seen.length;
    await listCommands(dir);
    assertEquals(seen.length, after, "a successful listing is reused");
  });
});

Deno.test("a config the child could not read is reported on the page, not swallowed", async () => {
  await withProject(listing([], { error: "boom" }), async (dir) => {
    const body = await payload(dir);
    assertEquals(body.timedOut, false);
    assert(body.error, "the failure travels in the envelope");
    assertStringIncludes(body.error, "boom");

    const res = await commandsPanel(new Request("http://127.0.0.1/commands"), ctx(dir));
    assertStringIncludes(await res.text(), "denext.config.ts could not be read");
  });
});

Deno.test("a child that prints no listing degrades instead of throwing", async () => {
  await withProject("deno: command not found", async (dir) => {
    const list = await listCommands(dir);
    assertEquals(list.commands, []);
    assertStringIncludes(list.error ?? "", "printed no listing");
  });
});

Deno.test("a child that cannot be spawned degrades to a timed-out listing", async () => {
  await withProject(listing([GREET]), async (dir) => {
    setCommandRunner(() => Promise.reject(new Error("no deno on PATH")));
    const list = await listCommands(dir);
    assertEquals(list, { commands: [], timedOut: true });
  });
});

Deno.test("running an unknown verb is refused", async () => {
  await withProject(listing([GREET]), async (dir) => {
    const res = await commandsPanel(
      new Request("http://127.0.0.1/commands", { method: "POST" }),
      ctx(dir, { method: "POST", json: true, form: runBody("rm -rf /") }),
    );
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.ok, false);
    assertStringIncludes(body.reason, `unknown command "rm -rf /"`);
    assertEquals(body.runnable, ["greet"]);
  });
});

Deno.test("running a built-in verb from the browser is refused", async () => {
  await withProject(listing([GREET]), async (dir) => {
    const res = await commandsPanel(
      new Request("http://127.0.0.1/commands", { method: "POST" }),
      ctx(dir, { method: "POST", json: true, form: runBody("dev") }),
    );
    assertEquals(res.status, 400);
    assertStringIncludes((await res.json()).reason, "built-in verb");
  });
});

Deno.test("read-only refuses to run a verb — a verb may write anything", async () => {
  await withProject(listing([GREET]), async (dir) => {
    const res = await commandsPanel(
      new Request("http://127.0.0.1/commands", { method: "POST" }),
      ctx(dir, { method: "POST", json: true, readOnly: true, form: runBody("greet") }),
    );
    assertEquals(res.status, 403);
    assertStringIncludes((await res.json()).reason, "read-only");
  });
});

Deno.test("running a verb streams its output and an exit frame", async () => {
  await withProject(listing([GREET]), async (dir) => {
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
  await withProject(listing([GREET]), async (dir) => {
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
  await withProject(listing([GREET]), async (dir) => {
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

Deno.test("a built-in lists its arguments and flags, and project text is escaped", async () => {
  const builtin: UiCommandInfo = {
    name: "serve",
    source: "core",
    summary: "Serve it",
    flags: [{
      name: "port",
      alias: "p",
      type: "number",
      default: 3000,
      valueName: "N",
      help: "Which port",
    }],
    positionals: [{ name: "dir", help: "The root", required: true, variadic: true }],
    runnable: false,
  };
  const hostile: UiCommandInfo = {
    ...GREET,
    summary: '<script>alert("x")</script>',
    usage: "a < b & c",
  };
  const document = JSON.stringify(
    { core: [builtin], project: [hostile], timedOut: false },
    null,
    2,
  );
  await withProject(document, async (dir) => {
    const res = await commandsPanel(new Request("http://127.0.0.1/commands"), ctx(dir));
    const body = await res.text();
    assertStringIncludes(
      body,
      '<ul class="args"><li><code>dir…</code> — The root <span class="badge">required</span></li></ul>',
    );
    assertStringIncludes(
      body,
      "<td><code>--port, -p N</code></td><td>number</td><td>3000</td><td>Which port</td>",
    );
    assertEquals(body.includes("<script>alert"), false, "a verb's summary is text, never markup");
    assertStringIncludes(body, "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>");
    assertStringIncludes(body, '<pre class="mono">a &lt; b &amp; c</pre>');
  });
});

Deno.test("parseListing lifts the document out of the child's combined output", () => {
  const doc = listing([GREET]);
  const parsed = parseListing(`Download https://jsr.io/@std/path\n${doc}\n`);
  assertEquals(parsed?.project?.[0].name, "greet");
  // CRLF, and a trailing warning after the document, are both tolerated.
  assertEquals(parseListing(doc.replace(/\n/g, "\r\n") + "\r\nWarning: x")?.core?.length, 3);
  assertEquals(parseListing(""), null);
  assertEquals(parseListing("not json at all"), null);
  assertEquals(parseListing("{\nnot json\n}"), null);
});

Deno.test("the panel is reachable through the kernel, and read-only stops the mutation", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_commands_srv_" });
  const previousDiscovery = discovery;
  discovery = listing([GREET]);
  const previousRunner = setCommandRunner(stubRunner());
  await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
  const server = await startUiServer({ dir, port: 0, readOnly: true });
  const base = `http://127.0.0.1:${server.port}`;
  const { headers, csrf } = await uiHandshake(server);
  try {
    const page = await fetch(`${base}/commands`, { headers });
    assertEquals(page.status, 200);
    assertStringIncludes(await page.text(), "Project commands");

    const run = await fetch(`${base}/commands`, {
      method: "POST",
      headers: { ...headers, origin: base, [UI_CSRF_HEADER]: csrf },
      body: runBody("greet"),
    });
    assertEquals(run.status, 403);
    assertStringIncludes((await run.json()).reason, "read-only");
  } finally {
    await server.shutdown();
    discovery = previousDiscovery;
    setCommandRunner(previousRunner);
    await Deno.remove(dir, { recursive: true });
  }
});

// ── the typed run form ───────────────────────────────────────────────────────

/**
 * A project verb with one flag of every type, a default-on switch, a flag the UI must never
 * offer (`cwd` is a CLI global), a required positional and a variadic one. The CLI calls it not
 * `runnable` (it needs an argument); the panel still offers it a form.
 */
const SEED: UiCommandInfo = {
  name: "seed",
  source: "project",
  summary: "load fixtures",
  flags: [
    { name: "force", type: "boolean", help: "Overwrite existing rows" },
    { name: "rows", type: "number", default: 100, help: "How many rows" },
    { name: "label", alias: "l", type: "string", help: "A label for the batch" },
    { name: "fresh", type: "boolean", default: true, help: "Start from an empty table" },
    { name: "cwd", type: "string", help: "A flag the UI never offers" },
  ],
  positionals: [
    { name: "table", help: "Which table", required: true },
    { name: "files", help: "Extra fixture files", variadic: true },
  ],
  runnable: false,
};

/** A plugin verb whose every argument is optional. */
const OPTS: UiCommandInfo = {
  name: "opts",
  source: "plugin",
  summary: "all optional",
  flags: [
    { name: "dry", type: "boolean", help: "Change nothing" },
    { name: "note", type: "string", help: "A note" },
    { name: "limit", type: "number", help: "A limit" },
  ],
  positionals: [{ name: "from", help: "Start" }, { name: "to", help: "End" }],
  runnable: true,
};

/** What one run submission produced: the response, and every verb argv that was spawned. */
interface Submission {
  readonly status: number;
  readonly text: string;
  /** The spawned verb runs, each argv minus the `run -A cli.ts` prefix. */
  readonly runs: string[][];
}

/** POST `fields` (repeat a name with an array) to the panel and capture what was spawned. */
async function submitRun(
  dir: string,
  fields: Record<string, string | string[]>,
  over: Partial<UiContext> = {},
): Promise<Submission> {
  const seen: string[][] = [];
  setCommandRunner(stubRunner([], 0, seen));
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const one of [value].flat()) form.append(key, one);
  }
  const res = await commandsPanel(
    new Request("http://127.0.0.1/api/commands", { method: "POST" }),
    ctx(dir, { method: "POST", json: true, form, ...over }),
  );
  return {
    status: res.status,
    text: await res.text(),
    runs: seen.filter((argv) => argv[3] !== "commands").map((argv) => argv.slice(3)),
  };
}

/** How many times `needle` occurs in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

Deno.test("the run form renders one typed control per declared flag and positional", async () => {
  await withProject(listing([SEED]), async (dir) => {
    const res = await commandsPanel(new Request("http://127.0.0.1/commands"), ctx(dir));
    const body = await res.text();
    // boolean → a checkbox after its hidden `false` twin; a default-on switch starts checked.
    assertStringIncludes(body, '<input type="hidden" name="flag:force" value="false">');
    assertStringIncludes(
      body,
      '<input type="checkbox" name="flag:force" value="true" id="cmd-seed-flag:force">',
    );
    assertStringIncludes(body, 'name="flag:fresh" value="true" id="cmd-seed-flag:fresh" checked>');
    // number → a number input with any step, its default as the placeholder.
    assertStringIncludes(
      body,
      '<input type="number" name="flag:rows" value="" step="any" id="cmd-seed-flag:rows" placeholder="100">',
    );
    // string → a bounded text input, labelled with its long name and short alias.
    assertStringIncludes(
      body,
      '<input type="text" name="flag:label" value="" maxlength="4096" id="cmd-seed-flag:label">',
    );
    assertStringIncludes(body, "--label, -l");
    assertStringIncludes(body, "A label for the batch");
    // A CLI global is never offered, even when a verb declares it.
    assertEquals(body.includes('name="flag:cwd"'), false);
    // positionals: a required text input, and a row editor for the variadic one.
    assertStringIncludes(
      body,
      'name="pos:0" value="" maxlength="4096" id="cmd-seed-pos:0" required>',
    );
    assertStringIncludes(body, 'name="pos:1" value=""');
    assertStringIncludes(body, 'value="add:1:pos:1"');
    assertStringIncludes(body, "files…");
    // Enter in a field runs the verb, not the first row's remove button.
    assertStringIncludes(body, '<button type="submit" hidden tabindex="-1" aria-hidden="true">Run');
    assertStringIncludes(body, 'name="verb" value="seed"');
  });
});

Deno.test("argv: a checked switch, a number, and a string with spaces as ONE element", async () => {
  await withProject(listing([SEED]), async (dir) => {
    const { status, runs } = await submitRun(dir, {
      verb: "seed",
      "flag:force": ["false", "true"],
      "flag:rows": "12.5",
      "flag:label": "two words here",
      "flag:fresh": ["false", "true"],
      "pos:0": "users",
      "pos:1": ["a.json", "", "b.json"],
    });
    assertEquals(status, 200);
    assertEquals(runs, [[
      "seed",
      "--cwd",
      dir,
      "--force",
      "--rows",
      "12.5",
      "--label",
      "two words here",
      "--fresh",
      "users",
      "a.json",
      "b.json",
    ]]);
  });
});

Deno.test("argv: an empty submission adds nothing, and a default-on switch turns off", async () => {
  await withProject(listing([OPTS, SEED]), async (dir) => {
    // Exactly what a browser posts for the untouched form: hidden twins and blank fields.
    const blank = await submitRun(dir, {
      verb: "opts",
      "flag:dry": "false",
      "flag:note": "",
      "flag:limit": " ",
      "pos:0": "",
      "pos:1": "",
    });
    assertEquals(blank.runs, [["opts", "--cwd", dir]]);
    // Unchecking a default-on switch is the one case the form must say out loud.
    const off = await submitRun(dir, { verb: "seed", "flag:fresh": "false", "pos:0": "users" });
    assertEquals(off.runs, [["seed", "--cwd", dir, "--fresh=false", "users"]]);
  });
});

Deno.test("argv: an undeclared or reserved field is ignored, never forwarded", async () => {
  await withProject(listing([SEED]), async (dir) => {
    const { runs } = await submitRun(dir, {
      verb: "seed",
      "flag:evil": "1",
      "flag:cwd": "/etc",
      "flag:config": "/tmp/evil.ts",
      "flag:help": "true",
      evil: "--cwd",
      "pos:9": "/etc",
      "pos:0": "users",
    });
    assertEquals(runs, [["seed", "--cwd", dir, "users"]]);
  });
});

Deno.test("argv: shell metacharacters and newlines arrive verbatim, each ONE element", async () => {
  await withProject(listing([SEED]), async (dir) => {
    const label = "a; rm -rf ~ && $(whoami) `id` | tee x\nnext line";
    const table = "users; echo $(pwned) > /tmp/x";
    const { runs } = await submitRun(dir, {
      verb: "seed",
      "flag:label": label,
      "pos:0": table,
    });
    assertEquals(runs, [["seed", "--cwd", dir, "--label", label, table]]);
    // A string VALUE that looks like a flag stays the value of the flag before it, and the
    // pinned `--cwd` is still the first one (which is what the CLI's pre-scan reads).
    const tricky = await submitRun(dir, { verb: "seed", "flag:label": "--cwd", "pos:0": "t" });
    assertEquals(tricky.runs, [["seed", "--cwd", dir, "--label", "--cwd", "t"]]);
    assertEquals(tricky.runs[0].indexOf("--cwd"), 1);
  });
});

Deno.test("a positional that would pass for a flag is refused with 422, nothing spawned", async () => {
  await withProject(listing([SEED]), async (dir) => {
    for (const value of ["--cwd=/etc", "-rf", "--"]) {
      const { status, text, runs } = await submitRun(dir, { verb: "seed", "pos:0": value });
      assertEquals(status, 422, value);
      const body = JSON.parse(text);
      assertEquals(body.ok, false);
      assertEquals(body.field, "pos:0");
      assertEquals(runs, [], `${value} spawned nothing`);
    }
    const row = await submitRun(dir, { verb: "seed", "pos:0": "t", "pos:1": ["ok", "--config"] });
    assertEquals([row.status, JSON.parse(row.text).field, row.runs], [422, "pos:1", []]);
  });
});

Deno.test("a number that is not finite is refused with 422 naming the flag", async () => {
  await withProject(listing([SEED]), async (dir) => {
    for (const value of ["abc", "NaN", "Infinity", "-Infinity", "1e400"]) {
      const { status, text, runs } = await submitRun(dir, {
        verb: "seed",
        "flag:rows": value,
        "pos:0": "users",
      });
      assertEquals(status, 422, value);
      const body = JSON.parse(text);
      assertEquals(body.field, "flag:rows");
      assertStringIncludes(body.reason, "finite number");
      assertEquals(runs, []);
    }
    const negative = await submitRun(dir, { verb: "seed", "flag:rows": "-3", "pos:0": "t" });
    assertEquals(negative.runs, [["seed", "--cwd", dir, "--rows", "-3", "t"]]);
  });
});

Deno.test("required, gapped, oversized and NUL-carrying values are refused with 422", async () => {
  await withProject(listing([SEED, OPTS]), async (dir) => {
    const missing = await submitRun(dir, { verb: "seed", "pos:0": "" });
    assertEquals(missing.status, 422);
    assertEquals(JSON.parse(missing.text).field, "pos:0");
    assertStringIncludes(JSON.parse(missing.text).reason, "table is required");
    // `to` without `from` would silently become `from`.
    const gap = await submitRun(dir, { verb: "opts", "pos:0": "", "pos:1": "end" });
    assertEquals([gap.status, JSON.parse(gap.text).field], [422, "pos:1"]);
    const long = await submitRun(dir, { verb: "seed", "pos:0": "x".repeat(4097) });
    assertEquals([long.status, JSON.parse(long.text).field], [422, "pos:0"]);
    const nul = await submitRun(dir, { verb: "seed", "flag:label": "a\0b", "pos:0": "t" });
    assertEquals([nul.status, JSON.parse(nul.text).field], [422, "flag:label"]);
    for (const refused of [missing, gap, long, nul]) assertEquals(refused.runs, []);
  });
});

Deno.test("a verb missing from the REFRESHED listing is refused, whatever fields it posts", async () => {
  await withProject(listing([OPTS]), async (dir) => {
    const { status, text, runs } = await submitRun(dir, {
      verb: "seed",
      "flag:force": "true",
      "pos:0": "users",
    });
    assertEquals(status, 400);
    const body = JSON.parse(text);
    assertStringIncludes(body.reason, 'unknown command "seed"');
    assertEquals(body.runnable, ["opts"]);
    assertEquals(runs, []);
  });
});

Deno.test("a JSON client posts the same field names as keys", async () => {
  await withProject(listing([SEED]), async (dir) => {
    const seen: string[][] = [];
    setCommandRunner(stubRunner([], 0, seen));
    const res = await commandsPanel(
      new Request("http://127.0.0.1/api/commands", { method: "POST" }),
      ctx(dir, {
        method: "POST",
        json: true,
        body: {
          verb: "seed",
          "flag:force": true,
          "flag:rows": 5,
          "flag:fresh": false,
          "pos:0": "users",
          "pos:1": ["a", "b"],
        },
      }),
    );
    assertEquals(res.status, 200);
    const run = seen.find((argv) => argv[3] === "seed");
    assertEquals(run?.slice(3), [
      "seed",
      "--cwd",
      dir,
      "--force",
      "--rows",
      "5",
      "--fresh=false",
      "users",
      "a",
      "b",
    ]);
  });
});

Deno.test("a row button edits the variadic list and re-renders the form — nothing runs", async () => {
  await withProject(listing([SEED]), async (dir) => {
    const added = await submitRun(dir, {
      verb: "seed",
      op: "add:1:pos:1",
      "flag:label": "batch one",
      "pos:0": "users",
      "pos:1": "a.json",
    }, { json: false, fragment: true });
    assertEquals(added.status, 200);
    assertEquals(added.runs, []);
    assertStringIncludes(added.text, '<section id="panel"');
    assertEquals(count(added.text, 'name="pos:1"'), 2);
    assertStringIncludes(added.text, 'name="pos:1" value="a.json"');
    // Everything else the user typed survives the round trip.
    assertStringIncludes(added.text, 'name="flag:label" value="batch one"');
    assertStringIncludes(added.text, 'name="pos:0" value="users"');

    const removed = await submitRun(dir, {
      verb: "seed",
      op: "remove:0:pos:1",
      "pos:1": ["a.json", "b.json"],
    }, { json: false, fragment: true });
    assertEquals(count(removed.text, 'name="pos:1"'), 1);
    assertStringIncludes(removed.text, 'name="pos:1" value="b.json"');

    // Only a variadic positional's rows are editable.
    for (const op of ["add:0:pos:0", "add:0:flag:label", "rm -rf /"]) {
      const bad = await submitRun(dir, { verb: "seed", op, "pos:0": "users" });
      assertEquals([bad.status, bad.runs], [400, []], op);
    }
  });
});

Deno.test("read-only renders the run form disabled and still refuses the run", async () => {
  await withProject(listing([SEED]), async (dir) => {
    const res = await commandsPanel(
      new Request("http://127.0.0.1/commands"),
      ctx(dir, { readOnly: true }),
    );
    const body = await res.text();
    assertStringIncludes(body, '<button type="submit" disabled>Run</button>');
    assertStringIncludes(
      body,
      'name="flag:rows" value="" step="any" id="cmd-seed-flag:rows" placeholder="100" disabled>',
    );
    assertEquals(body.includes('value="add:1:pos:1"'), false, "no + Add under read-only");

    const run = await submitRun(dir, { verb: "seed", "pos:0": "users" }, { readOnly: true });
    assertEquals(run.status, 403);
    assertStringIncludes(JSON.parse(run.text).reason, "read-only");
    assertEquals(run.runs, []);
  });
});

// ── --offline ────────────────────────────────────────────────────────────────

Deno.test("--offline: discovery and every run start --deny-net --cached-only; online argv is unchanged", async () => {
  await withProject(listing([GREET]), async (dir) => {
    const seen: string[][] = [];
    setCommandRunner(stubRunner(["ran"], 0, seen));
    const post = (offline: boolean) =>
      commandsPanel(
        new Request("http://127.0.0.1/api/commands", { method: "POST" }),
        ctx(dir, { offline, json: true, method: "POST", form: runBody("greet") }),
      );
    assertEquals((await (await post(true)).json()).ok, true);
    assertEquals(seen.map((argv) => argv.slice(0, 4)), [
      ["run", "-A", "--deny-net", "--cached-only"],
      ["run", "-A", "--deny-net", "--cached-only"],
    ]);
    assertEquals(seen.map((argv) => argv[5]), ["commands", "greet"], "one discovery, one run");

    seen.length = 0;
    assertEquals((await (await post(false)).json()).ok, true);
    assertEquals(seen.length, 2, "the online listing is its own cache entry, discovered afresh");
    for (const argv of seen) {
      assertEquals(argv.slice(0, 2), ["run", "-A"]);
      assertStringIncludes(argv[2], "cli.ts");
      assert(!argv.includes("--deny-net") && !argv.includes("--cached-only"), argv.join(" "));
    }
  });
});

Deno.test("--offline: the panel says every verb runs without the network", async () => {
  await withProject(listing([GREET]), async (dir) => {
    const page = async (offline: boolean) =>
      await (await commandsPanel(new Request("http://127.0.0.1/commands"), ctx(dir, { offline })))
        .text();
    assertStringIncludes(await page(true), "every verb runs with --deny-net --cached-only");
    assert(!(await page(false)).includes("--deny-net"));
  });
});

Deno.test("with JavaScript off a refused run answers with the panel and the reason, not JSON", async () => {
  await withProject(listing([GREET, SEED]), async (dir) => {
    const post = (form: FormData, over: Partial<UiContext> = {}) =>
      commandsPanel(
        new Request("http://127.0.0.1/commands", { method: "POST" }),
        ctx(dir, { method: "POST", form, ...over }),
      );
    const unknown = await post(runBody("rm -rf /"));
    assertEquals(unknown.status, 400);
    assertStringIncludes(unknown.headers.get("content-type") ?? "", "text/html");
    const page = await unknown.text();
    assertStringIncludes(page, 'role="alert"');
    assertStringIncludes(page, "unknown command");

    const locked = await post(runBody("greet"), { readOnly: true });
    assertEquals(locked.status, 403);
    assertStringIncludes(await locked.text(), "read-only — running a verb may write");

    const bad = new FormData();
    bad.set("verb", "seed");
    bad.set("pos:0", "--cwd=/etc");
    const field = await post(bad);
    assertEquals(field.status, 422);
    const html = await field.text();
    assertStringIncludes(html, 'role="alert"');
    assertStringIncludes(html, "--cwd=/etc", "the submitted value is kept in the form");
  });
});
