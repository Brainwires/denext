// Publishes the package-manager manifests scripts/gen-package-manifests.ts wrote for a release
// (the `package-managers` job of .github/workflows/publish.yml runs it once the release exists):
//
//   Homebrew  denext.rb               → <HOMEBREW_TAP_REPO>/Formula/denext.rb
//             (`brew install brainwires/denext/denext`)
//   Scoop     denext.json             → <SCOOP_BUCKET_REPO>/bucket/denext.json
//             (`scoop bucket add denext https://github.com/Brainwires/scoop-denext`)
//   winget    Brainwires.denext*.yaml → a pull request to microsoft/winget-pkgs, from a branch of
//             <WINGET_FORK_REPO>, adding manifests/b/Brainwires/denext/<version>/
//
// Only a stable release is published: a tag with a prerelease suffix (`v4.2.0-rc.1`, the rule
// publish.yml uses for `prerelease:`) is skipped whole. Each target needs its own token
// (HOMEBREW_TAP_TOKEN, SCOOP_BUCKET_TOKEN, WINGET_TOKEN); a missing one skips that target with a
// notice, never a failure, so the release stays green until the maintainer sets the repos up
// (CONTRIBUTING.md → "Package managers"). Everything goes through `gh api` / `gh pr create` with
// the target's token in GH_TOKEN: no clone, and a token never appears on a command line or in the
// log. A re-run is idempotent: an unchanged file is not re-committed, and a winget version that is
// already merged or has an open pull request is not submitted again.
//
//   deno run -A scripts/publish-package-manifests.ts --version v4.2.0 --dir dist [--dry-run]

import { encodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path";
import { requiredArg } from "./gen-package-manifests.ts";

/** Where each manifest goes, unless the environment names another repository. */
export const DEFAULT_REPOS = {
  homebrew: "Brainwires/homebrew-denext",
  scoop: "Brainwires/scoop-denext",
  winget: "Brainwires/winget-pkgs",
} as const;

/** The repository winget pull requests target. */
export const WINGET_UPSTREAM = "microsoft/winget-pkgs";
const WINGET_ID = "Brainwires.denext";
const WINGET_DIR = "manifests/b/Brainwires/denext";

/** A package manager this script publishes to. */
export type ManagerId = keyof typeof DEFAULT_REPOS;

interface Manager {
  readonly label: string;
  /** The env var holding its token. */
  readonly secret: string;
  /** The env var that may override {@linkcode DEFAULT_REPOS}. */
  readonly repoVar: string;
}

const MANAGERS: Record<ManagerId, Manager> = {
  homebrew: { label: "Homebrew", secret: "HOMEBREW_TAP_TOKEN", repoVar: "HOMEBREW_TAP_REPO" },
  scoop: { label: "Scoop", secret: "SCOOP_BUCKET_TOKEN", repoVar: "SCOOP_BUCKET_REPO" },
  winget: { label: "winget", secret: "WINGET_TOKEN", repoVar: "WINGET_FORK_REPO" },
};

/** What happens to one package manager. */
export type TargetPlan =
  | { readonly id: ManagerId; readonly action: "skip"; readonly reason: string }
  | {
    readonly id: ManagerId;
    readonly action: "publish";
    /** The tap / bucket, or (winget) the fork the pull request's branch is pushed to. */
    readonly repo: string;
    /** The env var the token is read from (the token itself never enters a plan). */
    readonly secret: string;
    /** Repository path → contents. */
    readonly files: Readonly<Record<string, string>>;
    /** The commit message (winget: also the pull request's title). */
    readonly message: string;
    /** winget only: the fork's branch the pull request comes from. */
    readonly branch?: string;
  };

/** Whether a tag is a prerelease — the rule publish.yml's `prerelease:` uses (a `-` in the tag). */
export function isPrerelease(tag: string): boolean {
  return tag.includes("-");
}

/** The version without the tag's `v`. */
function bare(tag: string): string {
  return tag.replace(/^v/, "");
}

/** The manifests gen-package-manifests.ts writes, by name: what {@linkcode planPublish} reads. */
export const MANIFEST_FILES = {
  homebrew: ["denext.rb"],
  scoop: ["denext.json"],
  winget: [`${WINGET_ID}.yaml`, `${WINGET_ID}.installer.yaml`, `${WINGET_ID}.locale.en-US.yaml`],
} as const;

/** Where a manager's manifest files go in its repository. */
function repoFiles(
  id: ManagerId,
  version: string,
  manifests: Readonly<Record<string, string>>,
): Record<string, string> {
  const read = (name: string) => {
    const text = manifests[name];
    if (text === undefined) throw new Error(`publish-package-manifests: no ${name} to publish`);
    return text;
  };
  if (id === "homebrew") return { "Formula/denext.rb": read("denext.rb") };
  if (id === "scoop") return { "bucket/denext.json": read("denext.json") };
  return Object.fromEntries(
    MANIFEST_FILES.winget.map((name) => [`${WINGET_DIR}/${version}/${name}`, read(name)]),
  );
}

/** The commit message of a manager's update (the winget pull request's title too). */
function commitMessage(id: ManagerId, version: string, newPackage = false): string {
  if (id === "homebrew") return `denext ${version}`;
  if (id === "scoop") return `denext: Update to version ${version}`;
  return `${newPackage ? "New package" : "New version"}: ${WINGET_ID} version ${version}`;
}

/** Reads an env var; empty counts as unset (a workflow passes an unset secret as ""). */
export type EnvGet = (name: string) => string | undefined;

/**
 * What a run would do: per package manager, publish (where) or skip (why). Pure — no network.
 *
 * @param tag The release tag (`v4.2.0`).
 * @param env Env reader (tokens and repository overrides).
 * @param manifests Manifest file name → contents (only needed for the managers that publish).
 * @returns One plan per manager, in Homebrew, Scoop, winget order.
 */
export function planPublish(
  tag: string,
  env: EnvGet,
  manifests: Readonly<Record<string, string>>,
): TargetPlan[] {
  const version = bare(tag);
  return (Object.keys(MANAGERS) as ManagerId[]).map((id): TargetPlan => {
    const m = MANAGERS[id];
    if (isPrerelease(tag)) {
      return { id, action: "skip", reason: `${tag} is a prerelease; only stable releases publish` };
    }
    if (!env(m.secret)) {
      return { id, action: "skip", reason: `no ${m.secret} secret is set` };
    }
    return {
      id,
      action: "publish",
      repo: env(m.repoVar) || DEFAULT_REPOS[id],
      secret: m.secret,
      files: repoFiles(id, version, manifests),
      message: commitMessage(id, version),
      ...(id === "winget" ? { branch: `${WINGET_ID}-${version}` } : {}),
    };
  });
}

/** One `gh` invocation's result. */
export interface GhResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `gh <args>` with `token` as GH_TOKEN. Tests pass a fake. */
export type GhRunner = (args: readonly string[], token: string) => Promise<GhResult>;

/** The real runner: the `gh` on PATH, the token in its environment only. */
export const runGh: GhRunner = async (args, token) => {
  const out = await new Deno.Command("gh", {
    args: [...args],
    env: { GH_TOKEN: token, GH_PROMPT_DISABLED: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
};

/** How a publish ended. */
export type PublishOutcome = "published" | "unchanged" | "pull-request-open" | "already-merged";

/** `gh` that throws (with its stderr) on a non-zero exit. */
async function must(gh: GhRunner, token: string, args: readonly string[]): Promise<string> {
  const r = await gh(args, token);
  if (r.code !== 0) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed (${r.code}): ${r.stderr.trim()}`);
  }
  return r.stdout;
}

/** Whether a `gh api` failure is a 404 (the path does not exist). */
function notFound(r: GhResult): boolean {
  return r.code !== 0 && /HTTP 404|Not Found/i.test(r.stderr);
}

/** `owner/repo/contents/<path>` with each path segment encoded. */
function contentsPath(repo: string, path: string): string {
  return `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The file's blob sha and decoded text on the default branch, or null when it does not exist. */
async function currentFile(
  gh: GhRunner,
  token: string,
  repo: string,
  path: string,
): Promise<{ sha: string; text: string } | null> {
  const r = await gh(["api", contentsPath(repo, path)], token);
  if (notFound(r)) return null;
  if (r.code !== 0) {
    throw new Error(`gh api ${contentsPath(repo, path)} failed: ${r.stderr.trim()}`);
  }
  const body = JSON.parse(r.stdout) as { sha: string; content?: string };
  const b64 = (body.content ?? "").replace(/\s+/g, "");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return { sha: body.sha, text: new TextDecoder().decode(bytes) };
}

/** `gh api -X PUT …/contents/<path>`: create or update one file in one commit. */
async function putFile(
  gh: GhRunner,
  token: string,
  repo: string,
  path: string,
  text: string,
  message: string,
  extra: { sha?: string; branch?: string } = {},
): Promise<void> {
  const args = [
    "api",
    "-X",
    "PUT",
    contentsPath(repo, path),
    "-f",
    `message=${message}`,
    "-f",
    `content=${encodeBase64(new TextEncoder().encode(text))}`,
  ];
  if (extra.sha) args.push("-f", `sha=${extra.sha}`);
  if (extra.branch) args.push("-f", `branch=${extra.branch}`);
  await must(gh, token, args);
}

/** Homebrew / Scoop: commit the file to the tap / bucket's default branch unless it is current. */
async function publishToRepo(
  plan: Extract<TargetPlan, { action: "publish" }>,
  gh: GhRunner,
  token: string,
): Promise<PublishOutcome> {
  let changed = false;
  for (const [path, text] of Object.entries(plan.files)) {
    const current = await currentFile(gh, token, plan.repo, path);
    if (current?.text === text) continue;
    await putFile(gh, token, plan.repo, path, text, plan.message, { sha: current?.sha });
    changed = true;
  }
  return changed ? "published" : "unchanged";
}

/**
 * winget: sync the fork with microsoft/winget-pkgs, put the version's manifests on a fresh branch
 * of it, and open the pull request (`New package:` the first time, `New version:` after).
 */
async function publishToWinget(
  plan: Extract<TargetPlan, { action: "publish" }>,
  gh: GhRunner,
  token: string,
): Promise<PublishOutcome> {
  const branch = plan.branch!;
  const versionDir = Object.keys(plan.files)[0].split("/").slice(0, -1).join("/");
  const version = versionDir.split("/").at(-1)!;
  // Already in winget-pkgs: nothing to submit.
  const merged = await gh(["api", contentsPath(WINGET_UPSTREAM, versionDir)], token);
  if (merged.code === 0) return "already-merged";
  if (!notFound(merged)) throw new Error(`gh api ${versionDir} failed: ${merged.stderr.trim()}`);
  const open = await must(gh, token, [
    "pr",
    "list",
    "--repo",
    WINGET_UPSTREAM,
    "--state",
    "open",
    "--head",
    branch,
    "--json",
    "url",
    "--jq",
    ".[].url",
  ]);
  if (open.trim()) return "pull-request-open";
  const pkg = await gh(["api", contentsPath(WINGET_UPSTREAM, WINGET_DIR)], token);
  if (pkg.code !== 0 && !notFound(pkg)) {
    throw new Error(`gh api ${WINGET_DIR} failed: ${pkg.stderr.trim()}`);
  }
  const title = commitMessage("winget", version, pkg.code !== 0);

  // The fork's default branch at microsoft/winget-pkgs' tip, then a branch of our own from it.
  await must(gh, token, [
    "api",
    "-X",
    "POST",
    `repos/${plan.repo}/merge-upstream`,
    "-f",
    "branch=master",
  ]);
  const base = (await must(gh, token, [
    "api",
    `repos/${plan.repo}/git/ref/heads/master`,
    "--jq",
    ".object.sha",
  ])).trim();
  // A branch left by an earlier, unfinished run is replaced (no pull request is open from it).
  await gh(["api", "-X", "DELETE", `repos/${plan.repo}/git/refs/heads/${branch}`], token);
  await must(gh, token, [
    "api",
    "-X",
    "POST",
    `repos/${plan.repo}/git/refs`,
    "-f",
    `ref=refs/heads/${branch}`,
    "-f",
    `sha=${base}`,
  ]);
  for (const [path, text] of Object.entries(plan.files)) {
    await putFile(gh, token, plan.repo, path, text, title, { branch });
  }
  const forkOwner = plan.repo.split("/")[0];
  await must(gh, token, [
    "pr",
    "create",
    "--repo",
    WINGET_UPSTREAM,
    "--base",
    "master",
    "--head",
    `${forkOwner}:${branch}`,
    "--title",
    title,
    "--body",
    `${title}\n\nManifests generated by denext's release workflow ` +
    `(https://github.com/Brainwires/denext/releases/tag/v${version}).`,
  ]);
  return "published";
}

/**
 * Carry out one plan. Never called for a skip.
 *
 * @param plan A `publish` plan from {@linkcode planPublish}.
 * @param gh The `gh` runner.
 * @param env Env reader the token comes from.
 * @returns What happened.
 */
export async function executePlan(
  plan: Extract<TargetPlan, { action: "publish" }>,
  gh: GhRunner,
  env: EnvGet,
): Promise<PublishOutcome> {
  const token = env(plan.secret);
  if (!token) throw new Error(`publish-package-manifests: ${plan.secret} is not set`);
  return plan.id === "winget"
    ? await publishToWinget(plan, gh, token)
    : await publishToRepo(plan, gh, token);
}

/** The line a plan prints: the dry-run's whole output, and each real run's heading. */
export function describePlan(plan: TargetPlan): string {
  const label = MANAGERS[plan.id].label;
  if (plan.action === "skip") return `${label}: skipped — ${plan.reason}`;
  const files = Object.keys(plan.files).join(", ");
  return plan.id === "winget"
    ? `${label}: pull request "${plan.message}" to ${WINGET_UPSTREAM} from ` +
      `${plan.repo}:${plan.branch} adding ${files}`
    : `${label}: commit "${plan.message}" to ${plan.repo} (${files})`;
}

/** Reads the manifests a plan may need from `dir` (missing ones are simply absent). */
export async function readManifests(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of Object.values(MANIFEST_FILES).flat()) {
    try {
      out[name] = await Deno.readTextFile(join(dir, name));
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  return out;
}

/** The options of {@linkcode run}. */
export interface RunOptions {
  readonly tag: string;
  readonly manifests: Readonly<Record<string, string>>;
  readonly env: EnvGet;
  readonly gh: GhRunner;
  readonly dryRun?: boolean;
  readonly log?: (line: string) => void;
}

/** A line as a GitHub Actions annotation under Actions, else as is. */
function annotate(env: EnvGet, kind: "notice" | "error", id: ManagerId, line: string): string {
  return env("GITHUB_ACTIONS") === "true" ? `::${kind} title=${MANAGERS[id].label}::${line}` : line;
}

/** Carry out one plan and log how it ended; returns whether it succeeded. */
async function runOne(plan: TargetPlan, options: RunOptions, log: (l: string) => void) {
  const line = describePlan(plan);
  if (plan.action === "skip") {
    log(annotate(options.env, "notice", plan.id, line));
    return true;
  }
  if (options.dryRun) {
    log(`[dry run] ${line}`);
    return true;
  }
  log(line);
  try {
    log(`${MANAGERS[plan.id].label}: ${await executePlan(plan, options.gh, options.env)}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const plain = options.env("GITHUB_ACTIONS") === "true" ? msg : `error: ${msg}`;
    log(annotate(options.env, "error", plan.id, plain));
    return false;
  }
}

/**
 * The whole run: plan, then (unless `dryRun`) publish each target, one failure not stopping the
 * others. Skips print as GitHub Actions notices under Actions.
 *
 * @returns Whether every publishing target succeeded (skips count as success).
 */
export async function run(options: RunOptions): Promise<boolean> {
  const log = options.log ?? console.log;
  let ok = true;
  for (const plan of planPublish(options.tag, options.env, options.manifests)) {
    if (!await runOne(plan, options, log)) ok = false;
  }
  return ok;
}

if (import.meta.main) {
  const arg = (name: string) => requiredArg(Deno.args, name, "publish-package-manifests");
  const ok = await run({
    tag: arg("version"),
    manifests: await readManifests(arg("dir")),
    env: (name) => Deno.env.get(name) || undefined,
    gh: runGh,
    dryRun: Deno.args.includes("--dry-run"),
  });
  if (!ok) Deno.exit(1);
}
