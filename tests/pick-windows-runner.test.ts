// The Windows runner pick (scripts/ci/pick-windows-runner.ts): our self-hosted Windows x64 runner
// while it has a free slot, windows-latest for the overflow, every job on our runner when the
// check fails; and the workflows' Windows jobs wired to it.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { parse } from "@std/yaml";
import {
  activeJobsOn,
  allocate,
  type ApiJob,
  busyRunnersWith,
  busySlots,
  formatOutputs,
  type GetJson,
  parseRunner,
  pick,
  type PickContext,
  type PickInput,
  readInput,
} from "../scripts/ci/pick-windows-runner.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const OURS = JSON.stringify(["self-hosted", "denext-windows-x64"]);
const HOSTED = JSON.stringify("windows-latest");
const LABEL = "denext-windows-x64";

function input(over: Partial<PickInput> = {}): PickInput {
  return {
    jobs: ["a", "b", "c"],
    follow: new Map(),
    ours: OURS,
    label: LABEL,
    slots: 1,
    forkPr: false,
    ...over,
  };
}

/** A fake GitHub API: `runs[status]` lists run ids, `jobs[id]` their jobs; records every path. */
function fakeApi(
  runs: Record<string, number[]>,
  jobs: Record<number, ApiJob[]>,
  runners?: unknown[],
): { get: GetJson; paths: string[]; tokens: string[] } {
  const paths: string[] = [];
  const tokens: string[] = [];
  const get: GetJson = (path, token) => {
    paths.push(path);
    tokens.push(token);
    const url = new URL(path, "https://api.test");
    const page = Number(url.searchParams.get("page") ?? "1");
    if (page > 1) return Promise.resolve({ workflow_runs: [], jobs: [], runners: [] });
    const m = url.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/);
    if (m) return Promise.resolve({ jobs: jobs[Number(m[1])] ?? [] });
    if (url.pathname.endsWith("/actions/runs")) {
      const ids = runs[url.searchParams.get("status") ?? ""] ?? [];
      return Promise.resolve({ workflow_runs: ids.map((id) => ({ id })) });
    }
    if (url.pathname.endsWith("/actions/runners")) return Promise.resolve({ runners });
    return Promise.reject(new Error(`unexpected ${path}`));
  };
  return { get, paths, tokens };
}

function ctx(get: GetJson, over: Partial<PickContext> = {}): PickContext {
  return { repo: "Brainwires/denext", runId: "100", token: "repo-token", get, ...over };
}

Deno.test("parseRunner: a label, a JSON array, and what it can't use", () => {
  assertEquals(parseRunner("denext-windows-x64"), { ours: JSON.stringify(LABEL), label: LABEL });
  assertEquals(parseRunner(` ${OURS} `), { ours: OURS, label: LABEL });
  assertEquals(parseRunner(""), { ours: null, label: null });
  assertEquals(parseRunner('["self-hosted"]'), { ours: null, label: null });
  assertEquals(parseRunner("[not json"), { ours: null, label: null });
  assertEquals(parseRunner('[1, "x"]'), { ours: null, label: null });
});

Deno.test("readInput: jobs in order, follows, slots, the fork flag", () => {
  const env: Record<string, string> = {
    PICK_JOBS: " windows_tests  windows_resolve ",
    PICK_FOLLOW: "cross_launch=cross_package bad=",
    PICK_RUNNER: OURS,
    PICK_SLOTS: "2",
    PICK_FORK_PR: "false",
  };
  const got = readInput((n) => env[n]);
  assertEquals(got.jobs, ["windows_tests", "windows_resolve"]);
  assertEquals([...got.follow], [["cross_launch", "cross_package"]]);
  assertEquals(got.slots, 2);
  assertEquals(got.forkPr, false);
  assertEquals(got.label, LABEL);
  assertEquals(readInput((n) => ({ PICK_SLOTS: "x", PICK_FORK_PR: "true" })[n]).slots, 1);
  assert(readInput((n) => ({ PICK_FORK_PR: "true" })[n]).forkPr);
});

Deno.test("activeJobsOn / busyRunnersWith count only our label's live work", () => {
  const jobs: ApiJob[] = [
    { status: "queued", labels: ["self-hosted", LABEL] },
    { status: "in_progress", labels: [LABEL] },
    { status: "completed", labels: [LABEL] },
    { status: "queued", labels: ["denext-windows-x64-cli"] },
    { status: "queued", labels: ["windows-latest"] },
    { status: "queued" },
  ];
  assertEquals(activeJobsOn(jobs, LABEL), 2);
  const runner = (busy: boolean, status: string, name: string) => ({
    busy,
    status,
    labels: [{ name: "self-hosted" }, { name }],
  });
  assertEquals(
    busyRunnersWith([
      runner(true, "online", LABEL),
      runner(false, "online", LABEL),
      runner(true, "offline", LABEL),
      runner(true, "online", "denext-macos-x64"),
    ], LABEL),
    1,
  );
});

Deno.test("allocate: the free slots go to the first jobs, the rest overflow; follows copy", () => {
  const follow = new Map([["d", "a"], ["e", "b"]]);
  assertEquals(
    [...allocate(input({ follow }), 1)],
    [["a", OURS], ["b", HOSTED], ["c", HOSTED], ["d", OURS], ["e", HOSTED]],
  );
  assertEquals([...allocate(input(), 0)].map(([, v]) => v), [HOSTED, HOSTED, HOSTED]);
  assertEquals([...allocate(input(), -3)].map(([, v]) => v), [HOSTED, HOSTED, HOSTED]);
  assertEquals([...allocate(input(), 2)].map(([, v]) => v), [OURS, OURS, HOSTED]);
  assertEquals([...allocate(input({ forkPr: true }), 5)].map(([, v]) => v), [
    HOSTED,
    HOSTED,
    HOSTED,
  ]);
  assertEquals([...allocate(input({ ours: null, label: null }), 5)].map(([, v]) => v), [
    HOSTED,
    HOSTED,
    HOSTED,
  ]);
});

Deno.test("formatOutputs: one $GITHUB_OUTPUT line per key", () => {
  assertEquals(
    formatOutputs(new Map([["a", OURS], ["b", HOSTED]])),
    `a=${OURS}\nb="windows-latest"`,
  );
});

Deno.test("pick: an idle runner takes the first job, the rest overflow", async () => {
  const api = fakeApi({ in_progress: [100, 7] }, {
    100: [{ status: "queued", labels: [LABEL] }], // this run's own: never counted
    7: [{ status: "in_progress", labels: ["denext-linux-x64"] }],
  });
  const got = await pick(input(), ctx(api.get));
  assertEquals([...got.values()], [OURS, HOSTED, HOSTED]);
  assert(!api.paths.some((p) => p.includes("/runs/100/jobs")), "this run's jobs are not read");
});

Deno.test("pick: another run's queued or running job on our label holds the slot", async () => {
  for (const status of ["queued", "in_progress"]) {
    const api = fakeApi({ [status]: [8] }, { 8: [{ status, labels: ["self-hosted", LABEL] }] });
    assertEquals([...(await pick(input(), ctx(api.get))).values()], [HOSTED, HOSTED, HOSTED]);
  }
  // two slots, one held: one job of ours
  const api = fakeApi({ in_progress: [8] }, { 8: [{ status: "in_progress", labels: [LABEL] }] });
  assertEquals([...(await pick(input({ slots: 2 }), ctx(api.get))).values()], [
    OURS,
    HOSTED,
    HOSTED,
  ]);
});

Deno.test("pick: with RUNNER_STATUS_TOKEN a busy org runner of ours counts too", async () => {
  const api = fakeApi({}, {}, [{
    status: "online",
    busy: true,
    labels: [{ name: "self-hosted" }, { name: LABEL }],
  }]);
  const got = await pick(input(), ctx(api.get, { runnerToken: "runner-token" }));
  assertEquals([...got.values()], [HOSTED, HOSTED, HOSTED]);
  const i = api.paths.findIndex((p) => p.startsWith("/orgs/Brainwires/actions/runners"));
  assert(i >= 0);
  assertEquals(api.tokens[i], "runner-token");
  assert(api.tokens.filter((_, j) => j !== i).every((t) => t === "repo-token"));
});

Deno.test("pick: a failed check keeps every job on our runner, with a warning", async () => {
  const warnings: string[] = [];
  const get: GetJson = () => Promise.reject(new Error("HTTP 403"));
  const got = await pick(
    input({ follow: new Map([["d", "c"]]) }),
    ctx(get),
    (m) => warnings.push(m),
  );
  assertEquals([...got.values()], [OURS, OURS, OURS, OURS]);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "HTTP 403");
  // a malformed answer is a failure too
  const bad: GetJson = () => Promise.resolve({ message: "nope" });
  assertEquals([...(await pick(input(), ctx(bad))).values()], [OURS, OURS, OURS]);
});

Deno.test("pick: a fork's pull request, or no runner variable, is windows-latest with no API call", async () => {
  const get: GetJson = () => Promise.reject(new Error("must not be called"));
  assertEquals([...(await pick(input({ forkPr: true }), ctx(get))).values()], [
    HOSTED,
    HOSTED,
    HOSTED,
  ]);
  assertEquals(
    [...(await pick(input({ ours: null, label: null }), ctx(get))).values()],
    [HOSTED, HOSTED, HOSTED],
  );
});

Deno.test("busySlots: pages through long lists", async () => {
  const many = Array.from({ length: 100 }, () => ({ status: "completed", labels: [LABEL] }));
  let pages = 0;
  const get: GetJson = (path) => {
    const url = new URL(path, "https://api.test");
    const page = Number(url.searchParams.get("page"));
    if (url.pathname.endsWith("/actions/runs")) {
      return Promise.resolve({
        workflow_runs: url.searchParams.get("status") === "in_progress" ? [{ id: 9 }] : [],
      });
    }
    pages++;
    return Promise.resolve({ jobs: page === 1 ? many : [{ status: "queued", labels: [LABEL] }] });
  };
  assertEquals(await busySlots(ctx(get), LABEL), 1);
  assertEquals(pages, 2);
});

// The workflows: every job that may run on RUNNER_WINDOWS_X64 takes the pick of its workflow's
// windows-runner job (an output it declares), needs that job, and still runs when it failed.

interface Job {
  "runs-on"?: string;
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
  steps?: { id?: string; env?: Record<string, string> }[];
}

/** The keys the workflow's windows-runner job picks (PICK_JOBS, and PICK_FOLLOW's followers). */
function pickedKeys(picker: Job): Set<string> {
  const env = picker.steps?.find((s) => s.id === "pick")?.env ?? {};
  const follow = String(env.PICK_FOLLOW ?? "").split(/\s+/).filter(Boolean);
  return new Set([
    ...String(env.PICK_JOBS ?? "").match(/[a-z0-9_]+/g) ?? [],
    ...follow.map((p) => p.split("=")[0]),
  ]);
}

/** A Windows x64 job reads a declared, picked key, needs the picker and runs if it failed. */
function assertTakesPick(name: string, job: Job, outputs: string[], keys: Set<string>): void {
  const runsOn = String(job["runs-on"]);
  assert(!runsOn.includes("RUNNER_WINDOWS_X64_CLI"), `${name}: the retired CLI runner`);
  const key = runsOn.match(/needs\.windows-runner\.outputs\.([a-z0-9_]+)/)?.[1] ?? "";
  assert(key, `${name}: runs-on reads the pick`);
  assert(outputs.includes(key), `${name}: windows-runner declares ${key}`);
  assert(keys.has(key), `${name}: windows-runner picks ${key}`);
  assert([job.needs ?? []].flat().includes("windows-runner"), `${name}: needs windows-runner`);
  assertStringIncludes(String(job.if ?? ""), "!cancelled()", `${name}: runs when the pick failed`);
}

for (const file of ["ci.yml", "desktop-ci.yml", "desktop-window.yml"]) {
  Deno.test(`${file}: the Windows x64 jobs take the windows-runner pick`, async () => {
    const doc = parse(await Deno.readTextFile(join(ROOT, ".github/workflows", file))) as {
      jobs: Record<string, Job>;
    };
    const picker = doc.jobs["windows-runner"];
    assert(picker, "a windows-runner job");
    const outputs = Object.keys(picker.outputs ?? {});
    const keys = pickedKeys(picker);
    const windowsJobs = Object.entries(doc.jobs).filter(([name, job]) =>
      name !== "windows-runner" && String(job["runs-on"] ?? "").includes("RUNNER_WINDOWS_X64")
    );
    assert(windowsJobs.length > 0);
    for (const [name, job] of windowsJobs) assertTakesPick(name, job, outputs, keys);
  });
}
