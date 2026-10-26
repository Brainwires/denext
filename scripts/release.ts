#!/usr/bin/env -S deno run -A
// One-command denext release: bump → CHANGELOG → API reference → lock → gate, then
// (after you confirm) commit, tag `v<version>`, and push. Pushing the `v*` tag fires
// the JSR publish workflow, which re-runs the whole gate on a clean checkout before it
// publishes — so this is the local pre-flight, not a substitute for it.
//
//   deno task release 2.0.0-rc.5            # prep, then PROMPT before tagging
//   deno task release 2.0.0-rc.5 --confirm  # skip the prompt (authorized/agent use)
//   deno task release 2.0.0-rc.5 --dry      # preview every step; write/commit nothing
//   deno task release 2.0.0-rc.5 --full-gate  # run the whole local suite at step 5
//   deno task release 2.0.0-rc.5 --confirm --resume-from corpus  # finish a stopped release
//   deno task release 2.0.0-rc.5 --confirm --resume-from tag --regate  # … re-running both gates
//
// Order of operations:
//   0. CI: the newest ci.yml run on HEAD that ran the heavy jobs (integration, next-compat,
//      coverage, backend-integration — a push to `development` skips them; dispatch ci.yml) is
//      green, and so are the newest desktop-ci.yml, e2e.yml, desktop-window.yml and
//      native-plugins.yml runs on HEAD (every job), else ABORT
//      (scripts/release-ci.ts)
//   1. bump the version pins (scripts/bump-version.ts)
//   2. roll CHANGELOG.md  [Unreleased] → [<version>] - <today>  (fresh [Unreleased] on top)
//   2b. a stable release folds the rc sections in and re-points the docs pages' links to
//       their anchors (`/docs/changelog#250-rc1---…`) at the folded release header
//   3. deno task docs:api  — regenerate the in-site API reference
//   3a. gen:plugin-catalog, docs:mcp, docs:corpus, docs:llms — regenerated from the bumped tree;
//       @denext/docs-corpus is at the release's version (the bump moved it), and when JSR already
//       has that version (a resumed release) its source hash must be this corpus's, else ABORT —
//       denext X.Y.Z pins exactly @denext/docs-corpus X.Y.Z, never another version
//   3b. deno task badge:tests — refresh the test-count badge (CI `check` gates it)
//   3c. deno task badge:fallow — refresh the fallow health-score badge
//   4. deno cache mod.ts   — refresh deno.lock; sync:example-locks — the examples' links
//   5. the gate (ABORTS the release if it fails): step 0 already proved CI's `check` job (fmt +
//      lint + the full suite) green on HEAD, so only the release's own changes are re-checked —
//      fmt, lint and RELEASE_DELTA_TESTS. publish.yml runs the same delta gate on the tagged
//      release commit (scripts/publish-verify.ts). `--full-gate` runs `deno task check` instead.
//   6. confirm  → git add -A, commit; when @denext/docs-corpus <version> is not on JSR, tag
//      docs-corpus-v<version>, push branch + that tag and wait for JSR to list it; REFUSE to tag
//      while any workspace member denext imports at run time (scripts/lib/jsr-pins.ts) pins a
//      version JSR does not have (4.1.0 shipped pinning an unpublished @denext/og); then tag
//      v<version> and push branch + tag
//
// A release that stopped in step 6 (JSR slow to list the corpus — the wait polls for the exact
// version with backoff for up to 3 hours —, a failed push, a closed terminal) resumes where it
// stopped: run the same command again. It sees the release commit on HEAD and the tags already
// made, and runs only the remaining steps (scripts/lib/release-publish.ts): `corpus` (publish and
// wait for @denext/docs-corpus), `tag`, `push`, `pr`. `--resume-from <step>` names the step.
// Every resume requires the gate-pass marker step 5 records (in the git directory: the release,
// the CI-green base commit and the gated tree's hash), matching the tree it would publish; without
// one it refuses, and `--regate` re-runs step 0 and step 5 on the tree first.
//
// After tagging, every release gets a `development → main` PR so main catches up to the
// tag (a hard rule — see AGENTS.md "Releasing"); this script prints the `gh pr create`
// command to run. The docs-site DEPLOY stays separate on purpose (it targets a server):
// after the tag,
// run `deno task docs:build`, then rsync the built `site/out/` to your docs host.

import { exists, walk } from "@std/fs";
import { join, relative, resolve } from "@std/path";
import { bumpVersion, REPO_ROOT, VERSION_RE } from "./bump-version.ts";
import {
  desktopCiVerdict,
  desktopWindowVerdict,
  e2eVerdict,
  nativePluginsVerdict,
  releaseCiHint,
  releaseCiVerdict,
} from "./release-ci.ts";
import {
  CORPUS_PACKAGE,
  corpusConflictMessage,
  type CorpusRelease,
  corpusReleaseState,
} from "./lib/docs-corpus-package.ts";
import { jsrHasVersion, missingPins } from "./lib/jsr-pins.ts";
import {
  detectResume,
  gateMarkerName,
  type GatePass,
  gateRefusal,
  pinRefusal,
  publishFrom,
  type PublishStep,
  readGatePass,
  realPublishDeps,
  ReleaseAbort,
  releaseSubject,
  resumeFromArg,
  writeGatePass,
} from "./lib/release-publish.ts";

export { pinRefusal };

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

/** What rolling the changelog did: the entries released, and the docs pages relinked. */
export interface ChangelogRoll {
  /** The number of `- ` entries that became this release. */
  entries: number;
  /** Docs pages (relative to the repo) whose folded-rc anchors were pointed at the release. */
  relinked: string[];
}

/**
 * Roll CHANGELOG.md: insert `## [<version>] - <today>` right after `## [Unreleased]`,
 * moving the accumulated notes under the new release and leaving a fresh empty
 * [Unreleased] on top. A stable release also folds the rc sections in (see
 * {@linkcode foldPrereleases}) and, in the same step, re-points every docs link to a folded
 * rc anchor at the release header — otherwise a docs page's `/docs/changelog#…-rcN…` link
 * dangles the moment the tag lands.
 */
export async function rollChangelog(version: string, dry: boolean): Promise<ChangelogRoll> {
  const path = join(REPO_ROOT, "CHANGELOG.md");
  const text = await Deno.readTextFile(path);
  const marker = "## [Unreleased]";
  if (!text.includes(marker)) die("CHANGELOG.md has no '## [Unreleased]' section");
  if (text.includes(`## [${version}]`)) {
    die(`CHANGELOG.md already has a '## [${version}]' section — already released?`);
  }
  const date = new Date().toISOString().slice(0, 10);
  const updated = isStable(version)
    ? rewriteInPageAnchors(
      foldPrereleases(text, version, date),
      foldedAnchorRewrites(text, version, date),
    )
    : text.replace(marker, `${marker}\n\n## [${version}] - ${date}`);
  if (!dry) {
    await Deno.writeTextFile(path, withLinkRef(updated, version));
    // A stable fold merges seven sections' bullets into one; their continuation indents do not
    // always agree with the formatter, and the gate's `fmt --check` would abort the release for
    // it (cutting 2.5.0 did). Format what was just written, so the gate sees canonical text.
    if (await run("deno", "fmt", path) !== 0) die("deno fmt CHANGELOG.md failed");
  }
  const relinked = isStable(version)
    ? await relinkDocsPages(foldedAnchorRewrites(text, version, date), dry)
    : [];
  return { entries: unreleasedEntries(text, marker), relinked };
}

/** A release header line: `## [<version>] - <date>`. */
const HEADER_RE = /^## \[([^\]]+)\](.*)$/m;

/** `x.y.z` with no prerelease suffix. */
export function isStable(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

/** The rc/beta headers of `version` that sit above the previous stable release. */
export function prereleaseHeaders(text: string, version: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(HEADER_RE);
    if (m && m[1].startsWith(`${version}-`)) out.push(line);
  }
  return out;
}

/** Split the changelog into `[header line, body]` sections (the preamble is section 0). */
export function splitSections(text: string): Array<[string, string]> {
  const sections: Array<[string, string]> = [];
  let header = "";
  let body: string[] = [];
  for (const line of text.split("\n")) {
    if (HEADER_RE.test(line)) {
      sections.push([header, body.join("\n")]);
      header = line;
      body = [];
    } else body.push(line);
  }
  sections.push([header, body.join("\n")]);
  return sections;
}

/**
 * Group a section body's bullets by their `### Heading` (top-level `- ` bullets + continuations).
 * A paragraph under a heading is that group's first item, never part of the heading: two rc
 * sections' `### Breaking (4.0)`, one with an intro paragraph, are one group (4.0.0 rendered two).
 */
export function groupByHeading(body: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  let heading = "### Changed";
  const add = (item: string) => groups.set(heading, [...(groups.get(heading) ?? []), item]);
  for (const chunk of bullets(body)) {
    if (!chunk.startsWith("### ")) {
      add(chunk);
      continue;
    }
    const [line, ...rest] = chunk.split("\n");
    heading = line.trim();
    const intro = rest.join("\n").trim();
    if (intro) add(intro);
  }
  return groups;
}

/** A body as `### ` headings and `- ` bullets (each bullet with its indented continuation lines). */
function bullets(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("### ") || line.startsWith("- ")) out.push(line);
    else if (out.length && line.trim()) out[out.length - 1] += "\n" + line;
  }
  return out;
}

/** Bullets that flag a breaking change (`**Breaking` prefix or the word in bold). */
export function isBreakingBullet(bullet: string): boolean {
  return /^- \*\*Breaking\b/i.test(bullet) || /\*\*Breaking[.:]?\*\*/i.test(bullet);
}

/** Merge many `heading → bullets` maps, deduping identical bullets, `### Breaking` first. */
export function mergeGroups(maps: Map<string, string[]>[]): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const m of maps) for (const [h, list] of m) addBullets(merged, seen, h, list);
  return orderGroups(merged);
}

function addBullets(merged: Map<string, string[]>, seen: Set<string>, h: string, list: string[]) {
  for (const b of list) {
    if (seen.has(b)) continue;
    seen.add(b);
    const heading = isBreakingBullet(b) ? "### Breaking" : h;
    merged.set(heading, [...(merged.get(heading) ?? []), b]);
  }
}

const GROUP_ORDER = [
  "### Breaking",
  "### Added",
  "### Changed",
  "### Deprecated",
  "### Removed",
  "### Fixed",
  "### Security",
];

function orderGroups(m: Map<string, string[]>): Map<string, string[]> {
  const rank = (h: string) => {
    const i = GROUP_ORDER.indexOf(h);
    return i === -1 ? GROUP_ORDER.length : i;
  };
  return new Map([...m].sort(([a], [b]) => rank(a) - rank(b)));
}

/**
 * A stable release folds the `[Unreleased]` notes AND every `[<version>-rc.N]` section into
 * one `## [<version>]` section (grouped, deduped, `### Breaking` first), so the tag's notes
 * carry the whole line rather than the last rc's housekeeping.
 */
export function foldPrereleases(text: string, version: string, date: string): string {
  const marker = "## [Unreleased]";
  const rcHeaders = new Set(prereleaseHeaders(text, version));
  const sections = splitSections(text);
  const folded = sections.filter(([h]) => h === marker || rcHeaders.has(h));
  const groups = mergeGroups(folded.map(([, body]) => groupByHeading(body)));
  const kept = sections.filter(([h]) => h !== marker && !rcHeaders.has(h));
  const release = renderRelease(version, date, groups);
  const [preamble, ...rest] = kept;
  // A blank line between the preamble and the first header keeps the file `deno fmt`-clean.
  return [preamble[1].trimEnd(), "", `${marker}\n`, release, ...rest.map(([h, b]) => `${h}\n${b}`)]
    .join("\n");
}

function renderRelease(version: string, date: string, groups: Map<string, string[]>): string {
  const parts = [`## [${version}] - ${date}`, ""];
  for (const [h, list] of groups) {
    parts.push(h, "");
    // A paragraph item (a heading's intro) is set off from the bullets after it.
    for (const item of list) parts.push(...(item.startsWith("- ") ? [item] : [item, ""]));
    if (parts.at(-1) !== "") parts.push("");
  }
  return parts.join("\n");
}

/**
 * The id the docs site gives a heading — `packages/content-collections/markdown.ts`'s
 * `slugify`, which `site/lib/toc.ts` mirrors: lowercase, everything but word characters,
 * whitespace and dashes dropped, whitespace to dashes. `## [2.5.0-rc.1] - 2026-09-14` is
 * `250-rc1---2026-09-14`, and `## [2.5.0] - 2026-09-18` is `250---2026-09-18`.
 */
export function headingSlug(heading: string): string {
  return heading.replace(/^#+\s*/, "").toLowerCase().replace(/[^\w\s-]/g, "").trim()
    .replace(/\s/g, "-");
}

/**
 * `old anchor → new anchor` for every rc header a stable release folds: each `[<version>-rc.N]`
 * header's slug maps to the slug of the `## [<version>] - <date>` header that replaces it.
 */
export function foldedAnchorRewrites(
  text: string,
  version: string,
  date: string,
): Map<string, string> {
  const release = headingSlug(`## [${version}] - ${date}`);
  return new Map(prereleaseHeaders(text, version).map((h) => [headingSlug(h), release]));
}

/** A link to the docs route that renders CHANGELOG.md, split at the anchor. */
const CHANGELOG_LINK = /(\/docs\/changelog#)([\w-]+)(?![\w-])/g;

/**
 * `doc` with every `/docs/changelog#<old>` link re-pointed per `rewrites`. An anchor is
 * matched whole (`#250-rc1---…` never claims `#250-rc10---…`); a link to a header that was
 * not folded is untouched.
 */
export function rewriteFoldedAnchors(doc: string, rewrites: Map<string, string>): string {
  return doc.replace(CHANGELOG_LINK, (whole, route: string, slug: string) => {
    const target = rewrites.get(slug);
    return target === undefined ? whole : `${route}${target}`;
  });
}

/** An in-page link (`](#<anchor>)`), as the changelog links its own headers. */
const IN_PAGE_LINK = /(\]\(#)([\w-]+)(\))/g;

/**
 * The changelog's own links to a folded rc header (`[rc.1 breaking changes](#400-rc1---…)`)
 * re-pointed per `rewrites`, like {@linkcode rewriteFoldedAnchors} does for the docs pages.
 */
export function rewriteInPageAnchors(text: string, rewrites: Map<string, string>): string {
  return rewriteFoldedAnchors(text, rewrites).replace(
    IN_PAGE_LINK,
    (whole, open: string, slug: string, close: string) => {
      const target = rewrites.get(slug);
      return target === undefined ? whole : `${open}${target}${close}`;
    },
  );
}

/** Where the docs pages live: every `.md` under here is a candidate for a changelog link. */
const DOCS_PAGES = join(REPO_ROOT, "site", "app");

/**
 * Re-point the folded anchors in every docs page that links one. Returns the pages (relative
 * to the repo) that changed — or would change, under `dry`, when nothing is written.
 *
 * @param rewrites From {@linkcode foldedAnchorRewrites}.
 * @param dry Report only; write nothing.
 * @param root The docs pages directory (a test points this at a fixture).
 */
export async function relinkDocsPages(
  rewrites: Map<string, string>,
  dry: boolean,
  root = DOCS_PAGES,
): Promise<string[]> {
  const changed: string[] = [];
  if (rewrites.size === 0 || !(await exists(root, { isDirectory: true }))) return changed;
  for await (const entry of walk(root, { exts: [".md"], includeDirs: false })) {
    const before = await Deno.readTextFile(entry.path);
    const after = rewriteFoldedAnchors(before, rewrites);
    if (after === before) continue;
    if (!dry) await Deno.writeTextFile(entry.path, after);
    changed.push(relative(REPO_ROOT, entry.path));
  }
  return changed.sort();
}

/**
 * Add the `[<version>]: https://jsr.io/…` link-reference definition if absent, and point the
 * `[Unreleased]: …/compare/v<x>...<branch>` link at the new tag (it compares from the LAST release).
 */
export function withLinkRef(text: string, version: string): string {
  const out = text.replace(
    /^\[Unreleased\]: (\S+\/compare\/)v\S+?\.\.\.(\S+)$/m,
    `[Unreleased]: $1v${version}...$2`,
  );
  const ref = `[${version}]: https://jsr.io/@denext/denext@${version}`;
  if (out.includes(ref)) return out;
  const idx = out.search(/^\[[0-9][^\]]*\]: https:/m);
  return idx === -1
    ? `${out.trimEnd()}\n\n${ref}\n`
    : out.slice(0, idx) + ref + "\n" + out.slice(idx);
}

/** The `- ` entries under [Unreleased] (up to the next release header). */
function unreleasedEntries(text: string, marker: string): number {
  const after = text.slice(text.indexOf(marker) + marker.length);
  const nextIdx = after.indexOf("\n## [");
  const section = nextIdx === -1 ? after : after.slice(0, nextIdx);
  return (section.match(/^- /gm) ?? []).length;
}

async function main(): Promise<void> {
  const { version, dry, confirmed, fullGate, resumeFrom, regate } = parseReleaseArgs();
  const branch = await capture("git", "rev-parse", "--abbrev-ref", "HEAD");
  const tag = `v${version}`;
  if (dry) return await dryRun(version, tag, branch);
  const target = { version, tag, branch };
  const resume = resumeFrom ?? await detectResume(target, realPublishDeps(REPO_ROOT));
  if (resume) return await resumeRelease(target, resume, { confirmed, regate, fullGate });
  await checkPreconditions(tag, branch);
  const base = await capture("git", "rev-parse", "HEAD");
  await checkCi(branch, false, base);
  console.log(`\n=== Releasing denext ${version} ===\n`);
  await prepareRelease(version, false);
  // Step 0 refuses a HEAD whose ci.yml `check` job (fmt + lint + the whole suite) is not green.
  await runGate(version, fullGate);
  await recordGatePass({ version, base, tree: await worktreeTree() });
  if (await confirmRelease(target, confirmed)) await publish(version, tag, branch);
}

/** `--dry`: preview steps 1–2 regardless of tree state; skip the gate; write nothing. */
async function dryRun(version: string, tag: string, branch: string): Promise<void> {
  console.log(`\n=== Releasing denext ${version}  (dry run) ===\n`);
  await checkCi(branch, true, await capture("git", "rev-parse", "HEAD"));
  await prepareRelease(version, true);
  console.log("3. docs:api          (skipped — dry run)");
  console.log("3b. badge:tests      (skipped — dry run)");
  console.log("3c. badge:fallow     (skipped — dry run)");
  console.log("4. deno cache        (skipped — dry run)");
  console.log("5. release gate      (skipped — dry run)");
  const missing = await missingPins().catch((err: Error) => {
    console.log(`6. JSR pins: could not ask JSR (${err.message})`);
    return null;
  });
  if (missing) {
    // The corpus is pinned at the release's version (step 6 publishes it), not the tree's.
    const others = missing.filter((p) => p.name !== CORPUS_PACKAGE);
    console.log(
      others.length
        ? `6. JSR pins not published yet: ${others.map((p) => p.tag).join(", ")}`
        : "6. JSR pins: every runtime package version is on JSR",
    );
    const corpusOnJsr = await jsrHasVersion(CORPUS_PACKAGE, version).catch(() => null);
    console.log(
      `6. ${CORPUS_PACKAGE}@${version}: ${
        corpusOnJsr === null
          ? "could not ask JSR"
          : corpusOnJsr
          ? "already on JSR (its source hash must match the regenerated corpus)"
          : `not on JSR — a real run publishes docs-corpus-v${version} first`
      }`,
    );
  }
  console.log(`\nDry run complete — nothing written, nothing committed. Would tag ${tag}.`);
}

function parseReleaseArgs(): {
  version: string;
  dry: boolean;
  confirmed: boolean;
  fullGate: boolean;
  resumeFrom: PublishStep | undefined;
  regate: boolean;
} {
  const flags = new Set(Deno.args.filter((a) => a.startsWith("--")));
  const version = Deno.args.find((a, i) =>
    !a.startsWith("--") && Deno.args[i - 1] !== "--resume-from"
  );
  if (!version) {
    die(
      "usage: deno task release <version> [--confirm] [--dry] [--full-gate] " +
        "[--resume-from <step> [--regate]]",
    );
  }
  if (!VERSION_RE.test(version!)) die(`"${version}" is not a valid semver (e.g. 2.0.0-rc.5)`);
  let resumeFrom: PublishStep | undefined;
  try {
    resumeFrom = resumeFromArg(Deno.args);
  } catch (err) {
    die((err as Error).message);
  }
  return {
    version: version!,
    dry: flags.has("--dry"),
    confirmed: flags.has("--confirm"),
    fullGate: flags.has("--full-gate"),
    resumeFrom,
    regate: flags.has("--regate"),
  };
}

/**
 * Finish a release that stopped in step 6: from `step`, with a clean tree and the release commit
 * on HEAD (`commit` makes it from the prepared tree instead). Every resume requires a recorded
 * gate pass for exactly the tree it publishes ({@linkcode requireGatePass}).
 */
async function resumeRelease(
  target: { version: string; tag: string; branch: string },
  step: PublishStep,
  opts: { confirmed: boolean; regate: boolean; fullGate: boolean },
): Promise<void> {
  console.log(`\n=== Resuming the release of denext ${target.version} at step "${step}" ===\n`);
  if (step === "commit") {
    await requireGatePass(target, step, opts);
    if (!await confirmRelease(target, opts.confirmed)) return;
    return await publish(target.version, target.tag, target.branch);
  }
  if (await capture("git", "status", "--porcelain")) {
    die("working tree is not clean — a resumed release publishes the release commit as made.");
  }
  const subject = await capture("git", "log", "-1", "--format=%s");
  if (subject !== releaseSubject(target.version)) {
    die(`HEAD is "${subject}", not the release commit "${releaseSubject(target.version)}".`);
  }
  const tagged = await capture("git", "rev-parse", "--verify", "--quiet", `${target.tag}^{commit}`);
  if (tagged && tagged !== await capture("git", "rev-parse", "HEAD")) {
    die(
      `${target.tag} exists here but is not HEAD (${tagged.slice(0, 12)}): delete the stale ` +
        "tag or check out the release commit it names, then resume.",
    );
  }
  await requireGatePass(target, step, opts);
  await publishSteps(target, step);
}

/** Where the gate-pass marker lives: the git directory (never in the tree, never committed). */
async function gateMarkerPath(version: string): Promise<string> {
  const path = await capture("git", "rev-parse", "--git-path", gateMarkerName(version));
  if (!path) die("could not locate the git directory for the gate-pass marker.");
  return resolve(REPO_ROOT, path);
}

/** Record that step 0 and step 5 passed for `pass.base` and `pass.tree`. */
async function recordGatePass(pass: GatePass): Promise<void> {
  await writeGatePass(await gateMarkerPath(pass.version), pass);
  console.log(
    `\n5. Gate passed: recorded tree ${pass.tree.slice(0, 12)} on ${pass.base.slice(0, 12)}.`,
  );
}

/**
 * The tree `git add -A` would commit right now, hashed through a copy of the index (the real
 * index is untouched; the copy keeps its stat data, so unchanged files are not re-hashed).
 */
async function worktreeTree(): Promise<string> {
  const index = await Deno.makeTempFile({ prefix: "denext-release-index-" });
  try {
    await Deno.copyFile(
      resolve(REPO_ROOT, await capture("git", "rev-parse", "--git-path", "index")),
      index,
    );
    const env = { GIT_INDEX_FILE: index };
    const add = await new Deno.Command("git", { args: ["add", "-A"], cwd: REPO_ROOT, env })
      .output();
    if (add.code !== 0) die("git add -A (into a scratch index) failed.");
    const out = await new Deno.Command("git", {
      args: ["write-tree"],
      cwd: REPO_ROOT,
      env,
      stdout: "piped",
    }).output();
    if (out.code !== 0) die("git write-tree failed.");
    return new TextDecoder().decode(out.stdout).trim();
  } finally {
    await Deno.remove(index).catch(() => {});
  }
}

/**
 * The base commit and tree a release at `step` publishes: before the release commit, HEAD and
 * the prepared working tree; after it, the release commit's parent and its tree.
 */
async function currentGateState(version: string, step: PublishStep): Promise<GatePass> {
  if (step === "commit") {
    return { version, base: await capture("git", "rev-parse", "HEAD"), tree: await worktreeTree() };
  }
  return {
    version,
    base: await capture("git", "rev-parse", "HEAD^"),
    tree: await capture("git", "rev-parse", "HEAD^{tree}"),
  };
}

/**
 * Refuse to resume at `step` unless a gate pass is recorded for exactly the base and tree it
 * would publish. `--regate` re-runs step 0 (CI on the base) and step 5 (the local gate, plus doc
 * lint) on the tree as it is, and records the pass when both are green.
 */
async function requireGatePass(
  target: { version: string; tag: string; branch: string },
  step: PublishStep,
  opts: { regate: boolean; fullGate: boolean },
): Promise<void> {
  const current = await currentGateState(target.version, step);
  if (opts.regate) {
    await checkCi(target.branch, false, current.base);
    await runReleaseGate(opts.fullGate);
    if (await run("deno", "task", "doc-lint") !== 0) die("doc-lint failed — release aborted.");
    const after = await currentGateState(target.version, step);
    if (after.tree !== current.tree) die("the gate changed the tree — release aborted.");
    return await recordGatePass(current);
  }
  const recorded = await readGatePass(await gateMarkerPath(target.version));
  const refusal = gateRefusal(recorded, current, target, step);
  if (refusal) die(refusal);
  console.log(`0. Gate pass recorded for tree ${current.tree.slice(0, 12)} — resuming.`);
}

/** Run the publish steps from `step`, turning a stop into the abort message. */
async function publishSteps(
  target: { version: string; tag: string; branch: string },
  step: PublishStep,
): Promise<void> {
  try {
    await publishFrom(target, step, realPublishDeps(REPO_ROOT));
  } catch (err) {
    if (err instanceof ReleaseAbort) die(err.message);
    throw err;
  }
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
  // The release publishes a new docs corpus itself (step 6); any other unpublished pin stops it
  // here, before anything changes.
  const others = (await missingPins()).filter((p) => p.name !== CORPUS_PACKAGE);
  const refusal = pinRefusal(others, tag);
  if (refusal) die(refusal);
  if (branch !== "development") {
    console.warn(`release: warning — on branch "${branch}", not "development".`);
  }
}

/**
 * Step 0: the ci.yml jobs a push skips (integration, next-compat, coverage, backend-integration)
 * and every desktop-ci.yml, e2e.yml, desktop-window.yml and native-plugins.yml job passed on HEAD
 * (scripts/release-ci.ts). A real run aborts
 * otherwise; `--dry` reports and goes on.
 */
async function checkCi(branch: string, dry: boolean, sha: string): Promise<void> {
  const verdicts = await Promise.all(
    [
      releaseCiVerdict,
      desktopCiVerdict,
      e2eVerdict,
      desktopWindowVerdict,
      nativePluginsVerdict,
    ].map((check) =>
      check(sha).catch((err: Error) => ({
        ok: false,
        reason: `could not ask GitHub (needs the GitHub CLI, logged in): ${err.message}`,
        run: undefined,
      }))
    ),
  );
  const lines = verdicts.map((v) => `${v.reason}${v.run ? ` — ${v.run.url}` : ""}`);
  if (verdicts.every((v) => v.ok)) return console.log(`0. CI: ${lines.join("\n   ")}`);
  const message = `CI gate: ${lines.join("\n  ")}\n  ${releaseCiHint(branch)}`;
  if (dry) return console.log(`0. ${message}\n   (a real run stops here)`);
  die(`${message}\nrelease aborted BEFORE any change.`);
}

/**
 * Generated files the version bump makes stale, in dependency order: the plugin catalog is
 * built from every packages/* manifest (whose `@denext/denext` range the bump re-points), and
 * the MCP page is an input of the docs corpus, which feeds llms.txt.
 */
export const RELEASE_REGEN_TASKS = ["gen:plugin-catalog", "docs:mcp", "docs:corpus", "docs:llms"];

/**
 * The tests that read what the release commit changes on top of the CI-tested HEAD: the version
 * pins, the CHANGELOG roll, the effect golden and the regenerated catalog / corpus / API docs.
 * With CI's `check` job green on HEAD (step 0), the gate runs these instead of the whole suite;
 * `--full-gate` runs everything.
 */
export const RELEASE_DELTA_TESTS = [
  "tests/release-tools.test.ts",
  "tests/release-pins.test.ts",
  "tests/release-blockers.test.ts",
  "tests/plugin-catalog.test.ts",
  "tests/mcp-docs-corpus.test.ts",
  "tests/docs-generated.test.ts",
  "tests/api-reference.test.ts",
  "tests/migrate-effect-fixture.test.ts",
  "tests/cli-upgrade.test.ts",
  "tests/public-surface.test.ts",
  // The folded CHANGELOG renders on the docs site: every in-page anchor must still resolve.
  "tests/docs-site.test.ts",
];

/** Steps 1–2: version pins (+ the effect example golden) and the CHANGELOG roll. */
export async function prepareRelease(version: string, dry: boolean): Promise<void> {
  const bump = await bumpVersion(version, { dry });
  console.log(
    `1. Bump ${bump.oldVersion} → ${version}: ${bump.total} spot(s) in ${bump.changed.length} file(s)`,
  );
  for (const { file, hits } of bump.changed) console.log(`     ${file} (${hits})`);
  // 1b. Refresh the version-pinned examples/effect migrate golden (else the gate fails).
  console.log(goldenLine(await refreshEffectGolden(dry), dry));
  const { entries, relinked } = await rollChangelog(version, dry);
  console.log(
    `2. CHANGELOG: rolled [Unreleased] → [${version}] (${plural(entries, "entry", "entries")})`,
  );
  if (entries === 0) {
    console.warn("     warning — no entries under [Unreleased]; releasing empty notes.");
  }
  // 2b. A stable release folded the rc sections away, so the docs links to their anchors
  // were re-pointed at the release header in the same step.
  for (const page of relinked) {
    console.log(`2b. Relinked folded rc anchors in ${page}${dry ? "  (skipped — dry run)" : ""}`);
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
async function runGate(version: string, fullGate: boolean): Promise<void> {
  console.log("\n3. Regenerating API reference (deno task docs:api)…");
  if (await run("deno", "task", "docs:api") !== 0) {
    die("docs:api failed — release aborted (changes left in tree).");
  }
  // The MCP docs corpus (@denext/docs-corpus, packages/docs-corpus) + llms*.txt
  // embed the version, so they must be regenerated on the release commit, not after the tag.
  // docs:mcp runs first: the MCP page (mcp.json) is one of the corpus's inputs. The bump
  // re-points every packages/* plugin's `@denext/denext` range, and the plugin catalog is
  // generated from those manifests, so it is regenerated first (cutting 3.3.0 failed the
  // gate on a stale src/plugin/catalog.json).
  console.log(
    "\n3a. Regenerating plugin catalog, docs corpus + llms.txt " +
      "(deno task gen:plugin-catalog/docs:mcp/docs:corpus/docs:llms)…",
  );
  for (const task of RELEASE_REGEN_TASKS) {
    if (await run("deno", "task", task) !== 0) die(`${task} failed — release aborted.`);
  }
  const corpus = await checkCorpus(version);
  console.log(
    `3a. ${CORPUS_PACKAGE}@${version}: ${
      corpus.state === "missing"
        ? "not on JSR yet — step 6 publishes it"
        : "already on JSR with this corpus"
    }`,
  );
  console.log("\n3b. Regenerating the test-count badge (deno task badge:tests)…");
  if (await run("deno", "task", "badge:tests") !== 0) {
    die("badge:tests failed — release aborted (changes left in tree).");
  }
  console.log("\n3c. Regenerating the fallow health badge (deno task badge:fallow)…");
  if (await run("deno", "task", "badge:fallow") !== 0) {
    die("badge:fallow failed — release aborted (changes left in tree).");
  }
  await refreshLocks();
  await runReleaseGate(fullGate);
  // What the publish job will do after the tag — fail HERE instead (rc.6's slow-type incident).
  console.log("\n6. Doc lint + publish dry-run…");
  if (await run("deno", "task", "doc-lint") !== 0) die("doc-lint failed — release aborted.");
  if (await run("deno", "publish", "--dry-run", "--allow-dirty") !== 0) {
    die("publish dry-run failed — release aborted BEFORE tagging.");
  }
}

/**
 * Step 4: refresh deno.lock, then the examples' locks, which link every workspace member at its
 * version — derived from the refreshed root lock, so building an example after the release
 * rewrites nothing.
 */
async function refreshLocks(): Promise<void> {
  console.log("\n4. Refreshing deno.lock (deno cache mod.ts) and the example locks' links…");
  if (await run("deno", "cache", "mod.ts") !== 0) {
    die("deno cache mod.ts failed — release aborted (changes left in tree).");
  }
  if (await run("deno", "task", "sync:example-locks") !== 0) {
    die("sync:example-locks failed — release aborted (changes left in tree).");
  }
}

/** Step 5: {@linkcode gateCommand}; a failure aborts before anything is committed. */
async function runReleaseGate(fullGate: boolean): Promise<void> {
  console.log(`\n5. Running the gate (${fullGate ? "deno task check" : "release delta"})…`);
  const [gate, ...gateArgs] = gateCommand(fullGate);
  if (await run(gate, ...gateArgs) !== 0) {
    die("gate failed — release aborted BEFORE tagging. Prepared changes are in your working tree.");
  }
}

/**
 * Step 5's command. CI's `check` job already ran fmt, lint and the whole suite on HEAD, so by
 * default the gate re-checks only the release's own changes: fmt and lint over the tree, and
 * {@linkcode RELEASE_DELTA_TESTS}. `--full-gate` runs `deno task check` as well.
 */
export function gateCommand(fullGate: boolean): string[] {
  if (fullGate) return ["deno", "task", "check"];
  const tests = `deno run -A scripts/test-run.ts ${RELEASE_DELTA_TESTS.join(" ")}`;
  return ["sh", "-c", `deno fmt --check && deno lint && ${tests}`];
}

/** Show the diff and ask (unless `--confirm`); false aborts with the tree left as prepared. */
async function confirmRelease(
  target: { version: string; tag: string; branch: string },
  confirmed: boolean,
): Promise<boolean> {
  const { version, tag, branch } = target;
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
    "\nAborted — nothing committed or pushed. Prepared changes remain in your working tree. " +
      "Run `git checkout .` and `git clean -n` to discard them, or release them as gated with\n" +
      `  deno task release ${version} --resume-from commit\n` +
      "(the gate pass is recorded for exactly this tree; a changed tree is refused).",
  );
  return false;
}

/** Run each command; the first that fails aborts with its message. */
async function runSteps(steps: Array<[string[], string]>): Promise<void> {
  for (const [[cmd, ...args], message] of steps) {
    if (await run(cmd, ...args) !== 0) die(message);
  }
}

/**
 * The corpus's release state for `version` (scripts/lib/docs-corpus-package.ts); aborts when JSR
 * cannot be asked, the corpus is not at `version`, or JSR has `version` with another corpus.
 */
async function checkCorpus(
  version: string,
): Promise<Exclude<CorpusRelease, { state: "conflict" }>> {
  const corpus = await corpusReleaseState(version).catch((err: Error) =>
    die(`could not check ${CORPUS_PACKAGE}: ${err.message} — release aborted.`)
  );
  if (corpus.state === "conflict") die(`${corpusConflictMessage(corpus)} Release aborted.`);
  return corpus;
}

/**
 * Step 6: the release commit, then the resumable publish steps (scripts/lib/release-publish.ts):
 * publish `@denext/docs-corpus` <version> unless JSR has it with this corpus, refuse the tag
 * while any pinned member is not on JSR, then tag, push, and hand over the PR. A stop names the
 * command that resumes it.
 */
async function publish(version: string, tag: string, branch: string): Promise<void> {
  console.log("\n6. Committing, tagging, and pushing…");
  await runSteps([
    [["git", "add", "-A"], "git add failed"],
    [["git", "commit", "-m", releaseSubject(version)], "git commit failed"],
  ]);
  // The commit must be exactly the gated tree (a hook, or a write between the gate and the commit,
  // would publish something the gate never saw).
  const refusal = gateRefusal(
    await readGatePass(await gateMarkerPath(version)),
    await currentGateState(version, "corpus"),
    { version, tag, branch },
    "corpus",
  );
  if (refusal) die(refusal);
  await publishSteps({ version, tag, branch }, "corpus");
}

if (import.meta.main) await main();
