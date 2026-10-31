// An in-memory `Host` for examples/hangar's tests: files, processes, `qemu-img` and QMP sockets are
// all fakes, so no test reads ~/VMs, starts QEMU, signals a process or opens a socket.

import { dirname } from "@std/path";
import type {
  DirEntry,
  Host,
  ProcessInfo,
  QmpSession,
  RunResult,
} from "../../examples/hangar/lib/host.ts";

/** One fake process. */
export interface FakeProcess extends ProcessInfo {
  /** Its working directory (`null`: unreadable). */
  cwd: string | null;
}

/** What a fake QMP socket does with each command. */
type QmpHandler = (command: string) => unknown;

/** The fake machine; every interaction is recorded for the assertions. */
export class FakeHost implements Host {
  readonly home = "/home/u";
  os = "darwin";
  files = new Map<string, string>();
  dirs = new Set<string>(["/home/u"]);
  /** Symlinks: path → target. */
  links = new Map<string, string>();
  processList: FakeProcess[] = [];
  qmpSockets = new Map<string, QmpHandler>();
  /** Answers `run` (default: success, empty output). */
  onRun: (program: string, args: readonly string[]) => RunResult = () => ({
    code: 0,
    stdout: "",
    stderr: "",
  });
  runs: { program: string; args: string[] }[] = [];
  spawns: { program: string; args: string[]; cwd: string; env?: Record<string, string> }[] = [];
  kills: { pid: number; signal: string }[] = [];
  /** Whether a SIGTERM ends the process. */
  termKills = true;
  /** Files read (to prove what was never read). */
  reads: string[] = [];
  memory = 32 * 1024 ** 3;
  slept = 0;

  /** Add a file (and its parent folders). */
  file(path: string, text = ""): this {
    this.files.set(path, text);
    for (let d = dirname(path); d !== "/" && !this.dirs.has(d); d = dirname(d)) this.dirs.add(d);
    return this;
  }

  /** Add a QEMU process. */
  proc(pid: number, cwd: string | null, command: string, rssKiB = 1024 * 1024): this {
    this.processList.push({
      pid,
      ppid: 1,
      rssKiB,
      cpuPercent: 12.5,
      executable: command.split(" ")[0],
      command,
      cwd,
    });
    return this;
  }

  run(program: string, args: readonly string[]): Promise<RunResult> {
    this.runs.push({ program, args: [...args] });
    return Promise.resolve(this.onRun(program, args));
  }
  spawnDetached(
    program: string,
    args: readonly string[],
    options: { cwd: string; env?: Record<string, string>; logFile: string },
  ): Promise<number> {
    this.spawns.push({ program, args: [...args], cwd: options.cwd, env: options.env });
    return Promise.resolve(4242);
  }
  processes(): Promise<ProcessInfo[]> {
    return Promise.resolve(this.processList.map(({ cwd: _cwd, ...p }) => p));
  }
  processCwd(pid: number): Promise<string | null> {
    return Promise.resolve(this.processList.find((p) => p.pid === pid)?.cwd ?? null);
  }
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
    this.kills.push({ pid, signal });
    if (signal === "SIGKILL" || this.termKills) {
      this.processList = this.processList.filter((p) => p.pid !== pid);
    }
  }
  qmp(socketPath: string): Promise<QmpSession> {
    const handler = this.qmpSockets.get(socketPath);
    if (!handler) return Promise.reject(new Error("connection refused"));
    return Promise.resolve({
      execute: (command: string) => Promise.resolve(handler(command)),
      close: () => {},
    });
  }
  readTextFile(path: string): Promise<string> {
    this.reads.push(path);
    const text = this.files.get(path);
    return text === undefined ? Promise.reject(new Error("not found")) : Promise.resolve(text);
  }
  writeTextFile(path: string, text: string): Promise<void> {
    this.file(path, text);
    return Promise.resolve();
  }
  copyFile(from: string, to: string): Promise<void> {
    this.file(to, `copy of ${from}`);
    return Promise.resolve();
  }
  readDir(path: string): Promise<DirEntry[]> {
    const names = new Map<string, DirEntry>();
    for (const d of this.dirs) {
      if (dirname(d) === path && d !== path) {
        names.set(d, { name: d.slice(path.length + 1), isDirectory: true, isFile: false });
      }
    }
    for (const f of [...this.files.keys(), ...this.links.keys()]) {
      if (dirname(f) === path) {
        names.set(f, { name: f.slice(path.length + 1), isDirectory: false, isFile: true });
      }
    }
    return Promise.resolve([...names.values()]);
  }
  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path) || this.dirs.has(path) || this.links.has(path));
  }
  realPath(path: string): Promise<string | null> {
    const target = this.links.get(path) ?? path;
    return Promise.resolve(this.files.has(target) || this.dirs.has(target) ? target : null);
  }
  fileSize(path: string): Promise<number | null> {
    const text = this.files.get(path);
    return Promise.resolve(text === undefined ? null : text.length);
  }
  mkdir(path: string): Promise<void> {
    this.dirs.add(path);
    return Promise.resolve();
  }
  removeFile(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }
  totalMemoryBytes(): number {
    return this.memory;
  }
  sleep(ms: number): Promise<void> {
    this.slept += ms;
    return Promise.resolve();
  }
}
