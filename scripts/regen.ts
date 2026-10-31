// Regenerate every committed file a CI drift test compares against its generator, in dependency
// order, so one command brings a branch back in line before a push:
//
//   deno task regen            # rewrite the stale ones (then commit them)
//   deno task regen --check    # exit 1 and list the stale ones; the working tree is left as it was
//
// Each step is the generator its drift test names (tests/plugin-catalog.test.ts,
// tests/mcp-docs-corpus.test.ts, tests/docs-generated.test.ts, tests/config-schema.test.ts,
// tests/integration/scaffold.test.ts, tests/serial-tests.test.ts, …); the tests stay the backstop in CI. `--check` snapshots
// every output, runs the generators, compares, and puts the snapshot back, so a dirty working tree
// is never lost. Not covered: the test-count badge (main and release PRs only; the release script
// regenerates it) and the API reference (`deno task docs:api`, which CI does not diff).

import { fromFileUrl, join, relative } from "@std/path";
import { linkedLockFiles } from "./sync-example-locks.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** One generator: a script (run with `deno run -A`) or an in-process step, and what it writes. */
export interface RegenStep {
  /** The task or command a person would run for this output alone. */
  readonly name: string;
  /** `deno run -A <script> ...args`, repo-relative. */
  readonly script?: readonly string[];
  /** An in-process step (copies and other one-liners). */
  readonly run?: () => Promise<void>;
  /** The files it (re)writes, repo-relative. */
  readonly outputs: readonly string[];
  /**
   * When it runs: the steps of one phase run concurrently, the phases in order. A step that reads
   * another's output, or writes the same file, sits in a later phase.
   */
  readonly phase: 1 | 2 | 3 | 4;
}

const copy = (from: string, to: string) => async () => {
  await Deno.writeTextFile(join(ROOT, to), await Deno.readTextFile(join(ROOT, from)));
};

/** The desktop examples whose packaging scripts are the scaffold's, byte for byte. */
export const PACKAGE_SCRIPT_EXAMPLES = ["examples/native", "examples/rn-desktop"] as const;
const PACKAGE_SCRIPTS = ["macos", "linux", "windows"].map((os) => `scripts/package-${os}.ts`);

async function writePackageScripts(): Promise<void> {
  const { scaffoldFiles } = await import("../src/build/scaffold.ts");
  const files = scaffoldFiles({ dir: "/x", desktop: true });
  for (const path of PACKAGE_SCRIPTS) {
    const content = files.find((f) => f.path === path)?.content;
    if (content === undefined) throw new Error(`the desktop scaffold no longer emits ${path}`);
    for (const example of PACKAGE_SCRIPT_EXAMPLES) {
      await Deno.writeTextFile(join(ROOT, example, path), content);
    }
  }
}

/** Every step; the corpus and the llms files read the others, so they come last. */
export const STEPS: readonly RegenStep[] = [
  {
    name: "deno task gen:command-table",
    script: ["scripts/gen-command-table.ts"],
    outputs: [
      "src/cli/command-table.generated.ts",
      "src/cli/command-meta.packed.ts",
      "src/cli/lazy-modules.generated.ts",
      "src/cli/offline-modules.generated.ts",
    ],
    phase: 1,
  },
  {
    name: "deno task gen:native-templates",
    script: ["scripts/gen-native-templates.ts"],
    outputs: ["src/build/native-templates.packed.ts", "packages/docs-corpus/native-templates.ts"],
    phase: 1,
  },
  {
    name: "deno task gen:config-schema",
    script: ["scripts/gen-config-schema.ts"],
    outputs: [
      "src/server/config-keys.generated.ts",
      "denext.config.schema.json",
      "src/ui/form/config-schema.packed.ts",
    ],
    phase: 1,
  },
  {
    name: "deno run -A scripts/gen-serial-tests.ts",
    script: ["scripts/gen-serial-tests.ts"],
    outputs: ["tests/serial-tests.ts"],
    phase: 1,
  },
  {
    name: "deno task gen:plugin-catalog",
    script: ["scripts/gen-plugin-catalog.ts"],
    outputs: ["src/plugin/catalog.json"],
    phase: 1,
  },
  {
    name: "deno run -A scripts/gen-expo-shim-docs.ts",
    script: ["scripts/gen-expo-shim-docs.ts"],
    outputs: ["site/app/docs/react-native/content.md"],
    phase: 1,
  },
  {
    name: "deno run -A scripts/gen-rn-community-docs.ts",
    script: ["scripts/gen-rn-community-docs.ts"],
    outputs: ["site/app/docs/react-native/content.md"],
    phase: 2,
  },
  {
    name: "cp scripts/install.sh site/public/install.sh",
    run: copy("scripts/install.sh", "site/public/install.sh"),
    outputs: ["site/public/install.sh"],
    phase: 1,
  },
  {
    name: "cp scripts/install.ps1 site/public/install.ps1",
    run: copy("scripts/install.ps1", "site/public/install.ps1"),
    outputs: ["site/public/install.ps1"],
    phase: 1,
  },
  {
    name: "the desktop scaffold's package scripts → examples/{native,rn-desktop}/scripts/",
    run: writePackageScripts,
    outputs: PACKAGE_SCRIPT_EXAMPLES.flatMap((e) => PACKAGE_SCRIPTS.map((s) => `${e}/${s}`)),
    phase: 1,
  },
  {
    // Reads the root deno.lock, which no step writes.
    name: "deno task sync:example-locks",
    script: ["scripts/sync-example-locks.ts"],
    outputs: linkedLockFiles(),
    phase: 1,
  },
  {
    name: "deno task docs:mcp",
    script: ["scripts/gen-mcp-reference.ts"],
    outputs: ["site/app/docs/mcp/mcp.json"],
    phase: 1,
  },
  {
    name: "deno task docs:cli",
    script: ["scripts/gen-cli-reference.ts"],
    outputs: ["site/app/docs/cli/cli.json"],
    phase: 2,
  },
  {
    name: "deno task docs:examples",
    script: ["scripts/gen-examples-index.ts"],
    outputs: ["site/app/docs/examples/examples.json"],
    phase: 2,
  },
  {
    name: "deno task docs:fixed",
    script: ["scripts/gen-fixed-page.ts"],
    outputs: ["site/app/docs/fixed/content.md"],
    phase: 2,
  },
  {
    // `--if-stale`: the corpus fingerprints its inputs, so an unchanged corpus is not rebuilt.
    name: "deno task docs:corpus",
    script: ["scripts/gen-docs-corpus.ts", "--if-stale"],
    outputs: ["packages/docs-corpus/mod.ts"],
    phase: 3,
  },
  {
    name: "deno task docs:llms",
    script: ["scripts/gen-llms-txt.ts"],
    outputs: ["site/public/llms.txt", "site/public/llms-full.txt"],
    phase: 4,
  },
];

/** Every output, once each, in step order. */
export function allOutputs(steps: readonly RegenStep[] = STEPS): string[] {
  return [...new Set(steps.flatMap((s) => s.outputs))];
}

async function readOrNull(root: string, path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(join(root, path));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

async function runStep(step: RegenStep, quiet: boolean): Promise<void> {
  if (step.run) return await step.run();
  const { code, stderr, stdout } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", ...step.script!],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!quiet) await Deno.stdout.write(stdout);
  if (code !== 0) {
    await Deno.stderr.write(stderr);
    throw new Error(`${step.name} failed (exit ${code})`);
  }
}

/** Run the steps phase by phase, each phase's steps concurrently. */
async function runPhases(steps: readonly RegenStep[], quiet: boolean): Promise<void> {
  for (const phase of [1, 2, 3, 4]) {
    await Promise.all(
      steps.filter((s) => s.phase === phase).map(async (step) => {
        const t0 = performance.now();
        await runStep(step, quiet);
        if (!quiet) {
          console.log(`regen: ${step.name} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
        }
      }),
    );
  }
}

/** Each output whose bytes differ from `before`, with the first step that writes it. */
async function changedOutputs(
  steps: readonly RegenStep[],
  root: string,
  before: ReadonlyMap<string, Uint8Array | null>,
): Promise<Map<string, string>> {
  const staleBy = new Map<string, string>();
  for (const step of steps) {
    for (const p of step.outputs) {
      if (staleBy.has(p)) continue;
      if (!sameBytes(before.get(p)!, await readOrNull(root, p))) staleBy.set(p, step.name);
    }
  }
  return staleBy;
}

/** Put every output back as `before` held it (removing one that did not exist). */
async function restore(root: string, before: ReadonlyMap<string, Uint8Array | null>) {
  for (const [p, bytes] of before) {
    if (bytes === null) await Deno.remove(join(root, p)).catch(() => {});
    else if (!sameBytes(bytes, await readOrNull(root, p))) {
      await Deno.writeFile(join(root, p), bytes);
    }
  }
}

/** Run every step; returns the outputs whose bytes changed. With `check`, restores them all. */
export async function regen(
  opts: { check?: boolean; quiet?: boolean; steps?: readonly RegenStep[]; root?: string } = {},
): Promise<{ stale: string[]; staleBy: Map<string, string> }> {
  const steps = opts.steps ?? STEPS;
  const root = opts.root ?? ROOT;
  const before = new Map<string, Uint8Array | null>();
  for (const p of allOutputs(steps)) before.set(p, await readOrNull(root, p));
  try {
    await runPhases(steps, opts.quiet ?? false);
    const staleBy = await changedOutputs(steps, root, before);
    return { stale: [...staleBy.keys()], staleBy };
  } finally {
    if (opts.check) await restore(root, before);
  }
}

if (import.meta.main) {
  const check = Deno.args.includes("--check");
  const t0 = performance.now();
  const { stale, staleBy } = await regen({ check, quiet: check }).catch((e: unknown) => {
    console.error(`regen: ${e instanceof Error ? e.message : e}`);
    return Deno.exit(1);
  });
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (stale.length === 0) {
    console.log(`regen: every generated file is current (${secs}s)`);
  } else if (check) {
    console.error(`regen --check: ${stale.length} generated file(s) are stale (${secs}s):`);
    for (const p of stale) console.error(`  ${p}   ← ${staleBy.get(p)}`);
    console.error("Fix: deno task regen && git add -- " + stale.join(" ") + " && git commit");
    Deno.exit(1);
  } else {
    console.log(`regen: rewrote ${stale.length} file(s) (${secs}s); commit them:`);
    for (const p of stale) console.log(`  ${relative(ROOT, join(ROOT, p))}`);
  }
}
