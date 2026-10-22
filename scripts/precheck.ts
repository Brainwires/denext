// The fast gate a push runs first (.githooks/pre-push; `deno task hooks:install` enables it), so
// the failures CI's `check` and `bundle-budget` jobs keep catching never reach a runner:
//
//   deno task precheck                 # against the merge base with origin/development
//   deno task precheck --base <ref>    # against another base
//   deno task precheck --no-budget     # skip the bundle budget even when the client runtime changed
//
// It runs, in order, stopping at nothing (every failure is listed, each with its fix):
//   1. regen --check   every generated file CI diffs is current (scripts/regen.ts)
//   2. fmt + lint      the changed files (the whole repo when deno.json's fmt or lint changed)
//   3. type-check      cli.ts + mod.ts (CI's step) and every changed TypeScript file; changed
//                      `.vitest.ts` files on denext's Deno toolchain, as CI checks them
//   4. drift tests     the consistency tests that turned CI red most often (DRIFT_TESTS)
//   5. doc-lint        when a published module changed (`deno task doc-lint`)
//   6. bundle budget   when a module that can reach the client bundle changed (`deno task budget`)
//   7. cargo audit     when a wasm package's Cargo.lock / Cargo.toml / .cargo/audit.toml changed
//                      (`deno task audit:cargo`; skipped, with a note, without cargo-audit)
//
// It checks the working tree, so uncommitted edits count. The full suites stay in CI.

import { fromFileUrl } from "@std/path";
import { regen } from "./regen.ts";
import { cargoAuditAvailable, isCargoAuditInput } from "./cargo-audit.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/**
 * The tests that compare committed state with its source of truth and need no build. They were
 * most of CI's red `check` runs from 2026-10-13 to 10-20 (plans are local; see CONTRIBUTING.md).
 */
export const DRIFT_TESTS: readonly string[] = [
  "tests/catalog-fixed.test.ts",
  "tests/config-schema.test.ts",
  "tests/docs-examples-index.test.ts",
  "tests/docs-generated.test.ts",
  "tests/docs-tutorial.test.ts",
  "tests/expo-shims-docs.test.ts",
  "tests/generated-files-hook.test.ts",
  "tests/mcp-docs-corpus.test.ts",
  "tests/mcp-search.test.ts",
  "tests/native-templates-packed.test.ts",
  "tests/plugin-catalog.test.ts",
  "tests/react-native-aliases-manifest.test.ts",
  "tests/serial-tests.test.ts",
  "tests/ui-form-widgets.test.ts",
  "tests/workflow-path-filters.test.ts",
];

/** Directories whose modules never reach a page's client bundle (the budget skips them). */
const SERVER_ONLY = /^src\/(cli|mcp|ui|server|lint|deploy|standalone|desktop|testing)\//;

/** Whether `path` is a source file that can change examples/hello's shared client chunks. */
export function reachesClientBundle(path: string): boolean {
  return /^src\/.*\.(ts|tsx|js)$/.test(path) && !SERVER_ONLY.test(path) &&
    !/\.(test|vitest)\.ts$/.test(path);
}

/** Whether `path` is a module `deno task doc-lint` documents (a published source file). */
export function isPublishedSource(path: string): boolean {
  return /^(src|packages\/[^/]+)\/.*\.(ts|tsx)$/.test(path) || /^(mod|cli)\.ts$/.test(path);
}

/** Changed files are type-checked when they are TypeScript the root config compiles. */
export function isCheckable(path: string): boolean {
  return /\.(ts|tsx)$/.test(path) && !path.endsWith(".d.ts") &&
    /^(src|tests|scripts|packages)\//.test(path) && !/\/fixtures?\//.test(path);
}

async function git(...args: string[]): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command("git", { args, cwd: ROOT }).output();
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(stderr)}`);
  return new TextDecoder().decode(stdout).trim();
}

/** Files changed since the merge base with `base`, plus uncommitted and untracked ones. */
async function changedFiles(base: string): Promise<string[]> {
  const mergeBase = await git("merge-base", "HEAD", base).catch(() => "HEAD~1");
  const lists = await Promise.all([
    git("diff", "--name-only", "--diff-filter=ACMR", mergeBase),
    git("ls-files", "--others", "--exclude-standard"),
  ]);
  const files = new Set(lists.flatMap((l) => l.split("\n")).filter(Boolean));
  const present: string[] = [];
  for (const f of files) {
    try {
      if ((await Deno.stat(`${ROOT}${f}`)).isFile) present.push(f);
    } catch { /* deleted in the working tree */ }
  }
  return present.sort();
}

/**
 * Lint and format named files under the root config, as the whole-repo run in CI does (site/ has
 * its own deno.json outside the workspace), and accept a list that config excludes entirely.
 */
const ROOT_CONFIG = ["--config", "deno.json", "--permit-no-files"];

/** Whether deno.json's `fmt` or `lint` section differs from the merge base's (a whole-repo rerun). */
async function lintOrFmtConfigChanged(base: string): Promise<boolean> {
  try {
    const mergeBase = await git("merge-base", "HEAD", base);
    const before = JSON.parse(await git("show", `${mergeBase}:deno.json`));
    const now = JSON.parse(await Deno.readTextFile(`${ROOT}deno.json`));
    return JSON.stringify([before.fmt, before.lint]) !== JSON.stringify([now.fmt, now.lint]);
  } catch {
    return true;
  }
}

interface Outcome {
  name: string;
  ok: boolean;
  secs: number;
  fix?: string;
  skipped?: string;
}

async function deno(args: string[], env?: Record<string, string>): Promise<boolean> {
  const { code } = await new Deno.Command(Deno.execPath(), {
    args,
    cwd: ROOT,
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  return code === 0;
}

async function step(
  outcomes: Outcome[],
  name: string,
  fix: string,
  body: () => Promise<boolean | string>,
): Promise<void> {
  const t0 = performance.now();
  console.log(`\nprecheck: ${name}`);
  const r = await body().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    return false;
  });
  const secs = (performance.now() - t0) / 1000;
  if (typeof r === "string") outcomes.push({ name, ok: true, secs, skipped: r });
  else outcomes.push({ name, ok: r, secs, fix: r ? undefined : fix });
}

function parseArgs(args: readonly string[]) {
  const i = args.indexOf("--base");
  return {
    base: i >= 0 && args[i + 1] ? args[i + 1] : "origin/development",
    budget: !args.includes("--no-budget"),
  };
}

if (import.meta.main) {
  const { base, budget } = parseArgs(Deno.args);
  const t0 = performance.now();
  const changed = await changedFiles(base);
  const configChanged = changed.includes("deno.json") && await lintOrFmtConfigChanged(base);
  const fmtLintTargets = changed.filter((f) => /\.(ts|tsx|js|jsx|json|jsonc|md|css)$/.test(f));
  const checkable = changed.filter(isCheckable);
  const vitest = checkable.filter((f) => f.endsWith(".vitest.ts"));
  const plain = checkable.filter((f) => !f.endsWith(".vitest.ts"));
  console.log(`precheck: ${changed.length} changed file(s) since ${base}`);
  const outcomes: Outcome[] = [];

  await step(
    outcomes,
    "generated files (regen --check)",
    "deno task regen, then commit",
    async () => {
      const { stale, staleBy } = await regen({ check: true, quiet: true });
      for (const p of stale) console.error(`  stale: ${p}   ← ${staleBy.get(p)}`);
      return stale.length === 0;
    },
  );

  await step(outcomes, "fmt", "deno fmt <files> (or deno task check:fix)", async () => {
    if (configChanged) return await deno(["fmt", "--check"]);
    if (fmtLintTargets.length === 0) return "no formattable file changed";
    return await deno(["fmt", "--check", ...ROOT_CONFIG, ...fmtLintTargets]);
  });

  await step(outcomes, "lint", "deno lint --fix, then fix the rest by hand", async () => {
    if (configChanged) return await deno(["lint"]);
    const lintable = fmtLintTargets.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f));
    if (lintable.length === 0) return "no lintable file changed";
    return await deno(["lint", ...ROOT_CONFIG, ...lintable]);
  });

  await step(outcomes, "type-check", "fix the TS errors above", async () => {
    let ok = await deno(["check", "cli.ts", "mod.ts", ...plain]);
    if (vitest.length > 0) {
      // Vitest files type-check only against the toolchain's `vitest` (scripts/test-run.ts).
      ok = await deno(["run", "-A", "scripts/toolchain-deno.ts", "check", ...vitest]) && ok;
    }
    return ok;
  });

  await step(
    outcomes,
    "drift tests",
    "each failure above names its fix (most: deno task regen, then commit)",
    () => deno(["test", "-A", "--unstable-kv", "--parallel", ...DRIFT_TESTS], { NO_COLOR: "1" }),
  );

  await step(outcomes, "doc-lint", "add the missing JSDoc / export the referenced type", () => {
    if (!changed.some(isPublishedSource)) return Promise.resolve("no published module changed");
    return deno(["task", "doc-lint"]);
  });

  await step(
    outcomes,
    "bundle budget (examples/hello)",
    "deno task budget; the message says how far over and what to do",
    () => {
      if (!budget) return Promise.resolve("--no-budget");
      if (!changed.some(reachesClientBundle) && !changed.includes("deno.lock")) {
        return Promise.resolve("no client-reachable module changed");
      }
      return deno(["task", "budget"]);
    },
  );

  await step(
    outcomes,
    "cargo audit (packages/*/Cargo.lock)",
    "deno task audit:cargo; update the crate, or document an unreachable advisory in .cargo/audit.toml",
    async () => {
      if (!changed.some(isCargoAuditInput)) {
        return "no Cargo.lock / Cargo.toml / audit.toml changed";
      }
      if (!await cargoAuditAvailable()) {
        return "cargo-audit not installed (cargo install cargo-audit --locked); CI's cargo-audit job runs it";
      }
      return deno(["task", "audit:cargo"]);
    },
  );

  const total = ((performance.now() - t0) / 1000).toFixed(0);
  console.log("\nprecheck summary:");
  for (const o of outcomes) {
    const mark = o.skipped ? "skip" : o.ok ? " ok " : "FAIL";
    console.log(
      `  [${mark}] ${o.name} (${o.secs.toFixed(1)}s)${o.skipped ? ` — ${o.skipped}` : ""}${
        o.fix ? `\n         fix: ${o.fix}` : ""
      }`,
    );
  }
  const failed = outcomes.filter((o) => !o.ok);
  console.log(
    failed.length ? `precheck: ${failed.length} failed (${total}s)` : `precheck: ok (${total}s)`,
  );
  Deno.exit(failed.length ? 1 : 0);
}
