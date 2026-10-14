// The publish workflow's verify decision (scripts/publish-verify.ts): the full suite is skipped only
// when ci.yml's heavy run vouches for the tagged commit, or for the parent of the release script's
// own commit; anything else, a failure to ask included, runs the whole suite.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { verifyCommands, type VerifyFacts, verifyMode } from "../scripts/publish-verify.ts";
import { RELEASE_DELTA_TESTS } from "../scripts/release.ts";

/** Facts where `green` commits have a green heavy run and `commits` gives subjects/parents. */
function facts(
  green: string[],
  commits: Record<string, { subject: string; parent?: string }>,
): VerifyFacts {
  return {
    verdict: (sha) =>
      Promise.resolve(
        green.includes(sha)
          ? { ok: true, reason: `green on ${sha}` }
          : { ok: false, reason: `no ci.yml run on ${sha} ran the heavy jobs` },
      ),
    commit: (sha) => Promise.resolve(commits[sha] ?? { subject: "unknown" }),
  };
}

Deno.test("a tagged commit CI already passed re-runs fmt + lint only", async () => {
  const { mode } = await verifyMode("abc", facts(["abc"], {}));
  assertEquals(mode, "ci");
  assertEquals(verifyCommands(mode), ["deno fmt --check", "deno lint"]);
});

Deno.test("the release script's commit on a checked parent runs the release delta gate", async () => {
  const commits = { rel: { subject: "release: denext 4.0.0", parent: "base" } };
  const { mode, reason } = await verifyMode("rel", facts(["base"], commits));
  assertEquals(mode, "delta");
  assertStringIncludes(reason, "green on base");
  const commands = verifyCommands(mode).join(" && ");
  for (const file of RELEASE_DELTA_TESTS) assertStringIncludes(commands, file);
  assertStringIncludes(commands, "deno check cli.ts mod.ts");
  // An rc's release commit qualifies the same way.
  const rc = { rel: { subject: "release: denext 4.1.0-rc.1", parent: "base" } };
  assertEquals((await verifyMode("rel", facts(["base"], rc))).mode, "delta");
});

Deno.test("anything CI did not vouch for runs the whole suite", async () => {
  // A release commit whose parent CI never checked.
  const rel = { rel: { subject: "release: denext 4.0.0", parent: "base" } };
  assertEquals((await verifyMode("rel", facts([], rel))).mode, "full");
  // A checked parent, but the tagged commit is not the release script's (a fix on top).
  const fix = { fix: { subject: "fix: something", parent: "base" } };
  assertEquals((await verifyMode("fix", facts(["base"], fix))).mode, "full");
  // A subject that only starts like a release commit.
  const sly = { s: { subject: "release: denext 4.0.0 and a change", parent: "base" } };
  assertEquals((await verifyMode("s", facts(["base"], sly))).mode, "full");
  // gh failing is never a pass.
  const broken: VerifyFacts = {
    verdict: () => Promise.reject(new Error("gh: not logged in")),
    commit: () => Promise.resolve({ subject: "release: denext 4.0.0", parent: "base" }),
  };
  const failed = await verifyMode("x", broken);
  assertEquals(failed.mode, "full");
  assertStringIncludes(failed.reason, "gh: not logged in");
  assertStringIncludes(
    verifyCommands("full").join(" "),
    "--ignore=tests/e2e/,tests/migration-bed/",
  );
});
