#!/usr/bin/env -S deno run -A
// One-command denext release: bump → CHANGELOG → API reference → lock → gate, then
// (after you confirm) commit, tag `v<version>`, and push. Pushing the `v*` tag fires
// the JSR publish workflow, which re-runs the whole gate on a clean checkout before it
// publishes — so this is the local pre-flight, not a substitute for it.
//
//   deno task release 2.0.0-rc.5            # prep, then PROMPT before tagging
//   deno task release 2.0.0-rc.5 --confirm  # skip the prompt (authorized/agent use)
//   deno task release 2.0.0-rc.5 --dry      # preview every step; write/commit nothing
//
// Order of operations:
//   1. bump the version pins (scripts/bump-version.ts)
//   2. roll CHANGELOG.md  [Unreleased] → [<version>] - <today>  (fresh [Unreleased] on top)
//   3. deno task docs:api  — regenerate the in-site API reference
//   3b. deno task badge:tests — refresh the test-count badge (CI `check` gates it)
//   3c. deno task badge:fallow — refresh the fallow health-score badge
//   4. deno cache mod.ts   — refresh deno.lock
//   5. deno task check     — fmt + lint + full test suite (ABORTS the release if it fails)
//   6. confirm  → git add -A, commit, tag v<version>, push branch + tag
//
// After tagging, every release gets a `development → main` PR so main catches up to the
// tag (a hard rule — see AGENTS.md "Releasing"); this script prints the `gh pr create`
// command to run. The docs-site DEPLOY stays separate on purpose (it targets a server):
// after the tag,
// run `deno task docs:build`, then rsync the built `apps/web/out/` to your docs host.

import { exists } from "@std/fs";
import { join } from "@std/path";
import { bumpVersion, REPO_ROOT, VERSION_RE } from "./bump-version.ts";

/**
 * Regenerate the `examples/effect` migrate golden against the just-bumped framework
 * version. `denext migrate` pins the generated `deno.json` to the framework's current
 * `deno.json` "version" (via migrate's `denextVersion()`), so every bump drifts this
 * committed golden — and the commit-parity test (tests/migrate-effect-fixture.test.ts)
 * fails in the gate below unless it is refreshed. bump-version.ts deliberately stays a
 * pure string-pin bumper and does not touch example fixtures, so the release owns this.
 * Migrate leaves a stray, un-gitignored `deno.lock` in the example dir; drop it so the
 * release's `git add -A` never sweeps it in. No-op if the example isn't in this checkout.
 */
async function refreshEffectGolden(dry: boolean): Promise<boolean> {
  const dir = join(REPO_ROOT, "examples", "effect");
  if (!(await exists(dir, { isDirectory: true }))) return false; // not in this checkout
  if (dry) return true;
  const code = await run("deno", "run", "-A", "cli.ts", "migrate", "examples/effect");
  await Deno.remove(join(dir, "deno.lock")).catch(() => {}); // stray, un-gitignored
  if (code !== 0) die("regenerating the examples/effect golden failed — release aborted.");
  return true;
}

/** Run a command, inheriting stdio so its output streams to the user. Returns the code. */
async function run(cmd: string, ...args: string[]): Promise<number> {
  const { code } = await new Deno.Command(cmd, {
    args,
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  }).output();
  return code;
}

/** Capture a command's trimmed stdout (used for short git queries). */
async function capture(cmd: string, ...args: string[]): Promise<string> {
  const { stdout } = await new Deno.Command(cmd, { args, cwd: REPO_ROOT, stdout: "piped" })
    .output();
  return new TextDecoder().decode(stdout).trim();
}

function die(message: string): never {
  console.error(`\nrelease: ${message}`);
  Deno.exit(1);
}

/**
 * Roll CHANGELOG.md: insert `## [<version>] - <today>` right after `## [Unreleased]`,
 * moving the accumulated notes under the new release and leaving a fresh empty
 * [Unreleased] on top. Returns the number of `- ` entries that became this release.
 */
export async function rollChangelog(version: string, dry: boolean): Promise<number> {
  const path = join(REPO_ROOT, "CHANGELOG.md");
  const text = await Deno.readTextFile(path);
  const marker = "## [Unreleased]";
  if (!text.includes(marker)) die("CHANGELOG.md has no '## [Unreleased]' section");
  if (text.includes(`## [${version}]`)) {
    die(`CHANGELOG.md already has a '## [${version}]' section — already released?`);
  }
  const date = new Date().toISOString().slice(0, 10);
  const updated = text.replace(marker, `${marker}\n\n## [${version}] - ${date}`);
  if (!dry) await Deno.writeTextFile(path, updated);
  return unreleasedEntries(text, marker);
}

/** The `- ` entries under [Unreleased] (up to the next release header). */
function unreleasedEntries(text: string, marker: string): number {
  const after = text.slice(text.indexOf(marker) + marker.length);
  const nextIdx = after.indexOf("\n## [");
  const section = nextIdx === -1 ? after : after.slice(0, nextIdx);
  return (section.match(/^- /gm) ?? []).length;
}

async function main(): Promise<void> {
  const { version, dry, confirmed } = parseReleaseArgs();
  const branch = await capture("git", "rev-parse", "--abbrev-ref", "HEAD");
  const tag = `v${version}`;
  if (dry) return await dryRun(version, tag);
  await checkPreconditions(tag, branch);
  console.log(`\n=== Releasing denext ${version} ===\n`);
  await prepareRelease(version, false);
  await runGate();
  if (await confirmRelease(tag, branch, confirmed)) await publish(version, tag, branch);
}

/** `--dry`: preview steps 1–2 regardless of tree state; skip the gate; write nothing. */
async function dryRun(version: string, tag: string): Promise<void> {
  console.log(`\n=== Releasing denext ${version}  (dry run) ===\n`);
  await prepareRelease(version, true);
  console.log("3. docs:api          (skipped — dry run)");
  console.log("3b. badge:tests      (skipped — dry run)");
  console.log("3c. badge:fallow     (skipped — dry run)");
  console.log("4. deno cache        (skipped — dry run)");
  console.log("5. deno task check   (skipped — dry run)");
  console.log(`\nDry run complete — nothing written, nothing committed. Would tag ${tag}.`);
}

function parseReleaseArgs(): { version: string; dry: boolean; confirmed: boolean } {
  const flags = new Set(Deno.args.filter((a) => a.startsWith("--")));
  const version = Deno.args.find((a) => !a.startsWith("--"));
  if (!version) die("usage: deno task release <version> [--confirm] [--dry]");
  if (!VERSION_RE.test(version!)) die(`"${version}" is not a valid semver (e.g. 2.0.0-rc.5)`);
  return { version: version!, dry: flags.has("--dry"), confirmed: flags.has("--confirm") };
}

/** Preconditions (a real run only — --dry previews regardless of tree state). */
async function checkPreconditions(tag: string, branch: string): Promise<void> {
  const dirty = await capture("git", "status", "--porcelain");
  if (dirty) {
    die(
      "working tree is not clean — commit or stash first so the release commit " +
        "contains only the version bump.\n" + dirty,
    );
  }
  const existing = await capture("git", "tag", "--list", tag);
  if (existing) die(`tag ${tag} already exists`);
  if (branch !== "development") {
    console.warn(`release: warning — on branch "${branch}", not "development".`);
  }
}

/** Steps 1–2: version pins (+ the effect example golden) and the CHANGELOG roll. */
export async function prepareRelease(version: string, dry: boolean): Promise<void> {
  const bump = await bumpVersion(version, { dry });
  console.log(
    `1. Bump ${bump.oldVersion} → ${version}: ${bump.total} spot(s) in ${bump.changed.length} file(s)`,
  );
  for (const { file, hits } of bump.changed) console.log(`     ${file} (${hits})`);
  // 1b. Refresh the version-pinned examples/effect migrate golden (else the gate fails).
  console.log(goldenLine(await refreshEffectGolden(dry), dry));
  const entries = await rollChangelog(version, dry);
  console.log(
    `2. CHANGELOG: rolled [Unreleased] → [${version}] (${plural(entries, "entry", "entries")})`,
  );
  if (entries === 0) {
    console.warn("     warning — no entries under [Unreleased]; releasing empty notes.");
  }
}

function goldenLine(refreshed: boolean, dry: boolean): string {
  if (!refreshed) return "1b. examples/effect golden: not in this checkout — skipped";
  return `1b. Refreshed examples/effect golden${dry ? "  (skipped — dry run)" : ""}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Steps 3–5: regenerate the API reference and the two badges, refresh the lock,
 * run the gate. The CI `check` job verifies `.github/badges/tests.json` matches the
 * source-derived Deno.test count (`deno task badge:tests --check`), but `deno task check`
 * does NOT — so a release that adds tests would ship a stale badge and turn CI red on the
 * merge. Regenerating it here keeps the release commit current.
 */
async function runGate(): Promise<void> {
  console.log("\n3. Regenerating API reference (deno task docs:api)…");
  if (await run("deno", "task", "docs:api") !== 0) {
    die("docs:api failed — release aborted (changes left in tree).");
  }
  console.log("\n3b. Regenerating the test-count badge (deno task badge:tests)…");
  if (await run("deno", "task", "badge:tests") !== 0) {
    die("badge:tests failed — release aborted (changes left in tree).");
  }
  console.log("\n3c. Regenerating the fallow health badge (deno task badge:fallow)…");
  if (await run("deno", "task", "badge:fallow") !== 0) {
    die("badge:fallow failed — release aborted (changes left in tree).");
  }
  console.log("\n4. Refreshing deno.lock (deno cache mod.ts)…");
  await run("deno", "cache", "mod.ts");
  console.log("\n5. Running the gate (deno task check)…");
  if (await run("deno", "task", "check") !== 0) {
    die("gate failed — release aborted BEFORE tagging. Prepared changes are in your working tree.");
  }
}

/** Show the diff and ask (unless `--confirm`); false aborts with the tree left as prepared. */
async function confirmRelease(tag: string, branch: string, confirmed: boolean): Promise<boolean> {
  console.log("\n=== Prepared. Review the changes: ===");
  await run("git", "--no-pager", "diff", "--stat");
  if (confirmed) {
    console.log("\n--confirm set — skipping the prompt.");
    return true;
  }
  const answer = prompt(
    `\nCommit, tag ${tag}, and push to origin/${branch}? Type "yes" to release:`,
  );
  if (answer !== null && ["yes", "y"].includes(answer.trim().toLowerCase())) return true;
  console.log(
    "\nAborted — nothing committed or pushed. Prepared changes remain in your working " +
      "tree (run `git checkout .` and `git clean -n` to discard, or commit by hand).",
  );
  return false;
}

/** Step 6: commit, tag and push; each command that fails aborts with its own message. */
async function publish(version: string, tag: string, branch: string): Promise<void> {
  console.log("\n6. Committing, tagging, and pushing…");
  const steps: Array<[string[], string]> = [
    [["git", "add", "-A"], "git add failed"],
    [["git", "commit", "-m", `release: denext ${version}`], "git commit failed"],
    [["git", "tag", "-a", tag, "-m", `denext ${version}`], "git tag failed"],
    [["git", "push", "origin", branch], "git push (branch) failed"],
    [["git", "push", "origin", tag], "git push (tag) failed"],
  ];
  for (const [[cmd, ...args], message] of steps) {
    if (await run(cmd, ...args) !== 0) die(message);
  }
  console.log(
    `\n✓ Released ${version}. The ${tag} tag fires the JSR publish workflow ` +
      "(it re-runs the gate, then publishes).\n" +
      "  REQUIRED next: open a PR so `main` catches up to this tag —\n" +
      `    gh pr create --base main --head ${branch}\n` +
      "  (every release tag gets a `development → main` PR; see AGENTS.md).\n" +
      "  Docs deploy is separate: run `deno task docs:build`, then rsync apps/web/out/ " +
      "to your docs host.",
  );
}

if (import.meta.main) await main();
