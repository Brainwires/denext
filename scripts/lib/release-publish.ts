// The release's publish half (step 6 of scripts/release.ts), resumable: publish the members whose
// version is denext's (`@denext/docs-corpus`, `@denext/ui` and `@denext/migrate` <version>,
// SAME_VERSION_MEMBERS) and
// wait for JSR to list them, then tag `v<version>`, push, and hand over the `development → main`
// PR. A release that stopped part-way — JSR slow to list them, a network error, a closed
// terminal — is picked up where it stopped: run
// `deno task release <version>` again (it sees the release commit and the tags already made) or
// name the step with `--resume-from <step>`.

import {
  CORPUS_PACKAGE,
  corpusConflictMessage,
  corpusReleaseState,
} from "./docs-corpus-package.ts";
import {
  type Fetch,
  jsrHasVersion,
  type MemberPin,
  memberPin,
  missingPins,
  SAME_VERSION_MEMBERS,
} from "./jsr-pins.ts";

/**
 * The same-version members a release publishes once JSR does not list their version: all but
 * the docs corpus, which is also checked for content (`@denext/ui`, `@denext/migrate`).
 */
export const LISTED_MEMBERS: readonly string[] = SAME_VERSION_MEMBERS.filter((dir) =>
  dir !== "docs-corpus"
);

/**
 * The publish steps, in order. `commit` is the release commit the earlier steps prepared;
 * `corpus` publishes every same-version member (`@denext/docs-corpus`, `@denext/ui`,
 * `@denext/migrate`).
 */
export const PUBLISH_STEPS = ["commit", "corpus", "tag", "push", "pr"] as const;

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
 * no `v<version>` tag exists (a fresh release). `pr` once `v<version>` is on origin, `push` once
 * it is made here, else `corpus` (which skips what JSR and origin already have).
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
  if (tag.remote) return "pr";
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

/** Whether JSR lists `pin`; a JSR that cannot be asked aborts the release. */
async function listed(pin: MemberPin, deps: PublishDeps): Promise<boolean> {
  return await jsrHasVersion(pin.name, pin.version, deps.fetch).catch((err: Error) => {
    throw new ReleaseAbort(`could not check ${pin.name}: ${err.message}`);
  });
}

/** A listed member's pin, which must be at the release's version (the bump moves both). */
async function listedPin(
  dir: string,
  target: ReleaseTarget,
  deps: PublishDeps,
): Promise<MemberPin> {
  const pin = await memberPin(dir, deps.root);
  if (pin.version !== target.version) {
    throw new ReleaseAbort(
      `${pin.name} is at ${pin.version}, not ${target.version} — the bump moves both ` +
        "(scripts/bump-version.ts)",
    );
  }
  return pin;
}

/**
 * The same-version members this release must still publish: `@denext/docs-corpus` unless JSR has
 * <version> with this corpus (another corpus aborts), each of {@linkcode LISTED_MEMBERS} unless
 * JSR lists <version>.
 */
async function pendingMembers(target: ReleaseTarget, deps: PublishDeps): Promise<MemberPin[]> {
  const pending: MemberPin[] = [];
  if (await corpusState(target.version, deps) === "published") {
    deps.log(`   ${CORPUS_PACKAGE}@${target.version} is on JSR with this corpus`);
  } else pending.push(await memberPin("docs-corpus", deps.root));
  for (const dir of LISTED_MEMBERS) {
    const pin = await listedPin(dir, target, deps);
    if (await listed(pin, deps)) deps.log(`   ${pin.name}@${pin.version} is on JSR`);
    else pending.push(pin);
  }
  return pending;
}

/**
 * The corpus step: tag each same-version member JSR does not have yet (`docs-corpus-v<version>`,
 * `ui-v<version>`, `migrate-v<version>`, unless the tag exists), push the branch and those tags, and wait for JSR to
 * list every one — then check that the corpus JSR serves is this tree's. The tags are pushed
 * together, so their publish runs overlap instead of queueing one wait behind the other.
 */
async function corpusStep(target: ReleaseTarget, deps: PublishDeps): Promise<void> {
  const pending = await pendingMembers(target, deps);
  if (pending.length === 0) return;
  const resume = resumeCommand(target, "corpus");
  const tags: Array<{ pin: MemberPin; remote: boolean }> = [];
  for (const pin of pending) {
    deps.log(`   ${pin.name}@${pin.version} is not on JSR: publishing it first (${pin.tag})`);
    const tag = await tagState(pin.tag, deps);
    if (!tag.local) {
      const args = ["tag", "-a", pin.tag, "-m", `${pin.name} ${pin.version}`];
      await gitOrAbort(deps, args, `git tag ${pin.tag} failed`, resume);
    }
    tags.push({ pin, remote: tag.remote });
  }
  await gitOrAbort(deps, ["push", "origin", target.branch], "git push (branch) failed", resume);
  for (const { pin, remote } of tags) {
    if (remote) continue;
    await gitOrAbort(deps, ["push", "origin", pin.tag], `git push (${pin.tag}) failed`, resume);
  }
  for (const { pin } of tags) {
    if (!await waitForJsrVersion(pin.name, pin.version, deps)) {
      throw new ReleaseAbort(
        `${pin.tag} is pushed but jsr.io does not list ${pin.name}@${pin.version} yet ` +
          `(check publish.yml's run). The release commit is pushed; once JSR lists it, resume:\n` +
          `  ${resume}`,
      );
    }
  }
  // Listed is not enough for the corpus: what JSR serves must be this tree's corpus.
  if (pending.some((pin) => pin.name === CORPUS_PACKAGE)) await corpusState(target.version, deps);
}

/** The tag step: refuse while a pinned member is not on JSR, else tag `v<version>`. */
async function tagStep(target: ReleaseTarget, deps: PublishDeps): Promise<void> {
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

/** The PR step: what is left to do by hand. */
function prStep(target: ReleaseTarget, deps: PublishDeps): void {
  deps.log(
    `\n✓ Released ${target.version}. The ${target.tag} tag fires the JSR publish workflow ` +
      "(it re-runs the gate, then publishes).\n" +
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
