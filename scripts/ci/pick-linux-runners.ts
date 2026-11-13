// Pick each Linux job's runner for one workflow run: our self-hosted Linux pools while the shared
// Linux capacity has a free slot, GitHub's image for the overflow. A workflow's `linux-runner` job
// runs this first; every Linux job reads its choice from `needs.linux-runner.outputs.<key>` and
// falls back to its repository variable (the routing before this script) when that output is
// empty.
//
//   deno run --allow-net=api.github.com --allow-env scripts/ci/pick-linux-runners.ts >> "$GITHUB_OUTPUT"
//
// Why: biscuits' Linux pools (linux-x64, linux-x64-2204 and linux-x64-docker) are labels over ONE
// set of job containers on one 8-core host. A release gate queued 6-9 Linux jobs on them for 40+
// minutes, and the contention pushed `coverage` past its limit. The repository is public, so
// GitHub's Linux images cost nothing: the jobs that most need our pools take the free slots, the
// rest run on GitHub's image at once. (The same idea as Brainwires/deno's
// .github/denext-runtime/pick_runner.py and plan_matrix.py.)
//
// Prints one `<key>=<runs-on JSON>` line per job key, then `hosted=<JSON array>`: the keys on
// GitHub's image (a job whose `services:` run only there reads it). Environment:
//
// - `PICK_JOBS`: the job keys in priority order (space separated): the first ones take the free
//   slots. Only the jobs that run this time. Each is `key[:pool][@image]`: `pool` is `x64` (the
//   default), `docker` or `2204`; `image` the GitHub image of its overflow (default
//   `PICK_IMAGE`).
// - `PICK_RUNNER_X64`, `PICK_RUNNER_DOCKER`, `PICK_RUNNER_2204`: the pools' repository variables
//   (RUNNER_LINUX_X64, RUNNER_LINUX_X64_DOCKER, RUNNER_LINUX_X64_2204): a label, or a JSON array of
//   labels. An empty docker pool falls back to x64 (as the workflows did); an empty pool otherwise
//   sends its jobs to their image.
// - `PICK_IMAGE`: GitHub's image for the overflow (default `ubuntu-latest`, what each job already
//   ran on for a fork's pull request).
// - `PICK_SHARED_LABELS`: the labels that share one capacity (default biscuits' three pools).
// - `PICK_SHARED_SLOTS` (optional): that capacity. Default: the largest `healthy_slots` (else
//   `slots`) DENEXT_POOL_HEALTH lists for those labels.
// - `PICK_HEALTH`: the organization variable DENEXT_POOL_HEALTH (the runner fleet's watchdog keeps
//   it: `{ v: 1, checked_at, pools: { <label>: { ok, slots, busy, healthy_slots, paused } } }`). A
//   missing, unparsable or stale value (over 30 minutes old), or a pool it does not list, marks not
//   ok or paused, sends the pool's jobs to their image: without it the free capacity is unknown.
// - `PICK_FORK_PR`: `true` for a fork's pull request: every job takes its image (a self-hosted
//   runner never takes a fork's code), with no API call.
// - `PICK_DELAY` (optional): seconds to wait before counting (a release gate dispatches several
//   workflows at once: a later one then sees the jobs an earlier one queued on the pools).
// - `GITHUB_TOKEN` (`actions: read`), `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`,
//   `GITHUB_API_URL`.
// - `RUNNER_STATUS_TOKEN` (optional): may list the organization's self-hosted runners; a busy one
//   counts whatever repository its job came from.
//
// The free capacity is counted across the shared labels, never per pool: the shared capacity
// minus every shared pool's busy slots, and each pool's own cap minus its own busy slots (the
// docker pool takes one job). A pool's busy slots are its running jobs (the larger of the health
// value's `busy` and the running jobs of this repository's other runs that name its label) plus
// the queued jobs of those runs that name it (the scheduler mints a runner per queued job). If the
// API fails, the health value's `busy` alone counts. A re-run whose previous attempt had a job on
// these pools cancelled before any runner took it sends every job to its image (the pool was
// stuck; the fleet's watchdog re-routes a stuck run that way).

import {
  type ApiJob,
  type ApiRunner,
  contextFromEnv,
  listAll,
  parseRunner,
  type PickContext,
} from "./pick-windows-runner.ts";

/** A pool kind a job may ask for. */
export type PoolKind = "x64" | "docker" | "2204";

/** One job of the run that may take a Linux pool. */
export interface LinuxJob {
  readonly key: string;
  readonly pool: PoolKind;
  /** GitHub's image of its overflow. */
  readonly image: string;
}

/** A pool's `runs-on` JSON and the label that identifies it, or `null`s when unset. */
export interface Pool {
  readonly ours: string | null;
  readonly label: string | null;
}

/** What the pick needs to know, read from the environment. */
export interface PickInput {
  readonly jobs: readonly LinuxJob[];
  readonly pools: Readonly<Record<PoolKind, Pool>>;
  readonly sharedLabels: readonly string[];
  readonly sharedSlots: number | null;
  readonly health: string;
  readonly forkPr: boolean;
  readonly attempt: number;
  readonly delaySeconds: number;
}

/** One pool as DENEXT_POOL_HEALTH lists it. */
export interface PoolHealth {
  readonly ok?: boolean;
  readonly paused?: boolean;
  readonly slots?: number;
  readonly busy?: number;
  readonly healthy_slots?: number;
}

/** Each label's running and queued jobs, counted from the API. */
export interface BusyCount {
  readonly running: ReadonlyMap<string, number>;
  readonly queued: ReadonlyMap<string, number>;
}

/** biscuits' Linux pools: one set of job containers behind three labels. */
export const DEFAULT_SHARED_LABELS = [
  "denext-linux-x64",
  "denext-linux-x64-2204",
  "denext-linux-x64-docker",
];

/** An older DENEXT_POOL_HEALTH is ignored (seconds). */
export const HEALTH_MAX_AGE = 30 * 60;

const KINDS: readonly PoolKind[] = ["x64", "docker", "2204"];

/** A job's states that hold (or will hold) a slot of the pool its labels name. */
const ACTIVE = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

const words = (s: string | undefined) => (s ?? "").split(/\s+/).filter(Boolean);

/** One `PICK_JOBS` entry (`key[:pool][@image]`), or `null` when malformed. */
export function parseJob(entry: string, image: string): LinuxJob | null {
  const m = /^([A-Za-z0-9_-]+)(?::(x64|docker|2204))?(?:@([A-Za-z0-9._-]+))?$/.exec(entry);
  if (!m) return null;
  return { key: m[1], pool: (m[2] ?? "x64") as PoolKind, image: m[3] ?? image };
}

/** A whole number of `value` at least `min`, else `fallback`. */
function intOr<T>(value: string | undefined, min: number, fallback: T): number | T {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** `PICK_*` from `env`. */
export function readInput(env: (name: string) => string | undefined): PickInput {
  const image = env("PICK_IMAGE")?.trim() || "ubuntu-latest";
  const x64 = parseRunner(env("PICK_RUNNER_X64") ?? "");
  const docker = parseRunner(env("PICK_RUNNER_DOCKER") ?? "");
  const labels = words(env("PICK_SHARED_LABELS"));
  return {
    jobs: words(env("PICK_JOBS")).map((e) => parseJob(e, image)).filter((j) => j !== null),
    pools: {
      x64,
      docker: docker.ours ? docker : x64,
      "2204": parseRunner(env("PICK_RUNNER_2204") ?? ""),
    },
    sharedLabels: labels.length ? labels : DEFAULT_SHARED_LABELS,
    sharedSlots: intOr(env("PICK_SHARED_SLOTS"), 0, null),
    health: env("PICK_HEALTH") ?? "",
    forkPr: env("PICK_FORK_PR") === "true",
    attempt: intOr(env("GITHUB_RUN_ATTEMPT"), 1, 1),
    delaySeconds: Math.min(intOr(env("PICK_DELAY"), 0, 0), 300),
  };
}

/**
 * DENEXT_POOL_HEALTH's `pools` map when `value` parses and is fresh (`now` in epoch seconds), else
 * `null` (missing, unparsable or stale).
 */
export function freshPools(
  value: string,
  now = Date.now() / 1000,
): Record<string, PoolHealth> | null {
  let health: unknown;
  try {
    health = JSON.parse(value || "null");
  } catch {
    return null;
  }
  if (!health || typeof health !== "object") return null;
  const { checked_at: at, pools } = health as { checked_at?: unknown; pools?: unknown };
  if (typeof at !== "number") return null;
  const age = now - at;
  if (age > HEALTH_MAX_AGE || age < -300) return null;
  return pools && typeof pools === "object" ? pools as Record<string, PoolHealth> : null;
}

const count = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? Math.max(0, n) : 0;

/** A healthy pool's slot cap, or `null` when it may take no job (unlisted, not ok, paused). */
export function poolCap(pools: Record<string, PoolHealth>, label: string): number | null {
  const p = pools[label];
  if (!p || typeof p !== "object" || p.ok === false || p.paused === true) return null;
  const cap = typeof p.healthy_slots === "number" ? p.healthy_slots : p.slots;
  return typeof cap === "number" ? count(cap) : null;
}

/** The free slots: per label, and of the shared capacity. */
export interface Capacity {
  readonly free: Map<string, number>;
  shared: number;
}

/**
 * The free slots of each label the jobs name (see the header): `api` is the API's count of the
 * other runs' jobs, or `null` when it failed (the health value's `busy` alone counts).
 */
export function capacity(
  input: PickInput,
  pools: Record<string, PoolHealth>,
  api: BusyCount | null,
): Capacity {
  const busyOf = (label: string) => {
    const running = Math.max(count(pools[label]?.busy), api?.running.get(label) ?? 0);
    return running + (api?.queued.get(label) ?? 0);
  };
  const shared = input.sharedLabels;
  const sharedCap = input.sharedSlots ??
    Math.max(0, ...shared.map((l) => poolCap(pools, l) ?? 0));
  const sum = (f: (l: string) => number) => shared.reduce((n, l) => n + f(l), 0);
  const sharedRunning = Math.max(
    sum((l) => count(pools[l]?.busy)),
    sum((l) => api?.running.get(l) ?? 0),
  );
  const sharedBusy = sharedRunning + sum((l) => api?.queued.get(l) ?? 0);
  const free = new Map<string, number>();
  for (const kind of KINDS) {
    const label = input.pools[kind].label;
    if (!label || free.has(label)) continue;
    const cap = poolCap(pools, label);
    free.set(label, cap === null ? 0 : Math.max(0, cap - busyOf(label)));
  }
  return { free, shared: Math.max(0, sharedCap - sharedBusy) };
}

/**
 * Each job key's `runs-on` JSON: in priority order, its pool while that pool and (for a shared
 * label) the shared capacity have a free slot, else its image. `cap` `null` sends every job to its
 * image.
 */
export function allocate(input: PickInput, cap: Capacity | null): Map<string, string> {
  const out = new Map<string, string>();
  const shared = new Set(input.sharedLabels);
  for (const job of input.jobs) {
    const pool = input.pools[job.pool];
    const label = pool.label;
    const ok = !input.forkPr && cap !== null && pool.ours !== null && label !== null &&
      (cap.free.get(label) ?? 0) > 0 && (!shared.has(label) || cap.shared > 0);
    if (ok) {
      cap.free.set(label, cap.free.get(label)! - 1);
      if (shared.has(label)) cap.shared--;
      out.set(job.key, pool.ours!);
    } else {
      out.set(job.key, JSON.stringify(job.image));
    }
  }
  return out;
}

/** `$GITHUB_OUTPUT` lines: one per key, then `hosted` (the keys on GitHub's image). */
export function formatOutputs(input: PickInput, picks: ReadonlyMap<string, string>): string {
  const hosted = input.jobs.filter((j) => picks.get(j.key) === JSON.stringify(j.image));
  return [
    ...[...picks].map(([key, runsOn]) => `${key}=${runsOn}`),
    `hosted=${JSON.stringify(hosted.map((j) => j.key))}`,
  ].join("\n");
}

export type { PickContext };

const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** Adds `jobs`' live jobs on a label of `want` to `running` / `queued`. */
function countJobs(
  jobs: readonly ApiJob[],
  want: ReadonlySet<string>,
  running: Map<string, number>,
  queued: Map<string, number>,
): void {
  for (const job of jobs) {
    const label = ACTIVE.has(job.status) ? (job.labels ?? []).find((l) => want.has(l)) : undefined;
    if (label) inc(job.status === "in_progress" ? running : queued, label);
  }
}

/** The ids of the repository's queued and in-progress runs, this run left out. */
async function otherRuns(ctx: PickContext): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const status of ["queued", "in_progress"]) {
    const runs = await listAll<{ id: number }>(
      ctx.get,
      `/repos/${ctx.repo}/actions/runs?status=${status}`,
      "workflow_runs",
      ctx.token,
    );
    for (const run of runs) ids.add(String(run.id));
  }
  ids.delete(ctx.runId);
  return ids;
}

/** The organization's online, busy runners per label of `want`. */
async function busyRunners(
  ctx: PickContext,
  token: string,
  want: ReadonlySet<string>,
): Promise<Map<string, number>> {
  const runners = await listAll<ApiRunner>(
    ctx.get,
    `/orgs/${ctx.repo.split("/")[0]}/actions/runners`,
    "runners",
    token,
  );
  const busy = new Map<string, number>();
  for (const r of runners.filter((r) => r.status === "online" && r.busy)) {
    const label = r.labels.map((l) => l.name).find((l) => want.has(l));
    if (label) inc(busy, label);
  }
  return busy;
}

/**
 * The running and queued jobs of the repository's other queued or in-progress runs, per label of
 * `labels` (this run's own Linux jobs wait on this pick); with `runnerToken` the running count of
 * a label is at least its busy organization runners.
 */
export async function busyCount(ctx: PickContext, labels: readonly string[]): Promise<BusyCount> {
  const want = new Set(labels);
  const running = new Map<string, number>();
  const queued = new Map<string, number>();
  for (const id of await otherRuns(ctx)) {
    const jobs = await listAll<ApiJob>(
      ctx.get,
      `/repos/${ctx.repo}/actions/runs/${id}/jobs?filter=latest`,
      "jobs",
      ctx.token,
    );
    countJobs(jobs, want, running, queued);
  }
  if (ctx.runnerToken) {
    for (const [label, n] of await busyRunners(ctx, ctx.runnerToken, want)) {
      running.set(label, Math.max(running.get(label) ?? 0, n));
    }
  }
  return { running, queued };
}

/**
 * Whether this re-run's previous attempt had a job on one of `labels` that was cancelled before
 * any runner took it (the pool was stuck).
 */
export async function previousAttemptStalled(
  ctx: PickContext,
  attempt: number,
  labels: readonly string[],
): Promise<boolean> {
  if (attempt <= 1) return false;
  const want = new Set(labels);
  const jobs = await listAll<ApiJob & { conclusion?: string | null; runner_name?: string | null }>(
    ctx.get,
    `/repos/${ctx.repo}/actions/runs/${ctx.runId}/attempts/${attempt - 1}/jobs`,
    "jobs",
    ctx.token,
  );
  return jobs.some((j) =>
    j.conclusion === "cancelled" && !j.runner_name && (j.labels ?? []).some((l) => want.has(l))
  );
}

const message = (err: unknown) => err instanceof Error ? err.message : String(err);

/** The labels the jobs may take, and the shared ones. */
function labelsOf(input: PickInput): string[] {
  const labels = new Set(input.sharedLabels);
  for (const job of input.jobs) {
    const label = input.pools[job.pool].label;
    if (label) labels.add(label);
  }
  return [...labels];
}

/** The picks for `input`, never throwing (see the header for what each failure does). */
export async function pick(
  input: PickInput,
  ctx: PickContext,
  warn: (message: string) => void = () => {},
  now = Date.now() / 1000,
): Promise<Map<string, string>> {
  const anyPool = input.jobs.some((j) => input.pools[j.pool].ours !== null);
  if (input.forkPr || !anyPool) return allocate(input, null);
  const pools = freshPools(input.health, now);
  if (!pools) {
    warn(
      "pick-linux-runners: DENEXT_POOL_HEALTH is missing, unparsable or stale; every Linux job takes GitHub's image",
    );
    return allocate(input, null);
  }
  const labels = labelsOf(input);
  try {
    if (await previousAttemptStalled(ctx, input.attempt, labels)) {
      warn(
        "pick-linux-runners: the previous attempt's job on a Linux pool was cancelled before a runner took it; every Linux job takes GitHub's image",
      );
      return allocate(input, null);
    }
  } catch (err) {
    warn(`pick-linux-runners: previous-attempt check failed: ${message(err)}; ignored`);
  }
  let api: BusyCount | null = null;
  try {
    api = await busyCount(ctx, labels);
  } catch (err) {
    warn(`pick-linux-runners: ${message(err)}; counting DENEXT_POOL_HEALTH's busy slots only`);
  }
  return allocate(input, capacity(input, pools, api));
}

/** The picks as a table for the log. */
export function describe(input: PickInput, picks: ReadonlyMap<string, string>): string {
  const rows = input.jobs.map((j) => `| ${j.key} | ${j.pool} | ${picks.get(j.key)} |`);
  return ["| job | wants | runs on |", "| --- | --- | --- |", ...rows].join("\n");
}

if (import.meta.main) {
  const env = (name: string) => Deno.env.get(name);
  const input = readInput(env);
  if (input.delaySeconds && !input.forkPr) {
    await new Promise((r) => setTimeout(r, input.delaySeconds * 1000));
  }
  const picks = await pick(input, contextFromEnv(env), (m) => console.error(`::warning::${m}`));
  console.log(formatOutputs(input, picks));
  console.error(describe(input, picks));
}
