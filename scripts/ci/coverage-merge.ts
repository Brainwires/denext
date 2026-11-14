// The coverage gate's merge: the `coverage-shard` jobs' raw profiles become one profile directory
// that `deno task coverage:report` reports on exactly as on an unsharded run's (the threshold, the
// lcov the floors and the ratchet read, the same includes and excludes).
//
//   deno run -A scripts/ci/coverage-merge.ts <shards dir> <profile dir>
//
// `<shards dir>` holds one directory per shard, each with what `deno task test:coverage:shard`
// left: `profile/` (the raw profiles) and `profile.shard.json` (scripts/test-run.ts's
// `ShardRecord`: the shard, the shard count, its checkout's root URL and the files it ran). The merge
// refuses unless every shard of the count is there once and each ran exactly the files the plan
// gives it over THIS checkout (scripts/ci/coverage-shards.ts), so no test file went unrun and none
// ran twice. A profile names its module by absolute `file:` URL, and a shard on another runner image
// checks out elsewhere (our pool's `/home/runner/actions-runner/_work/…`, GitHub's
// `/home/runner/work/…`): its root is rewritten to this checkout's. Then every covered module is
// re-emitted under this checkout's `deno.json` (`deno coverage` reads a module's transpiled source
// from this machine's emit cache; scripts/test-run.ts's `reEmitCovered`, which the shards skip).
// It prints each shard's planned time: when the shard jobs' own times drift apart from it, refresh
// coverage-durations.json from their logs (`coverage-shards.ts --update`).

import { fromFileUrl, join } from "@std/path";
import {
  COVERAGE_IGNORES,
  discoverTestFiles,
  planShards,
  readDurations,
} from "./coverage-shards.ts";
import {
  checkoutEmitDir,
  copyTransformedEmits,
  reEmitCovered,
  type ShardRecord,
  stockPassDeno,
  toolchainDeno,
  transformedEmitsDir,
} from "../test-run.ts";

/** One shard as found in the shards directory. */
export interface FoundShard {
  /** Its directory. */
  readonly dir: string;
  readonly record: ShardRecord;
}

/**
 * Why `shards` can't be merged over a checkout whose plan is `plan` (each shard's files), or null
 * when they can: every index of the count present once, all with that count, each with its planned
 * files.
 *
 * @param shards The shards found.
 * @param plan The files each shard should have run, by index - 1.
 */
export function mergeProblem(
  shards: readonly FoundShard[],
  plan: readonly (readonly string[])[],
): string | null {
  const counts = new Set(shards.map((s) => s.record.count));
  if (counts.size !== 1 || !counts.has(plan.length)) {
    return `the shards were planned for ${
      [...counts].join(", ") || "no"
    } shard(s), not ${plan.length}`;
  }
  for (let i = 1; i <= plan.length; i++) {
    const found = shards.filter((s) => s.record.index === i);
    if (found.length !== 1) return `shard ${i}/${plan.length}: found ${found.length} times`;
    const ran = found[0].record.files;
    const want = plan[i - 1];
    const missing = want.filter((f) => !ran.includes(f));
    const extra = ran.filter((f) => !want.includes(f));
    if (missing.length || extra.length) {
      return `shard ${i}/${plan.length} ran other files than this checkout plans ` +
        `(missing: ${missing.slice(0, 5).join(", ") || "none"}; extra: ${
          extra.slice(0, 5).join(", ") || "none"
        }): the shards and the merge must check out the same commit`;
    }
  }
  return null;
}

/**
 * A raw profile's text with the module URLs under `from` moved under `to` (both `file:` URLs
 * ending in `/`). Only the URLs change: the offsets are into the module's source, which is the same
 * file in either checkout.
 *
 * @param text The profile JSON.
 * @param from The shard's root.
 * @param to This checkout's root.
 */
export function rebaseProfile(text: string, from: string, to: string): string {
  return from === to ? text : text.replaceAll(JSON.stringify(from).slice(1, -1), to);
}

/** Every shard under `shardsDir` (a directory with a `profile.shard.json`). */
export async function findShards(shardsDir: string): Promise<FoundShard[]> {
  const out: FoundShard[] = [];
  for await (const e of Deno.readDir(shardsDir)) {
    if (!e.isDirectory) continue;
    const dir = join(shardsDir, e.name);
    try {
      const record = JSON.parse(
        await Deno.readTextFile(join(dir, "profile.shard.json")),
      ) as ShardRecord;
      out.push({ dir, record });
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  return out.sort((a, b) => a.record.index - b.record.index);
}

/**
 * Move every shard's profiles into `outDir`, rebased onto `root` (see {@linkcode rebaseProfile}).
 * Each file keeps its name behind its shard's index (profile names are UUIDs; the prefix only makes
 * a clash impossible).
 *
 * @returns How many profiles were moved.
 */
export async function gatherProfiles(
  shards: readonly FoundShard[],
  outDir: string,
  root: string,
): Promise<number> {
  await Deno.mkdir(outDir, { recursive: true });
  let n = 0;
  for (const { dir, record } of shards) {
    const from = join(dir, "profile");
    for await (const e of Deno.readDir(from)) {
      if (!e.isFile || !e.name.endsWith(".json")) continue;
      const src = join(from, e.name);
      const dest = join(outDir, `s${record.index}-${e.name}`);
      if (record.root === root) await Deno.rename(src, dest);
      else {
        await Deno.writeTextFile(
          dest,
          rebaseProfile(await Deno.readTextFile(src), record.root, root),
        );
        await Deno.remove(src);
      }
      n++;
    }
  }
  return n;
}

if (import.meta.main) {
  const [shardsDir, outDir] = Deno.args;
  if (!shardsDir || !outDir) {
    console.error("usage: coverage-merge.ts <shards dir> <profile dir>");
    Deno.exit(2);
  }
  const rootPath = new URL("../../", import.meta.url);
  const root = rootPath.href;
  const shards = await findShards(shardsDir);
  const count = shards[0]?.record.count ?? 0;
  const durations = await readDurations();
  const plan = count > 0
    ? planShards(await discoverTestFiles(fromFileUrl(rootPath), COVERAGE_IGNORES), durations, count)
    : [];
  const problem = shards.length === 0
    ? `no shard under ${shardsDir}`
    : mergeProblem(shards, plan.map((s) => s.files));
  if (problem) {
    console.error(`coverage-merge: ${problem}`);
    Deno.exit(1);
  }
  plan.forEach((s, i) =>
    console.log(
      `shard ${i + 1}/${count}: ${s.files.length} files, planned ${
        (s.seconds / 60).toFixed(1)
      } min`,
    )
  );
  await Deno.remove(outDir, { recursive: true }).catch(() => {});
  const moved = await gatherProfiles(shards, outDir, root);
  console.log(`coverage-merge: ${moved} profiles from ${shards.length} shards → ${outDir}`);
  const bin = stockPassDeno(await toolchainDeno(), Deno.execPath());
  const emitted = await reEmitCovered(outDir, { bin, tempDir: await Deno.makeTempDir() });
  console.log(`coverage-merge: re-emitted ${emitted} covered modules`);
  // The Vitest pass's profiles map through its transformed emits (scripts/test-run.ts's
  // transformedEmitsDir): each shard's go into this machine's emit cache, under this checkout.
  const emitDir = await checkoutEmitDir(bin, fromFileUrl(rootPath));
  if (emitDir === null) throw new Error("coverage-merge: `deno info --json` named no emit cache");
  let transformed = 0;
  for (const { dir } of shards) {
    transformed += await copyTransformedEmits(transformedEmitsDir(join(dir, "profile")), emitDir);
  }
  console.log(`coverage-merge: ${transformed} Vitest-transformed emits restored`);
}
