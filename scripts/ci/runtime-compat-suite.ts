// The unit suite a runtime-compat leg runs (.github/workflows/runtime-compat.yml): the denext
// release's own `test:unit` pass, minus the test files of that release that assert facts about
// its bundled pin, the live channel or release-time state rather than how it runs on a runtime.
// Those fail on any candidate toolchain (a frozen release cannot be fixed), so the proof would
// never pass; each exclusion names why, and the current tests no longer have the problem.
//
//   deno run -A scripts/ci/runtime-compat-suite.ts <denext version> <app dir>
//       prints the `--ignore=` value for `scripts/test-run.ts` in <app dir>: its `test:unit`
//       task's own ignores, then the leg's exclusions that exist there
//
// The leg runs with DENEXT_TOOLCHAIN_PIN_FILE (the candidate), DENEXT_REVOCATION_CHECK=0 and
// DENEXT_RUNTIME_CHANNEL=0 (nothing reaches a live list), and its own DENEXT_RUNTIME_DEFAULT_FILE.

import { join } from "@std/path";

/** One excluded test file and why it can't prove anything about a runtime. */
export interface CompatExclusion {
  readonly file: string;
  readonly reason: string;
}

const CHANNEL_ENV =
  "reads the process's own environment, where the leg turns the channel off (fixed after 4.22: " +
  "its loads take an empty env)";
const PIN_FILE =
  "asserts the remembered resolution, which the leg's DENEXT_TOOLCHAIN_PIN_FILE overrides by " +
  "design (fixed after 4.22: the test sets the variable aside)";

/**
 * The exclusions per denext minor (`4.21`). A minor not listed runs its whole unit suite.
 */
export const RUNTIME_COMPAT_EXCLUDED: Readonly<Record<string, readonly CompatExclusion[]>> = {
  "4.20": [
    {
      file: "tests/spa-dev-self-write.test.ts",
      reason: "a same-content rewrite raced the watcher's hash (test race, fixed in ff0f12a87)",
    },
  ],
  "4.21": [
    {
      file: "tests/runtime-channel.test.ts",
      reason: "assumes the compiled-in channel floor is 0; the 4.21.0 release raised it " +
        "(fixed in 4.22: NO_FLOOR)",
    },
    {
      file: "tests/runtime-channel-script.test.ts",
      reason: "`floor` assumes the compiled-in channel floor is 0; the release raised it",
    },
    { file: "tests/runtime-select.test.ts", reason: PIN_FILE },
    {
      file: "tests/runtime-prune.test.ts",
      reason: "asserts the bundled pin's version against a cache the candidate pin replaces",
    },
    {
      file: "tests/spa-dev-self-write.test.ts",
      reason: "a same-content rewrite raced the watcher's hash (test race, fixed in ff0f12a87)",
    },
    {
      file: "tests/serial-tests.test.ts",
      reason: "the re-emit test assumes a coverage report that skips a clobbered emit, which a " +
        "runtime transpiling the module itself no longer does (test fixed in 1fdb2f6b1)",
    },
  ],
  "4.22": [
    { file: "tests/runtime-channel.test.ts", reason: CHANNEL_ENV },
    { file: "tests/runtime-select.test.ts", reason: PIN_FILE },
    {
      file: "tests/runtime-prune.test.ts",
      reason: "asserts the bundled pin's version against a cache the candidate pin replaces",
    },
    {
      file: "tests/desktop-sidecar-detached.test.ts",
      reason:
        "the first-attach deadline raced the child's import (test race, fixed in e945cc394), " +
        "and 4.22.0's child exited twice on a module that fails to load (fixed in 2b95a8bfd)",
    },
    {
      file: "tests/serial-tests.test.ts",
      reason: "the re-emit test assumes a coverage report that skips a clobbered emit, which a " +
        "runtime transpiling the module itself no longer does (test fixed in 1fdb2f6b1)",
    },
  ],
  "4.23": [
    {
      file: "tests/runtime-prune.test.ts",
      reason:
        "its real-CLI test's child inherits the leg's DENEXT_TOOLCHAIN_PIN_FILE while the test " +
        "asserts the bundled pin (fixed after 4.23: the child gets the variable blank)",
    },
  ],
};

/**
 * The exclusions for a denext release.
 *
 * @param version The release (`4.21.0`).
 * @returns Its minor's exclusions (none for a minor not listed).
 */
export function compatExclusions(version: string): readonly CompatExclusion[] {
  const m = /^(\d+)\.(\d+)\./.exec(version);
  if (!m) throw new Error(`not a denext version: ${version}`);
  return RUNTIME_COMPAT_EXCLUDED[`${m[1]}.${m[2]}`] ?? [];
}

/** The `--ignore=` value of a `test:unit` task (`deno run -A scripts/test-run.ts --ignore=a/,b/`). */
export function taskIgnore(task: string): string {
  const m = /^deno run -A scripts\/test-run\.ts --ignore=(\S+)$/.exec(task.trim());
  if (!m) {
    throw new Error(
      `test:unit is not \`deno run -A scripts/test-run.ts --ignore=…\` (${task}): update ` +
        "scripts/ci/runtime-compat-suite.ts and runtime-compat.yml for its new shape",
    );
  }
  return m[1];
}

/**
 * The `--ignore=` value a leg's unit pass runs with: the task's own, then each exclusion whose
 * file the release has.
 *
 * @param task The release's `test:unit` task.
 * @param exclusions Its exclusions.
 * @param has Whether the release has a file.
 * @returns The value.
 */
export function compatIgnore(
  task: string,
  exclusions: readonly CompatExclusion[],
  has: (file: string) => boolean,
): string {
  const extra = exclusions.map((e) => e.file).filter(has);
  return [taskIgnore(task), ...extra].join(",");
}

if (import.meta.main) {
  const [version, app] = Deno.args;
  if (!version || !app) {
    console.error("usage: runtime-compat-suite.ts <denext version> <app dir>");
    Deno.exit(2);
  }
  const config = JSON.parse(await Deno.readTextFile(join(app, "deno.json"))) as {
    tasks?: Record<string, string>;
  };
  const has = (file: string) => {
    try {
      return Deno.statSync(join(app, file)).isFile;
    } catch {
      return false;
    }
  };
  const exclusions = compatExclusions(version);
  for (const e of exclusions.filter((x) => has(x.file))) {
    console.error(`runtime-compat: denext ${version} leaves out ${e.file}: ${e.reason}`);
  }
  console.log(compatIgnore(config.tasks?.["test:unit"] ?? "", exclusions, has));
}
