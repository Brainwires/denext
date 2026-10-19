// Generate (or verify) the Shields.io endpoint JSON for the test-count badge.
//
//   deno task badge:tests           # (re)write .github/badges/tests.json
//   deno task badge:tests --check   # exit 1 if the committed JSON is stale
//
// The count is the number of `Deno.test(...)` declarations across the whole
// `tests/` tree, plus the `it(...)` / `test(...)` cases of its Vitest files (`*.vitest.ts`, run on
// denext's Deno toolchain by scripts/test-run.ts) — a deterministic, source-derived figure (no test run needed), so
// the `--check` gate behaves like `deno fmt --check`: fast and never flaky. CI's
// actual test jobs are what prove those tests pass; this badge just reports how
// many there are, and the freshness check keeps the number honest.
//
// The badge the README shows is `main`'s, so it is refreshed where `main` is made: the release
// script (scripts/release.ts, step 3b) regenerates it before the tag, and CI checks it on `main`
// and on the development → main PR. It is NOT part of the pre-commit hook: the count moves with
// every test file a commit adds, so a per-commit badge put two parallel commits in conflict on
// this one file at nearly every rebase.
//
// Inside a git hook (git sets GIT_INDEX_FILE) it counts the STAGED test files, not the working
// tree: other uncommitted work in the tree must not leak into the committed badge, or CI's
// `--check` (which sees only the commit) fails.

import { walk } from "@std/fs/walk";
import { fromFileUrl } from "@std/path";

const REPO_ROOT = fromFileUrl(new URL("../", import.meta.url));
const TESTS_DIR = `${REPO_ROOT}tests`;
/** The badge file (a Shields.io endpoint document). */
export const BADGE_PATH: string = `${REPO_ROOT}.github/badges/tests.json`;

const TEST_RE = /\bDeno\.test\s*\(/g;
/** A Vitest case, one per line: `it(` / `test(` at the start of a (possibly indented) line. */
const VITEST_RE = /^\s*(?:it|test)\s*\(/gm;

/** The test cases one file declares (`path` decides which kind). */
function countIn(path: string, source: string): number {
  const re = path.endsWith(".vitest.ts") ? VITEST_RE : TEST_RE;
  return source.match(re)?.length ?? 0;
}

/** Whether `path` is a test file the badge counts. */
const isTestFile = (path: string) => /\.(?:test|vitest)\.ts$/.test(path);

/** Run git in the repo, `stdin` piped in, and return stdout (throws on failure). */
async function git(args: string[], stdin?: string): Promise<Uint8Array> {
  const child = new Deno.Command("git", {
    args,
    cwd: REPO_ROOT,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
  }).spawn();
  if (stdin !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const out = await child.output();
  if (!out.success) throw new Error(`git ${args.join(" ")} failed`);
  return out.stdout;
}

/**
 * Count the tests in the staged (index) copies of tests/**\/*.{test,vitest}.ts. Every blob is
 * read through ONE `git cat-file --batch` (a `git show` per file cost a process each — over a
 * thousand on every commit).
 */
async function countStagedTests(): Promise<number> {
  const entries = new TextDecoder().decode(await git(["ls-files", "-s", "-z", "--", "tests"]))
    .split("\0").filter(Boolean).map((line) => {
      // `<mode> <object> <stage>\t<path>`
      const tab = line.indexOf("\t");
      const [, object, stage] = line.slice(0, tab).split(" ");
      return { object, stage, path: line.slice(tab + 1) };
    }).filter((e) => e.stage === "0" && isTestFile(e.path));
  const out = await git(["cat-file", "--batch"], entries.map((e) => e.object + "\n").join(""));
  const decoder = new TextDecoder();
  let total = 0;
  let at = 0;
  for (const e of entries) {
    // `<object> blob <size>\n<content>\n` per object, in request order.
    const nl = out.indexOf(10, at);
    const size = Number(decoder.decode(out.subarray(at, nl)).split(" ")[2]);
    total += countIn(e.path, decoder.decode(out.subarray(nl + 1, nl + 1 + size)));
    at = nl + 1 + size + 1;
  }
  return total;
}

/** Count the tests in every *.test.ts / *.vitest.ts under tests/ in the working tree. */
async function countWorkingTreeTests(): Promise<number> {
  let total = 0;
  for await (
    const entry of walk(TESTS_DIR, { exts: [".ts"], match: [/\.(?:test|vitest)\.ts$/] })
  ) {
    total += countIn(entry.path, await Deno.readTextFile(entry.path));
  }
  return total;
}

/** The staged count inside a git hook, else the working-tree count. */
export function countTests(): Promise<number> {
  return Deno.env.get("GIT_INDEX_FILE") ? countStagedTests() : countWorkingTreeTests();
}

/**
 * The badge file's text for a test count: the Shields.io "endpoint" document, pretty-printed
 * with a trailing newline — the same bytes for the same count, wherever it is generated.
 *
 * @param count The number of tests.
 * @returns The JSON text to write.
 */
export function badgeJson(count: number): string {
  const badge = {
    schemaVersion: 1,
    label: "tests",
    message: `${count} passing`,
    color: "brightgreen",
  };
  return JSON.stringify(badge, null, 2) + "\n";
}

/**
 * Write `text` to `path` only when the file's content differs (a missing file counts as
 * different), so regenerating from unchanged inputs leaves the file — its mtime, and the
 * working tree — untouched.
 *
 * @param path The file to write.
 * @param text Its new content.
 * @returns Whether the file was written.
 */
export async function writeIfChanged(path: string, text: string): Promise<boolean> {
  let current: string | null = null;
  try {
    current = await Deno.readTextFile(path);
  } catch { /* missing → written below */ }
  if (current === text) return false;
  await Deno.writeTextFile(path, text);
  return true;
}

if (import.meta.main) {
  const count = await countTests();
  const json = badgeJson(count);

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
  } else if (await writeIfChanged(BADGE_PATH, json)) {
    console.log(`Wrote ${BADGE_PATH} (${count} tests).`);
  } else {
    console.log(`Test-count badge is current (${count} tests); nothing written.`);
  }
}
