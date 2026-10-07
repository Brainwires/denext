// `denext upgrade` — bump the project's denext pin, the CLI tasks pinned to it and every
// first-party `@denext/*` package together, to versions whose compatibility ranges agree.
// The planning lives in `src/build/upgrade.ts`; this file reads and writes `deno.json`.

import { join } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import {
  applyUpgrade,
  jsrLookups,
  planUpgrade,
  type UpgradeLookups,
  type UpgradePlan,
  type UpgradeStep,
} from "../../build/upgrade.ts";
import { projectDir } from "../shared.ts";

/** The project config `upgrade` edits: `deno.json`, else `deno.jsonc`. */
async function configPath(dir: string): Promise<string | null> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const path = join(dir, name);
    try {
      if ((await Deno.stat(path)).isFile) return path;
    } catch { /* try the next */ }
  }
  return null;
}

/** The steps as aligned `name  from → to` lines (unchanged ones say so). */
function describeSteps(steps: readonly UpgradeStep[]): string {
  const width = Math.max(...steps.map((s) => s.name.length));
  return steps.map((s) =>
    `  ${s.name.padEnd(width)}  ${
      s.from === s.to ? `${s.from} (up to date)` : `${s.from} → ${s.to}`
    }`
  ).join("\n");
}

/**
 * Run `denext upgrade` against `dir`: plan, then print / check / write.
 *
 * @param ctx The invocation (`--dry-run`, `--check`, `--to`, global `--json`).
 * @param lookups The registry lookups (JSR; injected by tests).
 * @returns The process exit code.
 */
export async function runUpgrade(
  ctx: CommandContext,
  lookups: UpgradeLookups = jsrLookups(),
): Promise<number> {
  const dir = projectDir(ctx);
  const path = await configPath(dir);
  if (!path) {
    console.error(`denext upgrade: no deno.json in ${dir}`);
    return 1;
  }
  const text = await Deno.readTextFile(path);
  const to = typeof ctx.flags.to === "string" ? ctx.flags.to.replace(/^v/, "") : undefined;
  const plan = await planUpgrade(text, { to }, lookups);
  const check = ctx.flags.check === true;
  const write = !check && ctx.flags["dry-run"] !== true;
  const written = plan.ok && plan.changed && write;
  if (written) await Deno.writeTextFile(path, applyUpgrade(text, plan.steps));
  if (ctx.global.json) console.log(JSON.stringify({ config: path, ...plan, written }));
  else report(plan, path, check, written);
  if (!plan.ok) return 1;
  return check && plan.changed ? 1 : 0;
}

/** The human output: the steps, then what happened to the file (or why nothing could). */
function report(plan: UpgradePlan, path: string, check: boolean, written: boolean): void {
  if (!plan.ok) {
    console.error(`denext upgrade: ${plan.reason}`);
    return;
  }
  console.log(describeSteps(plan.steps));
  if (!plan.changed) console.log("\nEverything is up to date.");
  else if (written) {
    console.log(
      `\nUpdated ${path}. The next \`deno task\` (or \`deno install\`) refreshes deno.lock.`,
    );
  } else console.log(`\n${check ? "Out of date" : "Dry run"} — ${path} was not changed.`);
}

/** `denext upgrade [dir]`. */
export const upgradeCommand: CommandSpec = {
  name: "upgrade",
  summary: "Bump denext, its CLI tasks and the first-party @denext/* packages together",
  usage: "Reads every jsr:@denext/* pin in deno.json (the import map and the `deno task`s that\n" +
    "run the CLI) and moves them to the newest versions that work together: the newest denext\n" +
    "every pinned first-party package has a compatible version for (each package's own\n" +
    "@denext/denext range, from src/plugin/catalog.json or its published deno.json on JSR).\n" +
    "Nothing moves backwards; each pin keeps its ^ / ~ / exact operator. --to picks the denext\n" +
    "version; --dry-run prints the plan; --check exits 1 when anything is out of date.",
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  flags: [
    { name: "dry-run", type: "boolean", help: "Print the plan without writing deno.json" },
    {
      name: "check",
      type: "boolean",
      help: "Write nothing; exit 1 when an upgrade is available (for CI)",
    },
    {
      name: "to",
      type: "string",
      valueName: "<version>",
      help: "The denext version to move to (default: the newest every package supports)",
    },
  ],
  run: async (ctx) => {
    const code = await runUpgrade(ctx);
    if (code !== 0) Deno.exit(code);
  },
};
