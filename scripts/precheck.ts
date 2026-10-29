// The fast gate a push runs first (.githooks/pre-push; `deno task hooks:install` enables it), so
// the failures CI's `check` and `bundle-budget` jobs keep catching never reach a runner:
//
//   deno task precheck                 # against the merge base with origin/development
//   deno task precheck --base <ref>    # against another base
//   deno task precheck --no-budget     # skip the bundle budget even when the client runtime changed
//   deno task precheck --no-tests      # skip the changed files' own tests
//
// It runs, in order, stopping at nothing (every failure is listed, each with its fix):
//   1. regen --check   every generated file CI diffs is current (scripts/regen.ts)
//   2. fmt + lint      the changed files (the whole repo when deno.json's fmt or lint changed)
//   3. type-check      cli.ts + mod.ts (CI's step) and every changed TypeScript file, on denext's
//                      Deno toolchain (native TypeScript 7) as CI checks them — never the `deno`
//                      that happens to be on PATH (a stock 2.9 checks with TypeScript 6)
//   4. drift tests     the consistency tests that turned CI red most often (DRIFT_TESTS)
//   5. test badge      `deno task badge:tests --check` (CI checks it on the dispatched run a
//                      release counts, on `main` and on pull requests)
//   6. affected tests  the changed test files and the test files importing a changed module
//                      (scripts/affected-tests.ts), when there are at most AFFECTED_TESTS_CAP
//   7. doc-lint        when a published module changed (`deno task doc-lint`)
//   8. bundle budget   when a module that can reach the client bundle changed (`deno task budget`)
//   9. cargo audit     when a wasm package's Cargo.lock / Cargo.toml / .cargo/audit.toml changed
//                      (`deno task audit:cargo`; skipped, with a note, without cargo-audit)
//  10. npm audit       when deno.lock, a deno.json or security/npm-audit-allow.json changed
//                      (`deno task audit:npm`: high / critical advisories fail)
//
// The fallow badge has no check mode (its score moves with unrelated churn): the release
// regenerates it.
//
// It checks the working tree, so uncommitted edits count. The full suites stay in CI.

import { fromFileUrl } from "@std/path";
import { regen } from "./regen.ts";
import { cargoAuditAvailable, isCargoAuditInput } from "./cargo-audit.ts";
import { isNpmAuditInput } from "./npm-audit.ts";
import { affectedTests } from "./affected-tests.ts";
import { parallelSuiteFiles } from "./lib/serial-scan.ts";

/**
 * The most affected test files precheck runs itself; past it, it names them and leaves them to
 * the push's CI dispatch (a pre-push hook that runs for many minutes gets skipped).
 */
export const AFFECTED_TESTS_CAP = 25;

/**
 * The type-check's command: `deno check` on denext's Deno toolchain (scripts/toolchain-deno.ts:
 * the running Deno when it is the toolchain, else the pinned build), as CI's "Type check" step
 * runs it after putting the toolchain on PATH.
 *
 * @param files What to check besides cli.ts and mod.ts.
 */
export function typeCheckArgs(files: readonly string[]): string[] {
  return ["run", "-A", "scripts/toolchain-deno.ts", "check", "cli.ts", "mod.ts", ...files];
}

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
  "tests/sanitizer-ratchet.test.ts",
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
    tests: !args.includes("--no-tests"),
  };
}

if (import.meta.main) {
  const { base, budget, tests } = parseArgs(Deno.args);
  const t0 = performance.now();
  const changed = await changedFiles(base);
  const configChanged = changed.includes("deno.json") && await lintOrFmtConfigChanged(base);
  const fmtLintTargets = changed.filter((f) => /\.(ts|tsx|js|jsx|json|jsonc|md|css)$/.test(f));
  const checkable = changed.filter(isCheckable);

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

  await step(
    outcomes,
    "type-check (denext's toolchain, TypeScript 7)",
    "fix the TS errors above (no toolchain yet: denext toolchain install)",
    // `.vitest.ts` files resolve `vitest` only on the toolchain, which now checks everything.
    () => deno(typeCheckArgs(checkable)),
  );

  await step(
    outcomes,
    "drift tests",
    "each failure above names its fix (most: deno task regen, then commit)",
    () => deno(["test", "-A", "--unstable-kv", "--parallel", ...DRIFT_TESTS], { NO_COLOR: "1" }),
  );

  await step(
    outcomes,
    "test-count badge (badge:tests --check)",
    "deno task badge:tests, then commit .github/badges/tests.json",
    () => deno(["task", "badge:tests", "--check"]),
  );

  await step(
    outcomes,
    "affected tests (scripts/affected-tests.ts)",
    "the failures above are the changed files' own tests",
    async () => {
      if (!tests) return "--no-tests";
      const affected = affectedTests(changed, await parallelSuiteFiles());
      if (affected.length === 0) return "no test file changed or imports a changed module";
      if (affected.length > AFFECTED_TESTS_CAP) {
        return `${affected.length} affected test files (over ${AFFECTED_TESTS_CAP}): run ` +
          "`deno run -A scripts/affected-tests.ts <changed files>` and test them before CI";
      }
      console.log(`  ${affected.join("\n  ")}`);
      return await deno(["run", "-A", "scripts/test-run.ts", ...affected], { NO_COLOR: "1" });
    },
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

  await step(
    outcomes,
    "npm audit (deno.lock)",
    "deno task audit:npm; lock a fixed version, or allowlist one still under the age hold in security/npm-audit-allow.json",
    () => {
      if (!changed.some(isNpmAuditInput)) {
        return Promise.resolve("no deno.lock / deno.json / npm-audit-allow.json changed");
      }
      return deno(["task", "audit:npm"]);
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
