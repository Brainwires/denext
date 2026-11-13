// Coverage sharding: ci.yml's coverage gate runs the suite in N parallel jobs (`coverage-shard`)
// whose raw profiles one final job (`coverage`) merges and reports exactly as the unsharded run did
// (`deno task coverage:report`: the same threshold, includes, excludes, floors and ratchet).
//
//   deno run -A scripts/test-run.ts --coverage=<dir> --shard=<i>/<n> ...   # one shard's files
//   deno run --allow-read scripts/ci/coverage-shards.ts --plan <n>          # each shard's estimate
//   deno run --allow-read --allow-write=scripts/ci scripts/ci/coverage-shards.ts --update <log>...
//
// The files are split by their measured duration under coverage (`coverage-durations.json`, one
// sequential coverage pass's per-file seconds), longest first, each to the shard with the least
// time so far (LPT), so the shards finish together. A file the table doesn't list (a new one)
// counts the table's mean. Some files are pinned to shard 1: the ones that need what only shard 1's
// runner has (the docker pool's own Docker daemon, `PINNED_TO_FIRST`). The Vitest files run in a
// pass of their own, so they all go to the last shard, whose stock files are planned around their
// total. The plan depends only on the file list, the table and N, so every shard computes the same
// split and the shards cover each file exactly once.
//
// `--update` rewrites the table from coverage job logs as GitHub stores them, each line stamped
// (`gh run view <run> --log --job <id> > shard.log` for every `coverage-shard` job, or one
// unsharded coverage job's): within one sequential pass a file's time is from its `running N tests
// from ./<file>` line to the next one (or the pass's `ok | ...` / `FAILED | ...` summary). Refresh
// it when the shard jobs' times drift apart (the merge job prints each shard's planned time).
//
// Test files are found as `deno test` finds them (its `is_supported_test_path`): a name ending in
// `_test` / `.test` (or `test` itself) with a script extension, outside `.git/`, `node_modules/` and
// the given ignores.

import { walk } from "@std/fs/walk";
import { fromFileUrl, join, relative } from "@std/path";

/** The table of per-file seconds under coverage, repo-relative paths. */
export const DURATIONS_FILE = fromFileUrl(new URL("./coverage-durations.json", import.meta.url));

/** The files only shard 1 runs: they need its runner's Docker daemon (the docker pool). */
export const PINNED_TO_FIRST: readonly string[] = ["tests/integration/stack-ops-docker.test.ts"];

/** The file-name suffix of a Vitest file (scripts/test-run.ts's `VITEST_SUFFIX`). */
const VITEST_SUFFIX = ".vitest.ts";

/** `deno test`'s test-file rule: the stem ends in `_test` / `.test` or is `test`; a script extension. */
const TEST_FILE = /(?:^|[_.])test\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Whether `file` is `entry` or lies under it (a directory, with or without its trailing `/`). */
export function covers(entry: string, file: string): boolean {
  const e = entry.replace(/^\.\//, "").replace(/\/$/, "");
  return e === "" || e === "." || file === e || file.startsWith(`${e}/`);
}

/** One shard of N (`i` from 1). */
export interface ShardSpec {
  readonly index: number;
  readonly count: number;
}

/**
 * `--shard=<i>/<n>`'s value, or null when it is malformed (`i` from 1 to `n`).
 *
 * @param value The value after `=`.
 */
export function parseShard(value: string): ShardSpec | null {
  const m = /^(\d+)\/(\d+)$/.exec(value);
  if (!m) return null;
  const index = Number(m[1]);
  const count = Number(m[2]);
  return index >= 1 && index <= count ? { index, count } : null;
}

/**
 * Every test file `deno test` would find under `root` (repo-relative, `/`-separated, sorted), the
 * stock and the Vitest ones, outside `ignores` (as `--ignore` entries are written).
 *
 * @param root The repository root.
 * @param ignores Directories / files to leave out.
 */
export async function discoverTestFiles(
  root: string,
  ignores: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  // An ignored directory is never entered (coverage/ holds a run's hundreds of thousands of
  // profiles); an ignored file is dropped below.
  const escape = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const skip = [
    /[/\\](?:\.git|node_modules)(?:[/\\]|$)/,
    ...ignores.filter((i) => i.endsWith("/")).map((i) =>
      new RegExp(
        `^${escape(join(root, i.replace(/^\.\//, "")).replace(/[/\\]+$/, ""))}(?:[/\\\\]|$)`,
      )
    ),
  ];
  for await (const e of walk(root, { includeDirs: false, skip })) {
    const file = relative(root, e.path).replaceAll("\\", "/");
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (!TEST_FILE.test(name) && !name.endsWith(VITEST_SUFFIX)) continue;
    if (ignores.some((i) => covers(i, file))) continue;
    out.push(file);
  }
  return out.sort();
}

/** One shard's planned files and seconds. */
export interface PlannedShard {
  readonly files: string[];
  seconds: number;
}

/**
 * The files split into `count` shards (see the module header): pinned files on shard 1, the Vitest
 * files on the last, the rest longest first onto the shard with the least time (ties: the lower
 * shard; equal durations: path order).
 *
 * @param files Every file to run (stock and Vitest).
 * @param durations Seconds per file; a file not listed counts the mean.
 * @param count How many shards.
 * @param pinned The files shard 1 must run.
 */
export function planShards(
  files: readonly string[],
  durations: Readonly<Record<string, number>>,
  count: number,
  pinned: readonly string[] = PINNED_TO_FIRST,
): PlannedShard[] {
  const known = Object.values(durations).filter((s) => Number.isFinite(s) && s >= 0);
  const mean = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const cost = (f: string) => durations[f] ?? mean;
  const shards: PlannedShard[] = Array.from({ length: count }, () => ({ files: [], seconds: 0 }));
  const add = (s: PlannedShard, f: string) => {
    s.files.push(f);
    s.seconds += cost(f);
  };
  const rest: string[] = [];
  for (const f of files) {
    if (pinned.includes(f)) add(shards[0], f);
    else if (f.endsWith(VITEST_SUFFIX)) add(shards[count - 1], f);
    else rest.push(f);
  }
  rest.sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const f of rest) {
    let least = shards[0];
    for (const s of shards) if (s.seconds < least.seconds) least = s;
    add(least, f);
  }
  for (const s of shards) s.files.sort();
  return shards;
}

/** The table of per-file seconds (empty when it can't be read). */
export async function readDurations(
  path: string = DURATIONS_FILE,
): Promise<Record<string, number>> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as Record<string, number>;
  } catch {
    return {};
  }
}

/** A coverage log line's timestamp (GitHub's log prefix), or null. */
const STAMP = /(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) /;
const START = /running \d+ tests? from \.\/(\S+)/;
const END = /(?:^|\s)(?:ok|FAILED) \| \d+ passed/;

/**
 * Per-file seconds from a coverage log whose lines carry GitHub's timestamps: within each
 * sequential pass, a file's time runs from its `running … from` line to the next such line or the
 * pass's summary line. A file seen twice (two logs) keeps its larger time.
 *
 * @param log The log's text.
 */
export function fileDurations(log: string): Record<string, number> {
  const out: Record<string, number> = {};
  let open: { file: string; at: number } | null = null;
  for (const line of log.split("\n")) {
    const stamp = STAMP.exec(line);
    if (!stamp) continue;
    const start = START.exec(line);
    if (!start && !END.test(line)) continue;
    const at = Date.parse(stamp[1]);
    if (open) {
      const s = Math.round((at - open.at) / 100) / 10;
      out[open.file] = Math.max(out[open.file] ?? 0, s);
    }
    open = start ? { file: start[1], at } : null;
  }
  return out;
}

/** `table` as the file writes it: sorted by path, one entry per line. */
export function formatDurations(table: Readonly<Record<string, number>>): string {
  const keys = Object.keys(table).sort();
  return `{\n${keys.map((k) => `  ${JSON.stringify(k)}: ${table[k]}`).join(",\n")}\n}\n`;
}

/** The ignores of `deno task test:coverage` (deno.json) plus the tool caches test-run adds. */
export const COVERAGE_IGNORES: readonly string[] = [
  "tests/e2e/",
  "tests/migration-bed/",
  ".deno/",
  ".denext/",
  "coverage/",
];

if (import.meta.main) {
  const root = fromFileUrl(new URL("../../", import.meta.url));
  const [verb, ...rest] = Deno.args;
  if (verb === "--update" && rest.length > 0) {
    const merged: Record<string, number> = {};
    for (const path of rest) {
      for (const [f, s] of Object.entries(fileDurations(await Deno.readTextFile(path)))) {
        merged[f] = Math.max(merged[f] ?? 0, s);
      }
    }
    await Deno.writeTextFile(DURATIONS_FILE, formatDurations(merged));
    console.log(`coverage-shards: ${Object.keys(merged).length} files → ${DURATIONS_FILE}`);
  } else if (verb === "--plan" && rest.length === 1 && Number(rest[0]) >= 1) {
    const files = await discoverTestFiles(root, COVERAGE_IGNORES);
    const plan = planShards(files, await readDurations(), Number(rest[0]));
    plan.forEach((s, i) =>
      console.log(
        `shard ${i + 1}/${plan.length}: ${s.files.length} files, ${
          (s.seconds / 60).toFixed(1)
        } min`,
      )
    );
  } else {
    console.error(
      "usage: coverage-shards.ts --plan <n> | --update <coverage log>...  (see the header)",
    );
    Deno.exit(2);
  }
}
