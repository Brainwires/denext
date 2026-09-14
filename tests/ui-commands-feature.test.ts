// `denext ui` → `/commands`: the project-command panel. Its ONE discovery path is a
// `denext commands --json` subprocess, so these cover parsing that listing, the degraded paths
// (a child that times out, a config the child could not read, output with no listing in it), the
// shared in-flight promise that makes concurrent loads spawn one child, the run gate (unknown
// verb, built-in verb, read-only), and the two run transports (SSE frames for ui.js, a JSON
// envelope for a machine).
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
import { deriveCsrf, UI_COOKIE, UI_CSRF_HEADER } from "../src/ui/security.ts";

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
  await withProject(listing([GREET]), async (dir) => {
    const res = await commandsPanel(
      new Request("http://127.0.0.1/commands", { method: "POST" }),
      ctx(dir, { method: "POST", form: runBody("dev") }),
    );
    assertEquals(res.status, 400);
    assertStringIncludes((await res.json()).reason, "built-in verb");
  });
});

Deno.test("read-only refuses to run a verb — a verb may write anything", async () => {
  await withProject(listing([GREET]), async (dir) => {
    const res = await commandsPanel(
      new Request("http://127.0.0.1/commands", { method: "POST" }),
      ctx(dir, { method: "POST", readOnly: true, form: runBody("greet") }),
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
    discovery = previousDiscovery;
    setCommandRunner(previousRunner);
    await Deno.remove(dir, { recursive: true });
  }
});
