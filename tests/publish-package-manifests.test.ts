// scripts/publish-package-manifests.ts: what the release's `package-managers` job publishes, and
// how. Every `gh` call goes to a fake that answers like the GitHub API, so the plans (stable vs
// prerelease, a missing token) and the calls (tap / bucket commits, the winget pull request) are
// checked without a network or a real token.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path";
import {
  describePlan,
  executePlan,
  type GhResult,
  type GhRunner,
  isPrerelease,
  planPublish,
  readManifests,
  run,
  type TargetPlan,
} from "../scripts/publish-package-manifests.ts";

const MANIFESTS = {
  "denext.rb": "class Denext < Formula\nend\n",
  "denext.json": '{ "version": "4.2.0" }\n',
  "Brainwires.denext.yaml": "PackageIdentifier: Brainwires.denext\n",
  "Brainwires.denext.installer.yaml": "Installers: []\n",
  "Brainwires.denext.locale.en-US.yaml": "PackageLocale: en-US\n",
};

const ALL_TOKENS: Record<string, string> = {
  HOMEBREW_TAP_TOKEN: "tap-token",
  SCOOP_BUCKET_TOKEN: "bucket-token",
  WINGET_TOKEN: "winget-token",
};

const envOf = (vars: Record<string, string>) => (name: string) => vars[name] || undefined;

type Publish = Extract<TargetPlan, { action: "publish" }>;

/** A fake `gh`: answers by the first rule whose pattern matches the joined args, else 404. */
function fakeGh(rules: Array<[RegExp, GhResult | ((args: string) => GhResult)]> = []) {
  const calls: Array<{ args: string; token: string }> = [];
  const gh: GhRunner = (args, token) => {
    const joined = args.join(" ");
    calls.push({ args: joined, token });
    for (const [re, answer] of rules) {
      if (re.test(joined)) {
        return Promise.resolve(typeof answer === "function" ? answer(joined) : answer);
      }
    }
    if (args[0] === "api" && !args.includes("-X")) return Promise.resolve(NOT_FOUND);
    return Promise.resolve(OK(""));
  };
  return { gh, calls };
}

const OK = (stdout: string): GhResult => ({ code: 0, stdout, stderr: "" });
const NOT_FOUND: GhResult = { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
const file = (text: string, sha = "abc123"): GhResult =>
  OK(JSON.stringify({ sha, content: encodeBase64(new TextEncoder().encode(text)) }));

Deno.test("publish manifests: a stable release with every token publishes all three", () => {
  const plans = planPublish("v4.2.0", envOf(ALL_TOKENS), MANIFESTS);
  assertEquals(plans.map((p) => [p.id, p.action]), [
    ["homebrew", "publish"],
    ["scoop", "publish"],
    ["winget", "publish"],
  ]);
  const [brew, scoop, winget] = plans as Publish[];
  assertEquals(brew.repo, "Brainwires/homebrew-denext");
  assertEquals(Object.keys(brew.files), ["Formula/denext.rb"]);
  assertEquals(brew.message, "denext 4.2.0");
  assertEquals(scoop.repo, "Brainwires/scoop-denext");
  assertEquals(scoop.files, { "bucket/denext.json": MANIFESTS["denext.json"] });
  assertEquals(winget.repo, "Brainwires/winget-pkgs");
  assertEquals(winget.branch, "Brainwires.denext-4.2.0");
  assertEquals(Object.keys(winget.files), [
    "manifests/b/Brainwires/denext/4.2.0/Brainwires.denext.yaml",
    "manifests/b/Brainwires/denext/4.2.0/Brainwires.denext.installer.yaml",
    "manifests/b/Brainwires/denext/4.2.0/Brainwires.denext.locale.en-US.yaml",
  ]);
  // No token ever enters a plan.
  assert(!JSON.stringify(plans).includes("tap-token"));
});

Deno.test("publish manifests: a prerelease publishes nowhere, tokens or not", () => {
  assert(isPrerelease("v4.2.0-rc.1"));
  assert(!isPrerelease("v4.2.0"));
  const plans = planPublish("v4.2.0-rc.1", envOf(ALL_TOKENS), {});
  assertEquals(plans.map((p) => p.action), ["skip", "skip", "skip"]);
  for (const p of plans) assertStringIncludes(describePlan(p), "prerelease");
});

Deno.test("publish manifests: a missing (or empty) token skips just that manager", () => {
  const plans = planPublish(
    "v4.2.0",
    envOf({ HOMEBREW_TAP_TOKEN: "t", SCOOP_BUCKET_TOKEN: "" }),
    MANIFESTS,
  );
  assertEquals(plans.map((p) => p.action), ["publish", "skip", "skip"]);
  assertStringIncludes(describePlan(plans[1]), "no SCOOP_BUCKET_TOKEN secret");
  assertStringIncludes(describePlan(plans[2]), "no WINGET_TOKEN secret");
});

Deno.test("publish manifests: repository overrides come from the environment", () => {
  const plans = planPublish(
    "v4.2.0",
    envOf({
      ...ALL_TOKENS,
      HOMEBREW_TAP_REPO: "me/homebrew-x",
      WINGET_FORK_REPO: "me/winget-pkgs",
    }),
    MANIFESTS,
  ) as Publish[];
  assertEquals(plans.map((p) => p.repo), [
    "me/homebrew-x",
    "Brainwires/scoop-denext",
    "me/winget-pkgs",
  ]);
});

Deno.test("publish manifests: --dry-run prints the plan and calls nothing", async () => {
  const { gh, calls } = fakeGh();
  const lines: string[] = [];
  const ok = await run({
    tag: "v4.2.0",
    manifests: MANIFESTS,
    env: envOf({ HOMEBREW_TAP_TOKEN: "t", WINGET_TOKEN: "w" }),
    gh,
    dryRun: true,
    log: (l) => lines.push(l),
  });
  assert(ok);
  assertEquals(calls, []);
  assertEquals(lines, [
    '[dry run] Homebrew: commit "denext 4.2.0" to Brainwires/homebrew-denext (Formula/denext.rb)',
    "Scoop: skipped — no SCOOP_BUCKET_TOKEN secret is set",
    '[dry run] winget: pull request "New version: Brainwires.denext version 4.2.0" to ' +
    "microsoft/winget-pkgs from Brainwires/winget-pkgs:Brainwires.denext-4.2.0 adding " +
    "manifests/b/Brainwires/denext/4.2.0/Brainwires.denext.yaml, " +
    "manifests/b/Brainwires/denext/4.2.0/Brainwires.denext.installer.yaml, " +
    "manifests/b/Brainwires/denext/4.2.0/Brainwires.denext.locale.en-US.yaml",
  ]);
});

Deno.test("publish manifests: under Actions a skip is a notice, and the run stays green", async () => {
  const lines: string[] = [];
  const ok = await run({
    tag: "v4.2.0",
    manifests: MANIFESTS,
    env: envOf({ GITHUB_ACTIONS: "true" }),
    gh: fakeGh().gh,
    log: (l) => lines.push(l),
  });
  assert(ok);
  assertEquals(lines.length, 3);
  for (const l of lines) assert(l.startsWith("::notice title="), l);
});

Deno.test("publish manifests: the tap gets a new file, or an updated one, by its sha", async () => {
  const [brew] = planPublish("v4.2.0", envOf(ALL_TOKENS), MANIFESTS) as Publish[];
  // New: no sha.
  const fresh = fakeGh();
  assertEquals(await executePlan(brew, fresh.gh, envOf(ALL_TOKENS)), "published");
  const put = fresh.calls.find((c) => c.args.includes("-X PUT"))!;
  assertEquals(put.token, "tap-token");
  assertStringIncludes(put.args, "repos/Brainwires/homebrew-denext/contents/Formula/denext.rb");
  assertStringIncludes(put.args, "message=denext 4.2.0");
  assertStringIncludes(put.args, `content=${encodeBase64(MANIFESTS["denext.rb"])}`);
  assert(!put.args.includes("sha="), put.args);
  // Existing and different: updated by its sha.
  const old = fakeGh([[/^api repos\/Brainwires\/homebrew-denext\/contents\//, file("old", "s1")]]);
  assertEquals(await executePlan(brew, old.gh, envOf(ALL_TOKENS)), "published");
  assertStringIncludes(old.calls.at(-1)!.args, "sha=s1");
  // Existing and identical: no commit.
  const same = fakeGh([[/contents\/Formula/, file(MANIFESTS["denext.rb"])]]);
  assertEquals(await executePlan(brew, same.gh, envOf(ALL_TOKENS)), "unchanged");
  assertEquals(same.calls.length, 1);
});

Deno.test("publish manifests: a failed commit fails that manager, not the others", async () => {
  const lines: string[] = [];
  const { gh, calls } = fakeGh([
    [/-X PUT repos\/Brainwires\/homebrew-denext/, { code: 1, stdout: "", stderr: "HTTP 403" }],
  ]);
  const ok = await run({
    tag: "v4.2.0",
    manifests: MANIFESTS,
    env: envOf({ HOMEBREW_TAP_TOKEN: "t", SCOOP_BUCKET_TOKEN: "s" }),
    gh,
    log: (l) => lines.push(l),
  });
  assert(!ok);
  assert(lines.some((l) => l.startsWith("error: gh api -X PUT failed")), lines.join("\n"));
  assert(calls.some((c) => c.args.includes("-X PUT repos/Brainwires/scoop-denext")));
  assertEquals(lines.at(-1), "winget: skipped — no WINGET_TOKEN secret is set");
});

Deno.test("publish manifests: winget syncs the fork, branches, commits and opens the PR", async () => {
  const winget = (planPublish("v4.2.0", envOf(ALL_TOKENS), MANIFESTS) as Publish[])[2];
  const { gh, calls } = fakeGh([
    // The package exists upstream (an earlier version), this version does not.
    [/^api repos\/microsoft\/winget-pkgs\/contents\/manifests\/b\/Brainwires\/denext$/, OK("[]")],
    [/git\/ref\/heads\/master/, OK("deadbeef\n")],
  ]);
  assertEquals(await executePlan(winget, gh, envOf(ALL_TOKENS)), "published");
  assert(calls.every((c) => c.token === "winget-token"));
  const seq = calls.map((c) => c.args);
  const at = (needle: string) => seq.findIndex((a) => a.includes(needle));
  assert(at("merge-upstream") >= 0);
  assert(at("merge-upstream") < at("git/refs -f ref=refs/heads/Brainwires.denext-4.2.0"));
  assertStringIncludes(seq[at("git/refs -f ref=")], "sha=deadbeef");
  const puts = seq.filter((a) => a.includes("-X PUT"));
  assertEquals(puts.length, 3);
  for (const p of puts) {
    assertStringIncludes(
      p,
      "repos/Brainwires/winget-pkgs/contents/manifests/b/Brainwires/denext/4.2.0/",
    );
    assertStringIncludes(p, "branch=Brainwires.denext-4.2.0");
  }
  const pr = seq.at(-1)!;
  assertStringIncludes(pr, "pr create --repo microsoft/winget-pkgs --base master");
  assertStringIncludes(pr, "--head Brainwires:Brainwires.denext-4.2.0");
  assertStringIncludes(pr, "--title New version: Brainwires.denext version 4.2.0");
});

Deno.test("publish manifests: winget's first submission is a New package PR", async () => {
  const winget = (planPublish("v4.2.0", envOf(ALL_TOKENS), MANIFESTS) as Publish[])[2];
  const { gh, calls } = fakeGh([[/git\/ref\/heads\/master/, OK("deadbeef")]]);
  assertEquals(await executePlan(winget, gh, envOf(ALL_TOKENS)), "published");
  assertStringIncludes(calls.at(-1)!.args, "--title New package: Brainwires.denext version 4.2.0");
});

Deno.test("publish manifests: winget never resubmits a merged version or an open PR", async () => {
  const winget = (planPublish("v4.2.0", envOf(ALL_TOKENS), MANIFESTS) as Publish[])[2];
  const merged = fakeGh([[/contents\/manifests\/b\/Brainwires\/denext\/4\.2\.0$/, OK("[]")]]);
  assertEquals(await executePlan(winget, merged.gh, envOf(ALL_TOKENS)), "already-merged");
  assertEquals(merged.calls.length, 1);
  const open = fakeGh([[/^pr list/, OK("https://github.com/microsoft/winget-pkgs/pull/1\n")]]);
  assertEquals(await executePlan(winget, open.gh, envOf(ALL_TOKENS)), "pull-request-open");
  assert(!open.calls.some((c) => c.args.includes("-X")), "nothing is written");
});

Deno.test("publish manifests: readManifests reads the generated files from the release dir", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "denext.rb"), "rb");
    await Deno.writeTextFile(join(dir, "SHA256SUMS"), "not a manifest");
    assertEquals(await readManifests(dir), { "denext.rb": "rb" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("publish.yml runs the publisher after the release, stable tags only, tokens as secrets", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/publish.yml", import.meta.url),
  );
  const job = workflow.slice(workflow.indexOf("\n  package-managers:"));
  const body = job.slice(0, job.indexOf("\n  windows-arm-check:"));
  assertStringIncludes(body, "needs: release");
  assertStringIncludes(
    body,
    "if: startsWith(github.ref_name, 'v') && !contains(github.ref_name, '-')",
  );
  assertStringIncludes(
    body,
    'scripts/publish-package-manifests.ts --version "$GITHUB_REF_NAME" --dir dist',
  );
  for (const secret of ["HOMEBREW_TAP_TOKEN", "SCOOP_BUCKET_TOKEN", "WINGET_TOKEN"]) {
    assertStringIncludes(body, `${secret}: \${{ secrets.${secret} }}`);
  }
  // The release job itself never holds a package-manager token.
  const release = workflow.slice(
    workflow.indexOf("\n  release:"),
    workflow.indexOf("\n  package-managers:"),
  );
  assert(!release.includes("TAP_TOKEN") && !release.includes("WINGET_TOKEN"));
});
