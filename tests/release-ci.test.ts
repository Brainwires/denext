// The release's CI gate (scripts/release-ci.ts): a version is tagged only from a commit whose newest
// ci.yml run that ran the heavy jobs is green, with `gh` faked.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CiJob,
  type CiRun,
  DESKTOP_CI_JOBS,
  DESKTOP_WINDOW_JOBS,
  desktopCiVerdict,
  desktopWindowVerdict,
  E2E_JOBS,
  e2eVerdict,
  GATED_WORKFLOWS,
  NATIVE_PLUGINS_JOBS,
  nativePluginsVerdict,
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
  "backend-integration": "skipped",
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
    "backend-integration",
    "ios-export-router",
    "windows-resolve",
    "windows-tests",
    "macos-tests",
    "cargo-audit",
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

/** Every desktop-ci job with `conclusion`, then `over` on top (extra names are added). */
function desktopJobs(conclusion: string, over: Record<string, string> = {}): CiJob[] {
  const names = [...new Set([...DESKTOP_CI_JOBS, ...Object.keys(over)])];
  return names.map((name) => ({ name, status: "completed", conclusion: over[name] ?? conclusion }));
}

Deno.test("desktop CI gate: the newest desktop-ci run on HEAD, push or dispatch, decides", async () => {
  const green = fakeGh([run(1, "push", "2026-10-06T10:00:00Z")], { 1: desktopJobs("success") });
  const ok = await desktopCiVerdict(SHA, green.gh);
  assert(ok.ok, ok.reason);
  assertEquals(green.calls[0].slice(0, 6), [
    "run",
    "list",
    "--workflow",
    "desktop-ci.yml",
    "--commit",
    SHA,
  ]);
  // A newer red dispatch outranks an older green push.
  const red = fakeGh(
    [run(1, "push", "2026-10-06T10:00:00Z"), run(2, "workflow_dispatch", "2026-10-06T11:00:00Z")],
    {
      1: desktopJobs("success"),
      2: desktopJobs("success", { "desktop tests (windows-latest)": "failure" }),
    },
  );
  const failed = await desktopCiVerdict(SHA, red.gh);
  assert(!failed.ok);
  assertStringIncludes(failed.reason, "desktop tests (windows-latest): failure");
  // A job outside the list still may not fail; a listed one that is missing refuses.
  const extra = await desktopCiVerdict(
    SHA,
    fakeGh([run(3, "push", "2026-10-06T10:00:00Z")], {
      3: desktopJobs("success", { "cross-launch (linux-to-windows)": "failure" }),
    }).gh,
  );
  assertStringIncludes(extra.reason, "cross-launch (linux-to-windows): failure");
  // Windows on Arm is required like every other job: its failure refuses the release.
  const arm = "windows on arm (windows-11-arm — desktop tests, install.ps1, Arm64 .msi)";
  assert(DESKTOP_CI_JOBS.includes(arm), "Windows on Arm is a required job");
  const armRed = await desktopCiVerdict(
    SHA,
    fakeGh([run(6, "push", "2026-10-06T10:00:00Z")], {
      6: desktopJobs("success", { [arm]: "failure" }),
    }).gh,
  );
  assert(!armRed.ok);
  assertStringIncludes(armRed.reason, `${arm}: failure`);
  const missing = await desktopCiVerdict(
    SHA,
    fakeGh([run(4, "push", "2026-10-06T10:00:00Z")], {
      4: desktopJobs("success").filter((j) => j.name !== "scaffold + package-script drift"),
    }).gh,
  );
  assertStringIncludes(missing.reason, "scaffold + package-script drift: missing");
  // Still running, or no run at all: refused, with the dispatch in the hint.
  const queued = fakeGh([run(5, "workflow_dispatch", "2026-10-06T10:00:00Z", "queued")], {});
  assertStringIncludes((await desktopCiVerdict(SHA, queued.gh)).reason, "queued");
  const none = await desktopCiVerdict(SHA, fakeGh([], {}).gh);
  assert(!none.ok);
  assertStringIncludes(none.reason, "no desktop-ci.yml run");
  assertStringIncludes(
    releaseCiHint("development"),
    "gh workflow run desktop-ci.yml --ref development",
  );
});

Deno.test("desktop CI gate: every required job is named in desktop-ci.yml", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/desktop-ci.yml", import.meta.url),
  );
  // No job may fail without failing the run: a release needs every one of them green.
  assert(!/^\s*continue-on-error:/m.test(workflow), "a desktop-ci.yml job has continue-on-error");
  for (const job of DESKTOP_CI_JOBS) {
    // A matrix leg `<name> (<os>[ — <note>])` comes from `name: <name> (${{ matrix.os }}[ — <note>])`
    // and that os.
    const leg = /^(.*) \(((?:windows|macos|ubuntu)-latest)( — [^)]*)?\)$/.exec(job);
    if (leg && !workflow.includes(`name: ${job}\n`)) {
      assertStringIncludes(workflow, `name: ${leg[1]} (\${{ matrix.os }}${leg[3] ?? ""})`, job);
      assertStringIncludes(workflow, leg[2], job);
    } else {
      assertStringIncludes(workflow, `name: ${job}\n`, job);
    }
  }
});

Deno.test("release CI gate: the release script runs it before changing anything", async () => {
  const src = await Deno.readTextFile(new URL("../scripts/release.ts", import.meta.url));
  const main = src.slice(src.indexOf("async function main()"));
  assert(main.indexOf("checkCi(") < main.indexOf("prepareRelease("), "CI is checked first");
});

/** `names` with `conclusion`, then `over` on top (extra names are added). */
function namedJobs(
  names: readonly string[],
  conclusion: string,
  over: Record<string, string> = {},
) {
  return [...new Set([...names, ...Object.keys(over)])].map((name) => ({
    name,
    status: "completed",
    conclusion: over[name] ?? conclusion,
  }));
}

Deno.test("e2e gate: e2e.yml's newest run on HEAD must have run every job, green", async () => {
  assertEquals(E2E_JOBS, ["e2e", "migration-beds", "timer-stress", "no-deno"]);
  const green = fakeGh([run(1, "workflow_dispatch", "2026-10-06T10:00:00Z")], {
    1: namedJobs(E2E_JOBS, "success"),
  });
  const ok = await e2eVerdict(SHA, green.gh);
  assert(ok.ok, ok.reason);
  assertEquals(green.calls[0].slice(0, 6), [
    "run",
    "list",
    "--workflow",
    "e2e.yml",
    "--commit",
    SHA,
  ]);
  // A one-job dispatch (`-f job=e2e`) skips the rest: it can't vouch for a release.
  const one = await e2eVerdict(
    SHA,
    fakeGh([run(2, "workflow_dispatch", "2026-10-06T10:00:00Z")], {
      2: namedJobs(E2E_JOBS, "skipped", { e2e: "success" }),
    }).gh,
  );
  assert(!one.ok);
  assertStringIncludes(one.reason, "no-deno: skipped");
  const red = await e2eVerdict(
    SHA,
    fakeGh([run(3, "workflow_dispatch", "2026-10-06T10:00:00Z")], {
      3: namedJobs(E2E_JOBS, "success", { e2e: "failure" }),
    }).gh,
  );
  assertStringIncludes(red.reason, "e2e: failure");
  const none = await e2eVerdict(SHA, fakeGh([], {}).gh);
  assert(!none.ok);
  assertStringIncludes(none.reason, "no e2e.yml run");
});

Deno.test("desktop window gate: desktop-window.yml's newest run on HEAD, every OS green", async () => {
  assertEquals(DESKTOP_WINDOW_JOBS, [
    "window test (linux-x64)",
    "window test (macos-arm64)",
    "window test (macos-x64)",
    "window test (windows-x64)",
    "results by OS",
  ]);
  const ok = await desktopWindowVerdict(
    SHA,
    fakeGh([run(1, "push", "2026-10-06T10:00:00Z")], {
      1: namedJobs(DESKTOP_WINDOW_JOBS, "success"),
    }).gh,
  );
  assert(ok.ok, ok.reason);
  const red = await desktopWindowVerdict(
    SHA,
    fakeGh([run(1, "push", "2026-10-06T10:00:00Z")], {
      1: namedJobs(DESKTOP_WINDOW_JOBS, "success", { "window test (windows-x64)": "failure" }),
    }).gh,
  );
  assert(!red.ok);
  assertStringIncludes(red.reason, "desktop-window.yml push run on");
  assertStringIncludes(red.reason, "window test (windows-x64): failure");
  const running = await desktopWindowVerdict(
    SHA,
    fakeGh([run(2, "workflow_dispatch", "2026-10-06T10:00:00Z", "in_progress")], {}).gh,
  );
  assertStringIncludes(running.reason, "in_progress");
});

Deno.test("release CI gate: the hint dispatches every gated workflow, e2e with every job", () => {
  assertEquals(GATED_WORKFLOWS, [
    "ci.yml",
    "desktop-ci.yml",
    "e2e.yml",
    "desktop-window.yml",
    "native-plugins.yml",
  ]);
  const hint = releaseCiHint("development");
  for (const w of GATED_WORKFLOWS) {
    assertStringIncludes(hint, `gh workflow run ${w} --ref development`);
  }
  assertStringIncludes(hint, "wait for all 5");
  assert(!hint.includes("-f job="), "e2e.yml runs every job (job=all, the default)");
  assert(!hint.includes("-f ios="), "native-plugins.yml builds iOS too (ios=true, the default)");
});

Deno.test("native plugins gate: native-plugins.yml's newest run on HEAD, both apps green", async () => {
  assertEquals(NATIVE_PLUGINS_JOBS, ["android", "ios"]);
  const green = fakeGh([run(1, "push", "2026-10-06T10:00:00Z")], {
    1: namedJobs(NATIVE_PLUGINS_JOBS, "success"),
  });
  const ok = await nativePluginsVerdict(SHA, green.gh);
  assert(ok.ok, ok.reason);
  assertEquals(green.calls[0].slice(0, 6), [
    "run",
    "list",
    "--workflow",
    "native-plugins.yml",
    "--commit",
    SHA,
  ]);
  // A dispatch with `-f ios=false` skips the iOS build: it can't vouch for a release.
  const noIos = await nativePluginsVerdict(
    SHA,
    fakeGh([run(2, "workflow_dispatch", "2026-10-06T10:00:00Z")], {
      2: namedJobs(NATIVE_PLUGINS_JOBS, "success", { ios: "skipped" }),
    }).gh,
  );
  assert(!noIos.ok);
  assertStringIncludes(noIos.reason, "ios: skipped");
  // A newer red run outranks an older green one; none at all refuses.
  const red = await nativePluginsVerdict(
    SHA,
    fakeGh(
      [run(3, "push", "2026-10-06T10:00:00Z"), run(4, "workflow_dispatch", "2026-10-06T11:00:00Z")],
      {
        3: namedJobs(NATIVE_PLUGINS_JOBS, "success"),
        4: namedJobs(NATIVE_PLUGINS_JOBS, "success", { android: "failure" }),
      },
    ).gh,
  );
  assertStringIncludes(red.reason, "android: failure");
  const none = await nativePluginsVerdict(SHA, fakeGh([], {}).gh);
  assert(!none.ok);
  assertStringIncludes(none.reason, "no native-plugins.yml run");
  // Both jobs exist in the workflow under those ids, and the dispatch builds iOS by default.
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/native-plugins.yml", import.meta.url),
  );
  for (const job of NATIVE_PLUGINS_JOBS) assertStringIncludes(workflow, `\n  ${job}:\n`, job);
  assertStringIncludes(workflow, "default: true");
});

Deno.test("release CI gate: every required job is a job of ci.yml", async () => {
  const ci = await Deno.readTextFile(new URL("../.github/workflows/ci.yml", import.meta.url));
  for (const job of RELEASE_CI_JOBS) assertStringIncludes(ci, `\n  ${job}:\n`, job);
});

Deno.test("e2e + desktop window gates: every required job is named in its workflow", async () => {
  const e2e = await Deno.readTextFile(new URL("../.github/workflows/e2e.yml", import.meta.url));
  for (const job of E2E_JOBS) assertStringIncludes(e2e, `\n  ${job}:\n`, job);
  const win = await Deno.readTextFile(
    new URL("../.github/workflows/desktop-window.yml", import.meta.url),
  );
  assertStringIncludes(win, "name: window test (${{ matrix.label }})");
  assertStringIncludes(win, "name: results by OS");
  for (const job of DESKTOP_WINDOW_JOBS.filter((j) => j.startsWith("window test"))) {
    assertStringIncludes(win, `label: ${/\((.*)\)/.exec(job)![1]} }`, job);
  }
});

Deno.test("release CI gate: the release script checks all five workflows", async () => {
  const src = await Deno.readTextFile(new URL("../scripts/release.ts", import.meta.url));
  const check = src.slice(src.indexOf("async function checkCi("));
  for (
    const v of [
      "releaseCiVerdict",
      "desktopCiVerdict",
      "e2eVerdict",
      "desktopWindowVerdict",
      "nativePluginsVerdict",
    ]
  ) {
    assertStringIncludes(check.slice(0, check.indexOf("\n}\n")), v);
  }
});
