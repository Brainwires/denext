// The release's publish half (step 6 of scripts/release.ts), resumable: publish
// `@denext/docs-corpus` <version> and wait for JSR to list it, then tag `v<version>` and push,
// wait for JSR to list `@denext/denext` <version>, then tag and push `auth-v<version>` (which pins
// that denext exactly) and wait for JSR to list `@denext/auth` <version>, and hand over the
// `development → main` PR. A release that stopped part-way — JSR slow to list the
// corpus, a network error, a closed terminal — is picked up where it stopped: run
// `deno task release <version>` again (it sees the release commit and the tags already made) or
// name the step with `--resume-from <step>`.

import {
  CORPUS_PACKAGE,
  corpusConflictMessage,
  corpusReleaseState,
} from "./docs-corpus-package.ts";
import { fromFileUrl, join } from "@std/path";
import { type Fetch, jsrHasVersion, type MemberPin, memberPin, missingPins } from "./jsr-pins.ts";

/** The publish steps, in order. `commit` is the release commit the earlier steps prepared. */
export const PUBLISH_STEPS = ["commit", "corpus", "tag", "push", "auth", "pr"] as const;

/** One publish step. */
export type PublishStep = (typeof PUBLISH_STEPS)[number];

/** A release that cannot go on; the message says why and how to resume. */
export class ReleaseAbort extends Error {}

/** What the publish steps run against: git, JSR and the clock (faked in tests). */
export interface PublishDeps {
  /** Run `git <args>`: its exit code and trimmed stdout. */
  git(...args: string[]): Promise<{ code: number; out: string }>;
  /** `fetch` for jsr.io. */
  fetch: Fetch;
  /** Wait `ms`. */
  sleep(ms: number): Promise<void>;
  /** The time, in ms. */
  now(): number;
  /** Progress output. */
  log(line: string): void;
  /** The repository root (the members' `deno.json` files). */
  root?: string;
  /** How long to wait for JSR to list the corpus (default {@linkcode JSR_WAIT_MS}). */
  jsrWaitMs?: number;
}

/**
 * How long the corpus step waits for JSR to list the version it pushed. publish.yml re-runs the
 * gate before it publishes, which takes about an hour on a busy queue; past this the release
 * stops with the command that resumes it.
 */
export const JSR_WAIT_MS = 3 * 60 * 60_000;

/** The first poll's delay, and the cap the backoff grows to. */
const FIRST_POLL_MS = 15_000;
const MAX_POLL_MS = 5 * 60_000;

/**
 * Poll `https://jsr.io/<name>/meta.json` until it lists exactly `version`, backing off from 15 s
 * to 5 minutes between polls. A failed request (JSR down, a network error) counts as "not yet".
 *
 * @param name The package.
 * @param version The exact version.
 * @param deps The fetch, clock and log.
 * @returns Whether JSR listed it before the deadline.
 */
export async function waitForJsrVersion(
  name: string,
  version: string,
  deps: Pick<PublishDeps, "fetch" | "sleep" | "now" | "log" | "jsrWaitMs">,
): Promise<boolean> {
  const deadline = deps.now() + (deps.jsrWaitMs ?? JSR_WAIT_MS);
  let delay = FIRST_POLL_MS;
  for (;;) {
    const listed = await jsrHasVersion(name, version, deps.fetch).catch((err: Error) => {
      deps.log(`   jsr.io could not be asked (${err.message}); retrying`);
      return false;
    });
    if (listed) return true;
    const left = deadline - deps.now();
    if (left <= 0) return false;
    const wait = Math.min(delay, left);
    deps.log(`   waiting for jsr.io to list ${name}@${version} (next check in ${wait / 1000}s)…`);
    await deps.sleep(wait);
    delay = Math.min(delay * 2, MAX_POLL_MS);
  }
}

/** What one release is: its version, its tag and the branch it is cut on. */
export interface ReleaseTarget {
  version: string;
  /** `v<version>`. */
  tag: string;
  branch: string;
}

/** Whether `tag` exists here, and on `origin`. */
async function tagState(
  tag: string,
  deps: PublishDeps,
): Promise<{ local: boolean; remote: boolean }> {
  const local = (await deps.git("tag", "--list", tag)).out === tag;
  const remote = (await deps.git("ls-remote", "--tags", "origin", `refs/tags/${tag}`)).out !== "";
  return { local, remote };
}

/**
 * The step a stopped release resumes from, or `null` when HEAD is not this release's commit and
 * no `v<version>` tag exists (a fresh release). `auth` once `v<version>` is on origin (it skips
 * what JSR and origin already have, so a finished release only re-checks JSR and hands over the
 * PR), `push` once it is made here, else `corpus` (which skips what JSR and origin already have).
 *
 * @param target The release.
 * @param deps Git.
 * @returns The step, or `null`.
 */
export async function detectResume(
  target: ReleaseTarget,
  deps: PublishDeps,
): Promise<PublishStep | null> {
  const tag = await tagState(target.tag, deps);
  if (tag.remote) return "auth";
  if (tag.local) return "push";
  const subject = (await deps.git("log", "-1", "--format=%s")).out;
  return subject === releaseSubject(target.version) ? "corpus" : null;
}

/** The release commit's subject. */
export function releaseSubject(version: string): string {
  return `release: denext ${version}`;
}

/** Parse `--resume-from <step>` (or `--resume-from=<step>`) out of `args`. */
export function resumeFromArg(args: readonly string[]): PublishStep | undefined {
  const i = args.findIndex((a) => a === "--resume-from" || a.startsWith("--resume-from="));
  if (i < 0) return undefined;
  const value = args[i].includes("=") ? args[i].split("=")[1] : args[i + 1];
  if (!PUBLISH_STEPS.includes(value as PublishStep)) {
    throw new ReleaseAbort(
      `--resume-from takes one of ${PUBLISH_STEPS.join(", ")} (got ${value ?? "nothing"})`,
    );
  }
  return value as PublishStep;
}

/** The command that resumes `target` at `step`. */
export function resumeCommand(target: ReleaseTarget, step: PublishStep): string {
  return `deno task release ${target.version} --confirm --resume-from ${step}`;
}

/** Run `git <args>`, aborting with `message` (and the resume command) when it fails. */
async function gitOrAbort(
  deps: PublishDeps,
  args: string[],
  message: string,
  resume: string,
): Promise<void> {
  if ((await deps.git(...args)).code !== 0) {
    throw new ReleaseAbort(`${message}. Fix it, then resume:\n  ${resume}`);
  }
}

/** The refusal for a release tag while `missing` members are unpublished, or null. */
export function pinRefusal(missing: readonly MemberPin[], tag: string): string | null {
  if (missing.length === 0) return null;
  const list = missing.map((p) => `  ${p.name}@${p.version} — push the tag ${p.tag}`).join("\n");
  return `refusing to tag ${tag}: it would pin package versions JSR does not have yet:\n${list}\n` +
    "Publish them first (publish.yml), wait until jsr.io lists them, then release again.";
}

/** The corpus's state on JSR for `version`; a conflict (or an unanswered JSR) aborts. */
async function corpusState(version: string, deps: PublishDeps): Promise<"missing" | "published"> {
  const corpus = await corpusReleaseState(version, deps.fetch).catch((err: Error) => {
    throw new ReleaseAbort(`could not check ${CORPUS_PACKAGE}: ${err.message}`);
  });
  if (corpus.state === "conflict") throw new ReleaseAbort(corpusConflictMessage(corpus));
  return corpus.state;
}

/**
 * The corpus step: unless JSR has `@denext/docs-corpus` <version> with this corpus, tag
 * `docs-corpus-v<version>` (unless it exists), push the branch and that tag, and wait for JSR to
 * list it — then check that what JSR serves is this tree's corpus.
 */
async function corpusStep(target: ReleaseTarget, deps: PublishDeps): Promise<void> {
  if (await corpusState(target.version, deps) === "published") {
    deps.log(`   ${CORPUS_PACKAGE}@${target.version} is on JSR with this corpus`);
    return;
  }
  const corpus = await memberPin("docs-corpus", deps.root);
  const resume = resumeCommand(target, "corpus");
  const tag = await tagState(corpus.tag, deps);
  deps.log(
    `   ${corpus.name}@${corpus.version} is not on JSR: publishing it first (${corpus.tag})`,
  );
  if (!tag.local) {
    const args = ["tag", "-a", corpus.tag, "-m", `${corpus.name} ${corpus.version}`];
    await gitOrAbort(deps, args, `git tag ${corpus.tag} failed`, resume);
  }
  await gitOrAbort(deps, ["push", "origin", target.branch], "git push (branch) failed", resume);
  if (!tag.remote) {
    await gitOrAbort(
      deps,
      ["push", "origin", corpus.tag],
      `git push (${corpus.tag}) failed`,
      resume,
    );
  }
  if (!await waitForJsrVersion(corpus.name, corpus.version, deps)) {
    throw new ReleaseAbort(
      `${corpus.tag} is pushed but jsr.io does not list ${corpus.name}@${corpus.version} yet ` +
        `(check publish.yml's run). The release commit is pushed; once JSR lists it, resume:\n` +
        `  ${resume}`,
    );
  }
  // Listed is not enough: what JSR serves must be this tree's corpus.
  await corpusState(target.version, deps);
}

/**
 * The tag step: refuse while a pinned member is not on JSR, or while `@denext/auth` is not in
 * lockstep (it would publish only after `v<version>` is out, too late to fix), else tag
 * `v<version>`.
 */
async function tagStep(target: ReleaseTarget, deps: PublishDeps): Promise<void> {
  const lockstep = await authLockstepRefusal(target.version, deps.root);
  if (lockstep) {
    throw new ReleaseAbort(
      `refusing to tag ${target.tag}: ${lockstep}.\n${target.tag} is not tagged, so ` +
        "denext is not published: fix packages/auth/deno.json and release again.",
    );
  }
  const refusal = pinRefusal(await missingPins(deps.fetch, deps.root), target.tag);
  if (refusal) {
    throw new ReleaseAbort(
      `${refusal}\n(the release commit is made; once they are published, resume:\n` +
        `  ${resumeCommand(target, "tag")})`,
    );
  }
  if ((await tagState(target.tag, deps)).local) return;
  const args = ["tag", "-a", target.tag, "-m", `denext ${target.version}`];
  await gitOrAbort(deps, args, "git tag failed", resumeCommand(target, "tag"));
}

/** The push step: the branch, then `v<version>` (which fires the JSR publish). */
async function pushStep(target: ReleaseTarget, deps: PublishDeps): Promise<void> {
  const resume = resumeCommand(target, "push");
  await gitOrAbort(deps, ["push", "origin", target.branch], "git push (branch) failed", resume);
  await gitOrAbort(deps, ["push", "origin", target.tag], "git push (tag) failed", resume);
}

/** The framework's JSR package, which `@denext/auth` pins exactly. */
const DENEXT_PACKAGE = "@denext/denext";

/** `@denext/auth`'s `packages/<dir>`: versioned with denext, and pinning it exactly. */
export const AUTH_DIR = "auth";

/**
 * Why `packages/auth/deno.json` cannot be published beside denext `version`, or `null`. The
 * package is released in lockstep: its version is denext's and it imports
 * `jsr:@denext/denext@<version>` exactly (scripts/bump-version.ts moves both), so `create` and
 * `migrate` can pin `@denext/auth` X.Y.Z beside denext X.Y.Z.
 *
 * @param version The denext release.
 * @param root The repository root (default: this checkout).
 */
export async function authLockstepRefusal(version: string, root?: string): Promise<string | null> {
  const dir = join(root ?? fromFileUrl(new URL("../../", import.meta.url)), "packages", AUTH_DIR);
  const json = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))) as {
    version?: string;
    imports?: Record<string, string>;
  };
  const pin = json.imports?.[DENEXT_PACKAGE];
  if (json.version !== version) {
    return `packages/auth/deno.json is at ${json.version}, not ${version}: @denext/auth is ` +
      "released in lockstep with denext (scripts/bump-version.ts moves it)";
  }
  if (pin !== `jsr:${DENEXT_PACKAGE}@${version}`) {
    return `packages/auth/deno.json maps ${DENEXT_PACKAGE} to ${pin ?? "nothing"}, not ` +
      `jsr:${DENEXT_PACKAGE}@${version}: @denext/auth pins the denext it ships with exactly`;
  }
  return null;
}

/**
 * The auth step: once JSR lists `@denext/denext` <version> (the `v<version>` publish), tag
 * `auth-v<version>` on the release commit (unless it exists), push it (unless origin has it) and
 * wait for JSR to list `@denext/auth` <version>. Denext goes first because auth pins it exactly:
 * an auth publish before denext's would fail to resolve its own dependency. Skipped when JSR
 * already lists that auth version.
 */
async function authStep(target: ReleaseTarget, deps: PublishDeps): Promise<void> {
  const resume = resumeCommand(target, "auth");
  const lockstep = await authLockstepRefusal(target.version, deps.root);
  if (lockstep) {
    throw new ReleaseAbort(`${lockstep}. Fix it in a new release; this one cannot ship auth.`);
  }
  const auth = await memberPin(AUTH_DIR, deps.root);
  const listed = await jsrHasVersion(auth.name, auth.version, deps.fetch).catch(() => false);
  if (listed) {
    deps.log(`   ${auth.name}@${auth.version} is on JSR`);
    return;
  }
  deps.log(`   waiting for ${DENEXT_PACKAGE}@${target.version} before ${auth.tag} (auth pins it)`);
  if (!await waitForJsrVersion(DENEXT_PACKAGE, target.version, deps)) {
    throw new ReleaseAbort(
      `${target.tag} is pushed but jsr.io does not list ${DENEXT_PACKAGE}@${target.version} yet ` +
        `(check publish.yml's run for ${target.tag}). ${auth.name} pins it exactly, so ` +
        `${auth.tag} waits. Once JSR lists it, resume:\n  ${resume}`,
    );
  }
  const tag = await tagState(auth.tag, deps);
  if (!tag.local) {
    const args = ["tag", "-a", auth.tag, "-m", `${auth.name} ${auth.version}`, `${target.tag}^{}`];
    await gitOrAbort(deps, args, `git tag ${auth.tag} failed`, resume);
  }
  if (!tag.remote) {
    await gitOrAbort(deps, ["push", "origin", auth.tag], `git push (${auth.tag}) failed`, resume);
  }
  if (!await waitForJsrVersion(auth.name, auth.version, deps)) {
    throw new ReleaseAbort(
      `${auth.tag} is pushed but jsr.io does not list ${auth.name}@${auth.version} yet ` +
        `(check publish.yml's run for ${auth.tag}; a failed run is re-run from the Actions ` +
        `page). Once JSR lists it, resume:\n  ${resume}`,
    );
  }
  deps.log(`   ${auth.name}@${auth.version} is on JSR`);
}

/** The PR step: what is left to do by hand. */
function prStep(target: ReleaseTarget, deps: PublishDeps): void {
  deps.log(
    `\n✓ Released ${target.version}: JSR lists @denext/denext and @denext/auth ` +
      `${target.version} (${target.tag} and auth-v${target.version}).\n` +
      "  REQUIRED next: open a PR so `main` catches up to this tag —\n" +
      `    gh pr create --base main --head ${target.branch}\n` +
      "  (every release tag gets a `development → main` PR; see AGENTS.md).\n" +
      "  Docs deploy is separate: run `deno task docs:build`, then rsync site/out/ " +
      "to your docs host.",
  );
}

/**
 * Run the publish steps from `from` to the end (`commit` is the caller's: this starts at
 * `corpus` either way). Every step is idempotent, so resuming at an earlier step than needed is
 * safe: a tag that exists is not made again, and one on origin is not pushed again.
 *
 * @param target The release.
 * @param from The first step to run.
 * @param deps Git, JSR and the clock.
 * @throws {ReleaseAbort} When a step cannot go on; the message names the resume command.
 */
export async function publishFrom(
  target: ReleaseTarget,
  from: PublishStep,
  deps: PublishDeps,
): Promise<void> {
  const start = Math.max(PUBLISH_STEPS.indexOf(from), PUBLISH_STEPS.indexOf("corpus"));
  for (const step of PUBLISH_STEPS.slice(start)) {
    if (step === "corpus") await corpusStep(target, deps);
    else if (step === "tag") await tagStep(target, deps);
    else if (step === "push") await pushStep(target, deps);
    else if (step === "auth") await authStep(target, deps);
    else prStep(target, deps);
  }
}

/** The real dependencies: git in `cwd`, the network, the clock and the console. */
export function realPublishDeps(cwd: string): PublishDeps {
  return {
    async git(...args) {
      const r = await new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "inherit" })
        .output();
      return { code: r.code, out: new TextDecoder().decode(r.stdout).trim() };
    },
    fetch: (url) => fetch(url),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (line) => console.log(line),
  };
}

/**
 * What a passed gate recorded (scripts/release.ts writes it when step 0's CI gate and step 5's
 * local gate both pass): the release, the commit CI was green on, and the tree the local gate
 * ran on — the tree the release commit must have.
 */
export interface GatePass {
  version: string;
  /** The commit step 0 found CI green on: HEAD before the release commit, its parent after. */
  base: string;
  /** The tree the local gate passed on (`git write-tree` of the prepared working tree). */
  tree: string;
}

/** The marker's file name, kept in the git directory so `git add -A` can never sweep it in. */
export function gateMarkerName(version: string): string {
  return `denext-release-gate-${version}.json`;
}

/** Record a passed gate at `path`. */
export async function writeGatePass(path: string, pass: GatePass): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(pass, null, 2) + "\n");
}

/** The gate pass recorded at `path`, or `null` when there is none (or it does not parse). */
export async function readGatePass(path: string): Promise<GatePass | null> {
  try {
    const value = JSON.parse(await Deno.readTextFile(path));
    const ok = typeof value?.version === "string" && typeof value?.base === "string" &&
      typeof value?.tree === "string";
    return ok ? value as GatePass : null;
  } catch {
    return null;
  }
}

/**
 * The refusal for publishing `current` (the release's base commit and tree as they are now)
 * without a matching gate pass, or `null` when `recorded` covers exactly that base and tree. A
 * resume never skips the gates: a release commit made by hand after a failed gate, a tree changed
 * since the gate, or a base CI never passed on all refuse here.
 *
 * @param recorded The marker {@linkcode readGatePass} found, or `null`.
 * @param current The base and tree the release would publish.
 * @param target The release.
 * @param step The step being resumed (named in the message).
 */
export function gateRefusal(
  recorded: GatePass | null,
  current: GatePass,
  target: ReleaseTarget,
  step: PublishStep,
): string | null {
  const regate = `deno task release ${target.version} --confirm --resume-from ${step} --regate`;
  const how =
    `Re-run both gates on this tree (CI on ${current.base.slice(0, 12)}, then the local ` +
    `gate) with:\n  ${regate}`;
  if (!recorded) {
    return `no passed gate is recorded for ${target.version}: refusing to publish a tree the CI ` +
      `and local gates never passed. ${how}`;
  }
  if (recorded.version !== target.version) {
    return `the recorded gate pass is for ${recorded.version}, not ${target.version}. ${how}`;
  }
  if (recorded.base !== current.base) {
    return `the gates passed on base ${recorded.base.slice(0, 12)}, but this release is cut on ` +
      `${current.base.slice(0, 12)}. ${how}`;
  }
  if (recorded.tree !== current.tree) {
    return `the tree changed since the gates passed (gated ${recorded.tree.slice(0, 12)}, now ` +
      `${current.tree.slice(0, 12)}). ${how}`;
  }
  return null;
}
