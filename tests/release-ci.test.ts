// The release's CI gate (scripts/release-ci.ts): a version is tagged only from a commit whose newest
// ci.yml run that ran the heavy jobs is green, with `gh` faked.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CiJob,
  type CiRun,
  RELEASE_CI_JOBS,
  releaseCiHint,
  releaseCiVerdict,
  unmetCiJobs,
} from "../scripts/release-ci.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** A run of ci.yml. */
function run(id: number, event: string, createdAt: string, status = "completed"): CiRun {
  return { databaseId: id, event, status, conclusion: "", createdAt, url: `https://x/runs/${id}` };
}

/** Every release job with `conclusion`, then `over` on top. */
function jobs(conclusion: string, over: Record<string, string> = {}): CiJob[] {
  return RELEASE_CI_JOBS.map((name) => ({
    name,
    status: "completed",
    conclusion: over[name] ?? conclusion,
  }));
}

/** A push run: the fast jobs ran, the heavy ones were skipped. */
const PUSH_JOBS = jobs("success", {
  integration: "skipped",
  "next-compat": "skipped",
  coverage: "skipped",
});

/** A fake `gh` over `runs` (the list) and `jobsOf` (each run's jobs); records its calls. */
function fakeGh(runs: CiRun[], jobsOf: Record<number, CiJob[]>) {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    if (args[1] === "list") return Promise.resolve(runs);
    return Promise.resolve({ jobs: jobsOf[Number(args[2])] ?? [] });
  };
  return { gh, calls };
}

Deno.test("release CI gate: the jobs a release needs, and what is unmet", () => {
  assertEquals(RELEASE_CI_JOBS, [
    "check",
    "integration",
    "next-compat",
    "coverage",
    "ios-export-router",
  ]);
  assertEquals(unmetCiJobs(jobs("success")), []);
  assertEquals(
    unmetCiJobs(jobs("success", { coverage: "failure" }).filter((j) => j.name !== "check")),
    ["check: missing", "coverage: failure"],
  );
  assertEquals(
    unmetCiJobs([{ name: "check", status: "in_progress", conclusion: "" }], ["check"]),
    ["check: in_progress"],
  );
});

Deno.test("release CI gate: a green dispatch run on HEAD passes, past a newer push run", async () => {
  const { gh, calls } = fakeGh(
    [run(1, "workflow_dispatch", "2026-10-06T10:00:00Z"), run(2, "push", "2026-10-06T11:00:00Z")],
    { 1: jobs("success"), 2: PUSH_JOBS },
  );
  const verdict = await releaseCiVerdict(SHA, gh);
  assert(verdict.ok, verdict.reason);
  assertEquals(verdict.run?.databaseId, 1);
  // It asked for ci.yml runs on exactly this commit.
  assertEquals(calls[0].slice(0, 6), ["run", "list", "--workflow", "ci.yml", "--commit", SHA]);
});

Deno.test("release CI gate: only push runs (heavy jobs skipped) refuse, with how to dispatch", async () => {
  const { gh } = fakeGh([run(2, "push", "2026-10-06T11:00:00Z")], { 2: PUSH_JOBS });
  const verdict = await releaseCiVerdict(SHA, gh);
  assert(!verdict.ok);
  assertStringIncludes(verdict.reason, "no ci.yml run");
  assertStringIncludes(releaseCiHint("development"), "gh workflow run ci.yml --ref development");
  // No run at all: the same refusal.
  assert(!(await releaseCiVerdict(SHA, fakeGh([], {}).gh)).ok);
});

Deno.test("release CI gate: the NEWEST heavy run decides — a failure, or one still running, refuses", async () => {
  const older = run(1, "workflow_dispatch", "2026-10-06T10:00:00Z");
  const failed = fakeGh([older, run(3, "workflow_dispatch", "2026-10-06T12:00:00Z")], {
    1: jobs("success"),
    3: jobs("success", { "next-compat": "failure" }),
  });
  const verdict = await releaseCiVerdict(SHA, failed.gh);
  assert(!verdict.ok);
  assertStringIncludes(verdict.reason, "next-compat: failure");
  assertEquals(verdict.run?.databaseId, 3);

  const running = fakeGh([older, run(4, "workflow_dispatch", "2026-10-06T12:00:00Z", "queued")], {
    1: jobs("success"),
    4: jobs("", { check: "success" }),
  });
  const pending = await releaseCiVerdict(SHA, running.gh);
  assert(!pending.ok);
  assertStringIncludes(pending.reason, "queued");
});

Deno.test("release CI gate: the release script runs it before changing anything", async () => {
  const src = await Deno.readTextFile(new URL("../scripts/release.ts", import.meta.url));
  const main = src.slice(src.indexOf("async function main()"));
  assert(main.indexOf("checkCi(") < main.indexOf("prepareRelease("), "CI is checked first");
});
