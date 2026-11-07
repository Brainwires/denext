// `denext job install [<name>...] [--dry-run] [--uninstall] [--user | --system]`: the project's
// scheduled jobs as OS scheduler entries (src/cli/job-install/). Reached from `denext job`, which
// hands over when its first positional is `install`.

import { fromFileUrl, join, resolve } from "@std/path";
import type { CommandContext } from "../command.ts";
import { resolveProject } from "../../build/paths.ts";
import { discoverJobs } from "../../server/job-loader.ts";
import { collectSchedules, jobNames } from "../../server/jobs.ts";
import { runtimeStateDir } from "../../server/standalone.ts";
import {
  dryRunHost,
  type DryRunStep,
  realSchedulerHost,
  type SchedulerHost,
} from "../job-install/host.ts";
import {
  denextCommand,
  type InstallReport,
  type InstallRequest,
  projectId,
  runJobInstall,
} from "../job-install/install.ts";
import type { InstallScope } from "../job-install/spec.ts";
import { formatOffset, zoneOffsets } from "../job-install/translate.ts";

/** What the verb runs against (tests pass a fake host and fixed offsets). */
export interface JobInstallDeps {
  readonly host?: SchedulerHost;
  readonly offsets?: readonly number[];
  readonly denext?: { readonly argv: readonly string[]; readonly warning?: string };
}

/** `--user` (the default) or `--system`, or an error when both are given. */
function scopeOf(ctx: CommandContext): InstallScope {
  if (ctx.flags.user === true && ctx.flags.system === true) {
    throw new Error("denext job install: pass --user or --system, not both");
  }
  return ctx.flags.system === true ? "system" : "user";
}

/** The command entries run denext with, here. */
function thisDenext(): { argv: string[]; warning?: string } {
  return denextCommand({
    os: Deno.build.os,
    env: (name) => {
      try {
        return Deno.env.get(name);
      } catch {
        return undefined;
      }
    },
    // Read here, not through ../self-exec.ts: `job.ts` imports this module, and a compiled app's
    // binary runs `job`, so self-exec's toolchain imports would put the build pipeline in it.
    standalone: (Deno.build as { standalone?: boolean }).standalone === true,
    execPath: Deno.execPath(),
    cliModule: cliModuleArg(new URL("../../../cli.ts", import.meta.url).href),
  });
}

/** The CLI module a scheduler entry runs: a path for a local checkout, else the module URL. */
function cliModuleArg(moduleUrl: string): string {
  return moduleUrl.startsWith("file://") ? fromFileUrl(moduleUrl) : moduleUrl;
}

/** A dry run's steps, as a reader (or a shell) takes them. */
function printSteps(steps: readonly DryRunStep[]): void {
  for (const step of steps) {
    if (step.kind === "write") console.log(`# write ${step.path}\n${step.content.trimEnd()}\n`);
    else if (step.kind === "mkdir") console.log(`mkdir -p ${step.path}`);
    else if (step.kind === "remove") console.log(`rm ${step.path}`);
    else {
      console.log(`${step.tool} ${step.args.join(" ")}`);
      if (step.stdin !== undefined) console.log(`# (stdin)\n${step.stdin.trimEnd()}\n`);
    }
  }
}

/** The summary of a run. */
function printReport(report: InstallReport, dryRun: boolean, offsets: readonly number[]): void {
  const verb = dryRun ? "would " : "";
  for (const r of report.removed) console.log(`${verb}remove ${r.slug} (${r.backend})`);
  for (const e of report.installed) {
    const guard = e.guarded
      ? ` — local time moves (UTC${offsets.map(formatOffset).join(", UTC")}), so it fires at ` +
        `every candidate time and runs only in a minute the UTC schedule matches`
      : "";
    console.log(`${verb}install ${e.job}: ${e.crons.join("; ")} UTC (${report.backend})${guard}`);
  }
  if (report.installed.length === 0 && report.removed.length === 0) {
    console.log(
      report.backend ? "No scheduled jobs to install." : "Nothing of this project's to remove.",
    );
  }
}

/** The request for this project, read from the command line and the project. */
async function requestFor(
  ctx: CommandContext,
  denext: readonly string[],
  offsets: readonly number[],
): Promise<InstallRequest> {
  const uninstall = ctx.flags.uninstall === true;
  const paths = await resolveProject(resolve(ctx.global.cwd ?? "."));
  const dir = await Deno.realPath(paths.projectDir);
  // An uninstall needs no job module: the entry of a job since deleted is removed by name.
  if (!uninstall) await discoverJobs(join(paths.projectDir, "jobs"));
  return {
    project: { dir, id: await projectId(dir), stateDir: resolve(runtimeStateDir(paths.outDir)) },
    scope: scopeOf(ctx),
    mode: uninstall ? "uninstall" : "install",
    names: ctx.positionals.slice(1),
    schedules: uninstall ? [] : collectSchedules(paths.config?.scheduledJobs ?? {}),
    knownJobs: uninstall ? [] : jobNames(),
    denext,
    offsets,
  };
}

/** Prints what a run did: JSON with `--json`, else the warnings, a dry run's steps and a summary. */
function printOutcome(
  ctx: CommandContext,
  outcome: { report: InstallReport; steps: DryRunStep[]; dryRun: boolean; warning?: string },
  offsets: readonly number[],
): void {
  const { report, steps, dryRun, warning } = outcome;
  if (ctx.global.json) {
    console.log(JSON.stringify({ ...report, ...(dryRun ? { steps } : {}) }, null, 2));
    return;
  }
  if (warning && report.installed.length > 0) console.error(`denext: ${warning}`);
  for (const note of report.warnings) console.error(`denext: ${note}`);
  if (dryRun) printSteps(steps);
  printReport(report, dryRun, offsets);
}

/**
 * Run `denext job install`.
 *
 * @param ctx The parsed command line (`positionals[0]` is `install`).
 * @param deps The host, zone offsets and denext command (defaults: this machine).
 * @returns The exit code.
 */
export async function jobInstallVerb(
  ctx: CommandContext,
  deps: JobInstallDeps = {},
): Promise<number> {
  try {
    const dryRun = ctx.flags["dry-run"] === true;
    const denext = deps.denext ?? thisDenext();
    const offsets = deps.offsets ?? zoneOffsets();
    const req = await requestFor(ctx, denext.argv, offsets);
    const steps: DryRunStep[] = [];
    const base = deps.host ?? realSchedulerHost();
    const report = await runJobInstall(req, dryRun ? dryRunHost(base, steps) : base);
    printOutcome(ctx, { report, steps, dryRun, warning: denext.warning }, offsets);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
