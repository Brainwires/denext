// publish.yml refuses a tag that names another version than the config it publishes
// (scripts/publish-tag.ts): JSR takes the version from the config, not the tag.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { tagVersionProblem } from "../scripts/publish-tag.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

Deno.test("tagVersionProblem: the tag must name the config's version under its prefix", () => {
  assertEquals(tagVersionProblem("v4.3.0", "deno.json", "4.3.0"), null);
  assertEquals(tagVersionProblem("v4.3.0-rc.1", "deno.json", "4.3.0-rc.1"), null);
  assertEquals(
    tagVersionProblem("docs-corpus-v4.3.0", "packages/docs-corpus/deno.json", "4.3.0"),
    null,
  );
  assertEquals(tagVersionProblem("og-v0.2.0", "packages/og/deno.json", "0.2.0"), null);
  assertStringIncludes(
    tagVersionProblem("docs-corpus-v4.3.0", "packages/docs-corpus/deno.json", "4.3.1")!,
    "is at 4.3.1",
  );
  assertStringIncludes(tagVersionProblem("v4.3.0", "deno.json", "4.3.2")!, "refusing to publish");
  assertStringIncludes(
    tagVersionProblem("v4.3.0", "packages/og/deno.json", "4.3.0")!,
    "does not start with og-v",
  );
  assertStringIncludes(tagVersionProblem("v4.3.0", "deno.json", undefined)!, "no version");
});

Deno.test("publish.yml checks the tag before it verifies or publishes", async () => {
  const yml = await Deno.readTextFile(join(ROOT, ".github", "workflows", "publish.yml"));
  const check = yml.indexOf("scripts/publish-tag.ts");
  assert(check > 0, "the check step runs");
  assertMatch(yml.slice(check - 300, check), /name: Check the tag names the config's version/);
  assert(check < yml.indexOf("run: deno publish --config"), "before the publish");
  assert(check < yml.indexOf("run: deno run -A scripts/publish-verify.ts"), "before the gate");
  // Every package tag publish.yml maps resolves to that package's own directory.
  for (const [, prefix, dir] of yml.matchAll(/^\s+([a-z-]+)-v\*\)\s+cfg=packages\/([a-z-]+)\//gm)) {
    assertEquals(prefix, dir, `${prefix}-v* publishes packages/${dir}`);
  }
});
