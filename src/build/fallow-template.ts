// The fallow code-health gate for a generated app — the files and `deno task`s that
// `denext create --fallow` writes and `denext fallow init` adds to an existing project.
// It reproduces the setup denext itself runs on (fallow.toml, a git pre-commit gate, a
// measured-coverage map for the CRAP score, the agent instructions), Deno-first: fallow
// runs from npm through `deno run`, pinned, so nothing has to be installed globally.
//
// Build-time only; never imported by a shipped bundle.

import { join } from "@std/path";
import { COVERAGE_TO_ISTANBUL_SCRIPT } from "./fallow-coverage-script.ts";
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

/** `fallow.toml` for a denext app: the path-loaded conventions as entry points. */
const FALLOW_TOML =
  `# fallow (https://docs.fallow.tools): dead code, duplication and complexity for this app.
#
#   deno task fallow            dead-code + dupes + health over the whole project
#   deno task fallow:audit      the changed-code gate the pre-commit hook runs
#   deno task coverage:fallow   measured coverage for the CRAP score (needs tests)
#
# The coverage map is passed on the command line by the hook, never configured here: a
# \`[health] coverage\` path that does not exist is a hard error.

# denext loads these files by PATH (file-based routing, config, conventions), not by an
# import, so fallow's reachability cannot see them. Declaring them as entry points keeps a
# new route and everything it imports from being reported as unused.
entry = [
  # App Router route files (app/ or src/app/).
  "**/app/**/page.tsx",
  "**/app/**/layout.tsx",
  "**/app/**/template.tsx",
  "**/app/**/default.tsx",
  "**/app/**/loading.tsx",
  "**/app/**/error.tsx",
  "**/app/**/global-error.tsx",
  "**/app/**/not-found.tsx",
  "**/app/**/route.ts",
  # App Router metadata files.
  "**/app/**/opengraph-image.tsx",
  "**/app/**/twitter-image.tsx",
  "**/app/**/icon.tsx",
  "**/app/**/apple-icon.tsx",
  "**/app/**/sitemap.ts",
  "**/app/**/robots.ts",
  "**/app/**/manifest.ts",
  # Project conventions at the root (or beside src/app).
  "denext.config.ts",
  "content.config.ts",
  "capacitor.config.ts",
  "desktop.ts",
  "middleware.ts",
  "src/middleware.ts",
  "instrumentation.ts",
  "src/instrumentation.ts",
  "instrumentation-client.ts",
  "src/instrumentation-client.ts",
  # Scheduled tasks (tasks/<name>.ts) and mobile background tasks (background/).
  "tasks/*.ts",
  "background/**",
  # SPA mode: the entry (and worker) named by \`spa.entry\`.
  "src/main.tsx",
  "src/worker.ts",
  # Scripts run with \`deno run\` / \`deno task\`, never imported.
  "scripts/*.ts",
  # Static assets served verbatim, and the Tailwind source stylesheet.
  "public/**",
  "styles/tailwind.css",
]

ignorePatterns = [
  # Build output: .denext/ (build + generated types), out/ (static export), dist/ (packages).
  ".denext/**",
  "out/**",
  "dist/**",
  "coverage/**",
  # Capacitor's native projects: \`cap sync\` copies the static export into them.
  "ios/**",
  "android/**",
  # Scripts vendored from denext's templates, tested in denext's own repository: the desktop
  # packaging scripts (regenerated by \`denext desktop package --regenerate-scripts\`; they
  # mirror each other on purpose) and the coverage converter \`coverage:fallow\` runs.
  "scripts/package-*.ts",
  "scripts/coverage-to-istanbul.ts",
]
`;

/** `.githooks/pre-commit`: the fallow gate, enabled by `deno task hooks:install`. */
const PRE_COMMIT_HOOK = `#!/bin/sh
# fallow gate: \`fallow audit\` scopes dead code, complexity and duplication to the changes
# being committed and exits 1 on a \`fail\` verdict, which aborts the commit. Enable it once
# per clone with:
#
#     deno task hooks:install
#
# fallow runs through \`deno task fallow:audit\` (npm:fallow, pinned in deno.json), so
# nothing has to be installed globally.
set -e

# git runs hooks under /bin/sh, whose PATH often lacks ~/.deno/bin.
if command -v deno >/dev/null 2>&1; then
  DENO=deno
elif [ -x "$HOME/.deno/bin/deno" ]; then
  DENO="$HOME/.deno/bin/deno"
else
  echo "pre-commit: deno not found. Install it (https://deno.com) or add ~/.deno/bin to PATH." >&2
  exit 1
fi

# fallow compares against the branch's upstream (or origin/HEAD, origin/main,
# origin/master). A repository without a remote has none of those: compare with the last
# commit instead, and skip the very first commit (there is nothing to compare with).
BASE=""
if [ -z "\${FALLOW_AUDIT_BASE:-}" ]; then
  FOUND=""
  for REF in '@{upstream}' origin/HEAD origin/main origin/master; do
    if git rev-parse --verify --quiet "$REF" >/dev/null 2>&1; then FOUND=1; break; fi
  done
  if [ -z "$FOUND" ]; then
    if git rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
      BASE="--base HEAD"
    else
      echo "pre-commit: first commit, nothing to compare with; skipping the fallow gate." >&2
      exit 0
    fi
  fi
fi

# Measured coverage, when present (\`deno task coverage:fallow\`), replaces fallow's
# import-graph ESTIMATE in the CRAP score.
COV=""
if [ -f coverage/coverage-final.json ]; then
  COV="--coverage coverage/coverage-final.json"
fi

# \`$BASE\` and \`$COV\` are deliberately unquoted: each is empty or two words.
"$DENO" task fallow:audit $BASE $COV
`;

/** The agent instructions: denext's "Fallow local gate" + task map, through deno tasks. */
const AGENTS_MD = `# Agent notes

This is a [denext](https://denext.dev) app: Next.js's App Router for Deno. Write it the
App Router way and import from \`denext\` instead of \`react\` / \`next\`; the full agent
guide is https://denext.dev/llms.txt (and \`denext mcp\` serves the docs over MCP).

## Fallow local gate

Before any \`git commit\` or \`git push\`, run \`deno task fallow:audit --format json\` (add
\`--coverage coverage/coverage-final.json\` when that file exists — \`deno task coverage:fallow\`
generates it, and it turns fallow's estimated CRAP coverage into measured coverage). If the
verdict is \`fail\`, fix the reported findings before retrying. Treat JSON runtime errors like
\`{ "error": true, ... }\` as non-blocking. The git pre-commit hook (\`deno task hooks:install\`)
runs the same gate.

Audit defaults to \`gate=new-only\`: only findings introduced by the current changeset affect
the verdict. Inherited findings on touched files are reported under \`attribution\` and
annotated with \`introduced: false\`, but do not block the commit. Set \`[audit] gate = "all"\`
in \`fallow.toml\` to gate every finding in changed files.

A file denext loads by path (a route, \`denext.config.ts\`, \`middleware.ts\`, \`tasks/*.ts\`) is
an entry point in \`fallow.toml\`; add a new path-loaded convention there rather than
suppressing the "unused file" finding.

## Fallow task map

| When the agent is about to...                                     | Run                                                                                           |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| delete an "unused" export or file                                 | \`deno task fallow dead-code --trace <file>:<export>\`                                          |
| prove a TypeScript symbol's exact consumers before refactoring    | \`deno task fallow dead-code --type-aware --symbol-impact <file>:<export-or-class.method>\`     |
| delete an "unused" dependency                                     | \`deno task fallow dead-code --trace-dependency <name>\`                                        |
| commit or open a PR                                               | \`deno task fallow audit --base <ref>\`                                                         |
| prioritize refactoring                                            | \`deno task fallow health --hotspots --targets\`                                                |
| check untested-but-reachable code                                 | \`deno task fallow health --coverage-gaps\`                                                     |
| consolidate duplication                                           | \`deno task fallow dupes --trace dup:<fingerprint>\`                                            |
| check which architecture rules apply to a file before changing it | \`deno task fallow guard <files>\`                                                              |
| understand a finding                                              | \`deno task fallow explain <issue-type>\`                                                       |
`;

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
