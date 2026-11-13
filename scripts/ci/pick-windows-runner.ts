// Pick each Windows x64 job's runner for one workflow run: our self-hosted Windows x64 runner
// (the repository variable RUNNER_WINDOWS_X64) while it has a free slot, GitHub's windows-latest
// for the overflow. A workflow's `windows-runner` job runs this first; every Windows job reads
// its choice from `needs.windows-runner.outputs.<key>` and falls back to the variable when that
// output is empty.
//
//   deno run --allow-net=api.github.com --allow-env scripts/ci/pick-windows-runner.ts >> "$GITHUB_OUTPUT"
//
// Prints one `<key>=<runs-on JSON>` line per job key. Environment:
//
// - `PICK_JOBS`: the job keys in priority order (space separated): the first ones take the free
//   slots. Only the jobs that will run this time (a job skipped on this event is left out).
// - `PICK_FOLLOW`: `key=other` pairs (space separated): `key` gets whatever `other` got (a job
//   that `needs` the other one starts when the other one's slot frees up).
// - `PICK_RUNNER`: the variable's value: a label, or a JSON array of labels. Empty: every job
//   takes windows-latest.
// - `PICK_SLOTS`: how many jobs our runner takes at once (default 1).
// - `PICK_FORK_PR`: `true` for a fork's pull request: every job takes windows-latest (a
//   self-hosted runner never takes a fork's code), with no API call.
// - `GITHUB_TOKEN` (`actions: read`), `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_API_URL`.
// - `RUNNER_STATUS_TOKEN` (optional): a token that may list the organization's self-hosted
//   runners (organization "Self-hosted runners: read"). With it a busy runner of ours counts too,
//   whatever repository its job came from.
//
// Our runner is busy while a job of another run in this repository that names its label is queued
// or in progress: the scheduler mints a just-in-time runner per queued job, so a queued job is a
// slot taken. When anything fails (the API, a timeout, a malformed answer) every job takes our
// runner: the routing it had before this script.

/** One job, as `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs` lists it. */
export interface ApiJob {
  readonly status: string;
  readonly labels?: readonly string[];
}

/** One self-hosted runner, as `GET /orgs/{org}/actions/runners` lists it. */
export interface ApiRunner {
  readonly status: string;
  readonly busy: boolean;
  readonly labels: readonly { readonly name: string }[];
}

/** What the pick needs to know, read from the environment. */
export interface PickInput {
  readonly jobs: readonly string[];
  readonly follow: ReadonlyMap<string, string>;
  /** Our runner's `runs-on` as JSON, or `null` when the variable is unset. */
  readonly ours: string | null;
  /** The label that tells our runner's jobs apart (`self-hosted` never does). */
  readonly label: string | null;
  readonly slots: number;
  readonly forkPr: boolean;
}

const GITHUB_HOSTED = JSON.stringify("windows-latest");

/** A job's states that hold (or will hold) a slot of the runner its labels name. */
const ACTIVE = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

/**
 * The variable's value as a `runs-on` JSON value and the label that identifies it, or `null`s for
 * an empty or malformed value.
 */
export function parseRunner(value: string): { ours: string | null; label: string | null } {
  const v = value.trim();
  if (!v) return { ours: null, label: null };
  if (!v.startsWith("[")) return { ours: JSON.stringify(v), label: v };
  try {
    const labels: unknown = JSON.parse(v);
    if (!Array.isArray(labels) || !labels.every((l) => typeof l === "string" && l)) {
      return { ours: null, label: null };
    }
    const label = labels.find((l) => l !== "self-hosted") ?? null;
    return label ? { ours: JSON.stringify(labels), label } : { ours: null, label: null };
  } catch {
    return { ours: null, label: null };
  }
}

/** `PICK_*` from `env`. */
export function readInput(env: (name: string) => string | undefined): PickInput {
  const words = (s: string | undefined) => (s ?? "").split(/\s+/).filter(Boolean);
  const follow = new Map<string, string>();
  for (const pair of words(env("PICK_FOLLOW"))) {
    const [key, other] = pair.split("=");
    if (key && other) follow.set(key, other);
  }
  const slots = Number.parseInt(env("PICK_SLOTS") ?? "", 10);
  return {
    jobs: words(env("PICK_JOBS")),
    follow,
    ...parseRunner(env("PICK_RUNNER") ?? ""),
    slots: Number.isFinite(slots) && slots >= 0 ? slots : 1,
    forkPr: env("PICK_FORK_PR") === "true",
  };
}

/** How many of `jobs` hold a slot of the runner `label` names. */
export function activeJobsOn(jobs: readonly ApiJob[], label: string): number {
  return jobs.filter((j) => ACTIVE.has(j.status) && (j.labels ?? []).includes(label)).length;
}

/** How many of `runners` with `label` are online and running a job. */
export function busyRunnersWith(runners: readonly ApiRunner[], label: string): number {
  return runners.filter((r) =>
    r.status === "online" && r.busy && r.labels.some((l) => l.name === label)
  ).length;
}

/**
 * Each job key's `runs-on` JSON: our runner for the first `free` keys, windows-latest for the
 * rest; a followed key copies its target's.
 */
export function allocate(input: PickInput, free: number): Map<string, string> {
  const out = new Map<string, string>();
  let left = input.ours && !input.forkPr ? Math.max(0, free) : 0;
  for (const key of input.jobs) {
    out.set(key, left > 0 ? input.ours! : GITHUB_HOSTED);
    if (left > 0) left--;
  }
  for (const [key, other] of input.follow) out.set(key, out.get(other) ?? GITHUB_HOSTED);
  return out;
}

/** Every key on our runner (the routing before this script), windows-latest without one. */
export function fallback(input: PickInput): Map<string, string> {
  const out = new Map<string, string>();
  const runsOn = input.ours && !input.forkPr ? input.ours : GITHUB_HOSTED;
  for (const key of [...input.jobs, ...input.follow.keys()]) out.set(key, runsOn);
  return out;
}

/** `$GITHUB_OUTPUT` lines. */
export function formatOutputs(picks: ReadonlyMap<string, string>): string {
  return [...picks].map(([key, runsOn]) => `${key}=${runsOn}`).join("\n");
}

/** A fetch of a JSON resource of the GitHub API. */
export type GetJson = (path: string, token: string) => Promise<unknown>;

/** Every item of a paginated list (`key` names the array), up to 10 pages of 100. */
export async function listAll<T>(
  get: GetJson,
  path: string,
  key: string,
  token: string,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= 10; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const body = await get(`${path}${sep}per_page=100&page=${page}`, token) as Record<
      string,
      unknown
    >;
    const batch = body?.[key];
    if (!Array.isArray(batch)) throw new Error(`no "${key}" in the answer to ${path}`);
    items.push(...(batch as T[]));
    if (batch.length < 100) break;
  }
  return items;
}

/** The context the busy count reads. */
export interface PickContext {
  readonly repo: string;
  readonly runId: string;
  readonly token: string;
  readonly runnerToken?: string;
  readonly get: GetJson;
}

/**
 * How many slots of our runner are taken: the active jobs of the repository's other queued or
 * in-progress runs that name its label, and with `runnerToken` at least as many as its busy
 * runners (plus the queued jobs, which no runner holds yet).
 */
export async function busySlots(ctx: PickContext, label: string): Promise<number> {
  const runs: { id: number }[] = [];
  for (const status of ["queued", "in_progress"]) {
    runs.push(
      ...await listAll<{ id: number }>(
        ctx.get,
        `/repos/${ctx.repo}/actions/runs?status=${status}`,
        "workflow_runs",
        ctx.token,
      ),
    );
  }
  let queued = 0;
  let running = 0;
  for (const run of runs) {
    if (String(run.id) === ctx.runId) continue; // this run's own Windows jobs wait on this pick
    const jobs = await listAll<ApiJob>(
      ctx.get,
      `/repos/${ctx.repo}/actions/runs/${run.id}/jobs?filter=latest`,
      "jobs",
      ctx.token,
    );
    running += activeJobsOn(jobs.filter((j) => j.status === "in_progress"), label);
    queued += activeJobsOn(jobs.filter((j) => j.status !== "in_progress"), label);
  }
  if (ctx.runnerToken) {
    const org = ctx.repo.split("/")[0];
    const runners = await listAll<ApiRunner>(
      ctx.get,
      `/orgs/${org}/actions/runners`,
      "runners",
      ctx.runnerToken,
    );
    running = Math.max(running, busyRunnersWith(runners, label));
  }
  return running + queued;
}

/** The picks for `input`, never throwing: on any failure, {@linkcode fallback} and a warning. */
export async function pick(
  input: PickInput,
  ctx: PickContext,
  warn: (message: string) => void = () => {},
): Promise<Map<string, string>> {
  if (!input.ours || input.forkPr) return allocate(input, 0);
  try {
    const busy = await busySlots(ctx, input.label!);
    return allocate(input, input.slots - busy);
  } catch (err) {
    warn(
      `pick-windows-runner: ${
        err instanceof Error ? err.message : String(err)
      }; every Windows job keeps our runner`,
    );
    return fallback(input);
  }
}

/** A {@linkcode GetJson} over `fetch`, every request bounded by `signal`. */
export function fetchJson(apiUrl: string, signal: AbortSignal): GetJson {
  return async (path, token) => {
    const res = await fetch(`${apiUrl}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`GET ${path.split("?")[0]}: HTTP ${res.status}`);
    }
    return await res.json();
  };
}

/** The {@linkcode PickContext} of a workflow step (`GITHUB_*`, `RUNNER_STATUS_TOKEN`), 60 s bound. */
export function contextFromEnv(env: (name: string) => string | undefined): PickContext {
  return {
    repo: env("GITHUB_REPOSITORY") ?? "",
    runId: env("GITHUB_RUN_ID") ?? "",
    token: env("GITHUB_TOKEN") ?? "",
    runnerToken: env("RUNNER_STATUS_TOKEN") || undefined,
    get: fetchJson(env("GITHUB_API_URL") ?? "https://api.github.com", AbortSignal.timeout(60_000)),
  };
}

if (import.meta.main) {
  const env = (name: string) => Deno.env.get(name);
  const input = readInput(env);
  const picks = await pick(
    input,
    contextFromEnv(env),
    (message) => console.error(`::warning::${message}`),
  );
  console.log(formatOutputs(picks));
  for (const [key, runsOn] of picks) console.error(`${key}: ${runsOn}`);
}
