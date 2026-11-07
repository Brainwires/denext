// `denext job install` / `--uninstall`: the project's scheduled jobs as OS scheduler entries
// that run `denext job <name>` in the project directory — launchd on macOS, a systemd user timer
// on Linux (the user's crontab where no systemd user manager runs), Task Scheduler on Windows.
//
// Every entry carries denext's marker and the project's id (a fingerprint of its directory), so a
// re-install replaces this project's entries and an uninstall removes only them. Everything is
// planned (and every schedule translated) before the first change, so a schedule the scheduler
// can't express stops the command with nothing changed.

import { join } from "@std/path";
import { cronError } from "../../runtime/cron.ts";
import { fnv1a } from "../../server/jobs.ts";
import { crontabBackend } from "./crontab.ts";
import type { SchedulerHost } from "./host.ts";
import { launchdBackend } from "./launchd.ts";
import { schtasksBackend } from "./schtasks.ts";
import type {
  Backend,
  BackendContext,
  BackendName,
  EntrySpec,
  InstallScope,
  ProjectRef,
} from "./spec.ts";
import { systemdBackend } from "./systemd.ts";
import { DUE_SEPARATOR, ScheduleTranslationError, translateSchedules } from "./translate.ts";

/** One (cron, job) pairing, as `collectSchedules` gives them. */
export interface ScheduledPair {
  readonly cron: string;
  readonly job: string;
}

/** What to install or remove. */
export interface InstallRequest {
  readonly project: ProjectRef;
  readonly scope: InstallScope;
  /** `uninstall` removes; `install` installs and removes this project's stale entries. */
  readonly mode: "install" | "uninstall";
  /** Only these jobs (every scheduled job when empty). */
  readonly names: readonly string[];
  /** Every (cron, job) pairing the project schedules (install only). */
  readonly schedules: readonly ScheduledPair[];
  /** Every job the project defines (install only). */
  readonly knownJobs: readonly string[];
  /** The command that runs denext (absolute program first). */
  readonly denext: readonly string[];
  /** Every offset from UTC the local zone takes, in minutes. */
  readonly offsets: readonly number[];
}

/** What a run did (or, in a dry run, would do). */
export interface InstallReport {
  /** The scheduler the entries went to (`null` for an uninstall). */
  readonly backend: BackendName | null;
  readonly installed: readonly {
    readonly job: string;
    readonly slug: string;
    readonly crons: readonly string[];
    readonly guarded: boolean;
  }[];
  readonly removed: readonly { readonly backend: BackendName; readonly slug: string }[];
  /** Notes worth printing (a config schedule naming a job that doesn't exist). */
  readonly warnings: readonly string[];
}

/** The schedulers to consider, in order of preference. */
function candidates(os: string, scope: InstallScope): Backend[] {
  if (os === "darwin") return [launchdBackend];
  if (os === "windows") return [schtasksBackend];
  if (os === "linux") return scope === "user" ? [systemdBackend, crontabBackend] : [systemdBackend];
  return [];
}

/**
 * A job's name as entry names spell it: `[A-Za-z0-9_-]` only, with a fingerprint of the name when
 * it had to change (`reports/daily` → `reports-daily-1a2b3c`), so two names never share a slug.
 */
export function jobSlug(name: string): string {
  const plain = name.replace(/[^A-Za-z0-9_-]+/g, "-");
  return plain === name ? name : `${plain}-${fnv1a(name).slice(0, 6)}`;
}

/** The project's id: the first 12 hex digits of the SHA-256 of its directory. */
export async function projectId(dir: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(dir));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
    .slice(0, 12);
}

/** The account a `system` entry runs as: whoever ran the install (through `sudo` too). */
function runAsFor(host: SchedulerHost, scope: InstallScope): string | undefined {
  if (scope !== "system" || host.os === "windows") return undefined;
  const user = host.env("SUDO_USER") || host.env("USER");
  if (!user) throw new Error("denext: --system needs $USER (or $SUDO_USER) to name the account");
  return user;
}

/** Each job's crons, in the order the schedule lists them. */
function cronsByJob(schedules: readonly ScheduledPair[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { cron, job } of schedules) {
    const list = out.get(job) ?? [];
    if (!list.includes(cron)) list.push(cron);
    out.set(job, list);
  }
  return out;
}

/** Why each named job can't be installed: it doesn't exist, or has no schedule. */
function nameErrors(req: InstallRequest, byJob: Map<string, string[]>): string[] {
  const known = new Set(req.knownJobs);
  return req.names.flatMap((name) => {
    if (!known.has(name)) return [`no job "${name}" (known: ${req.knownJobs.join(", ")})`];
    return byJob.has(name) ? [] : [`job "${name}" has no schedule`];
  });
}

/** The jobs to install with their crons, or the reasons it can't be done. */
function selectJobs(
  req: InstallRequest,
  warnings: string[],
): { jobs: [string, string[]][]; errors: string[] } {
  const known = new Set(req.knownJobs);
  const byJob = cronsByJob(req.schedules);
  const errors = nameErrors(req, byJob);
  const wanted = req.names.length > 0 ? new Set(req.names) : null;
  const jobs: [string, string[]][] = [];
  for (const [job, crons] of byJob) {
    if (wanted && !wanted.has(job)) continue;
    if (!known.has(job)) {
      warnings.push(`scheduledJobs names "${job}", which is not defined (skipped)`);
      continue;
    }
    errors.push(...crons.flatMap((cron) => {
      const err = cronError(cron);
      return err ? [`job "${job}": ${err}`] : [];
    }));
    jobs.push([job, crons]);
  }
  return { jobs: jobs.sort(([a], [b]) => a.localeCompare(b)), errors };
}

/** One job's entry for `backend`. */
function entryFor(req: InstallRequest, backend: Backend, job: string, crons: string[]): EntrySpec {
  const offsets = backend.clock === "utc" ? [0] : req.offsets;
  const schedule = translateSchedules(crons, offsets);
  const slug = jobSlug(job);
  return {
    job,
    slug,
    crons,
    schedule,
    argv: [
      ...req.denext,
      "job",
      job,
      ...(schedule.guarded ? ["--if-due", crons.join(DUE_SEPARATOR)] : []),
    ],
    logFile: join(req.project.stateDir, "logs", "jobs", `${slug}.log`),
  };
}

/** Every entry to install, or one error naming every job that can't be. */
function planEntries(req: InstallRequest, backend: Backend, warnings: string[]): EntrySpec[] {
  const { jobs, errors } = selectJobs(req, warnings);
  const entries: EntrySpec[] = [];
  for (const [job, crons] of jobs) {
    try {
      const entry = entryFor(req, backend, job, crons);
      backend.validate(entry);
      entries.push(entry);
    } catch (err) {
      if (!(err instanceof ScheduleTranslationError)) throw err;
      errors.push(`job "${job}" (${backend.name}): ${err.message}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`denext job install: nothing changed.\n  ${errors.join("\n  ")}`);
  }
  return entries;
}

/**
 * Install (or remove) the project's scheduled jobs on `host`'s scheduler.
 *
 * @param req What to do.
 * @param host The machine (a dry-run or fake host changes nothing).
 * @returns What was done.
 */
export async function runJobInstall(
  req: InstallRequest,
  host: SchedulerHost,
): Promise<InstallReport> {
  const ctx: BackendContext = {
    project: req.project,
    scope: req.scope,
    runAs: runAsFor(host, req.scope),
  };
  const backends: Backend[] = [];
  for (const b of candidates(host.os, req.scope)) {
    if (await b.available(host, ctx)) backends.push(b);
  }
  if (backends.length === 0) {
    throw new Error(
      `denext job install: no ${req.scope} scheduler here (${host.os}): launchd on macOS, a ` +
        `systemd${req.scope === "user" ? " user manager or crontab" : ""} on Linux, ` +
        `Task Scheduler on Windows.`,
    );
  }
  const warnings: string[] = [];
  const primary = backends[0];
  const entries = req.mode === "install" ? planEntries(req, primary, warnings) : [];
  const filter = req.names.length > 0 ? new Set(req.names.map(jobSlug)) : null;
  const replacing = new Set(entries.map((e) => e.slug));
  const removed: { backend: BackendName; slug: string }[] = [];
  for (const backend of backends) {
    const stale = (await backend.list(host, ctx)).filter((slug) =>
      (!filter || filter.has(slug)) && !(backend === primary && replacing.has(slug))
    );
    await backend.remove(host, ctx, stale);
    removed.push(...stale.map((slug) => ({ backend: backend.name, slug })));
  }
  if (entries.length > 0) await primary.install(host, ctx, entries);
  return {
    backend: req.mode === "install" ? primary.name : null,
    installed: entries.map((e) => ({
      job: e.job,
      slug: e.slug,
      crons: e.crons,
      guarded: e.schedule.guarded,
    })),
    removed,
    warnings,
  };
}

/** Whether a path is a file (the default for {@linkcode denextCommand}). */
function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/** Where {@linkcode denextCommand} looks, and what it falls back to. */
export interface DenextCommandEnv {
  readonly os: string;
  readonly env: (name: string) => string | undefined;
  /** This process is the compiled `denext` binary. */
  readonly standalone: boolean;
  /** This process's executable. */
  readonly execPath: string;
  /** The CLI module this process runs (`cli.ts`), for the `deno run` fallback. */
  readonly cliModule: string;
  readonly isFile?: (path: string) => boolean;
}

/**
 * The command an entry runs denext with: the compiled binary this process is, else the one the
 * installer put in `$DENEXT_INSTALL/bin` (`~/.denext/bin`), else this Deno running the CLI module
 * (with a warning: that Deno may be a toolchain version a later upgrade prunes).
 *
 * @returns The command, and a warning when it is the fallback.
 */
export function denextCommand(e: DenextCommandEnv): { argv: string[]; warning?: string } {
  if (e.standalone) return { argv: [e.execPath] };
  const home = e.env("HOME") ?? e.env("USERPROFILE");
  const install = e.env("DENEXT_INSTALL") || (home ? join(home, ".denext") : null);
  const bin = install ? join(install, "bin", e.os === "windows" ? "denext.exe" : "denext") : null;
  if (bin && (e.isFile ?? isFile)(bin)) return { argv: [bin] };
  return {
    argv: [e.execPath, "run", "-A", e.cliModule],
    warning: `no installed denext binary at ${bin ?? "$DENEXT_INSTALL/bin"}; the entries run ` +
      `${e.execPath} on ${e.cliModule} (install denext with its installer for a stable path)`,
  };
}
