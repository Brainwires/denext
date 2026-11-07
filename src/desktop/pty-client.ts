/**
 * The page side of the `pty` desktop capability (`denext desktop add pty`), re-exported from
 * `denext/desktop/client`: start a terminal ({@linkcode spawnPty}), type into it
 * ({@linkcode writePty}), size it, end it, and read its output ({@linkcode onPtyData}) and its end
 * ({@linkcode onPtyExit}). Built for a terminal emulator such as xterm.js:
 *
 * ```ts
 * import { onPtyData, onPtyExit, resizePty, spawnPty, writePty } from "denext/desktop/client";
 *
 * const stopData = onPtyData(({ id, data }) => id === term.id && xterm.write(data));
 * const stopExit = onPtyExit(({ id, exitCode }) => id === term.id && showEnded(exitCode));
 * const term = await spawnPty({ cols: xterm.cols, rows: xterm.rows });
 * xterm.onData((data) => writePty(term.id, data));
 * xterm.onBinary((data) => writePty(term.id, data, { binary: true }));
 * xterm.onResize(({ cols, rows }) => resizePty(term.id, cols, rows));
 * ```
 *
 * Subscribe before `spawnPty`: a shell's first output can arrive before the call resolves (an
 * event that arrives before any handler is kept for the first one). Each terminal belongs to the
 * window that started it: its events go to that window only, and another window's calls with its
 * id answer `not_found`. Closing that window (or reloading its page) kills the terminal, unless
 * `desktop.capabilities.pty.onWindowClose` is `"detach"`: then it keeps running, and a window
 * finds it with {@linkcode listPtys} and takes it over with {@linkcode attachPty}, which returns
 * the output (and the exit) it missed.
 *
 * Every call rejects `unavailable` off desktop or when the capability is not enabled, and
 * `unsupported` under a Deno Desktop runtime older than 3.0.0-denext.12 (no `Deno.openPty`), and on Windows, where the runtime has no terminals yet.
 *
 * Client-safe: web APIs only, nothing runs at import.
 *
 * @module
 */

import { desktopRpc, subscribeDesktopEvent } from "./bridge-client.ts";

/** The capability's bridge name. */
const CAP = "pty";

/** Options for {@linkcode spawnPty}. */
export interface PtySpawnOptions {
  /** Columns (1 to 10000). */
  readonly cols: number;
  /** Rows (1 to 10000). */
  readonly rows: number;
  /** The working directory: an absolute path to an existing directory (default: the home folder). */
  readonly cwd?: string;
  /**
   * The program: one of `desktop.capabilities.pty.shells`, by its absolute path (default: the
   * user's `$SHELL` when it is on the list, else the list's first entry).
   */
  readonly shell?: string;
  /** Its arguments (default `["-l"]`, a login shell, on macOS and Linux; none on Windows). */
  readonly args?: readonly string[];
  /**
   * Variables set over the app's environment. Names must be identifiers; a name starting with
   * `LD_` or `DYLD_` is dropped (the runtime refuses those under a scoped `--allow-run`).
   */
  readonly env?: Readonly<Record<string, string>>;
}

/** What {@linkcode spawnPty} resolves to. */
export interface PtySpawned {
  /** The terminal's id: random, and valid only in the window that owns the terminal. */
  readonly id: string;
  /** The program's process id. */
  readonly pid: number;
  /** The program started (its absolute path). */
  readonly shell: string;
  /** Its working directory (`""` when the home folder could not be read). */
  readonly cwd: string;
}

/** What {@linkcode ptyInfo} resolves to. */
export interface PtyInfo {
  /** The program's process id. */
  readonly pid: number;
  /** The foreground process's name (`vim`), where the OS tells it (Linux). */
  readonly process?: string;
  /** The foreground process's working directory, where the OS tells it (Linux). */
  readonly cwd?: string;
}

/** One terminal {@linkcode listPtys} reports. */
export interface PtySession {
  /** The terminal's id. */
  readonly id: string;
  /** The program's process id. */
  readonly pid: number;
  /** The program (its absolute path). */
  readonly shell: string;
  /** The folder it started in. */
  readonly cwd: string;
  /** No window owns it: {@linkcode attachPty} takes it over. */
  readonly detached: boolean;
  /** Its program has ended (the replay ends with the exit). */
  readonly exited: boolean;
}

/** A chunk of a terminal's output ({@linkcode onPtyData}). */
export interface PtyDataEvent {
  /** The terminal's id. */
  readonly id: string;
  /** Grows by one per chunk of this terminal; a chunk seen twice has the same `seq`. */
  readonly seq: number;
  /** The output, decoded as UTF-8 (a character split between reads is never cut). */
  readonly data: string;
}

/** A terminal's end ({@linkcode onPtyExit}). */
export interface PtyExitEvent {
  /** The terminal's id. */
  readonly id: string;
  /** The program's exit code. */
  readonly exitCode: number;
  /** The signal that ended it (`"SIGHUP"`), or `null`. */
  readonly signal: string | null;
}

/** One entry of {@linkcode attachPty}'s replay, oldest first. */
export type PtyReplayEntry =
  | { readonly event: "data"; readonly seq: number; readonly data: string }
  | { readonly event: "exit"; readonly exitCode: number; readonly signal: string | null };

/** What {@linkcode attachPty} resolves to. */
export interface PtyAttachment {
  /** The output kept for the terminal (up to `pty.replayBytes`), and its exit when it ended. */
  readonly replay: readonly PtyReplayEntry[];
}

/** The signals {@linkcode killPty} sends. */
export type PtySignal = "SIGHUP" | "SIGINT" | "SIGQUIT" | "SIGTERM" | "SIGKILL";

/**
 * Start a terminal running an allowed shell.
 *
 * @param options Its size, and optionally the shell, arguments, folder and variables.
 * @returns Its id, process id, program and folder. Rejects `forbidden` for a program not on
 * `desktop.capabilities.pty.shells`, `validation` for a bad size, a `cwd` that is not an
 * existing directory or malformed `env`, and `busy` past 64 terminals.
 */
export async function spawnPty(options: PtySpawnOptions): Promise<PtySpawned> {
  return await desktopRpc<PtySpawned>(CAP, "spawn", options);
}

/**
 * Send input to a terminal, in order with the previous writes.
 *
 * @param id The terminal.
 * @param data Text, written as UTF-8; with `binary`, one byte per character (U+0000 to U+00FF:
 * xterm.js's `onBinary`, such as legacy mouse reports).
 * @param options `binary`.
 */
export async function writePty(
  id: string,
  data: string,
  options: { readonly binary?: boolean } = {},
): Promise<void> {
  await desktopRpc(CAP, "write", options.binary ? { id, data, binary: true } : { id, data });
}

/**
 * Change a terminal's size (the program gets `SIGWINCH`).
 *
 * @param id The terminal.
 * @param cols Columns.
 * @param rows Rows.
 */
export async function resizePty(id: string, cols: number, rows: number): Promise<void> {
  await desktopRpc(CAP, "resize", { id, cols, rows });
}

/**
 * Send a signal to a terminal's program (default `SIGHUP`, as closing a terminal does); its
 * {@linkcode onPtyExit} follows. An ended terminal is forgotten.
 *
 * @param id The terminal.
 * @param signal The signal.
 */
export async function killPty(id: string, signal?: PtySignal): Promise<void> {
  await desktopRpc(CAP, "kill", signal === undefined ? { id } : { id, signal });
}

/**
 * A terminal's process id, and (on Linux) the foreground process's name and folder.
 *
 * @param id The terminal.
 * @returns What the OS tells.
 */
export async function ptyInfo(id: string): Promise<PtyInfo> {
  return await desktopRpc<PtyInfo>(CAP, "info", { id });
}

/**
 * Take a terminal over: one this window owns (after a reload) or a detached one. Its later events
 * come to this window. Drop a replayed `data` whose `seq` an {@linkcode onPtyData} handler has
 * already seen. An ended terminal is forgotten once its replay is returned.
 *
 * @param id The terminal.
 * @returns The output kept for it.
 */
export async function attachPty(id: string): Promise<PtyAttachment> {
  const { replay } = await desktopRpc<
    { replay: ReadonlyArray<{ event: string; data: unknown }> }
  >(CAP, "attach", { id });
  return {
    replay: replay.flatMap((entry): PtyReplayEntry[] => {
      const d = entry.data as Record<string, unknown>;
      if (entry.event === "data") {
        return [{ event: "data", seq: d.seq as number, data: d.data as string }];
      }
      if (entry.event === "exit") {
        return [{
          event: "exit",
          exitCode: d.exitCode as number,
          signal: (d.signal as string | null) ?? null,
        }];
      }
      return [];
    }),
  };
}

/**
 * The terminals this window owns, and the detached ones (which any window may attach).
 *
 * @returns The terminals.
 */
export async function listPtys(): Promise<PtySession[]> {
  return await desktopRpc<PtySession[]>(CAP, "list", {});
}

/**
 * Call `handler` with each chunk of output of this window's terminals. A chunk delivered twice (the
 * event stream reconnected) is dropped by its `seq`. Off desktop it does nothing.
 *
 * @param handler Called with each chunk.
 * @returns A function that unsubscribes.
 */
export function onPtyData(handler: (event: PtyDataEvent) => void): () => void {
  const last = new Map<string, number>();
  return subscribeDesktopEvent(CAP, "data", (frame) => {
    const { id, data } = frame as { id: string; data: { seq: number; data: string } };
    if (data.seq <= (last.get(id) ?? 0)) return;
    last.set(id, data.seq);
    handler({ id, seq: data.seq, data: data.data });
  });
}

/**
 * Call `handler` once for each of this window's terminals that ends (its program exited or was
 * killed). Off desktop it does nothing.
 *
 * @param handler Called with the exit.
 * @returns A function that unsubscribes.
 */
export function onPtyExit(handler: (event: PtyExitEvent) => void): () => void {
  const seen = new Set<string>();
  return subscribeDesktopEvent(CAP, "exit", (frame) => {
    const { id, data } = frame as { id: string; data: { exitCode: number; signal: string | null } };
    if (seen.has(id)) return;
    seen.add(id);
    handler({ id, exitCode: data.exitCode, signal: data.signal ?? null });
  });
}
