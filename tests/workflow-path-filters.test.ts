// The `push: paths:` filters of the path-filtered workflows cover what those workflows run.
//
// A workflow with a paths filter runs only when a listed path changes. When one of the tests or
// scripts it runs imports a module the filter misses, a change to that module skips the workflow,
// and its regression goes unseen until something else triggers it. For each such workflow this
// test builds the module graph of its entry tests and scripts with `deno info --json` and fails,
// naming each missing path, when a file the graph reaches matches no filter.
//
// The graph is followed from the entries and through the workflow's `owned` code (what the
// workflow exists to test), one import deep into everything else: a filter must list every module
// the entries and the owned code import directly. Following every import to the bottom would list
// nearly all of src/ and run the workflow on every push. The desktop workflows also leave the
// render / server / runtime layers to ci.yml's `check` job, which runs the whole unit suite on
// every push (each says so in its own header); those layers are `delegated` and never followed.

import { assert, assertEquals } from "@std/assert";
import { expandGlob } from "@std/fs";
import { fromFileUrl, globToRegExp, join, relative, toFileUrl } from "@std/path";
import { parse } from "@std/yaml";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** Entry globs resolved with the deno.json of `cwd` (an example with its own import map). */
interface EntryGroup {
  cwd: string;
  entries: string[];
}

/** One path-filtered workflow: what it runs, its own code, and the layers it leaves to ci.yml. */
interface FilteredWorkflow {
  /** The workflow file, repository-relative. */
  file: string;
  /** The tests and scripts its steps run (repository-relative globs or groups). */
  entries: (string | EntryGroup)[];
  /** Globs of the code the workflow exists to test: imports are followed through these. */
  owned?: string[];
  /** Repository-relative prefixes left to ci.yml's every-push `check` job (not followed). */
  delegated?: string[];
}

/** The render / server / runtime layers the desktop workflows leave to ci.yml (every push). */
const CORE_LAYERS = [
  "mod.ts",
  "src/client/",
  "src/server/",
  "src/runtime/",
  "src/jsx/",
  "src/router/",
  "src/compat/",
  "src/utils/",
  "src/class-runtime.ts",
  "src/globals.d.ts",
  "packages/",
];

const WORKFLOWS: FilteredWorkflow[] = [
  {
    file: ".github/workflows/desktop-ci.yml",
    entries: [
      // `deno task test:desktop` / `coverage:desktop` (deno.json)
      "tests/desktop-*.test.ts",
      "tests/safe-extract*.test.ts",
      "tests/cli-desktop-*.test.ts",
      "tests/notification-trigger.test.ts",
      "tests/coverage-floor.test.ts",
      "tests/project-locks.test.ts",
      "tests/install-sh.test.ts",
      "tests/react-native-core-desktop.test.ts",
      "scripts/coverage-floor.ts",
      // the jobs' own steps
      "scripts/ci/desktop-*.ts",
      "tests/integration/scaffold.test.ts",
      "tests/install-ps1.test.ts",
      {
        cwd: "examples/native",
        entries: ["examples/native/desktop.ts", "examples/native/scripts/*.ts"],
      },
    ],
    owned: [
      "src/desktop/**",
      "src/build/desktop*.ts",
      "src/cli/commands/desktop*.ts",
      "src/react-native/desktop*.ts",
      "src/mobile/**",
      "tests/helpers/**",
      "tests/_*.ts",
    ],
    delegated: CORE_LAYERS,
  },
  {
    file: ".github/workflows/desktop-window.yml",
    // `deno task test:window` in the kitchen sink: it runs `denext desktop package` (the CLI's
    // desktop, serve and patch commands, which export through src/build) and the packaged app.
    entries: [
      "examples/desktop-kitchen-sink/e2e/window-test.ts",
      "scripts/ci/desktop-window-summary.ts",
      "src/cli/commands/desktop*.ts",
      "src/cli/commands/serve.ts",
      "src/cli/commands/patch.ts",
    ],
    owned: ["src/desktop/**", "src/build/**", "src/cli/commands/desktop*.ts", "src/mobile/**"],
    delegated: CORE_LAYERS,
  },
  {
    file: ".github/workflows/parity-native.yml",
    // `deno task parity:native`
    entries: ["scripts/parity/native/check.ts"],
    owned: [
      "scripts/parity/**",
      "src/react-native/**",
      "src/react-native-compat/**",
      "src/expo/**",
      "src/build/react-native*.ts",
      "src/build/expo*.ts",
    ],
  },
  {
    file: ".github/workflows/parity-drift.yml",
    // `deno task parity:drift`, and the child process it extracts the real surface in
    entries: ["scripts/parity/refresh.ts", "scripts/parity/_real-runner.ts"],
    owned: ["scripts/parity/*.ts"],
  },
];

/** The workflow's `on.push.paths` filter, or undefined without one. */
async function pushPaths(file: string): Promise<string[] | undefined> {
  const doc = parse(await Deno.readTextFile(join(ROOT, file))) as {
    on?: { push?: { paths?: string[] } };
  };
  return doc.on?.push?.paths;
}

/** Whether `path` passes a GitHub `paths` filter: the last pattern that matches decides. */
function matchesFilter(path: string, patterns: readonly string[]): boolean {
  let included = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const glob = negated ? pattern.slice(1) : pattern;
    if (globToRegExp(glob, { extended: true, globstar: true }).test(path)) included = !negated;
  }
  return included;
}

/** The repository-relative files `globs` name. */
async function expand(globs: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const glob of globs) {
    for await (const f of expandGlob(glob, { root: ROOT, includeDirs: false })) {
      files.push(relative(ROOT, f.path).replaceAll("\\", "/"));
    }
  }
  return files;
}

/** One module of `deno info --json`: its specifier and what it imports. */
interface InfoModule {
  specifier: string;
  dependencies?: { code?: { specifier?: string }; type?: { specifier?: string } }[];
}

/** `deno info --json` over a module importing every one of `files`, run in `cwd`. */
async function denoInfo(files: readonly string[], cwd: string): Promise<Map<string, InfoModule>> {
  const dir = await Deno.makeTempDir({ prefix: "denext-path-filters-" });
  try {
    const entry = join(dir, "entries.ts");
    await Deno.writeTextFile(
      entry,
      files.map((f) => `import ${JSON.stringify(toFileUrl(join(ROOT, f)).href)};`).join("\n"),
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["info", "--json", "--no-lock", entry], // never rewrite a lockfile
      cwd,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(out.success, `deno info failed:\n${new TextDecoder().decode(out.stderr)}`);
    const info = JSON.parse(new TextDecoder().decode(out.stdout)) as { modules: InfoModule[] };
    return new Map(info.modules.map((m) => [m.specifier, m]));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const ROOT_URL = toFileUrl(ROOT).href.replace(/\/?$/, "/");

/** The repository-relative path of a `file:` specifier in the repository, else null. */
function localPath(specifier: string): string | null {
  return specifier.startsWith(ROOT_URL)
    ? decodeURIComponent(specifier.slice(ROOT_URL.length))
    : null;
}

/** The specifiers `module` imports (code and types). */
function importsOf(module: InfoModule | undefined): string[] {
  return (module?.dependencies ?? []).flatMap((dep) =>
    [dep.code?.specifier, dep.type?.specifier].filter((s): s is string => s !== undefined)
  );
}

/** `workflow`'s entries as groups: the plain globs together, resolved from the repository root. */
function entryGroups(workflow: FilteredWorkflow): EntryGroup[] {
  const rootGlobs = workflow.entries.filter((e) => typeof e === "string");
  return [
    ...(rootGlobs.length > 0 ? [{ cwd: ".", entries: rootGlobs }] : []),
    ...workflow.entries.filter((e) => typeof e !== "string"),
  ];
}

/**
 * Add to `reached` the repository files `group` reaches: its entries, and every import of an entry
 * or of an owned module, followed through owned modules and never into a delegated layer.
 */
async function walkGroup(
  workflow: FilteredWorkflow,
  group: EntryGroup,
  reached: Set<string>,
): Promise<void> {
  const files = await expand(group.entries);
  assert(files.length > 0, `${workflow.file}: no file matches ${group.entries.join(", ")}`);
  const modules = await denoInfo(files, join(ROOT, group.cwd));
  const delegated = workflow.delegated ?? [];
  const follow = (path: string) =>
    files.includes(path) || matchesFilter(path, workflow.owned ?? []);
  const followed = new Set<string>();
  const queue = files.map((f) => toFileUrl(join(ROOT, f)).href);
  while (queue.length > 0) {
    const specifier = queue.pop()!;
    const path = localPath(specifier);
    if (path === null || followed.has(path) || delegated.some((d) => path.startsWith(d))) continue;
    reached.add(path);
    if (!follow(path)) continue;
    followed.add(path);
    queue.push(...importsOf(modules.get(specifier)));
  }
}

/** The repository files `workflow` reaches (see {@linkcode walkGroup}). */
async function reachedFiles(workflow: FilteredWorkflow): Promise<Set<string>> {
  const reached = new Set<string>();
  for (const group of entryGroups(workflow)) await walkGroup(workflow, group, reached);
  return reached;
}

/** The files `workflow` reaches that `patterns` (default: its push filter) misses, sorted. */
async function uncovered(workflow: FilteredWorkflow, patterns?: string[]): Promise<string[]> {
  patterns ??= await pushPaths(workflow.file);
  assert(patterns, `${workflow.file} has no push paths filter`);
  const filter = patterns;
  return [...await reachedFiles(workflow)].filter((f) => !matchesFilter(f, filter)).sort();
}

for (const workflow of WORKFLOWS) {
  Deno.test(`${workflow.file}: the push paths filter covers every module its steps import`, async () => {
    const missing = await uncovered(workflow);
    assertEquals(
      missing,
      [],
      `${workflow.file} runs code its push \`paths\` filter does not list, so a change there ` +
        `skips the workflow. Add these paths (or a glob over them) to on.push.paths:\n  ` +
        missing.join("\n  "),
    );
  });
}

Deno.test("workflow path filters: a module missing from a filter is reported by its path", async () => {
  const parity = WORKFLOWS.find((w) => w.file.endsWith("parity-native.yml"))!;
  const patterns = (await pushPaths(parity.file))!.filter((p) => p !== "src/runtime/hooks.ts");
  assertEquals(await uncovered(parity, patterns), ["src/runtime/hooks.ts"]);
});

Deno.test("workflow path filters: GitHub's paths semantics (globs, globstar, negation)", () => {
  assert(matchesFilter("src/desktop/a/b.ts", ["src/desktop/**"]));
  assert(matchesFilter("src/build/desktop-run.ts", ["src/build/desktop*.ts"]));
  assert(!matchesFilter("src/build/sub/desktop-run.ts", ["src/build/desktop*.ts"]));
  assert(!matchesFilter("scripts/parity/native/check.ts", ["scripts/parity/*.ts"]));
  assert(!matchesFilter("src/a.ts", ["src/**", "!src/a.ts"]));
  assert(matchesFilter("src/a.ts", ["!src/a.ts", "src/**"]));
});
