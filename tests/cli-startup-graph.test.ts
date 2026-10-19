// The `denext` entrypoint loads only what the invocation needs. `cli.ts` statically imports the
// argv parser, the lazy verb table (src/cli/command-table.generated.ts) and help's helpers; a
// verb's implementation, the re-exec gates and project discovery are `import()`ed when used. So
// `denext --version` / `--help` / `commands` / completions never load the dev server, the
// bundler or `denext/server` (before: about 1,050 modules for every verb, `--version` included).
// This holds the line on the static module graph, checks the generated table against the live
// registry, and checks the dependency-free VERSION copy.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { buildRegistry } from "../src/cli/register.ts";
import { buildLazyRegistry } from "../src/cli/lazy-registry.ts";
import { materializeCommand } from "../src/cli/lazy-command.ts";
import { generate, MODULES_OUT, TABLE_OUT } from "../scripts/gen-command-table.ts";
import { VERSION as CLI_VERSION } from "../src/version.ts";
import { VERSION } from "../mod.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

/** `deno info --json`'s view of one root. */
interface ModuleInfo {
  roots: string[];
  redirects?: Record<string, string>;
  modules: Array<{ specifier: string; dependencies?: Array<{ code?: { specifier: string } }> }>;
}

/** `deno info --json <root>`. */
async function info(root: string): Promise<ModuleInfo> {
  const { stdout, success } = await new Deno.Command(Deno.execPath(), {
    // a file URL, not a path: `deno info` reads a Windows `C:\…` path as a URL with scheme "c"
    args: ["info", "--json", toFileUrl(join(ROOT, root)).href],
    cwd: ROOT,
    stdout: "piped",
    stderr: "null",
  }).output();
  assert(success, `deno info ${root}`);
  return JSON.parse(new TextDecoder().decode(stdout));
}

/** Every module reachable from the info's roots through code dependencies, into `out`. */
function walk(graph: ModuleInfo, out: Set<string>): void {
  const redirects = graph.redirects ?? {};
  const follow = (s: string): string => redirects[s] ? follow(redirects[s]) : s;
  const bySpec = new Map(graph.modules.map((m) => [m.specifier, m]));
  const stack = graph.roots.map(follow);
  while (stack.length) {
    const spec = stack.pop()!;
    const mod = bySpec.get(spec);
    if (!mod || out.has(spec)) continue;
    out.add(spec);
    const deps = (mod.dependencies ?? []).flatMap((dep) => dep.code ? [dep.code.specifier] : []);
    stack.push(...deps.map(follow));
  }
}

/**
 * The module graph `deno run` builds for each root before it starts: static imports AND every
 * statically analyzable `import()` (Deno walks those up front too; the CLI's on-demand modules
 * are imported through a computed URL, `importCliModule`, to stay out).
 */
async function staticGraph(...roots: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const root of roots) walk(await info(root), out);
  return out;
}

/** Which of the repo-relative `files` are in `graph`. */
function loaded(graph: Set<string>, files: readonly string[]): string[] {
  return files.filter((file) => graph.has(toFileUrl(join(ROOT, file)).href));
}

/** Modules `commands` and completions must never load statically. */
const HEAVY = [
  "src/server/mod.ts",
  "src/build/css.ts",
  "src/cli/register.ts",
  "src/cli/run-verb.ts",
  "src/cli/commands/serve.ts",
  "mod.ts",
];

/** And `--version` / `--help` not even the project resolver (and the bundler it names). */
const HEAVY_AT_STARTUP = [...HEAVY, "src/build/paths.ts", "src/build/bundle.ts"];

Deno.test("cli.ts loads the parser and the verb table, not the verbs (--version, --help)", async () => {
  const graph = await staticGraph("cli.ts");
  assertEquals(loaded(graph, ["src/cli/command.ts"]), ["src/cli/command.ts"], "graph paths");
  assertEquals(loaded(graph, HEAVY_AT_STARTUP), [], "cli.ts statically reaches a heavy module");
  // 85 modules at the time of writing, 73 of them @std/path; it was 1,048.
  assert(graph.size <= 120, `cli.ts's static graph grew to ${graph.size} modules (cap 120)`);
});

Deno.test("`denext commands` and completions load project discovery, not denext/server", async () => {
  for (const verb of ["commands", "completions"]) {
    const graph = await staticGraph("cli.ts", `src/cli/commands/${verb}.ts`);
    assertEquals(loaded(graph, HEAVY), [], `the ${verb} path statically reaches a heavy module`);
    // `commands`: 171 at the time of writing (the project resolver and the plugin host).
    assert(graph.size <= 220, `the ${verb} path's static graph is ${graph.size} modules (cap 220)`);
  }
});

Deno.test("the committed verb table matches buildRegistry() (drift check)", async () => {
  const { table, modules } = await generate();
  const stale = "is stale: run `deno task gen:command-table` and commit";
  assertEquals(await Deno.readTextFile(TABLE_OUT), table, `command-table.generated.ts ${stale}`);
  assertEquals(await Deno.readTextFile(MODULES_OUT), modules, `lazy-modules.generated.ts ${stale}`);
});

Deno.test("every lazy verb loads the registry's own spec", async () => {
  const eager = buildRegistry();
  const lazy = buildLazyRegistry();
  assertEquals(lazy.names(), eager.names());
  for (const spec of lazy.list()) {
    const real = await materializeCommand(spec);
    const expected = eager.get(spec.name)!;
    // `commands` and `completions` are built over the registry they enumerate: a fresh spec.
    if (spec.name === "commands" || spec.name === "completions") {
      assertEquals(real.name, expected.name);
      assertEquals(real.flags, expected.flags);
    } else {
      assert(real === expected, `${spec.name}: the table loads a different spec`);
    }
    // A plugin's or the project's spec is its own full spec.
    const plain = { name: "x", summary: "", run: () => {} };
    assert(await materializeCommand(plain) === plain);
  }
});

Deno.test("src/version.ts carries the framework VERSION", () => {
  assertEquals(CLI_VERSION, VERSION);
});

Deno.test("every `deno compile` of the CLI embeds the on-demand modules", async () => {
  // A binary built without `--include src/cli/lazy-modules.generated.ts` starts and prints its
  // version, but every verb fails to load. Each place the repo compiles cli.ts must pass it.
  const files = [
    "deno.json",
    ...[...Deno.readDirSync(join(ROOT, ".github/workflows"))].map((e) =>
      `.github/workflows/${e.name}`
    ),
    "tests/integration/cli-compiled-binary.test.ts",
  ];
  let compiles = 0;
  for (const file of files) {
    const text = await Deno.readTextFile(join(ROOT, file));
    // A one-line `deno compile … cli.ts` (workflows, the task), or the test's argv array.
    const lines = text.split("\n").filter((line) => /deno compile .*cli\.ts/.test(line));
    for (const line of lines) {
      compiles++;
      assert(
        line.includes("--include src/cli/lazy-modules.generated.ts"),
        `${file}: ${line.trim()}`,
      );
    }
    if (file.endsWith(".test.ts")) {
      compiles++;
      assert(text.includes(`"src/cli/lazy-modules.generated.ts"`), `${file} compiles without it`);
    }
  }
  // publish.yml's release binaries, e2e, desktop-ci (2), the task and the binary test.
  assert(compiles >= 6, `found ${compiles} compiles of cli.ts; the scan lost some`);
});
