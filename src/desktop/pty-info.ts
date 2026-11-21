/**
 * What runs in a terminal, for an app that drives its own PTYs: {@linkcode ptyInfoOf} takes a
 * `Deno.Pty` (or a bare process id) and answers the {@linkcode PtyInfo} the `pty` capability's
 * `ptyInfo(id)` answers for its own terminals, from the same sources: `Deno.Pty.foreground()` and
 * `ttyName` where the runtime has them (denext's Deno Desktop runtime: macOS, Linux, Windows), else
 * Linux's `/proc`. {@linkcode ptyInfoSupport} says which of them a `Deno.Pty` has.
 *
 * Runtime-only (a desktop entry, a sidecar, an extension; never a client bundle). Nothing runs at
 * import.
 *
 * @module
 */

import type { PtyInfo } from "./pty-client.ts";

export type { PtyInfo } from "./pty-client.ts";

/** What `Deno.Pty.foreground()` answers: the process in the terminal's foreground. */
export interface PtyForegroundProcess {
  /** The terminal's foreground process group (`null` on Windows, which has none). */
  readonly pgid: number | null;
  /** The process described. */
  readonly pid: number;
  /** Its name. */
  readonly name: string;
  /** Its arguments, the program first (`null` when the OS refuses). */
  readonly argv: string[] | null;
  /** Its working directory (`null` when the OS refuses). */
  readonly cwd: string | null;
}

/**
 * The part of a `Deno.Pty` {@linkcode ptyInfoOf} reads: its program's `pid`, and where the runtime
 * has them, `ttyName` and `foreground()`.
 */
export interface PtyInfoSource {
  /** The terminal's program's process id. */
  readonly pid: number;
  /** The terminal device's path (`null` on Windows), where the runtime tells it. */
  readonly ttyName?: string | null;
  /** The terminal's foreground process, where the runtime tells it. */
  foreground?(): PtyForegroundProcess | null;
}

/** Options for {@linkcode ptyInfoOf} (the OS and file reads; tests pass their own). */
export interface PtyInfoOptions {
  /** The OS (default the running one): only Linux has the `/proc` fallback. */
  readonly os?: string;
  /** Read a text file (default `Deno.readTextFile`): `/proc/<pid>/stat` and `comm`. */
  readonly readTextFile?: (path: string) => Promise<string>;
  /** Read a symlink (default `Deno.readLink`): `/proc/<pid>/cwd`. */
  readonly readLink?: (path: string) => Promise<string>;
}

/** What {@linkcode ptyInfoSupport} reports. */
export interface PtyInfoSupport {
  /** The runtime names the foreground process (`Deno.Pty.foreground()`). */
  readonly foreground: boolean;
  /** The runtime names the terminal device (`Deno.Pty.ttyName`; `null` on Windows counts). */
  readonly ttyName: boolean;
  /** Without `foreground()`, the name and folder still come from `/proc` (Linux). */
  readonly procFallback: boolean;
}

/**
 * Which of `ptyInfoOf`'s sources a `Deno.Pty` has.
 *
 * @param pty The terminal (`Deno.openPty`'s result), or `undefined` to ask about `/proc` alone.
 * @param os The OS (default the running one).
 * @returns The sources.
 * @example
 * ```ts
 * import { ptyInfoSupport } from "denext/desktop";
 *
 * const pty = Deno.openPty({ command: "/bin/zsh" });
 * if (!ptyInfoSupport(pty).foreground) console.warn("no foreground process on this runtime");
 * ```
 */
export function ptyInfoSupport(
  pty?: PtyInfoSource,
  os: string = Deno.build.os,
): PtyInfoSupport {
  return {
    foreground: typeof pty?.foreground === "function",
    ttyName: pty !== undefined && pty.ttyName !== undefined,
    procFallback: os === "linux",
  };
}

/** `fn()`'s value, or `undefined` once it rejects (a process gone, no `/proc`). */
async function orUndefined<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/** The terminal's foreground process group (`tpgid` of `/proc/<pid>/stat`), else `pid`. */
async function procForegroundGroup(
  pid: number,
  readTextFile: (path: string) => Promise<string>,
): Promise<number> {
  const stat = await orUndefined(() => readTextFile(`/proc/${pid}/stat`));
  if (stat === undefined) return pid;
  // `pid (comm) state ppid pgrp session tty_nr tpgid …`; comm may hold spaces and parens.
  const tpgid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[5]);
  return Number.isInteger(tpgid) && tpgid > 0 ? tpgid : pid;
}

/**
 * Linux's answer from `/proc` for the terminal whose program is `pid`: the terminal's foreground
 * process group, then that process's name and folder. Nothing elsewhere.
 */
async function ptyForegroundFromProc(
  pid: number,
  options: PtyInfoOptions,
): Promise<Omit<PtyInfo, "pid" | "tty">> {
  if ((options.os ?? Deno.build.os) !== "linux") return {};
  const readTextFile = options.readTextFile ?? Deno.readTextFile;
  const readLink = options.readLink ?? Deno.readLink;
  const fg = await procForegroundGroup(pid, readTextFile);
  const comm = await orUndefined(() => readTextFile(`/proc/${fg}/comm`));
  const cwd = await orUndefined(() => readLink(`/proc/${fg}/cwd`));
  return {
    ...(comm === undefined ? {} : { process: comm.trim() }),
    ...(cwd === undefined ? {} : { cwd }),
  };
}

/**
 * The foreground fields of `pty`: the runtime's `foreground()` where it has one (a throw or `null`
 * reads as nothing), else {@linkcode ptyForegroundFromProc}.
 *
 * @param pty The terminal.
 * @param options The OS and the file reads.
 * @returns The fields.
 */
export async function ptyForegroundInfo(
  pty: PtyInfoSource,
  options: PtyInfoOptions = {},
): Promise<Omit<PtyInfo, "pid" | "tty">> {
  if (typeof pty.foreground !== "function") return await ptyForegroundFromProc(pty.pid, options);
  let fg: PtyForegroundProcess | null;
  try {
    fg = pty.foreground();
  } catch {
    fg = null;
  }
  if (fg === null || typeof fg !== "object") return {};
  return {
    process: fg.name,
    foregroundPid: fg.pid,
    ...(fg.pgid === null ? {} : { foregroundGroup: fg.pgid }),
    ...(fg.argv === null ? {} : { argv: fg.argv }),
    ...(fg.cwd === null ? {} : { cwd: fg.cwd }),
  };
}

/**
 * What runs in a terminal the app opened itself (its own PTY backend over `Deno.openPty`), in the
 * shape `ptyInfo(id)` from `denext/desktop/client` answers for the `pty` capability's terminals:
 * the program's `pid`, the terminal device (`tty`, from `ttyName`), and the foreground process's
 * name, arguments, folder, id and process group, asked of the OS at each call. Each field is left
 * out where the runtime or the OS does not tell it (a `Deno.Pty` without `foreground()` has only
 * Linux's `/proc` name and folder; see {@linkcode ptyInfoSupport}).
 *
 * A bare process id (the terminal's program, from another PTY library) has no `Deno.Pty` to ask:
 * it gets Linux's `/proc` answer and `{ pid }` elsewhere.
 *
 * @param pty The terminal (`Deno.openPty`'s result), or its program's process id.
 * @param options The OS and the file reads (tests).
 * @returns The info.
 * @example
 * ```ts
 * import { ptyInfoOf } from "denext/desktop";
 *
 * const pty = Deno.openPty({ command: "/bin/zsh", cols: 80, rows: 24 });
 * const { process, cwd } = await ptyInfoOf(pty); // "vim", "/Users/me/src"
 * ```
 */
export async function ptyInfoOf(
  pty: PtyInfoSource | number,
  options: PtyInfoOptions = {},
): Promise<PtyInfo> {
  if (typeof pty === "number") {
    if (!Number.isSafeInteger(pty) || pty <= 0) {
      throw new TypeError("ptyInfoOf: a process id must be a positive integer");
    }
    return { pid: pty, ...await ptyForegroundFromProc(pty, options) };
  }
  if (typeof pty !== "object" || pty === null || !Number.isSafeInteger(pty.pid)) {
    throw new TypeError("ptyInfoOf: pass a Deno.Pty (with its pid) or a process id");
  }
  const tty = typeof pty.ttyName === "string" ? { tty: pty.ttyName } : {};
  return { pid: pty.pid, ...tty, ...await ptyForegroundInfo(pty, options) };
}
