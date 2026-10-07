// The release's CI gate: a version is tagged only from a commit that ci.yml's heavy jobs passed on.
// A push to `development` runs only the fast jobs (integration, next-compat and coverage stay on
// pull requests, `main` and a manual dispatch), so `deno task release` asks GitHub for the ci.yml
// runs on HEAD and refuses unless the newest one that ran those jobs has every required job green.
// On `development` that run is a dispatch: `gh workflow run ci.yml --ref development`.

/** The ci.yml jobs a release needs green on the commit it is cut from. */
export const RELEASE_CI_JOBS: readonly string[] = [
  "check",
  "integration",
  "next-compat",
  "coverage",
  "ios-export-router",
];

/** The jobs a push to `development` skips: a run that skipped them can't vouch for a release. */
const HEAVY_JOBS = ["integration", "next-compat", "coverage"];

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
  const runs = (await gh([
    "run",
    "list",
    "--workflow",
    "ci.yml",
    "--commit",
    sha,
    "--limit",
    "20",
    "--json",
    "databaseId,event,status,conclusion,createdAt,url",
  ]) as CiRun[]).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const run of runs) {
    const { jobs } = await gh([
      "run",
      "view",
      String(run.databaseId),
      "--json",
      "jobs",
    ]) as { jobs: CiJob[] };
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

/** What to run to get the heavy jobs onto `sha` on `branch`. */
export function releaseCiHint(branch: string): string {
  return `push ${branch}, then run ci.yml on it and wait for it:\n` +
    `    gh workflow run ci.yml --ref ${branch}\n` +
    `    gh run watch "$(gh run list --workflow=ci.yml --event=workflow_dispatch --limit 1 ` +
    `--json databaseId -q '.[0].databaseId')" --exit-status`;
}
