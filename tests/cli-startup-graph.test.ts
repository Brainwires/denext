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
import {
  computedModuleUrls,
  ENTRY_LAZY_MODULES,
  generate,
  MODULES_OUT,
  OFFLINE_OUT,
  TABLE_OUT,
} from "../scripts/gen-command-table.ts";
import { CLI_MODULES_URL } from "../src/cli/cli-cache.ts";
import { boundedOutput, childDeadlineMs, retryOnStall } from "../src/build/serial-child.ts";
import { VERSION as CLI_VERSION } from "../src/version.ts";
import { VERSION } from "../mod.ts";
import { CLI_COMPILE_INCLUDES, compileCliArgs } from "../scripts/compile-cli.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

/** `deno info --json`'s view of one root. */
interface ModuleInfo {
  roots: string[];
  redirects?: Record<string, string>;
  modules: Array<{ specifier: string; dependencies?: Array<{ code?: { specifier: string } }> }>;
}

/**
 * `deno info --json <root>`, the way the build runs it (src/build/serial-child.ts): one `deno info`
 * child at a time in this process, read until it exits, killed at its deadline and retried once.
 * On Windows a `deno info` child started beside the other Deno children of `deno test --parallel`
 * sometimes never exits; unbounded, that held this file until the 600 s stall watchdog.
 */
async function info(root: string): Promise<ModuleInfo> {
  // a file URL, not a path: `deno info` reads a Windows `C:\…` path as a URL with scheme "c"
  const args = ["info", "--json", toFileUrl(join(ROOT, root)).href];
  const { stdout, success } = await retryOnStall(
    "deno info",
    args,
    (deadline) =>
      boundedOutput(
        new Deno.Command(Deno.execPath(), {
          args,
          cwd: ROOT,
          stdin: "null",
          stdout: "piped",
          stderr: "null",
        }).spawn(),
        { stdout: true, stderr: false },
        deadline,
        "deno info",
      ),
    childDeadlineMs(120_000),
  );
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
  const { table, modules, offline } = await generate();
  const stale = "is stale: run `deno task gen:command-table` and commit";
  assertEquals(await Deno.readTextFile(TABLE_OUT), table, `command-table.generated.ts ${stale}`);
  assertEquals(await Deno.readTextFile(MODULES_OUT), modules, `lazy-modules.generated.ts ${stale}`);
  assertEquals(
    await Deno.readTextFile(OFFLINE_OUT),
    offline,
    `offline-modules.generated.ts ${stale}`,
  );
});

Deno.test("the CLI's offline cache covers every module a verb can load", async () => {
  // What `denext toolchain install` (and a remote CLI's first-run warm-up) `deno cache`s.
  assertEquals(CLI_MODULES_URL, toFileUrl(OFFLINE_OUT).href);
  const real = Deno.realPathSync(ROOT);
  const graph = new Set(
    [...await staticGraph("src/cli/offline-modules.generated.ts")].map((url) =>
      url.startsWith("file:") ? toFileUrl(Deno.realPathSync(fromFileUrl(url))).href : url
    ),
  );
  const missing = (files: readonly string[]) =>
    files.filter((file) => !graph.has(toFileUrl(join(real, file)).href));
  // Every verb module the lazy table imports on demand, and the entrypoint's own lazy modules.
  const table = await Deno.readTextFile(TABLE_OUT);
  const verbs = [...table.matchAll(/(?:spec|factory)\("(\.\/[^"]+)"/g)].map((m) => m[1]);
  assert(verbs.length > 30, `only ${verbs.length} verb modules in the table`);
  const cli = (rel: string) => join("src/cli", rel);
  assertEquals(missing([...new Set([...verbs, ...ENTRY_LAZY_MODULES])].map(cli)), [], "lazy");
  // Every framework export: a build bundles and a server loads them by URL.
  const { exports } = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json"))) as {
    exports: Record<string, string>;
  };
  const exported = Object.values(exports).filter((p) => /\.(?:ts|tsx|js|mjs)$/.test(p));
  assertEquals(missing(exported), [], "exports");
  // Every module src/ loads through a computed URL (the desktop sidecar bundler, a worker, …).
  const computed = await computedModuleUrls();
  const rel = (file: string) => file.slice(ROOT.length).replace(/^[\\/]/, "");
  assert(
    computed.some((f) => f.endsWith("desktop-sidecar-bundle.ts")),
    "a `new URL(CONST, import.meta.url)` module is found",
  );
  assert(
    computed.some((f) => f.endsWith("client-runtime.ts")),
    "a frameworkFileUrl module is found",
  );
  assertEquals(missing(computed.map(rel)), [], "computed URLs");
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

Deno.test("every compile of the CLI goes through scripts/compile-cli.ts", async () => {
  // A binary built without `--include src/cli/lazy-modules.generated.ts` starts and prints its
  // version, but every verb fails to load; one built without the framework files the CLI reads
  // at run time (deno.json) fails in those verbs (4.5.1: `migrate`, then still reading AGENTS.md
  // for the MCP guide).
  // So no place spells out its own `deno compile … cli.ts`: each runs the one script.
  const files = [
    "deno.json",
    ...[...Deno.readDirSync(join(ROOT, ".github/workflows"))].map((e) =>
      `.github/workflows/${e.name}`
    ),
  ];
  let compiles = 0;
  for (const file of files) {
    const text = await Deno.readTextFile(join(ROOT, file));
    for (const line of text.split("\n")) {
      assert(
        !/deno compile .*cli\.ts/.test(line),
        `${file} compiles the CLI by hand: ${line.trim()}`,
      );
      if (line.includes("scripts/compile-cli.ts")) compiles++;
    }
  }
  // publish.yml's release binaries, e2e, desktop-ci (3) and the task.
  assert(compiles >= 6, `found ${compiles} compiles of the CLI; the scan lost some`);
  for (const file of CLI_COMPILE_INCLUDES) {
    assert((await Deno.stat(join(ROOT, file))).isFile, `${file} is embedded but missing`);
  }
  assert(CLI_COMPILE_INCLUDES.includes("src/cli/lazy-modules.generated.ts"));
  const args = compileCliArgs({ output: "out", target: "x86_64-unknown-linux-gnu" });
  assertEquals(args.slice(0, 4), ["compile", "-A", "--target", "x86_64-unknown-linux-gnu"]);
  assertEquals(args.slice(-3), ["--output", "out", "cli.ts"]);
  for (const file of CLI_COMPILE_INCLUDES) {
    assert(args.join(" ").includes(`--include ${file}`), file);
  }
});
