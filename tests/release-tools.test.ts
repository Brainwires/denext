// The release tooling's pure/dry-run halves: the version bump (dry: reads the real target
// files, writes nothing) and the CHANGELOG roll + release preparation in dry mode.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { renderMarkdown } from "../packages/content-collections/markdown.ts";
import { bumpVersion, printBumpResult } from "../scripts/bump-version.ts";
import {
  foldedAnchorRewrites,
  foldPrereleases,
  headingSlug,
  prepareRelease,
  relinkDocsPages,
  rewriteFoldedAnchors,
  rollChangelog,
} from "../scripts/release.ts";

/** Capture console output while `fn` runs. */
async function captured(fn: () => Promise<void> | void): Promise<string> {
  const lines: string[] = [];
  const { log, warn } = console;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  console.warn = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return lines.join("\n");
}

Deno.test("bumpVersion (dry) finds the current version in the target files and reports it", async () => {
  const result = await bumpVersion("99.0.0-test.1", { dry: true });
  assert(result.oldVersion !== "99.0.0-test.1");
  assert(result.changed.some((c) => c.file === "deno.json"), "root deno.json carries the version");
  assert(result.total >= result.changed.length);
  const out = await captured(() => printBumpResult(result, true));
  assertStringIncludes(out, `Bumping ${result.oldVersion} → 99.0.0-test.1  (dry run)`);
  assertStringIncludes(out, "Would change");
  assertStringIncludes(out, "Reminders");
});

Deno.test("rollChangelog (dry) counts the unreleased entries without touching the file", async () => {
  const before = await Deno.readTextFile(new URL("../CHANGELOG.md", import.meta.url));
  const { entries, relinked } = await rollChangelog("99.0.0-test.1", true);
  // Mid-release the real [Unreleased] section is already rolled (empty), and this test runs
  // inside that very gate — so only the count's shape and the no-write contract are asserted.
  assert(Number.isInteger(entries) && entries >= 0, "reports a non-negative entry count");
  assertEquals(relinked, [], "a prerelease folds nothing, so no docs page is relinked");
  assertEquals(await Deno.readTextFile(new URL("../CHANGELOG.md", import.meta.url)), before);
});

Deno.test("prepareRelease (dry) reports the bump, the golden refresh and the changelog roll", async () => {
  const out = await captured(() => prepareRelease("99.0.0-test.1", true));
  assertStringIncludes(out, "1. Bump");
  assertStringIncludes(out, "1b. ");
  assertStringIncludes(out, "2. CHANGELOG: rolled [Unreleased] → [99.0.0-test.1]");
});

Deno.test("foldPrereleases keeps a blank line between the preamble and [Unreleased] (fmt-clean)", () => {
  const text =
    "# Changelog\n\nIntro.\n\n## [Unreleased]\n\n### Added\n\n- a\n\n## [1.0.0] - 2026-01-01\n\n- old\n";
  const out = foldPrereleases(text, "1.1.0", "2026-02-02");
  assertStringIncludes(out, "Intro.\n\n## [Unreleased]\n");
  assertStringIncludes(out, "## [1.1.0] - 2026-02-02");
});

/** A changelog with two rc sections above the previous stable release. */
const RC_CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Fixed",
  "",
  "- c",
  "",
  "## [2.5.0-rc.2] - 2026-09-14",
  "",
  "### Added",
  "",
  "- b",
  "",
  "## [2.5.0-rc.1] - 2026-09-14",
  "",
  "### Added",
  "",
  "- a",
  "",
  "## [2.4.0] - 2026-09-11",
  "",
  "- old",
  "",
].join("\n");

/** A docs page linking both rc anchors, one of them twice, plus an anchor that is not folded. */
const UPGRADING = [
  "# Upgrading",
  "",
  "- One. ([2.5.0-rc.2](/docs/changelog#250-rc2---2026-09-14))",
  "- Two. ([2.5.0-rc.1](/docs/changelog#250-rc1---2026-09-14),",
  "  [2.5.0-rc.2](/docs/changelog#250-rc2---2026-09-14))",
  "- Older. ([2.4.0](/docs/changelog#240---2026-09-11))",
  "",
].join("\n");

Deno.test("headingSlug is the id the docs site renders a changelog header with", () => {
  // The site's renderer owns the slug; this pins the release script's copy to it, so a
  // rewritten link lands on the anchor the changelog page actually emits.
  for (const heading of ["## [2.5.0-rc.1] - 2026-09-14", "## [2.5.0] - 2026-09-18"]) {
    assertStringIncludes(renderMarkdown(heading + "\n"), `id="${headingSlug(heading)}"`);
  }
  assertEquals(headingSlug("## [2.5.0-rc.1] - 2026-09-14"), "250-rc1---2026-09-14");
  assertEquals(headingSlug("## [2.5.0] - 2026-09-18"), "250---2026-09-18");
});

Deno.test("a stable fold maps every rc anchor to the release header's, and nothing else", () => {
  const rewrites = foldedAnchorRewrites(RC_CHANGELOG, "2.5.0", "2026-09-18");
  assertEquals(
    [...rewrites],
    [
      ["250-rc2---2026-09-14", "250---2026-09-18"],
      ["250-rc1---2026-09-14", "250---2026-09-18"],
    ],
  );
  // The folded changelog really does carry that header, so the new anchor exists.
  const folded = foldPrereleases(RC_CHANGELOG, "2.5.0", "2026-09-18");
  assertStringIncludes(folded, "## [2.5.0] - 2026-09-18");
  assert(!folded.includes("[2.5.0-rc."), "the rc headers are gone");

  const out = rewriteFoldedAnchors(UPGRADING, rewrites);
  assertEquals(
    out,
    [
      "# Upgrading",
      "",
      "- One. ([2.5.0-rc.2](/docs/changelog#250---2026-09-18))",
      "- Two. ([2.5.0-rc.1](/docs/changelog#250---2026-09-18),",
      "  [2.5.0-rc.2](/docs/changelog#250---2026-09-18))",
      "- Older. ([2.4.0](/docs/changelog#240---2026-09-11))",
      "",
    ].join("\n"),
  );
  // An anchor is matched whole: `rc1` never claims a longer slug that starts the same way.
  const longer = "[x](/docs/changelog#250-rc1---2026-09-14-extra)";
  assertEquals(rewriteFoldedAnchors(longer, rewrites), longer);
});

Deno.test("relinkDocsPages rewrites the pages that link a folded anchor, and honours --dry", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext_release_docs_" });
  try {
    await Deno.mkdir(join(root, "docs", "upgrading"), { recursive: true });
    await Deno.mkdir(join(root, "docs", "cli"), { recursive: true });
    const page = join(root, "docs", "upgrading", "content.md");
    const other = join(root, "docs", "cli", "content.md");
    await Deno.writeTextFile(page, UPGRADING);
    await Deno.writeTextFile(other, "# CLI\n\nSee [2.4.0](/docs/changelog#240---2026-09-11).\n");
    const rewrites = foldedAnchorRewrites(RC_CHANGELOG, "2.5.0", "2026-09-18");

    // Dry: the page is named, the file is untouched.
    const dry = await relinkDocsPages(rewrites, true, root);
    assertEquals(dry.length, 1);
    assert(dry[0].endsWith(join("docs", "upgrading", "content.md")), dry[0]);
    assertEquals(await Deno.readTextFile(page), UPGRADING);

    // Real: the page is rewritten; the page with no folded anchor is neither written nor named.
    const wet = await relinkDocsPages(rewrites, false, root);
    assertEquals(wet, dry);
    const after = await Deno.readTextFile(page);
    assert(!after.includes("#250-rc"), "no rc anchor survives the fold");
    assertStringIncludes(after, "(/docs/changelog#250---2026-09-18)");
    assertStringIncludes(after, "(/docs/changelog#240---2026-09-11)");
    assertEquals(
      await Deno.readTextFile(other),
      "# CLI\n\nSee [2.4.0](/docs/changelog#240---2026-09-11).\n",
    );
    // Nothing to fold means nothing to walk.
    assertEquals(await relinkDocsPages(new Map(), false, root), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
