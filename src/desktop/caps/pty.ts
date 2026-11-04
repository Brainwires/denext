/**
 * The `pty` capability (`denext desktop add pty`): terminals for the page, over the runtime's
 * `Deno.openPty` (denext's Deno Desktop runtime from {@linkcode FIRST_PTY_RUNTIME}). The page calls
 * it through `spawnPty` / `writePty` / … in `denext/desktop/client` (`./pty-client.ts`).
 *
 * Each terminal is a resource of {@linkcode createOwnedResources}, owned by the window that
 * started it (`ctx.windowId`):
 *
 * - its output goes to that window only, as `data` events `{ id, data: { seq, data } }` (`seq`
 *   grows by one per event per terminal: the event stream is at-least-once, so the page drops a
 *   `seq` it has seen), coalesced to one event per ~8 ms or per chunk (64 KiB, less with a small
 *   `replayBytes`), and its end as one `exit` event `{ id, data: { exitCode, signal } }`;
 * - both are kept in the terminal's replay (`replayBytes`), which `attach` returns;
 * - closing the window, or reloading its page, kills its terminals (`onWindowClose: "kill"`, the
 *   default) or detaches them (`"detach"`), and a window can `list` the detached ones and
 *   `attach` one; the app's quit kills them all.
 *
 * SECURITY:
 * - A page starts only a program on the allow-list (`desktop.capabilities.pty.shells`, by default
 *   the OS's login shells and `/bin/sh` / PowerShell / `cmd.exe`, absolute paths), and the packaged
 *   app bakes `--allow-run` for exactly those paths (never an unscoped run), so the runtime's own
 *   `--allow-run` check refuses anything else as well.
 * - `cwd` must be an absolute path to an existing directory.
 * - The environment is built here and passed with `clearEnv`: the page's variables (name and size
 *   checked) over the app's, less the ones the runtime refuses under a scoped `--allow-run` (a name
 *   starting with `LD_` or `DYLD_`, any case, after trimming) and a parent terminal's (`TMUX`, …).
 * - Terminal ids are random UUIDs, and a window may write to, resize, kill, inspect or attach only
 *   a terminal it owns (or attach a detached one): any other id answers `not_found`, the same as
 *   an id that does not exist, so a window cannot learn another window's terminals.
 *
 * Runtime-only (imported by the desktop entry via the caps resolver, never a client bundle).
 *
 * @module
 */

import {
  type DesktopCapability,
  type DesktopCapCtx,
  DesktopCapError,
  type DesktopExtensionHost,
} from "../extension.ts";
import { createOwnedResources, type OwnedResourcesHost } from "../owned-resources.ts";
import { FIRST_PTY_RUNTIME } from "../../build/deno-version.ts";
import { isPtyShellFor, type PtyOs, type ResolvedPtyConfig } from "../pty-config.ts";

/** `Deno.openPty`'s options (runtime 3.0.0-denext.11). */
export interface DenoPtyOptions {
  readonly cmd: string;
  readonly args?: string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly clearEnv?: boolean;
  readonly cols: number;
  readonly rows: number;
}

/** How a PTY's program ended (`Deno.CommandStatus`). */
export interface DenoPtyStatus {
  readonly success: boolean;
  readonly code: number;
  readonly signal: string | null;
}

/** `Deno.Pty` (runtime 3.0.0-denext.11). */
export interface DenoPty {
  readonly pid: number;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly status: Promise<DenoPtyStatus>;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** `Deno.openPty`. */
export type OpenPty = (options: DenoPtyOptions) => DenoPty;

/** The `exit` event's payload (`exitCode`: the program's exit code; `signal`: what killed it). */
interface PtyExitPayload {
  readonly exitCode: number;
  readonly signal: string | null;
}

/** The `data` event's payload. */
interface PtyDataPayload {
  readonly seq: number;
  readonly data: string;
}

/** What the capability reads from the process (injected in tests). */
export interface PtyProcessEnv {
  /** One variable, or `undefined`. */
  get(key: string): string | undefined;
  /** Every variable (throws under a scoped `--allow-env`; the known names are read instead). */
  toObject(): Record<string, string>;
}

/** Options for {@linkcode ptyCapability}. */
export interface PtyCapabilityOptions {
  /** `desktop.capabilities.pty`, resolved for the running OS. */
  readonly config: ResolvedPtyConfig;
  /** The running OS (default `Deno.build.os`). */
  readonly os?: PtyOs;
  /** `Deno.openPty` (default: the runtime's, looked up at each call). */
  readonly openPty?: OpenPty;
  /** The process environment (default `Deno.env`). */
  readonly env?: PtyProcessEnv;
  /** Whether a path is a directory (default `Deno.stat`; a failure is "no"). */
  readonly isDirectory?: (path: string) => Promise<boolean>;
  /** Read a text file (default `Deno.readTextFile`): Linux `/proc` for `info`. */
  readonly readTextFile?: (path: string) => Promise<string>;
  /** Read a symlink (default `Deno.readLink`): Linux `/proc/<pid>/cwd` for `info`. */
  readonly readLink?: (path: string) => Promise<string>;
  /** How long output is held to coalesce it, in ms (default 8). */
  readonly flushMs?: number;
  /** How long a killed program gets after SIGHUP before SIGKILL, in ms (default 2000). */
  readonly killGraceMs?: number;
  /** After the program exits, how long to wait for its last output, in ms (default 250). */
  readonly exitGraceMs?: number;
}

/** The most terminals open at once (each is a process and a PTY). */
const PTY_MAX_SESSIONS = 64;
/** The largest single coalesced `data` event, in bytes of output. */
const FLUSH_BYTES = 64 * 1024;
/** The most bytes of input one `write` takes (a paste). */
const MAX_WRITE_CHARS = 1024 * 1024;
/** The largest terminal, in columns or rows. */
const MAX_DIMENSION = 10_000;
/** The most `args` a page may pass, and the longest one. */
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4096;
/** The most environment variables a page may pass, and the longest value. */
const MAX_ENV = 256;
const MAX_ENV_VALUE_CHARS = 32 * 1024;
/** The signals `kill` takes. */
const KILL_SIGNALS = new Set(["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM", "SIGKILL"]);
/** A parent terminal's variables a shell must not inherit (node-pty's `_sanitizeEnv`). */
const STRIP_ENV = ["TMUX", "TMUX_PANE", "STY", "WINDOW", "WINDOWID", "TERMCAP", "COLUMNS", "LINES"];
/** What is read under a scoped `--allow-env` (strict permissions), where `toObject` throws. */
const KNOWN_ENV = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TZ",
  "XDG_RUNTIME_DIR",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "USERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "ProgramFiles",
  "ProgramData",
];
/** A variable name the page may set. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Why the capability cannot run under this runtime. */
const PTY_UNSUPPORTED_REASON =
  `the pty capability needs Deno.openPty, which denext's Deno Desktop runtime has from ${FIRST_PTY_RUNTIME}`;

/**
 * Whether the runtime refuses `key` in a child's environment under a scoped `--allow-run`: a name
 * starting with `LD_` or `DYLD_` (any case, after trimming), which Deno lets only an unscoped
 * `--allow-run` set, since it changes what code the child loads. Such a variable is never passed.
 *
 * @param key The variable name.
 * @returns Whether it is dropped.
 */
export function ptyEnvNameRefused(key: string): boolean {
  const k = key.trim().toUpperCase();
  return k.startsWith("LD_") || k.startsWith("DYLD_");
}

/** One live (or exited, not yet collected) terminal. */
interface Session {
  readonly id: string;
  readonly pty: DenoPty;
  readonly shell: string;
  readonly cwd: string;
  readonly decoder: TextDecoder;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  pending: string[];
  pendingBytes: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  seq: number;
  writeChain: Promise<void>;
  exited: PtyExitPayload | undefined;
  disposed: boolean;
}

/** What `spawn` returns. */
interface PtySpawnResult {
  readonly id: string;
  readonly pid: number;
  readonly shell: string;
  readonly cwd: string;
}

/** One entry of `list`. */
interface PtyListEntry {
  readonly id: string;
  readonly pid: number;
  readonly shell: string;
  readonly cwd: string;
  /** No window owns it: `attach` takes it over. */
  readonly detached: boolean;
  /** Its program has ended (its replay ends with the `exit`). */
  readonly exited: boolean;
}

/** Whether `v` is a non-array object. */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An object argument, or a `validation` error. */
function argsObject(args: unknown): Record<string, unknown> {
  if (!isPlainRecord(args)) {
    throw new DesktopCapError("validation", "pty: the arguments must be an object");
  }
  return args as Record<string, unknown>;
}

/** A terminal id argument. */
function idOf(a: Record<string, unknown>): string {
  if (typeof a.id !== "string" || a.id === "" || a.id.length > 64) {
    throw new DesktopCapError("validation", "pty: id must be a terminal id");
  }
  return a.id;
}

/** A column or row count. */
function dimension(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_DIMENSION) {
    throw new DesktopCapError(
      "validation",
      `pty: ${name} must be an integer from 1 to ${MAX_DIMENSION}`,
    );
  }
  return value as number;
}

/** `write`'s input as bytes: UTF-8 text, or with `binary` one byte per character. */
function inputBytes(a: Record<string, unknown>, encoder: TextEncoder): Uint8Array {
  if (typeof a.data !== "string" || a.data.length > MAX_WRITE_CHARS) {
    throw new DesktopCapError(
      "validation",
      `pty: data must be a string of at most ${MAX_WRITE_CHARS} characters`,
    );
  }
  if (a.binary !== undefined && typeof a.binary !== "boolean") {
    throw new DesktopCapError("validation", "pty: binary must be a boolean");
  }
  const data = a.data;
  if (a.binary !== true) return encoder.encode(data);
  if (/[^\0-\xff]/.test(data)) {
    throw new DesktopCapError(
      "validation",
      "pty: binary data must hold only byte values (U+0000 to U+00FF)",
    );
  }
  return Uint8Array.from(data, (ch) => ch.charCodeAt(0));
}

/** The page's `args`, checked. */
function argList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const ok = Array.isArray(value) && value.length <= MAX_ARGS &&
    value.every((s) => typeof s === "string" && s.length <= MAX_ARG_CHARS && !s.includes("\0"));
  if (!ok) {
    throw new DesktopCapError(
      "validation",
      `pty: args must be at most ${MAX_ARGS} strings without NUL`,
    );
  }
  return [...value as string[]];
}

/**
 * The page's `env`, filtered: names that are identifiers, string values without NUL, and none the
 * runtime refuses ({@linkcode ptyEnvNameRefused}). A malformed object is a `validation` error; a
 * refused name is dropped.
 */
function pageEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) {
    throw new DesktopCapError("validation", "pty: env must be an object of strings");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ENV) {
    throw new DesktopCapError("validation", `pty: env takes at most ${MAX_ENV} variables`);
  }
  const out: Record<string, string> = {};
  for (const [key, v] of entries) {
    if (!envValueOk(v)) {
      throw new DesktopCapError("validation", `pty: env.${key} must be a string without NUL`);
    }
    if (ENV_NAME.test(key) && !ptyEnvNameRefused(key)) out[key] = v;
  }
  return out;
}

/** A variable's value the page may pass: a string of bounded length without NUL. */
function envValueOk(v: unknown): v is string {
  return typeof v === "string" && v.length <= MAX_ENV_VALUE_CHARS && !v.includes("\0");
}

/** What a Unix terminal sets over the app's environment (the page's `env` comes after). */
function terminalDefaults(out: Record<string, string>, shell: string, cwd: string | undefined) {
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  out.SHELL ??= shell;
  if (cwd !== undefined) out.PWD = cwd;
  if (!out.LANG && !out.LC_ALL && !out.LC_CTYPE) out.LANG = "en_US.UTF-8";
}

/** The app's environment (every variable, or the known ones under a scoped `--allow-env`). */
function inheritedEnvironment(env: PtyProcessEnv): Record<string, string> {
  try {
    return { ...env.toObject() };
  } catch {
    const out: Record<string, string> = {};
    for (const key of KNOWN_ENV) {
      try {
        const v = env.get(key);
        if (v !== undefined) out[key] = v;
      } catch { /* not granted */ }
    }
    return out;
  }
}

/** A window's id as the bridge gives it (`"main"` when absent). */
const windowOf = (ctx: Pick<DesktopCapCtx, "windowId">): string => ctx.windowId ?? "main";

/** The `not_found` every unknown, foreign or ended id answers. */
const notFound = () => new DesktopCapError("not_found", "pty: no such terminal", { status: 404 });

/**
 * The extension host as {@linkcode OwnedResourcesHost}: its `emit`, and the window lifecycle where
 * the host has it (a host without one never reports a close; the app's exit ends the terminals).
 */
function ownedHost(host: DesktopExtensionHost): OwnedResourcesHost {
  const h = host as DesktopExtensionHost & Partial<OwnedResourcesHost>;
  return {
    emit: (event, data, options) => host.emit(event, data, options),
    onWindowClosed: (fn) => h.onWindowClosed?.(fn) ?? (() => {}),
    onAppQuit: (fn) => h.onAppQuit?.(fn) ?? (() => {}),
    windows: () => h.windows?.() ?? [],
  };
}

/** Open the PTY; the runtime's refusal is `forbidden`, any other failure `spawn_failed`. */
function startPty(open: OpenPty, options: DenoPtyOptions): DenoPty {
  try {
    return open(options);
  } catch (err) {
    const denied = err instanceof Error && err.name === "NotCapable";
    throw new DesktopCapError(
      denied ? "forbidden" : "spawn_failed",
      denied
        ? "pty: the app may not run that program (its --allow-run does not list it)"
        : "pty: the program could not be started",
    );
  }
}

/** Whether `promise` settles within `ms` (the timer is cleared either way). */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the `pty` capability.
 *
 * @param options The resolved config, and seams for tests.
 * @returns The capability (`name: "pty"`, events `data` and `exit`).
 */
export function ptyCapability(options: PtyCapabilityOptions): DesktopCapability {
  const { config } = options;
  const os = options.os ?? (Deno.build.os as PtyOs);
  const env = options.env ?? Deno.env;
  const flushMs = options.flushMs ?? 8;
  const killGraceMs = options.killGraceMs ?? 2000;
  const exitGraceMs = options.exitGraceMs ?? 250;
  const isDirectory = options.isDirectory ??
    ((path: string) => Deno.stat(path).then((s) => s.isDirectory, () => false));
  const readTextFile = options.readTextFile ?? ((path: string) => Deno.readTextFile(path));
  const readLink = options.readLink ?? ((path: string) => Deno.readLink(path));
  // A chunk's JSON (control characters escape to 6 bytes) must fit the replay, or it is not kept.
  const flushBytes = config.replayBytes > 0
    ? Math.min(FLUSH_BYTES, Math.max(512, Math.floor(config.replayBytes / 8)))
    : FLUSH_BYTES;
  const encoder = new TextEncoder();

  /** Registered terminals (each is disposed exactly once when it is unregistered). */
  let registered = 0;
  const sessions = createOwnedResources<Session>({
    onOwnerClosed: config.onWindowClose === "detach" ? "detach" : "dispose",
    dispose: (s) => {
      registered--;
      return disposeSession(s);
    },
    ...(config.replayBytes > 0 ? { replay: { maxBytes: config.replayBytes } } : {}),
    disposeTimeoutMs: killGraceMs + 2000,
  });

  /** `Deno.openPty`, or `unsupported`. */
  const openPty = (): OpenPty => {
    const open = options.openPty ?? (Deno as unknown as { openPty?: OpenPty }).openPty;
    if (typeof open !== "function") {
      throw new DesktopCapError("unsupported", PTY_UNSUPPORTED_REASON, {
        data: { reason: PTY_UNSUPPORTED_REASON, requires: FIRST_PTY_RUNTIME },
      });
    }
    return open;
  };

  /** The terminal `id` if the calling window owns it, else `not_found`. */
  const owned = (id: string, ctx: DesktopCapCtx): Session => {
    const s = sessions.get(id);
    if (s === undefined || sessions.owner(id) !== windowOf(ctx)) throw notFound();
    return s;
  };

  /** Send what is pending as one `data` event. */
  const flush = (s: Session): void => {
    if (s.timer !== undefined) clearTimeout(s.timer);
    s.timer = undefined;
    s.pendingBytes = 0;
    if (s.pending.length === 0) return;
    const data = s.pending.join("");
    s.pending = [];
    sessions.emit(s.id, "data", { seq: ++s.seq, data } satisfies PtyDataPayload);
  };

  /** Take output: coalesce it, sending at most `flushBytes` per event. */
  const push = (s: Session, bytes: Uint8Array): void => {
    for (let off = 0; off < bytes.byteLength; off += flushBytes) {
      const part = bytes.subarray(off, off + flushBytes);
      const text = s.decoder.decode(part, { stream: true });
      if (text) s.pending.push(text);
      s.pendingBytes += part.byteLength;
      if (s.pendingBytes >= flushBytes) flush(s);
      else if (s.timer === undefined) s.timer = setTimeout(() => flush(s), flushMs);
    }
  };

  /** Read the terminal's output until it ends. */
  const pump = async (s: Session): Promise<void> => {
    const reader = s.pty.readable.getReader();
    let finished = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    // A background job can hold the PTY open after the program exits: stop reading a little after.
    const exited = new Promise<"exited">((resolve) => {
      const later = () => {
        if (!finished) grace = setTimeout(() => resolve("exited"), exitGraceMs);
      };
      s.pty.status.then(later, later);
    });
    try {
      for (;;) {
        const next = await Promise.race([reader.read(), exited]);
        if (next === "exited") {
          reader.cancel().catch(() => {});
          break;
        }
        if (next.done) break;
        push(s, next.value);
      }
    } catch {
      /* the PTY closed */
    } finally {
      finished = true;
      clearTimeout(grace);
    }
  };

  /** The program ended: send the last output and the exit, keep them in the replay. */
  const finish = (s: Session, status: DenoPtyStatus): void => {
    const tail = s.decoder.decode();
    if (tail) s.pending.push(tail);
    flush(s);
    s.exited = { exitCode: status.code, signal: status.signal };
    s.writer.close().catch(() => {});
    sessions.emit(s.id, "exit", s.exited);
    // A window that owns it has the exit; a detached one keeps it for the window that attaches.
    if (sessions.owner(s.id) !== undefined) void sessions.remove(s.id);
  };

  /** Kill a terminal (closing its window, the app's quit, a reload): SIGHUP, then SIGKILL. */
  async function disposeSession(s: Session): Promise<void> {
    if (s.disposed || s.exited) return;
    s.disposed = true;
    try {
      s.pty.kill("SIGHUP");
    } catch {
      try {
        s.pty.kill("SIGKILL");
      } catch { /* gone */ }
    }
    if (await settlesWithin(s.pty.status, killGraceMs)) return;
    try {
      s.pty.kill("SIGKILL");
    } catch { /* gone */ }
    await settlesWithin(s.pty.status, 1000);
  }

  /** The program to start: the page's (on the allow-list) or the user's shell. */
  const pickShell = (requested: unknown): string => {
    const allowed = config.shells;
    if (allowed.length === 0) {
      throw new DesktopCapError("forbidden", "pty: no shell is allowed on this OS");
    }
    const same = (a: string, b: string) =>
      os === "windows"
        ? a.replaceAll("/", "\\").toLowerCase() === b.replaceAll("/", "\\").toLowerCase()
        : a === b;
    if (requested !== undefined) {
      if (typeof requested !== "string") {
        throw new DesktopCapError("validation", "pty: shell must be a string");
      }
      const match = allowed.find((s) => same(s, requested));
      if (match === undefined) {
        throw new DesktopCapError(
          "forbidden",
          "pty: that program is not in desktop.capabilities.pty.shells",
        );
      }
      return match;
    }
    // macOS / Linux: the user's login shell when it is allowed; Windows: the first entry.
    let preferred: string | undefined;
    try {
      preferred = os === "windows" ? undefined : env.get("SHELL");
    } catch { /* not granted */ }
    return (preferred === undefined ? undefined : allowed.find((s) => same(s, preferred))) ??
      allowed[0];
  };

  /** The working directory: the page's (an existing directory) or the home folder. */
  const pickCwd = async (requested: unknown): Promise<string | undefined> => {
    if (requested !== undefined) {
      if (typeof requested !== "string" || !isPtyShellFor(requested, os)) {
        throw new DesktopCapError("validation", "pty: cwd must be an absolute path");
      }
      if (!await isDirectory(requested)) {
        throw new DesktopCapError("validation", "pty: cwd is not an existing directory");
      }
      return requested;
    }
    let home: string | undefined;
    try {
      home = env.get(os === "windows" ? "USERPROFILE" : "HOME");
    } catch { /* not granted */ }
    return home !== undefined && await isDirectory(home) ? home : undefined;
  };

  /** The terminal's environment (see the module notes). */
  const childEnvironment = (
    page: Record<string, string>,
    shell: string,
    cwd: string | undefined,
  ) => {
    const out = inheritedEnvironment(env);
    for (const key of Object.keys(out)) {
      if (STRIP_ENV.includes(key) || ptyEnvNameRefused(key)) delete out[key];
    }
    if (os !== "windows") terminalDefaults(out, shell, cwd);
    return { ...out, ...page };
  };

  const spawn = async (args: unknown, ctx: DesktopCapCtx): Promise<PtySpawnResult> => {
    const open = openPty();
    const a = argsObject(args);
    const cols = dimension(a.cols, "cols");
    const rows = dimension(a.rows, "rows");
    const shell = pickShell(a.shell);
    const argv = argList(a.args) ?? (os === "windows" ? [] : ["-l"]);
    const page = pageEnvironment(a.env);
    const cwd = await pickCwd(a.cwd);
    if (registered >= PTY_MAX_SESSIONS) {
      throw new DesktopCapError("busy", `pty: at most ${PTY_MAX_SESSIONS} terminals at once`);
    }
    const pty = startPty(open, {
      cmd: shell,
      args: argv,
      ...(cwd !== undefined ? { cwd } : {}),
      env: childEnvironment(page, shell, cwd),
      clearEnv: true,
      cols,
      rows,
    });
    const id = crypto.randomUUID();
    const s: Session = {
      id,
      pty,
      shell,
      cwd: cwd ?? "",
      decoder: new TextDecoder(),
      writer: pty.writable.getWriter(),
      pending: [],
      pendingBytes: 0,
      timer: undefined,
      seq: 0,
      writeChain: Promise.resolve(),
      exited: undefined,
      disposed: false,
    };
    sessions.add(id, s, { owner: windowOf(ctx) });
    registered++;
    const pumped = pump(s);
    pty.status.then(
      async (status) => {
        await pumped;
        finish(s, status);
      },
      async () => {
        await pumped;
        finish(s, { success: false, code: -1, signal: null });
      },
    );
    return { id, pid: pty.pid, shell, cwd: s.cwd };
  };

  const write = async (args: unknown, ctx: DesktopCapCtx): Promise<void> => {
    openPty();
    const a = argsObject(args);
    const s = owned(idOf(a), ctx);
    const bytes = inputBytes(a, encoder);
    if (bytes.byteLength === 0) return;
    if (s.exited) throw new DesktopCapError("closed", "pty: the terminal has ended");
    // In order: each write waits for the one before it (a paste and the next key).
    const done = s.writeChain.then(() => s.writer.write(bytes));
    s.writeChain = done.catch(() => {});
    try {
      await done;
    } catch {
      throw new DesktopCapError("closed", "pty: the terminal has ended");
    }
  };

  const resize = (args: unknown, ctx: DesktopCapCtx): void => {
    openPty();
    const a = argsObject(args);
    const s = owned(idOf(a), ctx);
    const cols = dimension(a.cols, "cols");
    const rows = dimension(a.rows, "rows");
    if (s.exited) return;
    try {
      s.pty.resize(cols, rows);
    } catch { /* ended meanwhile */ }
  };

  const kill = async (args: unknown, ctx: DesktopCapCtx): Promise<void> => {
    openPty();
    const a = argsObject(args);
    const s = owned(idOf(a), ctx);
    const signal = a.signal ?? "SIGHUP";
    if (typeof signal !== "string" || !KILL_SIGNALS.has(signal)) {
      throw new DesktopCapError(
        "validation",
        `pty: signal must be one of ${[...KILL_SIGNALS].join(", ")}`,
      );
    }
    if (s.exited) {
      await sessions.remove(s.id);
      return;
    }
    try {
      s.pty.kill(signal);
    } catch { /* ended meanwhile: its exit event follows */ }
  };

  /** Linux: the foreground process of the terminal and its folder, from `/proc`. */
  const foreground = async (pid: number): Promise<{ process?: string; cwd?: string }> => {
    if (os !== "linux") return {};
    let fg = pid;
    try {
      const stat = await readTextFile(`/proc/${pid}/stat`);
      // `pid (comm) state ppid pgrp session tty_nr tpgid …`; comm may hold spaces and parens.
      const tpgid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[5]);
      if (Number.isInteger(tpgid) && tpgid > 0) fg = tpgid;
    } catch { /* gone, or no /proc */ }
    const out: { process?: string; cwd?: string } = {};
    try {
      out.process = (await readTextFile(`/proc/${fg}/comm`)).trim();
    } catch { /* gone */ }
    try {
      out.cwd = await readLink(`/proc/${fg}/cwd`);
    } catch { /* gone */ }
    return out;
  };

  const info = async (args: unknown, ctx: DesktopCapCtx) => {
    openPty();
    const s = owned(idOf(argsObject(args)), ctx);
    const fg = s.exited ? {} : await foreground(s.pty.pid);
    return { pid: s.pty.pid, ...fg };
  };

  const attach = async (args: unknown, ctx: DesktopCapCtx) => {
    openPty();
    const id = idOf(argsObject(args));
    const s = sessions.get(id);
    const owner = sessions.owner(id);
    if (s === undefined || (owner !== undefined && owner !== windowOf(ctx))) throw notFound();
    const { replay } = sessions.attach(id, windowOf(ctx));
    // An ended terminal has nothing left to own once its replay (with the exit) is handed over.
    if (s.exited) await sessions.remove(id);
    return { replay };
  };

  const list = (_args: unknown, ctx: DesktopCapCtx): PtyListEntry[] => {
    openPty();
    const me = windowOf(ctx);
    const ids = [
      ...[...sessions.ownedBy(me)].filter((id) => sessions.owner(id) === me),
      ...sessions.detached(),
    ];
    return ids.flatMap((id) => {
      const s = sessions.get(id);
      return s === undefined ? [] : [{
        id,
        pid: s.pty.pid,
        shell: s.shell,
        cwd: s.cwd,
        detached: sessions.owner(id) === undefined,
        exited: s.exited !== undefined,
      }];
    });
  };

  const run = { run: [...config.shells] };
  return {
    name: "pty",
    events: ["data", "exit"],
    perWindow: true,
    setup: (host) => {
      sessions.connect(ownedHost(host));
    },
    // A reload or a navigation: the page that knew the terminals is gone. Kill them, or detach them
    // so the new page can `list` and `attach` them.
    onPageLoad: async (windowId?: string) => {
      const me = windowId ?? "main";
      const mine = sessions.ownedBy(me).filter((id) => sessions.owner(id) === me);
      if (config.onWindowClose === "detach") {
        for (const id of mine) sessions.detach(id);
        return;
      }
      await Promise.all(mine.map((id) => sessions.remove(id)));
    },
    methods: {
      spawn: { permissions: run, handler: spawn },
      write: { handler: write },
      resize: { handler: resize },
      kill: { handler: kill },
      info: { handler: info },
      attach: { handler: attach },
      list: { handler: list },
    },
  };
}
