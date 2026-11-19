// `denext kernel-sandbox [status|check]` — the kernel sandbox's tooling.
//
// - `status`: which kernel features this machine has, what the sandbox does for the project
//   (the runtime's own `deno info --json` report), and a dry run of the `start` task's grant: the
//   runtime compiles the kernel policy for those flags on an empty program, so nothing of the app
//   runs. The same data backs `denext doctor`'s "kernel sandbox" line.
// - `check`: runs the app (the `start` task, or the command after `--`) with the sandbox in warn
//   mode and prints the grants to add before the run is enforced. Nothing is refused.
//
// Everything here runs the project's `deno`; the analysis is src/build/kernel-sandbox.ts.

import type { CommandContext, CommandSpec } from "../command.ts";
import { commandMeta } from "../command-meta.ts";
import { projectDir } from "../shared.ts";
import { denoExecutable } from "../../build/deno-executable.ts";
import { readProjectDenoJson } from "../../build/desktop-launch-policy.ts";
import {
  type CommandGrant,
  commandGrant,
  type DryRun,
  dryRunGrant,
  type GrantReport,
  grantReport,
  type KernelSandboxInfo,
  machineFeatures,
  readKernelSandbox,
  renderGrantReport,
  ROLLOUT_DEFAULTS,
  sandboxVerdict,
  warnRun,
} from "../../build/kernel-sandbox.ts";

const NO_REPORT =
  "this Deno reports no kernel sandbox (stock Deno, or a runtime before it): run on denext's " +
  "Deno toolchain (`denext toolchain install`)";

/** The project's task `name`, or null. */
async function taskCommand(dir: string, name: string): Promise<string | null> {
  const denoJson = await readProjectDenoJson(dir);
  const task = (denoJson?.tasks as Record<string, unknown> | undefined)?.[name];
  if (typeof task === "string") return task;
  const command = (task as { command?: unknown } | undefined)?.command;
  return typeof command === "string" ? command : null;
}

/** The machine, what applies, and the defaults at the runtime's stage. */
export function statusLines(info: KernelSandboxInfo): string[] {
  const column = info.stage;
  return [
    `  This machine (${info.capabilities.os}):`,
    ...machineFeatures(info).map((f) => `    ${f.present ? "✓" : "✗"} ${f.name}: ${f.detail}`),
    "",
    `  What applies: ${sandboxVerdict(info)}`,
    ...info.warnings.map((w) => `    note: ${w.replace(/^kernel sandbox: /, "")}`),
    "",
    `  Defaults at this runtime's stage (${column}), with no setting:`,
    ...ROLLOUT_DEFAULTS.map((row) =>
      `    ${row[column].padEnd(8)} ${row.context.replaceAll("`", "")}`
    ),
  ];
}

/** What `status` knows about the task's grant. */
export interface TaskGrant {
  readonly name: string;
  /** The task's command, or null when deno.json has no such task. */
  readonly command: string | null;
  readonly grant: CommandGrant | null;
  readonly dryRun: DryRun | null;
}

function flagsLine(grant: CommandGrant): string {
  return `    ${grant.flags.join(" ") || "(no permission flags)"}`;
}

/** The dry run's lines: the policy report, then whether enforce would start. */
function dryRunLines(grant: CommandGrant, dry: DryRun): string[] {
  const verdict = dry.startup.length
    ? `  ✗ enforce would refuse to start: ${dry.startup.length} rule(s) this machine's ` +
      "kernel can't hold (the `!` lines above). Change those grants, or keep this command " +
      "on warn."
    : "  ✓ every rule of this grant can be held here: enforce would start. Run " +
      "`denext kernel-sandbox check` to see what the app does under it.";
  return [
    flagsLine(grant),
    ...(grant.mode ? [`    its own mode: --kernel-sandbox=${grant.mode}`] : []),
    "",
    "  Dry run (the policy the kernel would get; nothing of the app ran):",
    "",
    ...dry.report.split("\n").map((l) => `    ${l}`),
    "",
    verdict,
  ];
}

/** Why a task has no dry run, or the dry run itself. */
function grantLines(task: TaskGrant): string[] {
  if (!task.command) {
    return [`    deno.json has no \`${task.name}\` task; name one with --task <name>`];
  }
  if (!task.grant) {
    return [
      "    it starts no `deno run` / `deno serve` itself, so its grant can't be read here; " +
      "run `denext kernel-sandbox check` to see what a real run needs",
    ];
  }
  if (task.grant.allowAll) {
    return [
      "    -A: every permission, so there is nothing for the kernel to hold and the sandbox " +
      "stays off for it. A scoped grant (--allow-read=…, --allow-net=…) is what it enforces.",
    ];
  }
  if (!task.dryRun) {
    return [
      flagsLine(task.grant),
      "    the dry run failed; run `denext kernel-sandbox check` instead",
    ];
  }
  return dryRunLines(task.grant, task.dryRun);
}

/** The task section of `status`. */
export function taskGrantLines(task: TaskGrant): string[] {
  return [`  The \`${task.name}\` task's grant:`, ...grantLines(task)];
}

/** Reads the task's grant and dry-runs it (no dry run for `-A`, or without a runtime report). */
async function readTaskGrant(
  dir: string,
  name: string,
  info: KernelSandboxInfo | null,
): Promise<TaskGrant> {
  const command = await taskCommand(dir, name);
  const grant = command ? commandGrant(command) : null;
  const runnable = info !== null && grant !== null && !grant.allowAll;
  const dryRun = runnable ? await dryRunGrant(denoExecutable(), dir, grant.flags) : null;
  return { name, command, grant, dryRun };
}

/** `denext kernel-sandbox status`. */
async function status(ctx: CommandContext, dir: string, taskName: string): Promise<void> {
  const info = await readKernelSandbox(denoExecutable(), dir);
  const task = await readTaskGrant(dir, taskName, info);
  if (ctx.global.json) {
    const { name, grant, dryRun } = task;
    console.log(JSON.stringify(
      {
        kernelSandbox: info,
        features: info ? machineFeatures(info) : [],
        verdict: info ? sandboxVerdict(info) : NO_REPORT,
        task: { name, grant, dryRun },
      },
      null,
      2,
    ));
    return;
  }
  console.log(`\n  denext kernel-sandbox  ▸  ${dir}\n`);
  if (!info) {
    console.log(`  ${NO_REPORT}\n`);
    Deno.exit(1);
  }
  console.log([...statusLines(info), "", ...taskGrantLines(task), ""].join("\n"));
}

/** What `check` prints after the run. */
export function checkLines(
  report: GrantReport,
  runs: number,
  observed: boolean,
  os: string,
): string[] {
  if (!runs) {
    return [
      "  No `deno` process of this run was in warn mode: each either has every permission " +
      "(-A: nothing to hold), isn't a `deno run` / `serve`, or sets its own " +
      "--kernel-sandbox flag, which wins over the check.",
      "",
    ];
  }
  const out = renderGrantReport(report, observed).map((l) => `  ${l}`);
  if (!observed) {
    const why = os === "linux"
      ? "Linux has no report-only mode for Landlock."
      : "no observer was applied.";
    out.push(
      "",
      `  This run could not see what native code and child processes do: ${why} To find ` +
        "those, run the command once with --kernel-sandbox=enforce where a failure is " +
        'harmless (a branch build, a staging host): a refused access fails with "refused by ' +
        'the kernel sandbox", and a failing child prints a hint.',
    );
  }
  out.push("");
  return out;
}

/** The command `check` runs: what follows `--`, else the task; null when there is neither. */
async function checkCommand(
  ctx: CommandContext,
  dir: string,
  task: string,
): Promise<readonly string[] | null> {
  if (ctx.rest.length) return ctx.rest;
  return (await taskCommand(dir, task)) ? [denoExecutable(), "task", task] : null;
}

/** Runs `command` in warn mode until it ends, Ctrl-C, or `seconds` pass. */
async function runChecked(command: readonly string[], dir: string, seconds: number) {
  const stopper = new AbortController();
  const timer = seconds > 0 ? setTimeout(() => stopper.abort(), seconds * 1000) : undefined;
  const onSignal = () => stopper.abort();
  Deno.addSignalListener("SIGINT", onSignal);
  try {
    return await warnRun(command, dir, stopper.signal);
  } finally {
    clearTimeout(timer);
    Deno.removeSignalListener("SIGINT", onSignal);
  }
}

function fail(message: string): never {
  console.error(`denext kernel-sandbox: ${message}`);
  Deno.exit(1);
}

/** `denext kernel-sandbox check [-- command…]`. */
async function check(ctx: CommandContext, dir: string, task: string): Promise<void> {
  const info = await readKernelSandbox(denoExecutable(), dir);
  if (!info) fail(NO_REPORT);
  const command = await checkCommand(ctx, dir, task);
  if (!command) fail(`deno.json has no \`${task}\` task; pass the command after \`--\``);
  const seconds = typeof ctx.flags.timeout === "number" ? ctx.flags.timeout : 0;
  const json = ctx.global.json;
  if (!json) {
    const until = seconds > 0 ? `, for ${seconds} s` : "; stop it with Ctrl-C when done";
    console.error(
      `denext kernel-sandbox: running \`${command.join(" ")}\` in warn mode (nothing is ` +
        `refused)${until}\n`,
    );
  }
  const result = await runChecked(command, dir, seconds);
  const report = grantReport(result.log.events);
  if (json) {
    const { code, observed, log } = result;
    console.log(JSON.stringify({ code, observed, runs: log.runs, ...report }, null, 2));
  } else {
    console.log(`\n  denext kernel-sandbox check  ▸  ${dir}\n`);
    const { runs } = result.log;
    console.log(checkLines(report, runs.length, result.observed, info.capabilities.os).join("\n"));
  }
  const found = report.changes.length + report.startup.length + report.ungrantable.length;
  if (found > 0) Deno.exit(1);
}

/** `denext kernel-sandbox`. */
export const kernelSandboxCommand: CommandSpec = {
  ...commandMeta("kernel-sandbox"),
  run: async (ctx) => {
    const action = ctx.positionals[0] ?? "status";
    const dir = projectDir({ ...ctx, positionals: ctx.positionals.slice(1) });
    const task = typeof ctx.flags.task === "string" ? ctx.flags.task : "start";
    if (action === "status") return await status(ctx, dir, task);
    if (action === "check") return await check(ctx, dir, task);
    console.error(`denext kernel-sandbox: unknown action "${action}" (status, check)`);
    Deno.exit(2);
  },
};
