// The release's CI gate: a version is tagged only from a commit that ci.yml's heavy jobs and every
// desktop-ci.yml job passed on.
// A push to `development` runs only the fast jobs (integration, next-compat, coverage and
// backend-integration stay on pull requests, `main` and a manual dispatch), so `deno task release`
// asks GitHub for the ci.yml runs on HEAD and refuses unless the newest one that ran those jobs
// has every required job green. desktop-ci.yml runs on a push only when the desktop surface
// changed (its `paths` filter), so the release asks for its newest run on HEAD, push or dispatch,
// and refuses unless that run finished with every job green.
// On `development` both are dispatches: `gh workflow run ci.yml --ref development` and
// `gh workflow run desktop-ci.yml --ref development`.

/** The ci.yml jobs a release needs green on the commit it is cut from. */
export const RELEASE_CI_JOBS: readonly string[] = [
  "check",
  "integration",
  "next-compat",
  "coverage",
  "backend-integration",
  "ios-export-router",
  "windows-resolve",
];

/**
 * The desktop-ci.yml jobs a release needs green on the commit it is cut from (matrix legs by their
 * full names). Any other job of that run must not fail either: this list only makes a job that
 * went missing (renamed, dropped from the matrix) refuse rather than pass unseen.
 */
export const DESKTOP_CI_JOBS: readonly string[] = [
  "desktop tests (windows-latest)",
  "desktop tests (macos-latest)",
  "desktop tests (ubuntu-latest)",
  "secureStore round-trip (windows-latest)",
  "secureStore round-trip (macos-latest)",
  "install.ps1 (windows-latest — loopback release, this commit's build, the real latest one)",
  "install.sh (ubuntu-latest — this commit's build + the real latest one)",
  "installers (windows-latest — .msi per-user + per-machine, upgrade, uninstall)",
  "installers (ubuntu-latest — .deb via apt, .rpm via dnf)",
  "installers (macos-latest — .dmg mounted, .pkg installed; unsigned)",
  "scaffold + package-script drift",
];

/** The jobs a push to `development` skips: a run that skipped them can't vouch for a release. */
const HEAVY_JOBS = ["integration", "next-compat", "coverage", "backend-integration"];

/** One ci.yml run, as `gh run list --json` gives it. */
export interface CiRun {
  readonly databaseId: number;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string;
  readonly createdAt: string;
  readonly url: string;
}

/** One job of a run, as `gh run view --json jobs` gives it. */
export interface CiJob {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string;
}

/** `gh` with `args`, its stdout parsed as JSON (tests pass a fake). */
export type GhJson = (args: string[]) => Promise<unknown>;

const ghJson: GhJson = async (args) => {
  const out = await new Deno.Command("gh", { args, stdout: "piped", stderr: "piped" }).output();
  if (!out.success) {
    throw new Error(`gh ${args.join(" ")}: ${new TextDecoder().decode(out.stderr).trim()}`);
  }
  return JSON.parse(new TextDecoder().decode(out.stdout));
};

/** The verdict on HEAD: `ok`, or why not, with the run it looked at (if any). */
export interface CiVerdict {
  readonly ok: boolean;
  readonly reason: string;
  readonly run?: CiRun;
}

/**
 * The required jobs of `jobs` that did not succeed, each with its state (`coverage: failure`,
 * `ios-export-router: missing`).
 *
 * @param jobs The run's jobs.
 * @param required The jobs that must have succeeded.
 */
export function unmetCiJobs(
  jobs: readonly CiJob[],
  required: readonly string[] = RELEASE_CI_JOBS,
): string[] {
  return required.flatMap((name) => {
    const job = jobs.find((j) => j.name === name);
    if (!job) return [`${name}: missing`];
    if (job.conclusion === "success") return [];
    return [`${name}: ${job.conclusion || job.status}`];
  });
}

/** Whether a run ran the heavy jobs (a push to `development` skips them). */
function ranHeavyJobs(jobs: readonly CiJob[]): boolean {
  return HEAVY_JOBS.every((name) =>
    jobs.some((j) => j.name === name && j.conclusion !== "skipped")
  );
}

/**
 * Check ci.yml on `sha`: the newest run on it that ran the heavy jobs must have finished with every
 * {@linkcode RELEASE_CI_JOBS} job green.
 *
 * @param sha The commit to release (HEAD).
 * @param gh How `gh` is reached (default: the GitHub CLI).
 */
export async function releaseCiVerdict(sha: string, gh: GhJson = ghJson): Promise<CiVerdict> {
  for (const run of await workflowRuns("ci.yml", sha, gh)) {
    const jobs = await runJobs(run, gh);
    if (!ranHeavyJobs(jobs)) continue; // a plain push run: look further back
    if (run.status !== "completed") {
      return { ok: false, reason: `ci.yml ${run.event} run on ${sha} is ${run.status}`, run };
    }
    const unmet = unmetCiJobs(jobs);
    return unmet.length === 0
      ? { ok: true, reason: `ci.yml ${run.event} run is green on ${sha}`, run }
      : { ok: false, reason: `ci.yml ${run.event} run on ${sha}: ${unmet.join(", ")}`, run };
  }
  return {
    ok: false,
    reason: `no ci.yml run on ${sha} ran the heavy jobs (${HEAVY_JOBS.join(", ")})`,
  };
}

/** `workflow`'s runs on `sha`, newest first. */
async function workflowRuns(workflow: string, sha: string, gh: GhJson): Promise<CiRun[]> {
  const runs = await gh([
    "run",
    "list",
    "--workflow",
    workflow,
    "--commit",
    sha,
    "--limit",
    "20",
    "--json",
    "databaseId,event,status,conclusion,createdAt,url",
  ]) as CiRun[];
  return runs.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The jobs of `run`. */
async function runJobs(run: CiRun, gh: GhJson): Promise<CiJob[]> {
  return (await gh(["run", "view", String(run.databaseId), "--json", "jobs"]) as {
    jobs: CiJob[];
  }).jobs;
}

/**
 * Check desktop-ci.yml on `sha`: its newest run there (a push or a dispatch) must have finished
 * with every {@linkcode DESKTOP_CI_JOBS} job green and no other job failed.
 *
 * @param sha The commit to release (HEAD).
 * @param gh How `gh` is reached (default: the GitHub CLI).
 */
export async function desktopCiVerdict(sha: string, gh: GhJson = ghJson): Promise<CiVerdict> {
  const [run] = await workflowRuns("desktop-ci.yml", sha, gh);
  if (!run) return { ok: false, reason: `no desktop-ci.yml run on ${sha}` };
  if (run.status !== "completed") {
    return { ok: false, reason: `desktop-ci.yml ${run.event} run on ${sha} is ${run.status}`, run };
  }
  const jobs = await runJobs(run, gh);
  const others = jobs.filter((j) =>
    !DESKTOP_CI_JOBS.includes(j.name) && j.conclusion !== "success" && j.conclusion !== "skipped"
  ).map((j) => `${j.name}: ${j.conclusion || j.status}`);
  const unmet = [...unmetCiJobs(jobs, DESKTOP_CI_JOBS), ...others];
  return unmet.length === 0
    ? { ok: true, reason: `desktop-ci.yml ${run.event} run is green on ${sha}`, run }
    : { ok: false, reason: `desktop-ci.yml ${run.event} run on ${sha}: ${unmet.join(", ")}`, run };
}

/** What to run to get the heavy jobs and desktop-ci onto `sha` on `branch`. */
export function releaseCiHint(branch: string): string {
  const watch = (workflow: string) =>
    `    gh run watch "$(gh run list --workflow=${workflow} --event=workflow_dispatch --limit 1 ` +
    `--json databaseId -q '.[0].databaseId')" --exit-status`;
  return `push ${branch}, then run ci.yml and desktop-ci.yml on it and wait for both:\n` +
    `    gh workflow run ci.yml --ref ${branch}\n` +
    `    gh workflow run desktop-ci.yml --ref ${branch}\n` +
    `${watch("ci.yml")}\n${watch("desktop-ci.yml")}`;
}
