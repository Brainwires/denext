// The fake OS scheduler the `denext job install` tests run against: files, a crontab and Task
// Scheduler's task list in memory, every tool run recorded, so no test installs anything.

import * as hostPath from "@std/path";
import * as posixPath from "@std/path/posix";
import type {
  RunOptions,
  SchedulerHost,
  SchedulerTool,
  ToolResult,
} from "../src/cli/job-install/host.ts";
import { type InstallRequest, projectId } from "../src/cli/job-install/install.ts";

/** One recorded tool run. */
export interface Ran {
  readonly tool: SchedulerTool;
  readonly args: readonly string[];
  readonly stdin?: string;
}

/** An OS scheduler in memory: files, a crontab, Task Scheduler's task list. */
export class FakeHost implements SchedulerHost {
  readonly files = new Map<string, string | Uint8Array>();
  readonly dirs = new Set<string>();
  readonly ran: Ran[] = [];
  /** `null`: no `crontab` program. */
  crontab: string | null = "";
  systemdUser = true;
  systemdSystem = true;
  readonly tasks = new Set<string>();
  readonly uid = 501;

  constructor(
    readonly os: string,
    readonly home: string,
    private readonly vars: Record<string, string> = {},
  ) {}

  env(name: string): string | undefined {
    return this.vars[name];
  }
  readTextFile(path: string): Promise<string | null> {
    const data = this.files.get(path);
    return Promise.resolve(
      data === undefined ? null : typeof data === "string" ? data : new TextDecoder().decode(data),
    );
  }
  readDir(path: string): Promise<string[]> {
    // The simulated OS's paths, not this machine's: a darwin host on Windows still has `/Users`.
    const { basename, dirname } = this.os === "windows" ? hostPath : posixPath;
    return Promise.resolve(
      [...this.files.keys()].filter((p) => dirname(p) === path).map((p) => basename(p)).sort(),
    );
  }
  writeFile(path: string, data: string | Uint8Array): Promise<void> {
    this.files.set(path, data);
    return Promise.resolve();
  }
  ensureDir(path: string): Promise<void> {
    this.dirs.add(path);
    return Promise.resolve();
  }
  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }
  run(tool: SchedulerTool, args: readonly string[], options: RunOptions = {}): Promise<ToolResult> {
    this.ran.push({ tool, args, ...(options.stdin === undefined ? {} : { stdin: options.stdin }) });
    return Promise.resolve(this.answer(tool, args, options));
  }
  private answer(tool: SchedulerTool, args: readonly string[], options: RunOptions): ToolResult {
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (tool === "systemctl" && args.includes("show-environment")) {
      const up = args[0] === "--user" ? this.systemdUser : this.systemdSystem;
      return up ? ok() : { code: 1, stdout: "", stderr: "Failed to connect to bus" };
    }
    if (tool === "crontab") return this.crontabAnswer(args, options);
    if (tool === "schtasks") return this.schtasksAnswer(args);
    return ok();
  }
  private crontabAnswer(args: readonly string[], options: RunOptions): ToolResult {
    if (this.crontab === null) return { code: 127, stdout: "", stderr: "crontab: not found" };
    if (args[0] === "-") {
      this.crontab = options.stdin ?? "";
      return { code: 0, stdout: "", stderr: "" };
    }
    return this.crontab === ""
      ? { code: 1, stdout: "", stderr: "crontab: no crontab for u" }
      : { code: 0, stdout: this.crontab, stderr: "" };
  }
  private schtasksAnswer(args: readonly string[]): ToolResult {
    const name = args[args.indexOf("/TN") + 1];
    if (args[0] === "/Create") this.tasks.add(name);
    if (args[0] === "/Delete") this.tasks.delete(name);
    const listing = [...this.tasks].map((t) => `"${t}","N/A","Ready"`).join("\r\n");
    return { code: 0, stdout: args[0] === "/Query" ? listing : "SUCCESS", stderr: "" };
  }
  /** The runs that changed something. */
  changes(): Ran[] {
    return this.ran.filter((r) =>
      !(r.tool === "systemctl" && r.args.includes("show-environment")) &&
      !(r.tool === "crontab" && r.args[0] === "-l") &&
      !(r.tool === "schtasks" && r.args[0] === "/Query")
    );
  }
}

export const PROJECT = "/work/my app";
export const ID = await projectId(PROJECT);
export const OTHER_ID = await projectId("/work/other");

/** A request for the test project. */
export function request(over: Partial<InstallRequest> = {}): InstallRequest {
  return {
    project: { dir: PROJECT, id: ID, stateDir: `${PROJECT}/.denext` },
    scope: "user",
    mode: "install",
    names: [],
    schedules: [
      { cron: "0 3 * * *", job: "cleanup" },
      { cron: "*/15 * * * *", job: "reports/daily" },
    ],
    knownJobs: ["cleanup", "reports/daily", "manual"],
    denext: ["/Users/u/.denext/bin/denext"],
    offsets: [-360, -300],
    ...over,
  };
}
