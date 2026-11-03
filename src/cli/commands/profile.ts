// `denext profile` — build the app unminified, serve it, drive headless Chromium, and
// report where startup/interaction time goes (CPU self-time by function) plus heap growth
// and a leak check. With `--budget` it gates: a regression exits non-zero (CI-usable).
// The heavy lifting is `src/profile/core.ts`, shared with the `denext_profile` MCP tool.
// `--android` profiles the installed app's WebView on a device over adb + remote CDP instead
// (`src/profile/android.ts`): nothing is built or served.

import type { CommandSpec } from "../command.ts";
import { projectDir } from "../shared.ts";
import { profileApp } from "../../profile/core.ts";
import { comparisonLines, profileReportLines } from "../../profile/report.ts";
import { type Budget, budgetFromRun } from "../../profile/budget.ts";
import { compareProfiles, isProfileResult, type ProfileComparison } from "../../profile/compare.ts";
import type { ProfileOptions, ProfileResult } from "../../profile/types.ts";
import { capacitorConfigFile, readCapacitorConfig } from "../../build/capacitor-config.ts";
import { commandMeta } from "../command-meta.ts";

/** Read the interaction script source, or undefined when no `--interact` was given. */
async function loadInteract(file: string): Promise<string | undefined> {
  if (!file) return undefined;
  try {
    return await Deno.readTextFile(file);
  } catch {
    throw new Error(`denext: --interact script not found: ${file}`);
  }
}

/** Read + parse a `--budget` file, or undefined when none was given. */
async function loadBudget(file: string): Promise<Budget | undefined> {
  if (!file) return undefined;
  try {
    return JSON.parse(await Deno.readTextFile(file)) as Budget;
  } catch (err) {
    throw new Error(`denext: could not read --budget ${file} — ${(err as Error).message}`);
  }
}

/** Read a saved run (`--out` / `--json` output) for `--compare`, or undefined when none. */
async function loadSaved(file: string): Promise<ProfileResult | undefined> {
  if (!file) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(file));
  } catch (err) {
    throw new Error(`denext: could not read --compare ${file} — ${(err as Error).message}`);
  }
  // `--json` output with a comparison nests the run under `result`.
  const run = (parsed as { result?: unknown })?.result ?? parsed;
  if (!isProfileResult(run)) {
    throw new Error(`denext: --compare ${file} is not a saved \`denext profile\` run`);
  }
  return run;
}

/**
 * What a run produces besides its report: the saved file (`--out`), the baseline budget
 * (`--write-budget`) and the comparison with a saved run (`--compare`).
 *
 * @param result The run.
 * @param opts The files named by the flags (empty ⇒ skipped) and the saved run.
 * @returns The comparison, when a saved run was given.
 */
export async function finishProfileRun(
  result: ProfileResult,
  opts: { out: string; writeBudget: string; saved?: ProfileResult },
): Promise<ProfileComparison | undefined> {
  if (opts.out) await Deno.writeTextFile(opts.out, JSON.stringify(result, null, 2) + "\n");
  if (opts.writeBudget) {
    const baseline = budgetFromRun(result.cpu, result.heap);
    await Deno.writeTextFile(opts.writeBudget, JSON.stringify(baseline, null, 2) + "\n");
  }
  return opts.saved ? compareProfiles(opts.saved, result) : undefined;
}

const num = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The run's options from the parsed flags (the `--interact` script and `--budget` read). */
async function profileOptions(flags: Record<string, unknown>): Promise<ProfileOptions> {
  return {
    route: str(flags.route) || "/",
    interact: await loadInteract(str(flags.interact)),
    iterations: num(flags.iterations, 1),
    samplingMicros: num(flags.sampling, 100),
    topN: num(flags.top, 20),
    minify: flags.minify === true,
    budget: await loadBudget(str(flags.budget)),
    filter: str(flags.filter) || undefined,
  };
}

/** The Capacitor config's `appId` in `dir`, the default `--package` of an `--android` run. */
export async function capacitorAppId(dir: string): Promise<string | undefined> {
  const file = await capacitorConfigFile(dir);
  if (!file) return undefined;
  const config = await readCapacitorConfig(file, await Deno.readTextFile(file)).catch(() => null);
  return typeof config?.appId === "string" ? config.appId : undefined;
}

/** Run the profile: on the Android device (`--android`), or built and served locally. */
async function runProfile(
  dir: string,
  flags: Record<string, unknown>,
  options: ProfileOptions,
): Promise<ProfileResult> {
  if (flags.android !== true) return await profileApp(dir, options);
  if (flags.minify === true) {
    throw new Error(
      "denext: --minify does not apply to --android (the app is profiled as installed).",
    );
  }
  const { profileAndroid } = await import("../../profile/android.ts");
  return await profileAndroid({
    ...options,
    serial: str(flags.device) || undefined,
    package: str(flags.package) || await capacitorAppId(dir),
  });
}

/** The terminal report: the run, the comparison, and the files written. */
function printRun(
  result: ProfileResult,
  comparison: ProfileComparison | undefined,
  files: { out: string; writeBudget: string },
  top: number,
): void {
  const lines = [
    ...profileReportLines(result),
    ...(comparison ? comparisonLines(comparison, top) : []),
  ];
  for (const line of lines) console.log(`  ${line}`);
  if (files.out) console.log(`\n  Saved the run → ${files.out}`);
  if (files.writeBudget) console.log(`\n  Wrote baseline budget → ${files.writeBudget}`);
  console.log();
}

export const profileCommand: CommandSpec = {
  ...commandMeta("profile"),
  run: async (ctx) => {
    const dir = projectDir(ctx);
    const options = await profileOptions(ctx.flags);
    const saved = await loadSaved(str(ctx.flags.compare));

    if (!ctx.global.json) console.log(`\n  denext profile  ▸  ${dir}  ${options.route}\n`);

    const result = await runProfile(dir, ctx.flags, options);
    const files = { out: str(ctx.flags.out), writeBudget: str(ctx.flags["write-budget"]) };
    const comparison = await finishProfileRun(result, { ...files, saved });

    if (ctx.global.json) {
      console.log(JSON.stringify(comparison ? { result, comparison } : result, null, 2));
    } else {
      printRun(result, comparison, files, options.topN ?? 20);
    }

    if (result.budget && !result.budget.passed) Deno.exit(1);
  },
};
