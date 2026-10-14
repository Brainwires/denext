// How much the publish workflow re-verifies a tagged commit before `deno publish`.
//
// ci.yml's heavy run already passed the full suite on the commit a release is cut from (the
// release script refuses otherwise, scripts/release-ci.ts), and repeating it costs the publish
// ~10 minutes. So:
//   - `ci`    the tagged commit itself has a green ci.yml heavy run: fmt + lint only.
//   - `delta` the tagged commit is the release script's own `release: denext <v>` commit and its
//             parent has a green heavy run: the release's delta gate (fmt, lint, types and
//             RELEASE_DELTA_TESTS — what the script ran before tagging).
//   - `full`  anything else (a plugin tag on an unchecked commit, a gh failure): the whole suite.
//
//   deno run -A scripts/publish-verify.ts [<sha>]   → prints the mode; with GITHUB_OUTPUT set,
//                                                      also writes `mode=<mode>` there.

import { RELEASE_DELTA_TESTS } from "./release.ts";
import { type CiVerdict, releaseCiVerdict } from "./release-ci.ts";

/** How much to verify: see the file header. */
export type VerifyMode = "ci" | "delta" | "full";

/** What the decision reads (tests pass fakes). */
export interface VerifyFacts {
  /** ci.yml's verdict on a commit. */
  verdict(sha: string): Promise<CiVerdict>;
  /** A commit's subject line and its first parent (`undefined` for a root commit). */
  commit(sha: string): Promise<{ subject: string; parent?: string }>;
}

/** The subject the release script commits a version with (scripts/release.ts, step 6). */
const RELEASE_SUBJECT = /^release: denext \d+\.\d+\.\d+(-[\w.]+)?$/;

/** Decide the mode for `sha`, with the reason. Any error decides `full`. */
export async function verifyMode(
  sha: string,
  facts: VerifyFacts,
): Promise<{ mode: VerifyMode; reason: string }> {
  try {
    const own = await facts.verdict(sha);
    if (own.ok) return { mode: "ci", reason: own.reason };
    const { subject, parent } = await facts.commit(sha);
    if (!RELEASE_SUBJECT.test(subject) || !parent) {
      return { mode: "full", reason: `${own.reason}; ${sha} is not a release commit` };
    }
    const base = await facts.verdict(parent);
    return base.ok
      ? { mode: "delta", reason: `release commit on a checked parent: ${base.reason}` }
      : { mode: "full", reason: `release commit, but ${base.reason}` };
  } catch (err) {
    return { mode: "full", reason: `could not ask CI (${(err as Error).message})` };
  }
}

/** The shell commands each mode runs (the publish workflow's verify step runs them in order). */
export function verifyCommands(mode: VerifyMode): string[] {
  const base = ["deno fmt --check", "deno lint"];
  if (mode === "ci") return base;
  if (mode === "delta") {
    return [
      ...base,
      "deno check cli.ts mod.ts",
      `deno run -A scripts/test-run.ts ${RELEASE_DELTA_TESTS.join(" ")}`,
    ];
  }
  return [
    ...base,
    "deno check cli.ts mod.ts",
    "deno run -A scripts/test-run.ts --ignore=tests/e2e/,tests/migration-bed/",
  ];
}

async function git(...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", { args, stdout: "piped", stderr: "piped" }).output();
  if (!out.success) {
    throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
  }
  return new TextDecoder().decode(out.stdout).trim();
}

const realFacts: VerifyFacts = {
  verdict: (sha) => releaseCiVerdict(sha),
  async commit(sha) {
    const subject = await git("log", "-1", "--format=%s", sha);
    const parent = (await git("log", "-1", "--format=%P", sha)).split(" ")[0] || undefined;
    return { subject, parent };
  },
};

if (import.meta.main) {
  // `gh run list --commit` matches a full SHA only.
  const sha = await git("rev-parse", `${Deno.args[0] ?? "HEAD"}^{commit}`);
  const { mode, reason } = await verifyMode(sha, realFacts);
  console.log(`verify mode: ${mode} — ${reason}`);
  const output = Deno.env.get("GITHUB_OUTPUT");
  if (output) {
    const commands = verifyCommands(mode).join(" && ");
    await Deno.writeTextFile(output, `mode=${mode}\ncommands=${commands}\n`, { append: true });
  }
}
