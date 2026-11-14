// The Linux runner pick (scripts/ci/pick-linux-runners.ts): biscuits' Linux pools share one set of
// job containers, so the jobs first in priority order take that shared capacity's free slots and
// the rest run on GitHub's image; stale or unhealthy health, a stuck previous attempt and a fork's
// pull request send every job to the image. And the gate workflows' Linux jobs wired to it.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { parse } from "@std/yaml";
import {
  allocate,
  busyCount,
  capacity,
  DEFAULT_SHARED_LABELS,
  describe,
  formatOutputs,
  freshPools,
  HEALTH_MAX_AGE,
  parseJob,
  pick,
  type PickContext,
  type PickInput,
  poolCap,
  type PoolHealth,
  previousAttemptStalled,
  readInput,
} from "../scripts/ci/pick-linux-runners.ts";
import type { GetJson } from "../scripts/ci/pick-windows-runner.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const X64 = "denext-linux-x64";
const DOCKER = "denext-linux-x64-docker";
const X2204 = "denext-linux-x64-2204";
const OURS = JSON.stringify(["self-hosted", X64]);
const OURS_DOCKER = JSON.stringify(["self-hosted", DOCKER]);
const HOSTED = JSON.stringify("ubuntu-latest");
const NOW = 1_800_000_000;

/** ci.yml's shape: coverage on the docker pool, three jobs on x64, a fresh idle health value. */
function input(over: Partial<PickInput> = {}): PickInput {
  const env: Record<string, string> = {
    PICK_JOBS: "coverage:docker backend check integration",
    PICK_RUNNER_X64: OURS,
    PICK_RUNNER_DOCKER: OURS_DOCKER,
    PICK_HEALTH: health(),
  };
  return { ...readInput((name) => env[name]), ...over };
}

/** A DENEXT_POOL_HEALTH value: biscuits' three pools (3 / 3 / 1 slots), with `busy` per label. */
function health(
  busy: Record<string, number> = {},
  over: Record<string, Partial<PoolHealth>> = {},
  at = NOW - 60,
): string {
  const pool = (label: string, slots: number): PoolHealth => ({
    ok: true,
    paused: false,
    slots,
    healthy_slots: slots,
    busy: busy[label] ?? 0,
    ...over[label],
  });
  return JSON.stringify({
    v: 1,
    checked_at: at,
    pools: { [X64]: pool(X64, 3), [X2204]: pool(X2204, 3), [DOCKER]: pool(DOCKER, 1) },
  });
}

/** A fake GitHub API: `runs[status]` lists run ids, `jobs[id]` their jobs; records every path. */
function fakeApi(
  runs: Record<string, number[]>,
  jobs: Record<string | number, unknown[]>,
  runners?: unknown[],
): { get: GetJson; paths: string[] } {
  const paths: string[] = [];
  const answer = (url: URL): unknown => {
    if (url.pathname.endsWith("/actions/runs")) {
      const ids = runs[url.searchParams.get("status") ?? ""] ?? [];
      return { workflow_runs: ids.map((id) => ({ id })) };
    }
    if (url.pathname.endsWith("/actions/runners")) return { runners };
    const attempt = /\/attempts\/(\d+)\/jobs$/.exec(url.pathname);
    const key = attempt ? `attempt-${attempt[1]}` : url.pathname.split("/").at(-2)!;
    return { jobs: jobs[key] ?? [] };
  };
  const get: GetJson = (path) => {
    paths.push(path);
    const url = new URL(path, "https://api.test");
    const last = Number(url.searchParams.get("page") ?? 1) > 1;
    return Promise.resolve(last ? { workflow_runs: [], jobs: [], runners: [] } : answer(url));
  };
  return { get, paths };
}

function ctx(get: GetJson, runnerToken?: string): PickContext {
  return { repo: "o/r", runId: "1", token: "t", runnerToken, get };
}

const picked = (m: Map<string, string>) => Object.fromEntries(m);

Deno.test("parseJob / readInput: keys in order, pools, images, the fork flag, the fallbacks", () => {
  assertEquals(parseJob("check", "ubuntu-latest"), {
    key: "check",
    pool: "x64",
    image: "ubuntu-latest",
  });
  assertEquals(parseJob("laufey:2204@ubuntu-22.04", "ubuntu-latest"), {
    key: "laufey",
    pool: "2204",
    image: "ubuntu-22.04",
  });
  assertEquals(parseJob("bad:gpu", "ubuntu-latest"), null);
  const i = readInput((name) =>
    ({
      PICK_JOBS: " a:docker  b bad:gpu c@ubuntu-24.04 ",
      PICK_RUNNER_X64: OURS,
      PICK_FORK_PR: "true",
      GITHUB_RUN_ATTEMPT: "2",
      PICK_SHARED_SLOTS: "2",
      PICK_DELAY: "45",
    })[name]
  );
  assertEquals(i.jobs.map((j) => `${j.key}:${j.pool}@${j.image}`), [
    "a:docker@ubuntu-latest",
    "b:x64@ubuntu-latest",
    "c:x64@ubuntu-24.04",
  ]);
  // An unset docker pool falls back to x64 (as the workflows did); an unset 2204 pool stays unset.
  assertEquals(i.pools.docker, { ours: OURS, label: X64 });
  assertEquals(i.pools["2204"], { ours: null, label: null });
  assertEquals(i.sharedLabels, DEFAULT_SHARED_LABELS);
  assertEquals([i.forkPr, i.attempt, i.sharedSlots, i.delaySeconds], [true, 2, 2, 45]);
  const d = readInput(() => undefined);
  assertEquals([d.forkPr, d.attempt, d.sharedSlots, d.delaySeconds, d.jobs], [
    false,
    1,
    null,
    0,
    [],
  ]);
});

Deno.test("freshPools: fresh only; missing, unparsable, stale or future values are null", () => {
  assert(freshPools(health(), NOW));
  assertEquals(freshPools("", NOW), null);
  assertEquals(freshPools("{nope", NOW), null);
  assertEquals(freshPools(JSON.stringify({ pools: {} }), NOW), null);
  assertEquals(freshPools(health({}, {}, NOW - HEALTH_MAX_AGE - 1), NOW), null);
  assertEquals(freshPools(health({}, {}, NOW + 600), NOW), null);
});

Deno.test("poolCap: healthy_slots, else slots; none for a pool unlisted, not ok or paused", () => {
  const pools = freshPools(
    health({}, { [X64]: { healthy_slots: 2 }, [X2204]: { ok: false }, [DOCKER]: { paused: true } }),
    NOW,
  )!;
  assertEquals(poolCap(pools, X64), 2);
  assertEquals(poolCap(pools, X2204), null);
  assertEquals(poolCap(pools, DOCKER), null);
  assertEquals(poolCap(pools, "denext-linux-x64-gpu"), null);
  assertEquals(poolCap({ [X64]: { ok: true, slots: 3 } }, X64), 3);
});

Deno.test("capacity: the shared cap minus EVERY shared pool's busy, never each pool's own slots", () => {
  const i = input();
  // linux-x64 reports 3 slots and 1 busy, but the docker pool's 2 busy jobs take the same
  // containers: 3 - (1 + 2) = 0 shared slots left.
  const full = capacity(i, freshPools(health({ [X64]: 1, [DOCKER]: 2 }), NOW)!, null);
  assertEquals(full.shared, 0);
  assertEquals(full.free.get(X64), 2); // its own cap would allow it; the shared cap does not
  assertEquals(picked(allocate(i, full)), {
    coverage: HOSTED,
    backend: HOSTED,
    check: HOSTED,
    integration: HOSTED,
  });
  // The 2204 pool's busy jobs count too, though no job here asks for it.
  const c = capacity(i, freshPools(health({ [X2204]: 2 }), NOW)!, null);
  assertEquals([c.shared, c.free.get(X64), c.free.get(DOCKER)], [1, 3, 1]);
});

Deno.test("capacity: the API's queued jobs add to the busy count; running is the larger count", () => {
  const i = input();
  const pools = freshPools(health({ [X64]: 1 }), NOW)!;
  const api = {
    running: new Map([[X64, 1]]),
    queued: new Map([[X64, 1]]),
  };
  // running max(1, 1) = 1, plus 1 queued: 1 free of 3.
  assertEquals(capacity(i, pools, api).shared, 1);
  // The API sees more running than the (older) health value: the larger count wins.
  const more = { running: new Map([[X64, 2]]), queued: new Map<string, number>() };
  assertEquals(capacity(i, pools, more).shared, 1);
  // PICK_SHARED_SLOTS overrides the cap the health value implies.
  assertEquals(capacity({ ...i, sharedSlots: 2 }, pools, null).shared, 1);
});

Deno.test("allocate: priority order; the docker pool's own cap; the shared cap across pools", () => {
  const i = input();
  const picks = allocate(i, capacity(i, freshPools(health(), NOW)!, null));
  // 3 shared slots: coverage on the docker pool (its 1 slot), backend and check on x64, the rest
  // overflow.
  assertEquals(picked(picks), {
    coverage: OURS_DOCKER,
    backend: OURS,
    check: OURS,
    integration: HOSTED,
  });
  // The docker pool busy: coverage overflows to the image (whose Docker runs its Docker tests),
  // and its slot is not taken from the x64 jobs.
  const busyDocker = allocate(i, capacity(i, freshPools(health({ [DOCKER]: 1 }), NOW)!, null));
  assertEquals(picked(busyDocker), {
    coverage: HOSTED,
    backend: OURS,
    check: OURS,
    integration: HOSTED,
  });
  // A job's own image is its overflow; an unset pool sends the job there.
  const j = { ...i, jobs: [{ key: "laufey", pool: "2204" as const, image: "ubuntu-22.04" }] };
  assertEquals(picked(allocate(j, capacity(j, freshPools(health(), NOW)!, null))), {
    laufey: JSON.stringify("ubuntu-22.04"),
  });
  assertEquals(picked(allocate(i, null)), {
    coverage: HOSTED,
    backend: HOSTED,
    check: HOSTED,
    integration: HOSTED,
  });
});

Deno.test("formatOutputs / describe: one line per key, then the hosted keys; a table", () => {
  const i = input();
  const picks = new Map([["coverage", OURS_DOCKER], ["backend", OURS], ["check", HOSTED], [
    "integration",
    HOSTED,
  ]]);
  assertEquals(
    formatOutputs(i, picks),
    `coverage=${OURS_DOCKER}\nbackend=${OURS}\ncheck=${HOSTED}\nintegration=${HOSTED}\nhosted=["check","integration"]`,
  );
  assertStringIncludes(describe(i, picks), `| coverage | docker | ${OURS_DOCKER} |`);
});

Deno.test("pick: an idle shared capacity takes the first jobs, the rest overflow", async () => {
  const { get, paths } = fakeApi({}, {});
  const picks = await pick(input(), ctx(get), () => {}, NOW);
  assertEquals(picked(picks), {
    coverage: OURS_DOCKER,
    backend: OURS,
    check: OURS,
    integration: HOSTED,
  });
  assert(paths.some((p) => p.startsWith("/repos/o/r/actions/runs?status=queued")));
});

Deno.test("pick: other runs' queued and running jobs on any shared label hold slots; this run's don't", async () => {
  const { get } = fakeApi({ queued: [7], in_progress: [8, 1] }, {
    7: [{ status: "queued", labels: ["self-hosted", X2204] }],
    8: [
      { status: "in_progress", labels: ["self-hosted", X64] },
      { status: "completed", labels: ["self-hosted", X64] },
      { status: "queued", labels: ["ubuntu-latest"] },
    ],
    1: [{ status: "queued", labels: ["self-hosted", X64] }], // this run: waits on the pick
  });
  const picks = await pick(input(), ctx(get), () => {}, NOW);
  // 3 - (1 running + 1 queued) = 1 shared slot: coverage takes it.
  assertEquals(picked(picks), {
    coverage: OURS_DOCKER,
    backend: HOSTED,
    check: HOSTED,
    integration: HOSTED,
  });
});

Deno.test("pick: with RUNNER_STATUS_TOKEN a busy org runner of ours counts too", async () => {
  const runner = (label: string, busy: boolean) => ({
    status: "online",
    busy,
    labels: [{ name: "self-hosted" }, { name: label }],
  });
  const { get } = fakeApi({}, {}, [runner(X64, true), runner(X64, true), runner(DOCKER, false)]);
  const picks = await pick(input(), ctx(get, "rt"), () => {}, NOW);
  assertEquals(picked(picks), {
    coverage: OURS_DOCKER,
    backend: HOSTED,
    check: HOSTED,
    integration: HOSTED,
  });
});

Deno.test("pick: a stale, missing, unhealthy or paused health value overflows to GitHub", async () => {
  const warned: string[] = [];
  const { get, paths } = fakeApi({}, {});
  const all = { coverage: HOSTED, backend: HOSTED, check: HOSTED, integration: HOSTED };
  for (const value of ["", health({}, {}, NOW - HEALTH_MAX_AGE - 60)]) {
    const picks = await pick(input({ health: value }), ctx(get), (m) => warned.push(m), NOW);
    assertEquals(picked(picks), all);
  }
  assertEquals(paths, [], "no API call without a fresh health value");
  assertEquals(warned.length, 2);
  const down = health({}, { [X64]: { ok: false }, [DOCKER]: { paused: true } });
  assertEquals(picked(await pick(input({ health: down }), ctx(get), () => {}, NOW)), all);
});

Deno.test("pick: a failed API count falls back to the health value's busy slots", async () => {
  const warned: string[] = [];
  const get: GetJson = () => Promise.reject(new Error("HTTP 502"));
  const picks = await pick(
    input({ health: health({ [X64]: 2 }) }),
    ctx(get),
    (m) => warned.push(m),
    NOW,
  );
  assertEquals(picked(picks), {
    coverage: OURS_DOCKER,
    backend: HOSTED,
    check: HOSTED,
    integration: HOSTED,
  });
  assert(warned.some((m) => m.includes("HTTP 502") && m.includes("DENEXT_POOL_HEALTH")));
});

Deno.test("pick: a fork's pull request, or no pool variable, is GitHub's image with no API call", async () => {
  const { get, paths } = fakeApi({}, {});
  const all = { coverage: HOSTED, backend: HOSTED, check: HOSTED, integration: HOSTED };
  assertEquals(picked(await pick(input({ forkPr: true }), ctx(get), () => {}, NOW)), all);
  const none = { ours: null, label: null };
  const unset = input({ pools: { x64: none, docker: none, "2204": none } });
  assertEquals(picked(await pick(unset, ctx(get), () => {}, NOW)), all);
  assertEquals(paths, []);
});

Deno.test("previousAttemptStalled / pick: a re-run after a stuck pool overflows everything", async () => {
  const { get } = fakeApi({}, {
    "attempt-1": [
      { status: "completed", conclusion: "cancelled", runner_name: null, labels: [X64] },
    ],
  });
  assertEquals(await previousAttemptStalled(ctx(get), 1, [X64]), false);
  assertEquals(await previousAttemptStalled(ctx(get), 2, [X64]), true);
  assertEquals(await previousAttemptStalled(ctx(get), 2, [DOCKER]), false);
  const picks = await pick(input({ attempt: 2 }), ctx(get), () => {}, NOW);
  assertEquals([...picks.values()].every((v) => v === HOSTED), true);
});

Deno.test("busyCount: pages through long lists and counts each label", async () => {
  let pages = 0;
  const many = Array.from({ length: 100 }, () => ({ status: "completed", labels: [X64] }));
  const get: GetJson = (path) => {
    const url = new URL(path, "https://api.test");
    if (url.pathname.endsWith("/actions/runs")) {
      return Promise.resolve({
        workflow_runs: url.searchParams.get("status") === "in_progress" ? [{ id: 9 }] : [],
      });
    }
    pages++;
    const page = Number(url.searchParams.get("page"));
    return Promise.resolve({
      jobs: page === 1 ? many : [{ status: "queued", labels: ["self-hosted", DOCKER] }],
    });
  };
  const count = await busyCount(ctx(get), DEFAULT_SHARED_LABELS);
  assertEquals(count.queued.get(DOCKER), 1);
  assertEquals(count.running.size, 0);
  assertEquals(pages, 2);
});

// The workflows: every job that may run on RUNNER_LINUX_X64 (or its docker pool) takes the pick of
// its workflow's linux-runner job (an output it declares), needs that job, and still runs when it
// failed; the pick itself, and windows-runner, run on GitHub's image.

interface Job {
  "runs-on"?: string;
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
  services?: Record<string, { image?: string }>;
  steps?: { id?: string; if?: string; run?: string; env?: Record<string, string> }[];
}

function pickedKeys(picker: Job): Set<string> {
  const env = picker.steps?.find((s) => s.id === "pick")?.env ?? {};
  return new Set(String(env.PICK_JOBS ?? "").match(/\b[a-z0-9_]+(?=[:@ ']|$)/g) ?? []);
}

/** A Linux job reads a declared, picked key behind the fork guard, needs the picker, runs if it
 * failed, and starts its `services:` / job services where it really runs. */
function assertTakesPick(name: string, job: Job, outputs: string[], keys: Set<string>): void {
  const runsOn = String(job["runs-on"]);
  const read = [...runsOn.matchAll(/needs\.linux-runner\.outputs\.([a-z0-9_]+)/g)].map((m) => m[1]);
  assert(read.length > 0, `${name}: runs-on reads the pick`);
  for (const key of read) {
    assert(outputs.includes(key), `${name}: linux-runner declares ${key}`);
    assert(keys.has(key), `${name}: linux-runner picks ${key}`);
  }
  // The fork guard comes before the pick: a fork's pull request never reads it.
  assert(runsOn.indexOf("pull_request") < runsOn.indexOf("needs.linux-runner"), name);
  assert([job.needs ?? []].flat().includes("linux-runner"), `${name}: needs linux-runner`);
  assert(/!cancelled\(\)|always\(\)/.test(String(job.if)), `${name}: runs when the pick failed`);
  // A job with `services:` starts them on GitHub's image only, by the pick's hosted list.
  for (const [svc, def] of Object.entries(job.services ?? {})) {
    assertStringIncludes(String(def.image), "needs.linux-runner.outputs.hosted", `${name}.${svc}`);
  }
  const services = (job.steps ?? []).filter((s) => s.run?.includes("job-services-env.sh"));
  for (const step of services) {
    assertEquals(step.if, "runner.environment == 'self-hosted'", `${name}: job services`);
  }
}

for (const file of ["ci.yml", "desktop-ci.yml", "desktop-window.yml", "e2e.yml"]) {
  Deno.test(`${file}: the Linux jobs take the linux-runner pick`, async () => {
    const doc = parse(await Deno.readTextFile(join(ROOT, ".github/workflows", file))) as {
      jobs: Record<string, Job>;
    };
    const picker = doc.jobs["linux-runner"];
    assert(picker, "a linux-runner job");
    assertEquals(picker["runs-on"], "ubuntu-latest", "the pick never waits in the pools' queue");
    if (doc.jobs["windows-runner"]) {
      assertEquals(doc.jobs["windows-runner"]["runs-on"], "ubuntu-latest");
    }
    const outputs = Object.keys(picker.outputs ?? {});
    assert(outputs.includes("hosted"));
    const keys = pickedKeys(picker);
    const linuxJobs = Object.entries(doc.jobs).filter(([, job]) =>
      String(job["runs-on"] ?? "").includes("RUNNER_LINUX_X64")
    );
    assert(linuxJobs.length > 0);
    for (const [name, job] of linuxJobs) assertTakesPick(name, job, outputs, keys);
  });
}
