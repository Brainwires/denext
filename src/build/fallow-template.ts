// The fallow code-health gate for a generated app — the files and `deno task`s that
// `denext create --fallow` writes and `denext fallow init` adds to an existing project.
// It reproduces the setup denext itself runs on (fallow.toml, a git pre-commit gate, a
// measured-coverage map for the CRAP score, the agent instructions), Deno-first: fallow
// runs from npm through `deno run`, pinned, so nothing has to be installed globally.
//
// Build-time only; never imported by a shipped bundle. The files' texts ship packed
// (fallow-texts.packed.ts, from fallow-texts.ts and denext's own scripts/coverage-to-istanbul.ts).

import { join } from "@std/path";
import {
  AGENTS_MD,
  COVERAGE_TO_ISTANBUL_SCRIPT,
  FALLOW_TOML,
  PRE_COMMIT_HOOK,
} from "./fallow-texts.packed.ts";
import { readJson, setJsonValue } from "./json-edit.ts";

/**
 * The fallow release the generated tasks pin. An exact version (not a range) so a
 * project's gate verdict changes only when its `deno.json` does; it is old enough to
 * clear Deno's default minimum-dependency-age hold.
 */
export const FALLOW_VERSION = "3.30.0";

/** How a generated task runs fallow: from npm through Deno, at the pinned version. */
const FALLOW_RUN = `deno run -A npm:fallow@${FALLOW_VERSION}`;

/** One file the fallow setup writes (repo-relative path + contents, optional mode). */
export interface FallowFile {
  /** Path relative to the project root, `/`-separated. */
  readonly path: string;
  /** The file's text. */
  readonly content: string;
  /** File mode on creation (the git hook is executable). */
  readonly mode?: number;
}

/** Lines the fallow setup adds to `.gitignore`: the coverage output and fallow's cache. */
export const FALLOW_GITIGNORE: readonly string[] = ["coverage/", ".fallow/"];

/**
 * The `deno task` entries the fallow setup adds.
 *
 * - `fallow` runs any fallow command (`deno task fallow health --hotspots`); bare, it
 *   runs dead-code + duplication + health together.
 * - `fallow:audit` is the changed-code gate the pre-commit hook runs (exit 1 on `fail`).
 * - `coverage:fallow` turns `deno test --coverage` into the Istanbul map fallow scores
 *   CRAP with (`coverage/coverage-final.json`), instead of estimating coverage.
 * - `hooks:install` points git at `.githooks/` — the one step that touches `.git`, so it
 *   only happens when the developer runs it.
 *
 * @returns The task name → command map.
 */
export function fallowTasks(): Record<string, string> {
  return {
    "fallow": FALLOW_RUN,
    "fallow:audit": `${FALLOW_RUN} audit --quiet --explain`,
    "coverage:fallow": "rm -rf coverage && deno test -A --coverage=coverage/profile" +
      " && deno coverage coverage/profile --lcov --output=coverage/lcov.info" +
      " && deno run --allow-read --allow-write scripts/coverage-to-istanbul.ts" +
      " coverage/lcov.info coverage/coverage-final.json",
    "hooks:install": "git config core.hooksPath .githooks",
  };
}

/**
 * The files the fallow setup writes. `fallow.toml`, the pre-commit hook and the coverage
 * converter are the gate itself; `AGENTS.md` (plus a `CLAUDE.md` that includes it) carries
 * the instructions agents follow before committing. A caller that adds fallow to an
 * existing project skips any of these that already exist.
 *
 * @returns The files, with repo-relative paths.
 */
export function fallowFiles(): FallowFile[] {
  return [
    { path: "fallow.toml", content: FALLOW_TOML },
    { path: ".githooks/pre-commit", content: PRE_COMMIT_HOOK, mode: 0o755 },
    { path: "scripts/coverage-to-istanbul.ts", content: COVERAGE_TO_ISTANBUL_SCRIPT },
    { path: "AGENTS.md", content: AGENTS_MD },
    { path: "CLAUDE.md", content: "@AGENTS.md\n" },
  ];
}

/** What {@linkcode addFallow} did (or, on a dry run, would do). */
export interface AddFallowResult {
  /** Paths written (relative to the project). */
  readonly written: string[];
  /** Paths left alone because they already exist (or already had the entries). */
  readonly skipped: string[];
}

/**
 * Add the fallow setup to an existing denext project: write the files that are missing,
 * add the missing `deno task`s to `deno.json` (a comment-preserving splice, so a
 * hand-authored file keeps its bytes outside the new keys) and the missing `.gitignore`
 * lines. Never overwrites a file and never touches `.git` — enabling the hook stays the
 * developer's `deno task hooks:install`.
 *
 * @param dir The project root (must hold a `deno.json`).
 * @param options `dryRun` reports the plan without writing anything.
 * @returns What was written and what was skipped.
 * @throws {Error} When the project has no `deno.json` / `deno.jsonc`.
 */
export async function addFallow(
  dir: string,
  options: { dryRun?: boolean } = {},
): Promise<AddFallowResult> {
  const write = options.dryRun !== true;
  const written: string[] = [];
  const skipped: string[] = [];
  for (const file of fallowFiles()) {
    const abs = join(dir, file.path);
    if (await exists(abs)) {
      skipped.push(file.path);
      continue;
    }
    if (write) {
      await Deno.mkdir(join(abs, ".."), { recursive: true });
      await Deno.writeTextFile(abs, file.content, file.mode ? { mode: file.mode } : undefined);
    }
    written.push(file.path);
  }
  await addTasks(dir, write, written, skipped);
  await addGitignore(dir, write, written, skipped);
  return { written, skipped };
}

/** Splice the missing fallow tasks into `deno.json` / `deno.jsonc`. */
async function addTasks(
  dir: string,
  write: boolean,
  written: string[],
  skipped: string[],
): Promise<void> {
  const name = await denoJsonName(dir);
  const path = join(dir, name);
  let source = await Deno.readTextFile(path);
  const doc = readJson(source) as { tasks?: Record<string, unknown> } | null;
  const have = doc?.tasks ?? {};
  let changed = false;
  for (const [task, command] of Object.entries(fallowTasks())) {
    if (task in have) continue;
    const edit = await setJsonValue(source, ["tasks", task], command);
    if (!edit.ok) throw new Error(`denext fallow: could not edit ${name}: ${edit.reason}`);
    source = edit.source;
    changed = true;
  }
  if (!changed) {
    skipped.push(name);
    return;
  }
  if (write) await Deno.writeTextFile(path, source);
  written.push(name);
}

/** The project's Deno config file name, or an error when it has none. */
async function denoJsonName(dir: string): Promise<string> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    if (await exists(join(dir, name))) return name;
  }
  throw new Error(`denext fallow: no deno.json in ${dir} (run it from a denext project).`);
}

/** Append the missing fallow lines to `.gitignore` (creating it when absent). */
async function addGitignore(
  dir: string,
  write: boolean,
  written: string[],
  skipped: string[],
): Promise<void> {
  const path = join(dir, ".gitignore");
  const current = (await exists(path)) ? await Deno.readTextFile(path) : "";
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = FALLOW_GITIGNORE.filter((l) => !have.has(l) && !have.has(l.slice(0, -1)));
  if (missing.length === 0) {
    skipped.push(".gitignore");
    return;
  }
  const sep = current === "" || current.endsWith("\n") ? "" : "\n";
  if (write) await Deno.writeTextFile(path, current + sep + missing.join("\n") + "\n");
  written.push(".gitignore");
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}
