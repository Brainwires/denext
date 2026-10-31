// The release tooling's pure/dry-run halves: the version bump (dry: reads the real target
// files, writes nothing) and the CHANGELOG roll + release preparation in dry mode.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { renderMarkdown } from "../packages/content-collections/markdown.ts";
import { publishedFiles } from "./_published-files.ts";
import {
  bumpVersion,
  currentVersionPattern,
  docSpecifierPattern,
  printBumpResult,
} from "../scripts/bump-version.ts";
import {
  foldedAnchorRewrites,
  foldPrereleases,
  headingSlug,
  prepareRelease,
  relinkDocsPages,
  rewriteFoldedAnchors,
  rewriteInPageAnchors,
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
  // @denext/docs-corpus IS denext's version: its manifest and denext's exact import of it move too.
  assert(
    result.changed.some((c) => c.file === "packages/docs-corpus/deno.json"),
    "the docs corpus's version moves with denext's",
  );
  assert(
    result.changed.find((c) => c.file === "deno.json")!.hits >= 2,
    "root deno.json: the version and the jsr:@denext/docs-corpus@<version> import",
  );
  assert(result.total >= result.changed.length);
  const out = await captured(() => printBumpResult(result, true));
  assertStringIncludes(out, `Bumping ${result.oldVersion} → 99.0.0-test.1  (dry run)`);
  assertStringIncludes(out, "Would change");
  assertStringIncludes(out, "Reminders");
});

Deno.test("a stable bump rewrites the docs' prerelease specifiers of its own line only", () => {
  assertEquals(docSpecifierPattern("4.0.0-rc.3"), null, "an rc bump leaves the docs alone");
  const re = docSpecifierPattern("4.0.0")!;
  const text = [
    `"denext": "jsr:@denext/denext@^4.0.0-rc.1",`,
    "deno run -A jsr:@denext/denext@^4.0.0-rc.12/cli start .",
    "jsr:@denext/denext@^3.4.0-rc.1 and jsr:@denext/denext@^4.0.0 and jsr:@denext/denext@^14.0.0-rc.1",
  ].join("\n");
  assertEquals(
    text.replace(re, "4.0.0"),
    [
      `"denext": "jsr:@denext/denext@^4.0.0",`,
      "deno run -A jsr:@denext/denext@^4.0.0/cli start .",
      "jsr:@denext/denext@^3.4.0-rc.1 and jsr:@denext/denext@^4.0.0 and jsr:@denext/denext@^14.0.0-rc.1",
    ].join("\n"),
  );
});

Deno.test("bumpVersion (dry) to a stable release lists the docs that teach an rc specifier", async () => {
  const current = (await bumpVersion("99.0.0-test.1", { dry: true })).oldVersion;
  const core = current.split("-")[0];
  if (core === current) return; // already on a stable release: nothing to fold
  const result = await bumpVersion(core, { dry: true });
  assert(
    result.changed.some((c) => c.file === "README.md" || c.file.startsWith("site/app/docs/")),
    "the README / docs pages' rc specifiers move to the release",
  );
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
  assertStringIncludes(out, "1c. revocation floor (skipped — dry run)");
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

Deno.test("a stable fold keeps one group per heading, intros and all, and relinks its own anchors", () => {
  // 4.0.0's shape: two rc sections with the same `###` heading, one opening with a paragraph that
  // links the other rc's header. The fold rendered two `### Breaking (4.0)` sections and left that
  // link pointing at a header it had removed.
  const text = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "## [4.0.0-rc.2] - 2026-10-13",
    "",
    "### Breaking (4.0)",
    "",
    "These join the [rc.1 breaking changes](#400-rc1---2026-10-13).",
    "",
    "- two",
    "",
    "## [4.0.0-rc.1] - 2026-10-13",
    "",
    "### Breaking (4.0)",
    "",
    "- one",
    "",
    "## [3.4.16] - 2026-10-12",
    "",
    "- old",
    "",
  ].join("\n");
  const folded = rewriteInPageAnchors(
    foldPrereleases(text, "4.0.0", "2026-10-14"),
    foldedAnchorRewrites(text, "4.0.0", "2026-10-14"),
  );
  assertEquals(folded.split("\n").filter((l) => l === "### Breaking (4.0)").length, 1, folded);
  assertStringIncludes(
    folded,
    "### Breaking (4.0)\n\nThese join the [rc.1 breaking changes](#400---2026-10-14).\n\n- two\n- one\n",
  );
  assert(!folded.includes("#400-rc"), "no link to a folded rc header survives");
  // A link to a header that was not folded is untouched.
  const kept = "[3.4.16](#3416---2026-10-12)";
  assertEquals(rewriteInPageAnchors(kept, foldedAnchorRewrites(text, "4.0.0", "2026-10-14")), kept);
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

Deno.test("the release regenerates the plugin catalog the bump makes stale, before the corpus", async () => {
  const { RELEASE_REGEN_TASKS } = await import("../scripts/release.ts");
  const deno = JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url)));
  for (const task of RELEASE_REGEN_TASKS) assert(task in deno.tasks, `${task} is a deno task`);
  const at = (t: string) => RELEASE_REGEN_TASKS.indexOf(t);
  assert(at("gen:plugin-catalog") >= 0, "the catalog is regenerated");
  assert(at("gen:plugin-catalog") < at("docs:corpus"), "before the corpus that reads it");
  assert(at("docs:mcp") < at("docs:corpus"), "the MCP page feeds the corpus");
});

Deno.test("the release gate re-checks only the release's own changes unless --full-gate", async () => {
  const { gateCommand, RELEASE_DELTA_TESTS } = await import("../scripts/release.ts");
  assertEquals(gateCommand(true), ["deno", "task", "check"]);
  const [sh, flag, script] = gateCommand(false);
  assertEquals([sh, flag], ["sh", "-c"]);
  assertStringIncludes(script, "deno fmt --check && deno lint && ");
  for (const file of RELEASE_DELTA_TESTS) {
    assertStringIncludes(script, file);
    assert((await Deno.stat(new URL(`../${file}`, import.meta.url))).isFile, `${file} exists`);
  }
});

Deno.test("the @denext/denext package stays clear of JSR's 20 MiB cap", async () => {
  // JSR refuses a package over 20 MiB at upload (its hard limit), after the tag is pushed
  // (4.0.0's first two publishes). Sum what `deno publish` sends against a guard below that limit.
  // The guard was 19 MiB; 4.9.0 grew past it, so it was 19.6 MiB while the quota increase asked of
  // JSR on 2026-10-25 is pending. Raised to 19.85 MiB on 2026-10-29 for the 4.10-c train
  // (19.545 → 19.79 MiB, all of it source: the OTA app binding and desktop overlay verification,
  // the lock rework, the resource limits, the next.config sandbox's contained read, the child
  // probe, the react-reconciler context bridge, the mobile build / doctor checks). Nothing in the
  // publish set is outside the import graph of an export but the React Native modules that
  // resolveAlias reaches by path, so there was nothing to drop; 0.15 MiB of headroom to 20 MiB is
  // left. Splitting the package (the auth package first) is 5.0 work. Raised to 19.9 MiB on
  // 2026-10-30 for the 4.10-d train (19.79 → 19.85 MiB: workspace globs, desktop transfer
  // records, the child-exit grace, React Router render middleware). Lowered to 19.75 MiB for the
  // 4.10-e train (20.03 MiB with its merges, the revoked-runtimes list, start.tls and the Prisma
  // 7 migration among them, → 19.70 MiB): the packed native templates moved into
  // @denext/docs-corpus, which denext pins at exactly its own version and every release publishes
  // first (scripts/lib/docs-corpus-package.ts CORPUS_DATA_MODULES; a checkout reads its own copy),
  // and the config schema, the CLI's verb descriptions and the Google Fonts families ship
  // Brotli-packed. Those three moved to docs-corpus first, which broke the CLI run from a checkout
  // outside its workspace: it resolved the corpus from JSR, where the commit's modules were not
  // published yet, or not past Deno's minimum dependency age. The 4.10-f train (19.73 MiB) packed
  // the `denext ui` assets, the dev page scripts, the scaffolded desktop packaging scripts and the
  // expo / React Native manifests in-package (scripts/gen-packed-texts.ts, tests/packed-texts.test.ts)
  // → 19.59 MiB; the guard stays at 19.75 MiB for the trains merging after it. The 4.11.1 trains
  // (19.747 MiB) moved the fastlane files, the widget / Live Activity / native-module sources, the
  // composed MainActivity's blocks and the scaffolded desktop packaging scripts into the
  // docs-corpus pack (holes filled by `fillTemplate`), packed the fallow init texts (the coverage
  // converter is read from scripts/coverage-to-istanbul.ts, no longer pasted), front-coded the font
  // metrics, moved the doc-lint list to scripts/doc-lint.ts and stopped publishing MISSION.md and
  // POLICIES.md → 19.65 MiB; 0.25 MiB above that is past 19.75, so the guard stays. The CLI verbs'
  // help text stopped shipping twice (plain in src/cli/commands/*.ts and packed in
  // src/cli/command-meta.packed.ts): the readable copy moved to the unpublished
  // src/cli/commands/meta/ → 19.55 MiB; 0.25 MiB above that is still past 19.75, so the guard
  // stays. Raise it only with the reason.
  const files = await publishedFiles();
  if (!files) return; // not a git checkout: nothing to measure
  const mib = [...files.values()].reduce((a, b) => a + b, 0) / 1024 / 1024;
  assert(mib < 19.75, `the package is ${mib.toFixed(2)} MiB; JSR refuses anything over 20 MiB`);
  // The data @denext/docs-corpus carries for denext stays out of it, and the plain-text copies of
  // what ships packed stay unpublished.
  for (
    const file of [
      "denext.config.schema.json",
      "src/build/native-templates/ota.ts",
      "src/compat/next/font/google-families.ts",
      "src/plugin/catalog.json",
      "src/cli/commands/meta/desktop.ts",
    ]
  ) assert(!files.has(file), `${file} is published again`);
  for (
    const file of ["src/build/native-templates.packed.ts", "src/cli/command-table.generated.ts"]
  ) {
    assert((files.get(file) ?? 0) < 16 * 1024, `${file} carries its data again`);
  }
  for (
    const file of [
      "src/cli/command-meta.packed.ts",
      "src/ui/form/config-schema.packed.ts",
      "src/compat/next/font/google-families.packed.ts",
      "src/plugin/catalog.packed.ts",
    ]
  ) assert(files.has(file), `${file} is not published`);
});

/** Published generated files over 50 KiB that may ship uncompressed, and why. */
const UNCOMPRESSED_GENERATED_OK: Readonly<Record<string, string>> = {
  "src/compat/next/font/font-metrics.ts":
    "next/font can run in a browser bundle, which has no node:zlib; already one compact row string",
};

Deno.test("no published generated file over 50 KiB ships uncompressed", async () => {
  // A generated table or a template set is data the package can carry Brotli-compressed (see
  // src/build/packed-text.ts and packages/docs-corpus/mod.ts): a quarter of its size. One that grows
  // past 50 KiB as plain text is the creep that took 4.0.0 to JSR's cap. Compress it, or list it
  // in UNCOMPRESSED_GENERATED_OK with the reason it must stay plain.
  const files = await publishedFiles();
  if (!files) return;
  const root = new URL("../", import.meta.url);
  const offenders: string[] = [];
  for (const [file, size] of files) {
    if (size <= 50 * 1024 || file in UNCOMPRESSED_GENERATED_OK) continue;
    const text = await Deno.readTextFile(new URL(file, root));
    const generated = /\.(generated|packed)\.|templates?\.ts$/.test(file) ||
      /\bgenerated (by|from)\b|do not edit/i.test(text.slice(0, 1024));
    if (!generated) continue;
    // Compressed: one base64 string literal (Brotli) holds nearly all of it.
    const blob = Math.max(
      0,
      ...[...text.matchAll(/"[A-Za-z0-9+/=]{1024,}"/g)].map((m) => m[0].length),
    );
    if (blob < size * 0.8) offenders.push(`${file} (${(size / 1024).toFixed(0)} KiB)`);
  }
  assertEquals(offenders, [], "generated files over 50 KiB that ship uncompressed");
  for (const file of Object.keys(UNCOMPRESSED_GENERATED_OK)) {
    assert(files.has(file), `UNCOMPRESSED_GENERATED_OK lists ${file}, which is not published`);
  }
});

Deno.test("bump: an npm dependency that shares denext's version keeps its own", () => {
  const text = `{ "version": "4.3.1", "a": "jsr:@denext/denext@^4.3.1/server",
  "tus-js-client": "npm:tus-js-client@4.3.1", "b": "npm:@scope/x@^4.3.1", "c": "14.3.1" }`;
  const out = text.replace(currentVersionPattern("4.3.1"), "4.4.0");
  assertStringIncludes(out, `"version": "4.4.0"`);
  assertStringIncludes(out, "jsr:@denext/denext@^4.4.0/server");
  assertStringIncludes(out, "npm:tus-js-client@4.3.1");
  assertStringIncludes(out, "npm:@scope/x@^4.3.1");
  assertStringIncludes(out, `"14.3.1"`);
});
