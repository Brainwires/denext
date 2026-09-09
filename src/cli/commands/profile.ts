// `denext profile` — build the app unminified, serve it, drive headless Chromium, and
// report where startup/interaction time goes (CPU self-time by function) plus heap growth
// and a leak check. With `--budget` it gates: a regression exits non-zero (CI-usable).
// The heavy lifting is `src/profile/core.ts`, shared with the `denext_profile` MCP tool.

import type { CommandSpec } from "../command.ts";
import { projectDir } from "../shared.ts";
import { profileApp } from "../../profile/core.ts";
import { profileReportLines } from "../../profile/report.ts";
import { type Budget, budgetFromRun } from "../../profile/budget.ts";

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

const num = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

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
  ],
  run: async (ctx) => {
    const dir = projectDir(ctx);
    const route = str(ctx.flags.route) || "/";
    const interact = await loadInteract(str(ctx.flags.interact));
    const budget = await loadBudget(str(ctx.flags.budget));

    if (!ctx.global.json) console.log(`\n  denext profile  ▸  ${dir}  ${route}\n`);

    const result = await profileApp(dir, {
      route,
      interact,
      iterations: num(ctx.flags.iterations, 1),
      samplingMicros: num(ctx.flags.sampling, 100),
      topN: num(ctx.flags.top, 20),
      minify: ctx.flags.minify === true,
      budget,
    });

    const writeBudget = str(ctx.flags["write-budget"]);
    if (writeBudget) {
      const baseline = budgetFromRun(result.cpu, result.heap);
      await Deno.writeTextFile(writeBudget, JSON.stringify(baseline, null, 2) + "\n");
    }

    if (ctx.global.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const line of profileReportLines(result)) console.log(`  ${line}`);
      if (writeBudget) console.log(`\n  Wrote baseline budget → ${writeBudget}`);
      console.log();
    }

    if (result.budget && !result.budget.passed) Deno.exit(1);
  },
};
