// Generate (or verify) the Shields.io endpoint JSON for the test-count badge.
//
//   deno task badge:tests           # (re)write .github/badges/tests.json
//   deno task badge:tests --check   # exit 1 if the committed JSON is stale
//
// The count is the number of `Deno.test(...)` declarations across the whole
// `tests/` tree — a deterministic, source-derived figure (no test run needed), so
// the `--check` gate behaves like `deno fmt --check`: fast and never flaky. CI's
// actual test jobs are what prove those tests pass; this badge just reports how
// many there are, and the freshness check keeps the number honest.
//
// Inside a git hook (git sets GIT_INDEX_FILE) it counts the STAGED test files, not the working
// tree: other uncommitted work in the tree must not leak into the committed badge, or CI's
// `--check` (which sees only the commit) fails.

import { walk } from "@std/fs/walk";
import { fromFileUrl } from "@std/path";

const REPO_ROOT = fromFileUrl(new URL("../", import.meta.url));
const TESTS_DIR = `${REPO_ROOT}tests`;
const BADGE_PATH = `${REPO_ROOT}.github/badges/tests.json`;

const TEST_RE = /\bDeno\.test\s*\(/g;

/** Run git in the repo and return stdout (throws on failure). */
async function git(args: string[]): Promise<string> {
  const out = await new Deno.Command("git", { args, cwd: REPO_ROOT, stdout: "piped" }).output();
  if (!out.success) throw new Error(`git ${args.join(" ")} failed`);
  return new TextDecoder().decode(out.stdout);
}

/** Count `Deno.test(...)` in the staged (index) copies of tests/**\/*.test.ts. */
async function countStagedTests(): Promise<number> {
  const files = (await git(["ls-files", "-z", "--", "tests"])).split("\0")
    .filter((f) => f.endsWith(".test.ts"));
  let total = 0;
  for (const f of files) {
    total += (await git(["show", `:${f}`])).match(TEST_RE)?.length ?? 0;
  }
  return total;
}

/** Count `Deno.test(...)` declarations across every *.test.ts under tests/ in the working tree. */
async function countWorkingTreeTests(): Promise<number> {
  let total = 0;
  for await (
    const entry of walk(TESTS_DIR, { exts: [".ts"], match: [/\.test\.ts$/] })
  ) {
    total += (await Deno.readTextFile(entry.path)).match(TEST_RE)?.length ?? 0;
  }
  return total;
}

/** The staged count inside a git hook, else the working-tree count. */
function countTests(): Promise<number> {
  return Deno.env.get("GIT_INDEX_FILE") ? countStagedTests() : countWorkingTreeTests();
}

/** The Shields.io "endpoint" badge document for a given test count. */
function badge(count: number): Record<string, unknown> {
  return {
    schemaVersion: 1,
    label: "tests",
    message: `${count} passing`,
    color: "brightgreen",
  };
}

const count = await countTests();
const json = JSON.stringify(badge(count), null, 2) + "\n";

if (Deno.args.includes("--check")) {
  let current: string | null = null;
  try {
    current = await Deno.readTextFile(BADGE_PATH);
  } catch { /* missing → treated as stale below */ }
  if (current !== json) {
    console.error(
      `Test-count badge is out of date (${count} tests found).\n` +
        `Run \`deno task badge:tests\` and commit .github/badges/tests.json.`,
    );
    Deno.exit(1);
  }
  console.log(`Test-count badge is current (${count} tests).`);
} else {
  await Deno.writeTextFile(BADGE_PATH, json);
  console.log(`Wrote ${BADGE_PATH} (${count} tests).`);
}
