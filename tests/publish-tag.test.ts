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

Deno.test("ci.yml dry-runs the stripped publish on stock Deno, before a tag can exist", async () => {
  const yml = await Deno.readTextFile(join(ROOT, ".github", "workflows", "ci.yml"));
  const step = yml.indexOf("name: Publish dry-run of the stripped package");
  const strip = yml.indexOf("deno run -A scripts/publish-strip.ts --write", step);
  const dry = yml.indexOf("deno publish --dry-run --allow-dirty", strip);
  const toolchain = yml.indexOf("name: Put denext's Deno toolchain on PATH");
  assert(step > 0 && step < strip && strip < dry, "strips, then dry-runs");
  assert(dry < toolchain, "under the stock Deno publish.yml publishes with");
  assert(
    yml.indexOf("\n  check:\n") < step && step < yml.indexOf("\n  bundle-budget:\n"),
    "in `check`",
  );
});

Deno.test("publish.yml checks the tag before it verifies or publishes", async () => {
  const yml = await Deno.readTextFile(join(ROOT, ".github", "workflows", "publish.yml"));
  const check = yml.indexOf("scripts/publish-tag.ts");
  assert(check > 0, "the check step runs");
  assertMatch(yml.slice(check - 300, check), /name: Check the tag names the config's version/);
  const publish = yml.indexOf("run: deno publish --allow-dirty --config");
  assert(check > 0 && check < publish, "before the publish");
  // The comments go after the verify step's leftovers are cleared, on @denext/denext only.
  const strip = yml.indexOf("run: deno run -A scripts/publish-strip.ts --write");
  assert(yml.indexOf("git clean -fdq") < strip && strip < publish, "strips right before publish");
  assertMatch(yml.slice(strip - 100, strip), /if: steps\.pkg\.outputs\.config == 'deno\.json'/);
  assert(check < yml.indexOf("run: deno run -A scripts/publish-verify.ts"), "before the gate");
  // Every package tag publish.yml maps resolves to that package's own directory.
  for (const [, prefix, dir] of yml.matchAll(/^\s+([a-z-]+)-v\*\)\s+cfg=packages\/([a-z-]+)\//gm)) {
    assertEquals(prefix, dir, `${prefix}-v* publishes packages/${dir}`);
  }
});
