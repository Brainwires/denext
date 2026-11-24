/**
 * Local IPC for a desktop app and its helper processes (a detached sidecar, a CLI of the app): one
 * API over a Unix-domain socket on macOS and Linux and a named pipe on Windows, with no loopback
 * TCP port. `Deno.listen` / `Deno.connect` have no named-pipe transport, but the runtime's
 * `node:net` does (`net.createServer().listen("\\\\.\\pipe\\name")`, a Unix socket for any other
 * path), so this module is a thin layer over `node:net` that hands each connection out as a pair
 * of web streams. A Windows pipe has no half-close, so both ends frame what they write there
 * (both are this module; a pipe channel speaks only to another `listenLocalIpc` /
 * `connectLocalIpc`).
 *
 * - {@linkcode localIpcPath} — where a channel lives for this app and user (pure).
 * - {@linkcode listenLocalIpc} — serve a channel: refuses a live server's socket, replaces a stale
 *   one, makes the socket `0600` and checks its folder on Unix.
 * - {@linkcode connectLocalIpc} — connect to one, with a timeout and an `AbortSignal`.
 *
 * Permissions: the runtime checks a socket or pipe path for read AND write access to the path and
 * for the network grant `unix:<path>` (`--allow-net=unix:<path>`, or `--allow-net-listen` /
 * `--allow-net-connect` with the split flags). A refused check is rethrown as `NotCapable` naming
 * those grants.
 *
 * Runtime-only (a desktop entry, a sidecar, a CLI; never a client bundle).
 *
 * @module
 */

import net from "node:net";
import { createHash } from "node:crypto";
import { dirname } from "@std/path";
import { acquireOsLock, type OsLock } from "./os-lock.ts";
import { join as posixJoin } from "@std/path/posix";
import { type DesktopOsName, env, osDataDir } from "./app-dirs.ts";

/** Options for {@linkcode localIpcPath}. */
export interface LocalIpcPathOptions {
  /**
   * macOS / Linux: the folder the socket goes in. Default: the app's data folder + `/ipc`
   * (`~/Library/Application Support/<appId>/ipc`, `$XDG_DATA_HOME|~/.local/share /<appId>/ipc`),
   * which {@linkcode listenLocalIpc} creates `0700`. Ignored on Windows.
   */
  readonly dir?: string;
  /**
   * The app's identifier, sanitized to `[A-Za-z0-9._-]`. Default: `desktop.app.identifier`, as
   * `resolveDesktopCapabilities` registered it in this process. Required where nothing registered
   * one (a module sidecar's worker, a CLI) and the path needs it: on Windows, and on Unix without
   * `dir`.
   */
  readonly appId?: string;
  /**
   * Windows: the per-user part of the pipe name (`[A-Za-z0-9._-]`). Default: a short SHA-256 hex
   * prefix of the user's profile folder (else the user name), stable, not secret, and never the
   * raw name, so two users of one machine never share a pipe name. Ignored on Unix.
   */
  readonly user?: string;
  /** The OS whose shape to compute (default: the running one). */
  readonly os?: "darwin" | "linux" | "windows";
}

/** One local IPC connection, as a pair of web streams. */
export interface LocalIpcConnection extends AsyncDisposable {
  /** What the other side writes. Ends when the other side closes its `writable`. */
  readonly readable: ReadableStream<Uint8Array>;
  /** What the other side reads. Closing it ends the other side's `readable` (a half close). */
  readonly writable: WritableStream<Uint8Array>;
  /** Destroy the connection at once (both directions; unsent bytes are dropped). */
  close(): void;
}

/** A listening local IPC channel. */
export interface LocalIpcServer extends AsyncDisposable {
  /** The socket or pipe path it listens on. */
  readonly path: string;
  /** Stop listening, end the open connections and, on Unix, remove the socket file. */
  close(): Promise<void>;
}

/** Options for {@linkcode listenLocalIpc}. */
export interface LocalIpcListenOptions {
  /** Aborting it closes the server (like {@linkcode LocalIpcServer.close}). */
  readonly signal?: AbortSignal;
}

/** Options for {@linkcode connectLocalIpc}. */
export interface LocalIpcConnectOptions {
  /** Aborting it gives up on the connection attempt (rejects with the signal's reason). */
  readonly signal?: AbortSignal;
  /** Give up after this many milliseconds (default 5000), rejecting with `TimedOut`. */
  readonly timeoutMs?: number;
}

/** A channel or user name: 1 to 64 of `[A-Za-z0-9._-]`, starting with a letter or digit. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `sun_path`'s size (bytes, the terminating NUL included) per Unix OS. */
const SUN_PATH_BYTES: Readonly<Record<"darwin" | "linux", number>> = { darwin: 104, linux: 108 };

/** The longest Windows pipe path (`\\.\pipe\` included), in UTF-16 code units. */
const PIPE_PATH_MAX = 256;

/** How long {@linkcode listenLocalIpc} waits for an existing socket to answer before reusing it. */
const STALE_PROBE_MS = 1000;

/** The `globalThis` key `resolveDesktopCapabilities` registers the app identifier under. */
const APP_ID_KEY = Symbol.for("denext.desktop.localIpcAppId");

/**
 * Register the identifier {@linkcode localIpcPath} defaults `appId` to (`desktop.app.identifier`).
 * `resolveDesktopCapabilities` calls it; `undefined` clears it.
 *
 * @param appId The app's identifier, or `undefined`.
 */
export function registerLocalIpcAppId(appId: string | undefined): void {
  (globalThis as Record<symbol, unknown>)[APP_ID_KEY] = appId;
}

/** The registered identifier, if any. */
function registeredAppId(): string | undefined {
  const id = (globalThis as Record<symbol, unknown>)[APP_ID_KEY];
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * Why `name` cannot be a channel name, or `null`.
 *
 * @param name The name.
 * @param what What it names, for the message.
 * @returns The message, or `null`.
 */
export function localIpcNameError(name: unknown, what = "channel name"): string | null {
  if (typeof name !== "string" || !NAME.test(name)) {
    return `local IPC ${what} ${JSON.stringify(name)} must be 1 to 64 of [A-Za-z0-9._-], ` +
      "starting with a letter or digit";
  }
  return null;
}

/** `id` with every character outside `[A-Za-z0-9._-]` replaced by `-`. */
function sanitizeAppId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "-");
  if (!/[A-Za-z0-9]/.test(safe)) {
    throw new TypeError(`local IPC appId ${JSON.stringify(id)} has no letter or digit`);
  }
  return safe;
}

/**
 * The default per-user token of a Windows pipe name: the first 12 hex digits of the SHA-256 of the
 * user's profile folder (lowercased: Windows paths are case-insensitive), else of the user name.
 * Stable for a user, different between users, and not the name itself.
 *
 * @param who The profile folder and user name (default: `USERPROFILE`, else `HOME`, and `USERNAME`).
 * @returns The token.
 */
export function localIpcUserToken(
  who: { readonly profile?: string; readonly user?: string } = {
    profile: env("USERPROFILE") ?? env("HOME"),
    user: env("USERNAME"),
  },
): string {
  const profile = who.profile?.trim();
  const source = profile
    ? `profile:${profile.replaceAll("/", "\\").toLowerCase()}`
    : `user:${(who.user ?? "").toLowerCase()}`;
  return createHash("sha256").update(source).digest("hex").slice(0, 12);
}

/** The app identifier the path needs, or a thrown error naming the option. */
function requireAppId(options: LocalIpcPathOptions): string {
  const id = options.appId ?? registeredAppId();
  if (id === undefined || id === "") {
    throw new TypeError(
      "local IPC: no app identifier — pass `appId` (desktop.app.identifier), or call " +
        "localIpcPath in a process where resolveDesktopCapabilities ran",
    );
  }
  return sanitizeAppId(id);
}

/**
 * Where the local IPC channel `name` lives for this app and user:
 *
 * - macOS / Linux: `<dir>/<name>.sock`, `dir` defaulting to the app's data folder + `/ipc`. A path
 *   longer than `sun_path` allows (103 bytes on macOS, 107 on Linux, counted in UTF-8) is refused:
 *   pass a shorter `dir`.
 * - Windows: `\\.\pipe\<appId>.<user>.<name>`.
 *
 * Pure apart from reading the environment for the defaults; creates nothing.
 *
 * @param name The channel's name: 1 to 64 of `[A-Za-z0-9._-]`, starting with a letter or digit.
 * @param options The folder, app identifier, user token and OS (see {@linkcode LocalIpcPathOptions}).
 * @returns The socket or pipe path.
 * @throws TypeError for a bad name, app id or user token, a missing app id, or a path too long.
 */
export function localIpcPath(name: string, options: LocalIpcPathOptions = {}): string {
  const nameError = localIpcNameError(name);
  if (nameError) throw new TypeError(nameError);
  const os = options.os ?? hostOs();
  if (os === "windows") {
    const user = options.user ?? localIpcUserToken();
    const userError = localIpcNameError(user, "user token");
    if (userError) throw new TypeError(userError);
    const path = `\\\\.\\pipe\\${requireAppId(options)}.${user}.${name}`;
    if (path.length > PIPE_PATH_MAX) {
      throw new TypeError(
        `local IPC pipe path ${path} is longer than Windows' ${PIPE_PATH_MAX}-character limit: ` +
          "pass a shorter appId or name",
      );
    }
    return path;
  }
  // A Unix path, even when computed on another host (osDataDir joins with that host's separator).
  const dir = options.dir ??
    posixJoin(osDataDir(requireAppId(options), os).replaceAll("\\", "/"), "ipc");
  const path = posixJoin(dir, `${name}.sock`);
  const limit = SUN_PATH_BYTES[os];
  const bytes = new TextEncoder().encode(path).length;
  if (bytes >= limit) {
    throw new TypeError(
      `local IPC socket path ${path} is ${bytes} bytes; ${os === "darwin" ? "macOS" : "Linux"} ` +
        `allows ${limit - 1} (sun_path is ${limit} bytes with its terminator): pass a shorter dir`,
    );
  }
  return path;
}

/** The running OS in {@linkcode DesktopOsName} spelling (any other Unix takes Linux's shape). */
function hostOs(): DesktopOsName {
  const os = Deno.build.os;
  return os === "darwin" || os === "windows" ? os : "linux";
}

/**
 * Whether `path` names a Windows named pipe (`\\.\pipe\…` or `\\?\pipe\…`, either slash).
 *
 * @param path The path.
 * @returns Whether it is a pipe path.
 */
export function isLocalIpcPipePath(path: string): boolean {
  return /^[\\/]{2}[.?][\\/]pipe[\\/]/i.test(path);
}

/** The subset of `Deno.FileInfo` the folder check reads. */
export interface LocalIpcDirInfo {
  /** Whether it is a directory. */
  readonly isDirectory: boolean;
  /** Its mode bits, `null` where the OS reports none. */
  readonly mode: number | null;
  /** Its owner, `null` where the OS reports none. */
  readonly uid: number | null;
}

/**
 * Why a Unix socket may not be bound in a folder, or `null`: the folder must be a directory owned
 * by this user (or root) and not writable by its group or others unless sticky — otherwise another
 * user could swap the socket for their own. Skipped (`null`) where the mode, the owner or this
 * process's uid is unknown.
 *
 * @param dir The folder (for the message).
 * @param info Its `Deno.stat`.
 * @param uid This process's uid (`Deno.uid()`).
 * @returns The message, or `null`.
 */
export function localIpcDirError(
  dir: string,
  info: LocalIpcDirInfo,
  uid: number | null,
): string | null {
  if (!info.isDirectory) return `local IPC: ${dir} is not a directory`;
  if (info.mode === null || info.uid === null || uid === null) return null;
  if (info.uid !== uid && info.uid !== 0) {
    return `local IPC: ${dir} is owned by uid ${info.uid}, not this user (${uid}); another ` +
      "user could replace the socket: use a folder of your own";
  }
  const sticky = (info.mode & 0o1000) !== 0;
  if ((info.mode & 0o022) !== 0 && !sticky) {
    return `local IPC: ${dir} is writable by its group or others (mode ${
      (info.mode & 0o7777).toString(8)
    }); another user could replace the socket: use a folder only you can write`;
  }
  return null;
}

/** A Node.js-style system error code (`ECONNREFUSED`, …), if any. */
function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Whether `err` is the runtime's refused permission check. */
function isNotCapable(err: unknown): boolean {
  return err instanceof Deno.errors.NotCapable ||
    (err as { name?: unknown } | null)?.name === "NotCapable";
}

/**
 * The grants a refused local IPC call needs, as a `NotCapable` naming them.
 *
 * @param path The socket or pipe path.
 * @param direction `listen` or `connect`.
 * @param cause The runtime's error.
 * @returns The error to throw.
 */
export function localIpcPermissionError(
  path: string,
  direction: "listen" | "connect",
  cause: unknown,
): Error {
  return new Deno.errors.NotCapable(
    `local IPC: ${direction} on ${path} needs read and write access to that path and the ` +
      `network grant unix:${path} (deno: --allow-read=${path} --allow-write=${path} ` +
      `--allow-net-${direction}=unix:${path}, or --allow-net=unix:${path} where the runtime has ` +
      "no split network flags). A packaged desktop app cannot name a per-user path in " +
      "desktop.extraPermissions.net (the runtime expands no folder token in a network grant): " +
      `grant the folder (write: ["$APPDATA/ipc"]) and net${
        direction === "listen" ? "Listen" : "Connect"
      }: ["*"]`,
    { cause },
  );
}

/** `err` as the error this module reports for `path`. */
function mapError(err: unknown, path: string, direction: "listen" | "connect"): unknown {
  if (isNotCapable(err)) return localIpcPermissionError(path, direction, err);
  const code = errorCode(err);
  if (direction === "connect" && code === "ECONNREFUSED") {
    return new Deno.errors.ConnectionRefused(`local IPC: nothing listens on ${path}`, {
      cause: err,
    });
  }
  if (direction === "connect" && code === "ENOENT") {
    return new Deno.errors.NotFound(`local IPC: nothing listens on ${path} (no such socket)`, {
      cause: err,
    });
  }
  if (code === "EADDRINUSE") {
    return new Deno.errors.AddrInUse(`local IPC: another server listens on ${path}`, {
      cause: err,
    });
  }
  return err;
}

/** The bytes of a frame header on a Windows pipe: the payload's length, little-endian. */
const FRAME_HEADER = 4;
/** The largest payload one frame carries (a longer write is split). */
const FRAME_MAX = 1024 * 1024;

/**
 * Windows pipe framing. A byte-mode named pipe has no half-close: ending its write side tells the
 * peer nothing, which only learns of the end when the whole pipe closes. Both ends of a pipe
 * channel are this module, so on a pipe each write travels as frames (a 4-byte little-endian
 * length, then the bytes) and a zero-length frame says "this side writes no more": the peer's
 * readable ends there while the other direction keeps flowing. The pipe itself closes once both
 * directions are done.
 */
function frame(chunk: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < chunk.length; at += FRAME_MAX) {
    const part = chunk.subarray(at, Math.min(at + FRAME_MAX, chunk.length));
    const header = new Uint8Array(FRAME_HEADER);
    new DataView(header.buffer).setUint32(0, part.length, true);
    out.push(header, part);
  }
  return out;
}

/** The end-of-writes frame (a zero length). */
const END_FRAME = new Uint8Array(FRAME_HEADER);

/**
 * Reassembles frames from pipe chunks: `onData` per payload, `onEnd` at the end frame, `onBad`
 * (once, then nothing more is read) for a header naming more than {@linkcode FRAME_MAX} bytes,
 * which this module never writes: nothing is buffered for it.
 */
function frameDecoder(
  onData: (bytes: Uint8Array) => void,
  onEnd: () => void,
  onBad: (err: Error) => void,
): (chunk: Uint8Array) => void {
  let buffered = new Uint8Array(0);
  let ended = false;
  return (chunk) => {
    if (ended) return;
    let buf: Uint8Array = buffered.length === 0 ? chunk : concatBytes(buffered, chunk);
    while (buf.length >= FRAME_HEADER) {
      const length = new DataView(buf.buffer, buf.byteOffset, FRAME_HEADER).getUint32(0, true);
      if (length === 0) {
        ended = true;
        buffered = new Uint8Array(0);
        onEnd();
        return;
      }
      if (length > FRAME_MAX) {
        ended = true;
        buffered = new Uint8Array(0);
        onBad(
          new Deno.errors.InvalidData(
            `local IPC: a frame of ${length} bytes exceeds the ${FRAME_MAX}-byte limit`,
          ),
        );
        return;
      }
      if (buf.length < FRAME_HEADER + length) break;
      onData(buf.slice(FRAME_HEADER, FRAME_HEADER + length));
      buf = buf.subarray(FRAME_HEADER + length);
    }
    buffered = buf.slice();
  };
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * A `node:net` socket as a {@linkcode LocalIpcConnection}: `data` / `end` feed the readable (paused
 * while its queue is full), each write resolves once the socket took it, closing the writable ends
 * the socket's write side (the socket is half-open, so the other direction keeps flowing). On a
 * Windows pipe (`framed`) the same contract rides on frames (see {@linkcode frame}).
 */
function wrapSocket(socket: net.Socket, framed: boolean): LocalIpcConnection {
  let readDone = false;
  let writeDone = false;
  let discard = false;
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  /** On a pipe: close it once neither direction has more to say. */
  const settleFramed = () => {
    if (framed && writeDone && (readDone || discard)) socket.destroy();
  };
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      const finish = (err?: unknown) => {
        if (readDone) return;
        readDone = true;
        if (!discard) {
          if (err === undefined) controller.close();
          else controller.error(err);
        }
        settleFramed();
      };
      const deliver = (bytes: Uint8Array) => {
        if (readDone || discard) return;
        controller.enqueue(bytes);
        if ((controller.desiredSize ?? 1) <= 0) socket.pause();
      };
      const decode = framed
        ? frameDecoder(deliver, () => finish(), (err) => {
          finish(err);
          socket.destroy();
        })
        : undefined;
      socket.on("data", (chunk: Uint8Array) => {
        if (decode) decode(new Uint8Array(chunk));
        else deliver(new Uint8Array(chunk));
      });
      socket.once("end", () => finish());
      socket.once("error", (err: unknown) => finish(err));
      socket.once("close", () => finish());
    },
    pull() {
      socket.resume();
    },
    cancel() {
      // Not interested in reading any more: drop what arrives, and end the socket once the write
      // side is done too.
      discard = true;
      socket.resume();
      if (framed) settleFramed();
      else if (socket.writableEnded) socket.destroy();
    },
  }, { highWaterMark: 4 });
  const send = (bytes: Uint8Array) =>
    new Promise<void>((resolve, reject) => {
      if (socket.destroyed) {
        reject(new Deno.errors.BrokenPipe("local IPC: the connection is closed"));
        return;
      }
      socket.write(bytes, (err?: Error | null) => err ? reject(err) : resolve());
    });
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (!framed) return send(chunk);
      if (chunk.length === 0) return; // a zero-length frame would end the stream
      for (const part of frame(chunk)) await send(part);
    },
    close() {
      if (framed) {
        if (socket.destroyed) {
          writeDone = true;
          return Promise.resolve();
        }
        return send(END_FRAME).catch(() => {}).then(() => {
          writeDone = true;
          settleFramed();
        });
      }
      return new Promise<void>((resolve) => {
        if (socket.destroyed || socket.writableFinished) return resolve();
        socket.once("close", () => resolve());
        socket.end(() => resolve());
      }).then(() => {
        if (readDone || discard) socket.destroy();
      });
    },
    abort() {
      socket.destroy();
    },
  });
  const close = () => {
    socket.destroy();
  };
  return {
    readable,
    writable,
    close,
    async [Symbol.asyncDispose]() {
      close();
      await closed;
    },
  };
}

/** Try to connect to `path`: `true` when something answers, `false` when nothing listens. */
function probeUnixSocket(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = net.connect({ path });
    const timer = setTimeout(() => {
      socket.destroy();
      // Something holds the socket but does not accept in time: treat it as live (never steal).
      resolve(true);
    }, STALE_PROBE_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (err: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      const code = errorCode(err);
      if (code === "ECONNREFUSED" || code === "ENOENT") resolve(false);
      else reject(mapError(err, path, "connect"));
    });
  });
}

/** Create the socket's folder (`0700`) when missing, and refuse an unsafe one. */
async function prepareUnixDir(path: string): Promise<void> {
  const dir = dirname(path);
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(dir);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
    await Deno.chmod(dir, 0o700);
    info = await Deno.stat(dir);
  }
  let uid: number | null = null;
  try {
    uid = Deno.uid();
  } catch {
    uid = null;
  }
  const problem = localIpcDirError(dir, info, uid);
  if (problem) throw new Deno.errors.PermissionDenied(problem);
}

/**
 * Make `path` bindable on Unix (its folder already checked): clear a stale socket file (nothing
 * answers on it), refusing a live one or a non-socket.
 */
async function prepareUnixPath(path: string): Promise<void> {
  let existing: Deno.FileInfo;
  try {
    existing = await Deno.lstat(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
  if (existing.isSocket !== true) {
    throw new Deno.errors.AlreadyExists(
      `local IPC: ${path} exists and is not a socket; remove it or pick another name`,
    );
  }
  if (await probeUnixSocket(path)) {
    throw new Deno.errors.AddrInUse(`local IPC: another server listens on ${path}`);
  }
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/** The lock file a Unix socket's server holds: `<socket path>.lock`, beside it. */
export function localIpcLockPath(path: string): string {
  return `${path}.lock`;
}

/**
 * Take the server lock of the socket at `path` ({@linkcode localIpcLockPath}): `AddrInUse` when
 * another server holds it. A process whose grants reach only the socket path itself (not its
 * folder) cannot create the lock file: it serves without one, as before the lock existed.
 */
async function serverLock(path: string): Promise<OsLock | null> {
  let lock: OsLock | null;
  try {
    lock = await acquireOsLock(localIpcLockPath(path), { timeoutMs: 0 });
  } catch (err) {
    if (isNotCapable(err) || err instanceof Deno.errors.PermissionDenied) return null;
    throw err;
  }
  if (!lock) throw new Deno.errors.AddrInUse(`local IPC: another server listens on ${path}`);
  return lock;
}

/** Remove the socket file at `path` if it is still a socket (a missing one is fine). */
async function removeSocketFile(path: string): Promise<void> {
  try {
    if ((await Deno.lstat(path)).isSocket === true) await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/**
 * Serve the local IPC channel at `path` (from {@linkcode localIpcPath}): `onConnection` gets each
 * accepted connection (one that throws closes that connection).
 *
 * On macOS / Linux the socket's folder is created `0700` when missing and must otherwise be owned
 * by this user and not writable by its group or others (unless sticky); an existing socket that
 * answers is never taken over (`AddrInUse`), one that does not (left by a crash) is replaced; the
 * bound socket is made `0600`. On Windows the pipe is created as the first instance of its name
 * (`AddrInUse` when another process holds it).
 *
 * @param path The socket or pipe path.
 * @param onConnection Called with each accepted connection.
 * @param options An `AbortSignal` that closes the server.
 * @returns The listening server.
 * @throws `AddrInUse` when another server holds the path, `NotCapable` naming the missing grants,
 * `PermissionDenied` for an unsafe folder, `AlreadyExists` for a non-socket file at the path.
 */
export async function listenLocalIpc(
  path: string,
  onConnection: (conn: LocalIpcConnection) => void,
  options: LocalIpcListenOptions = {},
): Promise<LocalIpcServer> {
  options.signal?.throwIfAborted();
  const pipe = isLocalIpcPipePath(path);
  // On Unix the server holds an OS lock beside its socket for as long as it serves: the stale
  // check, the bind and the removal at close are one server's alone, so two starting at once can
  // never remove each other's socket (a pipe name is claimed by its first instance instead).
  let lock: OsLock | null = null;
  try {
    if (!pipe) {
      await prepareUnixDir(path);
      lock = await serverLock(path);
      await prepareUnixPath(path);
    }
  } catch (err) {
    lock?.release();
    throw mapError(err, path, "listen");
  }
  try {
    options.signal?.throwIfAborted();
  } catch (err) {
    lock?.release();
    throw err;
  }
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (socket: net.Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    try {
      onConnection(wrapSocket(socket, pipe));
    } catch {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: unknown) => reject(mapError(err, path, "listen"));
    server.once("error", onError);
    try {
      server.listen(path, () => {
        server.off("error", onError);
        resolve();
      });
    } catch (err) {
      reject(mapError(err, path, "listen"));
    }
  }).catch((err) => {
    lock?.release();
    throw err;
  });
  // A later server error (none is expected once listening) must not crash the process.
  server.on("error", () => {});
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      options.signal?.removeEventListener("abort", onAbort);
      const done = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await done;
      try {
        if (!pipe) await removeSocketFile(path);
      } finally {
        lock?.release();
      }
    })();
    return closing;
  };
  const onAbort = () => void close();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (!pipe) {
    try {
      await Deno.chmod(path, 0o600);
    } catch (err) {
      await close();
      throw err;
    }
  }
  if (options.signal?.aborted) await close();
  return { path, close, [Symbol.asyncDispose]: close };
}

/**
 * Connect to the local IPC channel at `path` (from {@linkcode localIpcPath}).
 *
 * @param path The socket or pipe path.
 * @param options A timeout (default 5000 ms) and an `AbortSignal`.
 * @returns The connection.
 * @throws `ConnectionRefused` / `NotFound` when nothing listens, `TimedOut` after `timeoutMs`, the
 * signal's reason when aborted, `NotCapable` naming the missing grants.
 */
export function connectLocalIpc(
  path: string,
  options: LocalIpcConnectOptions = {},
): Promise<LocalIpcConnection> {
  return connectLocalIpcWith((p) => net.connect({ path: p, allowHalfOpen: true }), path, options);
}

/**
 * {@linkcode connectLocalIpc} with the socket made by `open` (tests hand in a socket that never
 * connects, to reach the timeout and the abort deterministically).
 *
 * @param open Makes the connecting socket for a path.
 * @param path The socket or pipe path.
 * @param options A timeout (default 5000 ms) and an `AbortSignal`.
 * @returns The connection.
 */
export function connectLocalIpcWith(
  open: (path: string) => net.Socket,
  path: string,
  options: LocalIpcConnectOptions = {},
): Promise<LocalIpcConnection> {
  const { signal, timeoutMs = 5000 } = options;
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<LocalIpcConnection>((resolve, reject) => {
    let socket: net.Socket;
    try {
      socket = open(path);
    } catch (err) {
      reject(mapError(err, path, "connect"));
      return;
    }
    const settle = (err: unknown | undefined) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.off("error", onError);
      socket.off("connect", onConnect);
      if (err === undefined) {
        resolve(wrapSocket(socket, isLocalIpcPipePath(path)));
      } else {
        socket.on("error", () => {});
        socket.destroy();
        reject(err);
      }
    };
    const onConnect = () => settle(undefined);
    const onError = (err: unknown) => settle(mapError(err, path, "connect"));
    const onAbort = () => settle(signal?.reason);
    const timer = setTimeout(
      () =>
        settle(
          new Deno.errors.TimedOut(`local IPC: connecting to ${path} took over ${timeoutMs} ms`),
        ),
      timeoutMs,
    );
    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
