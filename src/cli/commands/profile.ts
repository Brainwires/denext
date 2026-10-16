// `denext profile` — build the app unminified, serve it, drive headless Chromium, and
// report where startup/interaction time goes (CPU self-time by function) plus heap growth
// and a leak check. With `--budget` it gates: a regression exits non-zero (CI-usable).
// The heavy lifting is `src/profile/core.ts`, shared with the `denext_profile` MCP tool.

import type { CommandSpec } from "../command.ts";
import { projectDir } from "../shared.ts";
import { profileApp } from "../../profile/core.ts";
import { comparisonLines, profileReportLines } from "../../profile/report.ts";
import { type Budget, budgetFromRun } from "../../profile/budget.ts";
import { compareProfiles, isProfileResult, type ProfileComparison } from "../../profile/compare.ts";
import type { ProfileOptions, ProfileResult } from "../../profile/types.ts";

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
  name: "profile",
  summary: "Profile CPU self-time + heap for a route (with an optional budget gate)",
  loadsModules: true,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  flags: [
    { name: "route", type: "string", valueName: "<path>", default: "/", help: "Route to profile" },
    {
      name: "interact",
      type: "string",
      valueName: "<file>",
      help: "JS file evaluated in the page to exercise it each iteration",
    },
    { name: "iterations", type: "number", default: 1, help: "Repeat the interaction N times" },
    { name: "sampling", type: "number", default: 100, help: "CPU sampling interval (µs)" },
    { name: "top", type: "number", default: 20, help: "Max self-time rows to show" },
    {
      name: "budget",
      type: "string",
      valueName: "<file>",
      help: "Fail (exit 1) if the run exceeds this recorded budget",
    },
    {
      name: "write-budget",
      type: "string",
      valueName: "<file>",
      help: "Write the current run as a baseline budget file",
    },
    { name: "minify", type: "boolean", help: "Profile a minified build (default: unminified)" },
    {
      name: "filter",
      type: "string",
      valueName: "<text>",
      help: "Show only functions whose name or source contains this (a component, module, package)",
    },
    {
      name: "out",
      type: "string",
      valueName: "<file>",
      help: "Save the run as JSON (to --compare a later run against)",
    },
    {
      name: "compare",
      type: "string",
      valueName: "<file>",
      help: "Compare with a run saved by --out: CPU, heap and per-function deltas",
    },
  ],
  run: async (ctx) => {
    const dir = projectDir(ctx);
    const options = await profileOptions(ctx.flags);
    const saved = await loadSaved(str(ctx.flags.compare));

    if (!ctx.global.json) console.log(`\n  denext profile  ▸  ${dir}  ${options.route}\n`);

    const result = await profileApp(dir, options);
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
