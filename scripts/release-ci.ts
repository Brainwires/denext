// The release's CI gate: a version is tagged only from a commit that ci.yml's heavy jobs, every
// desktop-ci.yml job, every e2e.yml job, every desktop-window.yml job and both native-plugins.yml
// builds (an Android and an iOS app with every denext plugin) passed on.
// A push to `development` runs only the fast jobs (integration, next-compat, coverage,
// backend-integration, windows-tests and macos-tests stay on pull requests, `main` and a manual dispatch), so `deno task release`
// asks GitHub for the ci.yml runs on HEAD and refuses unless the newest one that ran those jobs
// has every required job green. desktop-ci.yml and desktop-window.yml run on a push only when their
// `paths` filter matches, and e2e.yml only on a dispatch, so for each of those the release asks
// for its newest run on HEAD, push or dispatch, and refuses unless that run finished with every
// job green (e2e.yml dispatched with `-f job=<one>` skips the rest, so it is refused: the release
// needs a full run). native-plugins.yml runs on a push only when a native template or installer
// changes, but a release also ships the mobile runtime, the export and the Capacitor config writers
// it builds: so its newest run on HEAD must be green too, its iOS build included (a dispatch with
// `-f ios=false` skips it and can't vouch).
// On `development` all five are dispatches: `gh workflow run ci.yml --ref development`,
// `gh workflow run desktop-ci.yml --ref development`, `gh workflow run e2e.yml --ref development`,
// `gh workflow run desktop-window.yml --ref development` and
// `gh workflow run native-plugins.yml --ref development`.

/** The ci.yml jobs a release needs green on the commit it is cut from. */
export const RELEASE_CI_JOBS: readonly string[] = [
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
  "install.sh (macos-latest — this commit's build + the real latest one)",
  "installers (windows-latest — .msi per-user + per-machine, upgrade, uninstall)",
  "installers (ubuntu-latest — .deb via apt, .rpm via dnf)",
  "installers (macos-latest — .dmg mounted, .pkg installed; unsigned)",
  "scaffold + package-script drift",
  "windows on arm (windows-11-arm — desktop tests, install.ps1, Arm64 .msi)",
];

/**
 * The e2e.yml jobs a release needs green on the commit it is cut from: real-browser hydration,
 * HMR and the `denext ui` panels (`e2e`), the migration beds, the timer stress runs and the
 * no-Deno install. A dispatch of one job (`-f job=e2e`) skips the others and can't vouch.
 */
export const E2E_JOBS: readonly string[] = ["e2e", "migration-beds", "timer-stress", "no-deno"];

/**
 * The desktop-window.yml jobs a release needs green on the commit it is cut from: a real packaged
 * window on each OS, and the job that compares every check across them.
 */
export const DESKTOP_WINDOW_JOBS: readonly string[] = [
  "window test (linux-x64)",
  "window test (macos-arm64)",
  "window test (macos-x64)",
  "window test (windows-x64)",
  "results by OS",
];

/**
 * The native-plugins.yml jobs a release needs green on the commit it is cut from: examples/mobile
 * exported, synced and built with every denext native plugin, as a debug `.apk` and an unsigned
 * iOS Release build.
 */
export const NATIVE_PLUGINS_JOBS: readonly string[] = ["android", "ios"];

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
 * The verdict on `workflow`'s newest run on `sha` (a push or a dispatch): it must have finished
 * with every `required` job green and no other job failed.
 */
async function newestRunVerdict(
  workflow: string,
  required: readonly string[],
  sha: string,
  gh: GhJson,
): Promise<CiVerdict> {
  const [run] = await workflowRuns(workflow, sha, gh);
  if (!run) return { ok: false, reason: `no ${workflow} run on ${sha}` };
  if (run.status !== "completed") {
    return { ok: false, reason: `${workflow} ${run.event} run on ${sha} is ${run.status}`, run };
  }
  const jobs = await runJobs(run, gh);
  const others = jobs.filter((j) =>
    !required.includes(j.name) && j.conclusion !== "success" && j.conclusion !== "skipped"
  ).map((j) => `${j.name}: ${j.conclusion || j.status}`);
  const unmet = [...unmetCiJobs(jobs, required), ...others];
  return unmet.length === 0
    ? { ok: true, reason: `${workflow} ${run.event} run is green on ${sha}`, run }
    : { ok: false, reason: `${workflow} ${run.event} run on ${sha}: ${unmet.join(", ")}`, run };
}

/**
 * Check desktop-ci.yml on `sha`: its newest run there (a push or a dispatch) must have finished
 * with every {@linkcode DESKTOP_CI_JOBS} job green and no other job failed.
 *
 * @param sha The commit to release (HEAD).
 * @param gh How `gh` is reached (default: the GitHub CLI).
 */
export function desktopCiVerdict(sha: string, gh: GhJson = ghJson): Promise<CiVerdict> {
  return newestRunVerdict("desktop-ci.yml", DESKTOP_CI_JOBS, sha, gh);
}

/**
 * Check e2e.yml on `sha`: its newest run there must have run every {@linkcode E2E_JOBS} job, green.
 *
 * @param sha The commit to release (HEAD).
 * @param gh How `gh` is reached (default: the GitHub CLI).
 */
export function e2eVerdict(sha: string, gh: GhJson = ghJson): Promise<CiVerdict> {
  return newestRunVerdict("e2e.yml", E2E_JOBS, sha, gh);
}

/**
 * Check desktop-window.yml on `sha`: its newest run there (a push or a dispatch) must have finished
 * with every {@linkcode DESKTOP_WINDOW_JOBS} job green.
 *
 * @param sha The commit to release (HEAD).
 * @param gh How `gh` is reached (default: the GitHub CLI).
 */
export function desktopWindowVerdict(sha: string, gh: GhJson = ghJson): Promise<CiVerdict> {
  return newestRunVerdict("desktop-window.yml", DESKTOP_WINDOW_JOBS, sha, gh);
}

/**
 * Check native-plugins.yml on `sha`: its newest run there (a push or a dispatch) must have finished
 * with both {@linkcode NATIVE_PLUGINS_JOBS} builds green.
 *
 * @param sha The commit to release (HEAD).
 * @param gh How `gh` is reached (default: the GitHub CLI).
 */
export function nativePluginsVerdict(sha: string, gh: GhJson = ghJson): Promise<CiVerdict> {
  return newestRunVerdict("native-plugins.yml", NATIVE_PLUGINS_JOBS, sha, gh);
}

/** The workflows the release gates on, in the order its hint dispatches them. */
export const GATED_WORKFLOWS: readonly string[] = [
  "ci.yml",
  "desktop-ci.yml",
  "e2e.yml",
  "desktop-window.yml",
  "native-plugins.yml",
];

/** What to run to get every gated workflow onto `sha` on `branch`. */
export function releaseCiHint(branch: string): string {
  const watch = (workflow: string) =>
    `    gh run watch "$(gh run list --workflow=${workflow} --event=workflow_dispatch --limit 1 ` +
    `--json databaseId -q '.[0].databaseId')" --exit-status`;
  return `push ${branch}, then run ${GATED_WORKFLOWS.join(", ")} on it and wait for all ` +
    `${GATED_WORKFLOWS.length}:\n` +
    GATED_WORKFLOWS.map((w) => `    gh workflow run ${w} --ref ${branch}\n`).join("") +
    GATED_WORKFLOWS.map(watch).join("\n");
}
