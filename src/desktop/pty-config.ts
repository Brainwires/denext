/**
 * `desktop.capabilities.pty`, resolved: the one reading of the config that the runtime capability
 * (`./caps/pty.ts`), the packaging flags (`../build/desktop-capabilities.ts`, which bake
 * `--allow-run=<the shells>`), the config validator and `denext desktop doctor` share, so the
 * programs a page may start and the programs the packaged app may run are the same list.
 *
 * Pure: no `Deno.*`, nothing runs at import.
 *
 * @module
 */

/** The operating systems a Deno Desktop app ships for (`Deno.build.os` spelling). */
export type PtyOs = "darwin" | "windows" | "linux";

/** What closing the window that owns a terminal does to it. */
export type PtyWindowClosePolicy = "kill" | "detach";

/** `desktop.capabilities.pty` resolved, for one OS. */
export interface ResolvedPtyConfig {
  /** What closing the owner window (or reloading its page) does to its terminals. */
  readonly onWindowClose: PtyWindowClosePolicy;
  /** The most bytes of output kept per terminal for `attach` (0: none). */
  readonly replayBytes: number;
  /** The programs a page may start, absolute paths for the OS, in the configured order. */
  readonly shells: readonly string[];
}

/** The default replay buffer per terminal: 512 KiB. */
const PTY_DEFAULT_REPLAY_BYTES = 512 * 1024;

/** The largest `replayBytes` accepted (64 MiB per terminal). */
const PTY_MAX_REPLAY_BYTES = 64 * 1024 * 1024;

/** The smallest non-zero `replayBytes` accepted. */
const PTY_MIN_REPLAY_BYTES = 4096;

/**
 * The shells a page may start when `desktop.capabilities.pty.shells` is not set: the OS's login
 * shells and `/bin/sh` on macOS and Linux (both the `/bin` and `/usr/bin` spellings on Linux, where
 * either may be a user's `$SHELL`), Windows PowerShell and `cmd.exe` on Windows. Absolute, so the
 * packaged app's `--allow-run` names exactly these programs.
 */
export const PTY_DEFAULT_SHELLS: Readonly<Record<PtyOs, readonly string[]>> = {
  darwin: ["/bin/zsh", "/bin/bash", "/bin/sh"],
  linux: [
    "/bin/bash",
    "/usr/bin/bash",
    "/bin/zsh",
    "/usr/bin/zsh",
    "/usr/bin/fish",
    "/bin/sh",
  ],
  windows: [
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "C:\\Windows\\System32\\cmd.exe",
  ],
};

/** An absolute POSIX path. */
const POSIX_ABSOLUTE = /^\/[^\0]*$/;
/** An absolute Windows path with a drive letter (`C:\x`, `C:/x`). */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/][^\0]*$/;

/**
 * Whether `path` is an absolute program path on `os`: `/…` on macOS and Linux, `C:\…` on Windows.
 *
 * @param path The configured entry.
 * @param os The OS.
 * @returns Whether it names a program on that OS.
 */
export function isPtyShellFor(path: string, os: PtyOs): boolean {
  return os === "windows" ? WINDOWS_ABSOLUTE.test(path) : POSIX_ABSOLUTE.test(path);
}

/**
 * Why `value` is not a valid `desktop.capabilities.pty`, as `[field, message]`, else `null`.
 * `true` / `false` / an object with `onWindowClose` (`"kill"` | `"detach"`), `replayBytes` (0, or
 * an integer from 4096 to 64 MiB) and `shells` (absolute program paths, each one value of a
 * permission list: no comma).
 *
 * @param value The configured value.
 * @returns The problem, or `null`.
 */
export function ptyConfigProblem(value: unknown): [string, string] | null {
  if (value === undefined || typeof value === "boolean") return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [PTY_FIELD, "must be a boolean or an options object"];
  }
  const v = value as Record<string, unknown>;
  if (v.onWindowClose !== undefined && v.onWindowClose !== "kill" && v.onWindowClose !== "detach") {
    return [`${PTY_FIELD}.onWindowClose`, 'must be "kill" or "detach"'];
  }
  if (v.replayBytes !== undefined && !replayBytesOk(v.replayBytes)) {
    return [
      `${PTY_FIELD}.replayBytes`,
      `must be 0 (no replay) or an integer from ${PTY_MIN_REPLAY_BYTES} to ${PTY_MAX_REPLAY_BYTES}`,
    ];
  }
  return v.shells === undefined ? null : shellsProblem(v.shells);
}

/** The config path every problem names. */
const PTY_FIELD = "desktop.capabilities.pty";

/** `replayBytes`: 0, or an integer in range. */
function replayBytesOk(value: unknown): boolean {
  return value === 0 ||
    (Number.isInteger(value) && (value as number) >= PTY_MIN_REPLAY_BYTES &&
      (value as number) <= PTY_MAX_REPLAY_BYTES);
}

/** Why `shells` is not a list of absolute program paths (one permission value each), else `null`. */
function shellsProblem(shells: unknown): [string, string] | null {
  if (!Array.isArray(shells)) {
    return [`${PTY_FIELD}.shells`, "must be an array of absolute program paths"];
  }
  const bad = shells.find((entry) =>
    typeof entry !== "string" || entry.includes(",") ||
    !(isPtyShellFor(entry, "darwin") || isPtyShellFor(entry, "windows"))
  );
  if (bad === undefined) return null;
  return [
    `${PTY_FIELD}.shells`,
    `entry ${
      JSON.stringify(bad)
    } is not an absolute program path (/bin/zsh, C:\\Windows\\System32\\cmd.exe) without a comma: the packaged app bakes --allow-run for exactly these paths`,
  ];
}

/**
 * Resolve `desktop.capabilities.pty` for `os`. `true` (or an object without `shells`) takes
 * {@linkcode PTY_DEFAULT_SHELLS}; a `shells` list keeps the entries that are absolute paths on
 * `os` (a list may name programs for several OSes; an entry for another OS is left out). An invalid
 * value throws (the desktop entry reads the config's JSON slice, which the loader never validated).
 *
 * @param value The configured value (`true`, or the options object).
 * @param os The OS the app runs on (or is packaged for).
 * @returns The resolved options.
 * @throws {Error} When the value is invalid ({@linkcode ptyConfigProblem}).
 */
export function resolvePtyConfig(value: unknown, os: PtyOs): ResolvedPtyConfig {
  const problem = ptyConfigProblem(value);
  if (problem) throw new Error(`desktop: ${problem[0]} ${problem[1]}`);
  const v = (typeof value === "object" && value !== null ? value : {}) as {
    onWindowClose?: PtyWindowClosePolicy;
    replayBytes?: number;
    shells?: string[];
  };
  const shells = v.shells === undefined
    ? [...PTY_DEFAULT_SHELLS[os]]
    : [...new Set(v.shells.filter((s) => isPtyShellFor(s, os)))];
  return {
    onWindowClose: v.onWindowClose ?? "kill",
    replayBytes: v.replayBytes ?? PTY_DEFAULT_REPLAY_BYTES,
    shells,
  };
}
