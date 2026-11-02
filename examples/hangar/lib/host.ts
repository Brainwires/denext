// The seam between Hangar's VM logic and the machine: every process, file and socket Hangar
// touches goes through a `Host`. `deno-host.ts` is the real one (the desktop extension's); the
// tests pass an in-memory fake, so no test ever starts QEMU, reads ~/VMs or opens a socket.

/**
 * The user's home folder, from the environment. Windows sets `USERPROFILE` and no `HOME`, and a
 * `HOME` a Unix-like shell exports there may not be a Windows path, so it is only the fallback.
 */
export function homeFolder(os: string, env: (name: string) => string | undefined): string {
  return (os === "windows" ? env("USERPROFILE") || env("HOME") : env("HOME")) || "/";
}

/** What a finished command printed. */
export interface RunResult {
  /** The exit code. */
  readonly code: number;
  /** Standard output, decoded. */
  readonly stdout: string;
  /** Standard error, decoded. */
  readonly stderr: string;
}

/** One process, as `ps` reports it. */
export interface ProcessInfo {
  /** The process id. */
  readonly pid: number;
  /** The parent's id. */
  readonly ppid: number;
  /** Resident memory, in KiB. */
  readonly rssKiB: number;
  /** CPU use, in percent of one core (can exceed 100). */
  readonly cpuPercent: number;
  /** The program (argv[0]). */
  readonly executable: string;
  /** The whole command line, as `ps` joins it. */
  readonly command: string;
}

/** An open QMP session (see `qmp.ts`). */
export interface QmpSession {
  /** Run one QMP command; resolves with its `return`, rejects with its `error`. */
  execute(command: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Close the socket. */
  close(): void;
}

/** A directory entry. */
export interface DirEntry {
  /** The entry's name. */
  readonly name: string;
  /** A directory. */
  readonly isDirectory: boolean;
  /** A regular file. */
  readonly isFile: boolean;
}

/** Everything Hangar asks of the machine. */
export interface Host {
  /** The user's home folder. */
  readonly home: string;
  /** `Deno.build.os`. */
  readonly os: string;
  /** Run a program to completion (no shell). */
  run(program: string, args: readonly string[], options?: { cwd?: string }): Promise<RunResult>;
  /**
   * Start a program detached from Hangar (it outlives the app), its output appended to `logFile`.
   * Resolves with the started process's pid.
   */
  spawnDetached(
    program: string,
    args: readonly string[],
    options: { cwd: string; env?: Record<string, string>; logFile: string },
  ): Promise<number>;
  /** Every process on the machine. */
  processes(): Promise<ProcessInfo[]>;
  /** A process's working directory, or `null` when it cannot be read. */
  processCwd(pid: number): Promise<string | null>;
  /** Send a signal to exactly this pid. */
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  /** Open a QMP session on a unix socket (rejects when nothing listens). */
  qmp(socketPath: string, timeoutMs: number): Promise<QmpSession>;
  /** Read a text file. */
  readTextFile(path: string): Promise<string>;
  /** Write a text file (creating or replacing it). */
  writeTextFile(path: string, text: string): Promise<void>;
  /** Copy a file. */
  copyFile(from: string, to: string): Promise<void>;
  /** The entries of a directory. */
  readDir(path: string): Promise<DirEntry[]>;
  /** Whether a path exists (without following a final symlink's target). */
  exists(path: string): Promise<boolean>;
  /** The canonical path (symlinks resolved), or `null` when it does not exist. */
  realPath(path: string): Promise<string | null>;
  /** The size of a file in bytes, or `null` when it does not exist. */
  fileSize(path: string): Promise<number | null>;
  /** Create a directory (its parents too). */
  mkdir(path: string): Promise<void>;
  /** Remove one file. */
  removeFile(path: string): Promise<void>;
  /** The machine's physical memory, in bytes. */
  totalMemoryBytes(): number;
  /** Wait. */
  sleep(ms: number): Promise<void>;
}
