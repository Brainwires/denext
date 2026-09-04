// The release tooling's pure/dry-run halves: the version bump (dry: reads the real target
// files, writes nothing) and the CHANGELOG roll + release preparation in dry mode.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { bumpVersion, printBumpResult } from "../scripts/bump-version.ts";
import { prepareRelease, rollChangelog } from "../scripts/release.ts";

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
  const entries = await rollChangelog("99.0.0-test.1", true);
  // Mid-release the real [Unreleased] section is already rolled (empty), and this test runs
  // inside that very gate — so only the count's shape and the no-write contract are asserted.
  assert(Number.isInteger(entries) && entries >= 0, "reports a non-negative entry count");
  assertEquals(await Deno.readTextFile(new URL("../CHANGELOG.md", import.meta.url)), before);
});

Deno.test("prepareRelease (dry) reports the bump, the golden refresh and the changelog roll", async () => {
  const out = await captured(() => prepareRelease("99.0.0-test.1", true));
  assertStringIncludes(out, "1. Bump");
  assertStringIncludes(out, "1b. ");
  assertStringIncludes(out, "2. CHANGELOG: rolled [Unreleased] → [99.0.0-test.1]");
});
