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
//   4. deno cache mod.ts   — refresh deno.lock
//   5. deno task check     — fmt + lint + full test suite (ABORTS the release if it fails)
//   6. confirm  → git add -A, commit, tag v<version>, push branch + tag
//
// The docs-site DEPLOY stays separate on purpose (it targets a server): after the tag,
// run `deno task docs:build`, then rsync the built `apps/web/out/` to your docs host.

import { join } from "@std/path";
import { bumpVersion, REPO_ROOT, VERSION_RE } from "./bump-version.ts";

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
async function rollChangelog(version: string, dry: boolean): Promise<number> {
  const path = join(REPO_ROOT, "CHANGELOG.md");
  const text = await Deno.readTextFile(path);
  const marker = "## [Unreleased]";
  if (!text.includes(marker)) die("CHANGELOG.md has no '## [Unreleased]' section");
  if (text.includes(`## [${version}]`)) {
    die(`CHANGELOG.md already has a '## [${version}]' section — already released?`);
  }
  // Count entries currently under [Unreleased] (up to the next release header).
  const after = text.slice(text.indexOf(marker) + marker.length);
  const nextIdx = after.indexOf("\n## [");
  const section = nextIdx === -1 ? after : after.slice(0, nextIdx);
  const entries = (section.match(/^- /gm) ?? []).length;

  const date = new Date().toISOString().slice(0, 10);
  const updated = text.replace(marker, `${marker}\n\n## [${version}] - ${date}`);
  if (!dry) await Deno.writeTextFile(path, updated);
  return entries;
}

async function main(): Promise<void> {
  const flags = new Set(Deno.args.filter((a) => a.startsWith("--")));
  const version = Deno.args.find((a) => !a.startsWith("--"));
  const dry = flags.has("--dry");
  const confirmed = flags.has("--confirm");

  if (!version) die("usage: deno task release <version> [--confirm] [--dry]");
  if (!VERSION_RE.test(version!)) die(`"${version}" is not a valid semver (e.g. 2.0.0-rc.5)`);

  const branch = await capture("git", "rev-parse", "--abbrev-ref", "HEAD");
  const tag = `v${version}`;

  // Preconditions (a real run only — --dry previews regardless of tree state).
  if (!dry) {
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

  console.log(`\n=== Releasing denext ${version}${dry ? "  (dry run)" : ""} ===\n`);

  // 1. Version pins.
  const bump = await bumpVersion(version!, { dry });
  console.log(
    `1. Bump ${bump.oldVersion} → ${version}: ${bump.total} spot(s) in ${bump.changed.length} file(s)`,
  );
  for (const { file, hits } of bump.changed) console.log(`     ${file} (${hits})`);

  // 2. CHANGELOG.
  const entries = await rollChangelog(version!, dry);
  console.log(
    `2. CHANGELOG: rolled [Unreleased] → [${version}] (${entries} entr${
      entries === 1 ? "y" : "ies"
    })`,
  );
  if (entries === 0) {
    console.warn("     warning — no entries under [Unreleased]; releasing empty notes.");
  }

  // 3–5. Reference, lock, gate (skipped in a dry run).
  if (dry) {
    console.log("3. docs:api        (skipped — dry run)");
    console.log("4. deno cache      (skipped — dry run)");
    console.log("5. deno task check (skipped — dry run)");
    console.log(`\nDry run complete — nothing written, nothing committed. Would tag ${tag}.`);
    return;
  }

  console.log("\n3. Regenerating API reference (deno task docs:api)…");
  if (await run("deno", "task", "docs:api") !== 0) {
    die("docs:api failed — release aborted (changes left in tree).");
  }

  console.log("\n4. Refreshing deno.lock (deno cache mod.ts)…");
  await run("deno", "cache", "mod.ts");

  console.log("\n5. Running the gate (deno task check)…");
  if (await run("deno", "task", "check") !== 0) {
    die("gate failed — release aborted BEFORE tagging. Prepared changes are in your working tree.");
  }

  // 6. Confirm, then commit + tag + push.
  console.log("\n=== Prepared. Review the changes: ===");
  await run("git", "--no-pager", "diff", "--stat");

  if (!confirmed) {
    const answer = prompt(
      `\nCommit, tag ${tag}, and push to origin/${branch}? Type "yes" to release:`,
    );
    const ok = answer !== null && ["yes", "y"].includes(answer.trim().toLowerCase());
    if (!ok) {
      console.log(
        "\nAborted — nothing committed or pushed. Prepared changes remain in your working " +
          "tree (run `git checkout .` and `git clean -n` to discard, or commit by hand).",
      );
      return;
    }
  } else {
    console.log("\n--confirm set — skipping the prompt.");
  }

  console.log("\n6. Committing, tagging, and pushing…");
  if (await run("git", "add", "-A") !== 0) die("git add failed");
  if (await run("git", "commit", "-m", `release: denext ${version}`) !== 0) {
    die("git commit failed");
  }
  if (await run("git", "tag", "-a", tag, "-m", `denext ${version}`) !== 0) die("git tag failed");
  if (await run("git", "push", "origin", branch) !== 0) die("git push (branch) failed");
  if (await run("git", "push", "origin", tag) !== 0) die("git push (tag) failed");

  console.log(
    `\n✓ Released ${version}. The ${tag} tag fires the JSR publish workflow ` +
      "(it re-runs the gate, then publishes).\n" +
      "  Docs deploy is separate: run `deno task docs:build`, then rsync apps/web/out/ " +
      "to your docs host.",
  );
}

if (import.meta.main) await main();
