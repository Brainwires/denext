// The shapes every `denext job install` backend shares: one job's entry, the project it belongs
// to, and the marker that tells denext's entries apart from everything else the scheduler holds.

import * as hostPath from "@std/path";
import * as posixPath from "@std/path/posix";
import type { SchedulerHost } from "./host.ts";
import type { TranslatedSchedule } from "./translate.ts";

/**
 * The path functions for the scheduler's OS: POSIX for launchd, systemd and cron (a plist or a
 * unit names `/Users/u/...` whichever machine renders it), the host's own for Task Scheduler,
 * which only runs on Windows.
 *
 * @param os The scheduler host's OS (`darwin`, `linux`, `windows`, ...).
 */
export function pathsFor(os: string): {
  join(...paths: string[]): string;
  dirname(path: string): string;
} {
  return os === "windows" ? hostPath : posixPath;
}

/** `user`: the logged-in user's scheduler. `system`: the machine's, run as the installing user. */
export type InstallScope = "user" | "system";

/** The OS schedulers denext writes to. */
export type BackendName = "launchd" | "systemd" | "crontab" | "schtasks";

/** The project the entries belong to. */
export interface ProjectRef {
  /** The project directory (absolute): every entry runs there. */
  readonly dir: string;
  /** A fingerprint of `dir`, in every entry's name and marker. */
  readonly id: string;
  /** Where denext keeps state (`.denext`): the job logs live under it. */
  readonly stateDir: string;
}

/** One job's scheduler entry. */
export interface EntrySpec {
  /** The job's name (`reports/daily`). */
  readonly job: string;
  /** The name as the entry's file / task name spells it. */
  readonly slug: string;
  /** Its cron expressions, as written (UTC). */
  readonly crons: readonly string[];
  /** When the entry fires, in the backend's calendar. */
  readonly schedule: TranslatedSchedule;
  /** The command the entry runs (absolute program first). */
  readonly argv: readonly string[];
  /** Where the run's output goes (launchd, cron). */
  readonly logFile: string;
}

/** What a backend needs besides the entries. */
export interface BackendContext {
  readonly project: ProjectRef;
  readonly scope: InstallScope;
  /** The account a `system` entry runs as. */
  readonly runAs?: string;
}

/** One OS scheduler. */
export interface Backend {
  readonly name: BackendName;
  /** `utc`: the scheduler takes a UTC calendar; `local`: the machine's local time. */
  readonly clock: "utc" | "local";
  /**
   * Throws a `ScheduleTranslationError` when the scheduler can't hold the entry's schedule
   * (too many calendar entries or triggers), before anything is changed.
   */
  validate(entry: EntrySpec): void;
  /** Whether the scheduler can be used here, in this scope. */
  available(host: SchedulerHost, ctx: BackendContext): Promise<boolean>;
  /** The slugs of this project's entries the scheduler holds. */
  list(host: SchedulerHost, ctx: BackendContext): Promise<string[]>;
  /** Installs the entries, replacing any of this project's with the same slug. */
  install(host: SchedulerHost, ctx: BackendContext, entries: readonly EntrySpec[]): Promise<void>;
  /** Removes this project's entries with these slugs. */
  remove(host: SchedulerHost, ctx: BackendContext, slugs: readonly string[]): Promise<void>;
}

/** The marker every entry carries: `denext-managed project=<id> job=<slug>`. */
export function marker(projectId: string, slug: string): string {
  return `denext-managed project=${projectId} job=${slug}`;
}

/** The slug an entry's text marks it with for `projectId`, or `null` when it isn't ours. */
export function markedSlug(text: string, projectId: string): string | null {
  const match = /denext-managed project=([0-9a-f]+) job=([A-Za-z0-9_-]+)/.exec(text);
  return match && match[1] === projectId ? match[2] : null;
}

/** Throws with the tool's own message when a run that had to work did not. */
export function check(
  result: { code: number; stderr: string; stdout: string },
  what: string,
): void {
  if (result.code === 0) return;
  const detail = (result.stderr || result.stdout).trim();
  throw new Error(`denext: ${what} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`);
}

/** `text` escaped for XML character data and attribute values. */
export function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Two digits. */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
