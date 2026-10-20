// Where `denext <name>` goes when no built-in claims it, and the names a project verb may not
// take. The rule: the project's config (arbitrary code, imported under the CLI's own permissions)
// is imported only for a name that can be a project verb — never for a script, never for a Deno
// verb that runs or installs code, and for any other Deno verb only when the project's cached
// `denext commands` listing names it.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { writeCommandCache } from "../src/cli/command-cache.ts";
import { loadPluginCommands } from "../src/cli/plugin-commands.ts";
import { buildRegistry } from "../src/cli/register.ts";
import { isReservedDenoVerb, reservedVerbError, unlistedVerbHint } from "../src/cli/deno-verbs.ts";
import { routeUnknownVerb } from "../src/cli/verb-route.ts";
import { applyPlugins, resetPlugins } from "../src/plugin/mod.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import { defaultLoader } from "../src/server/mod.ts";

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const CLI = join(ROOT, "cli.ts");
const DENO_JSON = join(ROOT, "deno.json");
const RESERVED = [
  "run",
  "x",
  "eval",
  "serve",
  "compile",
  "install",
  "uninstall",
  "upgrade",
  "task",
];

/** A temp project holding a `denext.config.ts` with `source` (none when null). */
async function withDir(source: string | null, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_verb_route_" });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
    if (source !== null) await Deno.writeTextFile(join(dir, "denext.config.ts"), source);
    await fn(dir);
  } finally {
    resetPlugins();
    await Deno.remove(dir, { recursive: true });
  }
}

/** `routeUnknownVerb` for `denext <args…>` with the verb at index 0, run in `dir`. */
function route(dir: string, ...args: string[]) {
  return routeUnknownVerb(args, { name: args[0], index: 0 }, dir);
}

Deno.test("reserved Deno verbs: the code-running ones, each with a one-line reason", () => {
  for (const name of RESERVED) assert(isReservedDenoVerb(name), name);
  for (const name of ["bench", "doc", "lint", "seed", "help"]) {
    assert(!isReservedDenoVerb(name), name);
  }
  const reason = reservedVerbError("run");
  assertStringIncludes(reason, "`deno run`");
  assert(!reason.includes("\n"));
  const hint = unlistedVerbHint("bench");
  assertStringIncludes(hint, "`denext commands`");
  assert(!hint.includes("\n"));
});

Deno.test("routeUnknownVerb: a script and a reserved verb go to Deno, whatever the listing says", async () => {
  await withDir("export default {};\n", async (dir) => {
    // Even a listing that claims `run` (a crafted cache) cannot route it to the project.
    await writeCommandCache(dir, [{ name: "run", summary: "x" }, {
      name: "compile",
      summary: "x",
    }]);
    assertEquals(await route(dir, "main.ts", "a"), {
      kind: "deno",
      forward: { args: ["run", "main.ts", "a"], cwd: dir },
      unlisted: false,
    });
    for (const name of ["run", "compile", "x", "eval", "serve", "install"]) {
      const r = await route(dir, name, "y");
      assertEquals(r.kind, "deno", name);
      if (r.kind === "deno") {
        assertEquals(r.forward.args, [name, "y"]);
        assertEquals(r.unlisted, false);
      }
    }
    assertEquals(await route(dir, "https://example.com/x.ts"), {
      kind: "deno",
      forward: { args: ["run", "https://example.com/x.ts"], cwd: dir },
      unlisted: false,
    });
  });
});

Deno.test("routeUnknownVerb: another Deno verb is the project's only when the fresh listing names it", async () => {
  await withDir("export default {};\n", async (dir) => {
    // No listing in a denext project: Deno's, with the hint.
    assertEquals(await route(dir, "bench"), {
      kind: "deno",
      forward: { args: ["bench"], cwd: dir },
      unlisted: true,
    });
    await writeCommandCache(dir, [{ name: "bench", summary: "Mine" }]);
    assertEquals(await route(dir, "bench"), { kind: "project" });
    // A listed project without that verb: Deno's, no hint.
    assertEquals(await route(dir, "doc"), {
      kind: "deno",
      forward: { args: ["doc"], cwd: dir },
      unlisted: false,
    });
    // A changed config makes the listing stale: Deno's again, with the hint.
    await Deno.writeTextFile(join(dir, "denext.config.ts"), "export default { };\n");
    assertEquals(await route(dir, "bench"), {
      kind: "deno",
      forward: { args: ["bench"], cwd: dir },
      unlisted: true,
    });
    // A name that is neither Deno's nor a script may be a project verb: discover.
    assertEquals(await route(dir, "seed"), { kind: "project" });
  });
});

Deno.test("routeUnknownVerb: a committed listing with a computable fingerprint is not trusted", async () => {
  // The audit's proof: the fingerprint was a plain SHA-256 over the project's files and their
  // absolute paths — both predictable in a devcontainer or CI — so a repository could ship a
  // `.denext/commands.json` this machine accepted, rerouting `denext info` / `doc` / `bench` to
  // import its config. It is keyed with a per-machine secret now.
  await withDir("export default {};\n", async (dir) => {
    const parts: Uint8Array[] = [];
    for (const name of ["denext.config.ts", "deno.json"]) {
      const path = join(dir, name);
      let bytes: Uint8Array;
      try {
        bytes = await Deno.readFile(path);
      } catch {
        continue;
      }
      parts.push(new TextEncoder().encode(`${path}:${bytes.length}:`), bytes);
    }
    const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) data.set(part, at), at += part.length;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    const fingerprint = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    await Deno.mkdir(join(dir, ".denext"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, ".denext", "commands.json"),
      JSON.stringify({ fingerprint, verbs: [{ name: "bench", summary: "x" }] }),
    );
    assertEquals(await route(dir, "bench"), {
      kind: "deno",
      forward: { args: ["bench"], cwd: dir },
      unlisted: true,
    });
  });
});

Deno.test("routeUnknownVerb: outside a denext project a Deno verb gets no hint", async () => {
  await withDir(null, async (dir) => {
    assertEquals(await route(dir, "bench"), {
      kind: "deno",
      forward: { args: ["bench"], cwd: dir },
      unlisted: false,
    });
  });
});

Deno.test("config: a `commands:` entry (or alias) named after a reserved Deno verb is refused", () => {
  for (const name of RESERVED) {
    const err = assertThrows(
      () => validateDenextConfig({ commands: [{ name, summary: "s", run: () => {} }] }),
      Error,
    );
    assertStringIncludes(err.message, "`commands[0].name`");
    assertStringIncludes(err.message, `\`deno ${name}\``);
  }
  const aliased = { name: "go", aliases: ["x"], summary: "s", run: () => {} };
  const err = assertThrows(() => validateDenextConfig({ commands: [aliased] }), Error);
  assertStringIncludes(err.message, "`commands[0].aliases[0]`");
  // Other Deno verbs stay allowed (they need a fresh listing to run).
  validateDenextConfig({ commands: [{ name: "bench", summary: "s", run: () => {} }] });
});

Deno.test("plugin addCommand: a reserved name or alias throws from setup", async () => {
  for (const spec of [{ name: "compile" }, { name: "build-it", aliases: ["serve"] }]) {
    resetPlugins();
    const err = await assertRejects(() =>
      applyPlugins({
        projectRoot: ".",
        appDir: "app",
        config: {
          plugins: [{
            name: "greedy",
            setup(ctx) {
              ctx.addCommand({ ...spec, summary: "s", run: () => {} });
            },
          }],
        },
        mode: "build",
        load: defaultLoader,
      }), Error);
    assertStringIncludes(err.message, 'plugin "greedy"');
    assertStringIncludes(err.message, "reserved");
  }
  resetPlugins();
});

Deno.test("loadPluginCommands: a reserved plugin verb fails discovery, registering nothing", async () => {
  const config = `export default {
  plugins: [{ name: "greedy", setup(ctx) {
    ctx.addCommand({ name: "seed", summary: "ok", run: () => {} });
    ctx.addCommand({ name: "run", summary: "takeover", run: () => {} });
  } }],
};
`;
  await withDir(config, async (dir) => {
    const reg = buildRegistry();
    const result = await loadPluginCommands(reg, dir);
    assertEquals(result.loaded, 0);
    assertStringIncludes(result.error ?? "", "reserved");
    assertEquals(reg.get("run"), undefined);
    assertEquals(reg.get("seed"), undefined);
  });
});

// --- through the real CLI -------------------------------------------------------------------

/** Run the CLI as a subprocess in `cwd`. */
async function runCli(
  args: string[],
  cwd: string,
): Promise<{ code: number; out: string; err: string }> {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", DENO_JSON, CLI, ...args],
    cwd,
    env: { DENEXT_DENO: "stock", NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return { code, out: decoder.decode(stdout), err: decoder.decode(stderr) };
}

/** A config that leaves a marker file when it is imported, and declares `verbs`. */
function trapConfig(verbs: string[]): string {
  return `await Deno.writeTextFile(new URL("./IMPORTED.txt", import.meta.url), "config ran");
export default { commands: [${
    verbs.map((v) =>
      `{ name: ${JSON.stringify(v)}, summary: "s", run: () => console.log("PROJECT ${v}") }`
    )
      .join(", ")
  }] };
`;
}

/** Whether the trap config was imported in `dir`. */
async function imported(dir: string): Promise<boolean> {
  try {
    await Deno.stat(join(dir, "IMPORTED.txt"));
    return true;
  } catch {
    return false;
  }
}

Deno.test("`denext <script>` and `denext run|eval …` never import the project's config", async () => {
  await withDir(trapConfig(["run"]), async (dir) => {
    await Deno.writeTextFile(join(dir, "hello.ts"), 'console.log("hello from script");\n');
    const script = await runCli(["hello.ts"], dir);
    assertEquals(script.code, 0, script.err);
    assertEquals(script.out.trim(), "hello from script");
    const run = await runCli(["run", "hello.ts"], dir);
    assertEquals(run.code, 0, run.err);
    assertEquals(run.out.trim(), "hello from script");
    assert(!run.out.includes("PROJECT"), run.out);
    const evaluated = await runCli(["eval", "console.log(1 + 1)"], dir);
    assertEquals(evaluated.out.trim(), "2", evaluated.err);
    assert(!await imported(dir), "the config was imported before Deno ran");
  });
});

Deno.test("a Deno verb with no listing runs Deno's (with one hint), never importing the config", async () => {
  await withDir(trapConfig(["bench"]), async (dir) => {
    const first = await runCli(["bench"], dir);
    assert(!first.out.includes("PROJECT bench"), first.out);
    const hints = first.err.split("\n").filter((l) => l.includes("`denext commands`"));
    assertEquals(hints.length, 1, first.err);
    const again = await runCli(["bench"], dir);
    assert(!again.err.includes("`denext commands`"), again.err);
    assert(!await imported(dir), "the config was imported for a Deno verb");
  });
});
