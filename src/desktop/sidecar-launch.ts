/**
 * How a sidecar runs: {@linkcode workerSidecarLauncher} starts a module sidecar in a dedicated
 * worker of the app's own Deno runtime (Node compatibility on, no second binary), and
 * {@linkcode execSidecarLauncher} spawns a program. Both hand the supervisor a
 * {@linkcode SidecarInstance}.
 *
 * A module sidecar runs behind a small wrapper (a `blob:` module, so nothing extra has to be
 * compiled into the app) that, before importing the module: sets `process.argv` (the module's
 * path, then the sidecar's `args`), gives the worker its own `process.env` with the login-shell
 * variables it asked for (`loginShellEnv`), its `env` and its port on top (the app's environment
 * is not changed), installs `globalThis.denextSidecar` (`name`, `port`, `bootstrap`, `secrets`,
 * `ready()`, `onShutdown(fn)`, and `childCommand(args)` / `spawnSelf(args, options)`, which start
 * the app's executable again as a child running this module: see `sidecar-child.ts`), and routes
 * its console and `process.stdout` / `process.stderr` to the app as lines. An uncaught error,
 * `process.exit()` and `self.close()` end the worker only, never the app. What a worker cannot
 * contain: a V8 out-of-memory abort and a crash in a native addon end the whole app.
 *
 * A program gets the login-shell variables it asked for, its `env` and its port on top of the app's
 * environment (without the runtime's own `DENO_SERVE_ADDRESS` / `DENO_DESKTOP_*`), and one JSON
 * line on stdin: `{"name","port","bootstrap","secrets"}`. Its stdin then stays open for as long as
 * the app runs, so a program that exits on end-of-file on stdin never outlives the app, however
 * the app ends. With `run.bootstrapFd` the line goes to that file descriptor instead (a pipe
 * written once and closed, as an Electron app hands its backend `--bootstrap-fd 3`): `Deno.Command`
 * has no extra descriptors, so such a program is spawned through `node:child_process`, whose
 * `stdio` array has them, under the same permission checks.
 *
 * {@linkcode detachedSidecarLauncher} runs a `detached` module sidecar as its own OS process that
 * outlives the app: the app's executable started again headless on the module (the `spawnSelf`
 * child shape, `sidecar-child.ts`), in a session / process group of its own, its output appended to
 * its log file or dropped. At each start it first looks for a running instance in the app's
 * registry and reattaches to it (see `sidecar-detached.ts`).
 *
 * Runtime-only (imported by `runDesktop`, never a client bundle).
 *
 * @module
 */

import type { spawn as nodeSpawn } from "node:child_process";
import type { Writable } from "node:stream";
import { basename, dirname, fromFileUrl, isAbsolute, join } from "@std/path";
import {
  detachedOptions,
  SIDECAR_DEFAULTS,
  SIDECAR_DETACHED_ENV,
  type SidecarDefinition,
  type SidecarExit,
} from "./sidecar.ts";
import { type SidecarChildBase, sidecarChildHelpersUrl } from "./sidecar-child.ts";
import { envAll } from "../runtime/env-safe.ts";
import {
  connectDetachedControl,
  type DetachedEnd,
  type DetachedRecord,
  detachedRecordPath,
  type DetachedSession,
  type DetachedStopOptions,
  endDetachedSession,
  newDetachedKey,
  probeDetachedRecordState,
  readDetachedRecord,
  removeDetachedRecord,
  withDetachedLock,
  writeDetachedRecord,
} from "./sidecar-detached.ts";
import type {
  SidecarInstance,
  SidecarLaunchContext,
  SidecarLauncher,
} from "./sidecar-supervisor.ts";

/** Where the wrapper's import of the child helpers' `blob:` URL goes. */
const HELPERS_URL = "__DENEXT_SIDECAR_CHILD_HELPERS__";

/**
 * The worker's wrapper module. Messages in: `init` (once), `shutdown`. Out: `line`, `ready`,
 * `exit`, `error`, `done` (shutdown handlers finished).
 */
const SIDECAR_WORKER_WRAPPER = `import process from "node:process";
import { childHelpers, installRequireBase } from "${HELPERS_URL}";
const post = (m) => { try { self.postMessage(m); } catch { /* host gone */ } };
const handlers = [];
const decoder = new TextDecoder();
function lines(stream) {
  let buf = "";
  return (chunk) => {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      post({ t: "line", s: stream, l: buf.slice(0, i).replace(/\\r$/, "") });
      buf = buf.slice(i + 1);
    }
    if (buf.length > 65536) { post({ t: "line", s: stream, l: buf }); buf = ""; }
  };
}
const out = lines("stdout"), err = lines("stderr");
const fmt = (args) => args.map((a) => typeof a === "string" ? a : Deno.inspect(a, { colors: false })).join(" ") + "\\n";
console.log = console.info = console.debug = (...a) => out(fmt(a));
console.error = console.warn = (...a) => err(fmt(a));
const writer = (sink) => function (chunk, enc, cb) {
  sink(chunk);
  const done = typeof enc === "function" ? enc : cb;
  if (typeof done === "function") queueMicrotask(done);
  return true;
};
try { process.stdout.write = writer(out); process.stderr.write = writer(err); } catch { /* read-only */ }
// A sidecar is the main program of its own world, without an IPC channel (as Node's main thread
// without one, where connected, channel, send and disconnect are all undefined): not a
// worker_threads worker, whose process.connected / channel / send throw or read false.
for (const key of ["connected", "channel", "send", "disconnect"]) {
  try { Object.defineProperty(process, key, { value: undefined, configurable: true, writable: true }); } catch { /* keep */ }
}
// Nor does it have a location (Node's main thread has none): a blob: worker's WorkerLocation reads
// origin "null", and a library that resolves URLs against location.origin + location.pathname
// (Effect's Url.make) would turn every request into "nullnull/<uuid>/…".
try { Object.defineProperty(globalThis, "location", { value: undefined, configurable: true, writable: true }); } catch { /* keep */ }
const exit = process.exit.bind(process);
process.exit = (code) => {
  const c = code ?? process.exitCode ?? 0;
  post({ t: "exit", code: typeof c === "number" ? c : Number(c) || 0 });
  exit(c);
};
const close = self.close.bind(self);
self.close = () => { post({ t: "exit", code: 0 }); close(); };
async function shutdown() {
  await Promise.allSettled(handlers.map((fn) => (async () => fn())()));
  try {
    if (process.listenerCount("SIGTERM") > 0) process.emit("SIGTERM", "SIGTERM");
  } catch { /* no signals in this isolate */ }
  post({ t: "done" });
}
self.onmessage = async (e) => {
  const m = e.data;
  if (m?.t === "shutdown") return void shutdown();
  if (m?.t !== "init") return;
  process.argv = [process.execPath, m.path, ...m.args];
  // The backend's own createRequire(import.meta.url) resolves from the bundle: every lookup in
  // this worker also searches the unpacked packages.
  if (m.requireBase) installRequireBase(m.requireBase, m.modulesPath);
  try { process.env = { ...process.env, ...m.env }; } catch { /* keep the shared view */ }
  globalThis.denextSidecar = Object.freeze({
    name: m.name,
    port: m.port,
    bootstrap: m.bootstrap,
    secrets: Object.freeze({ ...m.secrets }),
    ready: () => post({ t: "ready" }),
    onShutdown: (fn) => { if (typeof fn === "function") handlers.push(fn); },
    child: false,
    ...childHelpers(m.child),
  });
  try {
    await import(m.entry);
  } catch (e) {
    post({ t: "error", message: e instanceof Error ? (e.stack ?? e.message) : String(e) });
    close();
  }
};
`;

/** The `blob:` URL of {@linkcode SIDECAR_WORKER_WRAPPER}, made once. */
let wrapperUrl: string | undefined;

/** Options for {@linkcode workerSidecarLauncher}. */
export interface WorkerLauncherOptions {
  /** The module's URL (`file:` in the app's file system or its embedded one). */
  readonly entry: string;
  /**
   * A file path the bundle's `require()` resolves from (its unpacked packages, see
   * `sidecar-modules.ts`); without it, from the module itself.
   */
  readonly requireBase?: string;
  /**
   * How the sidecar starts children of the app (`denextSidecar.childCommand` / `spawnSelf`); without
   * it they throw.
   */
  readonly child?: SidecarChildBase;
  /** The worker constructor (tests pass a fake). */
  readonly Worker?: typeof Worker;
}

/**
 * The variables a sidecar is given: those from the login shell (when it asked), its `env`, then
 * the port under `portEnv`.
 */
function sidecarEnv(
  ctx: SidecarLaunchContext,
): Record<string, string> {
  const def = ctx.definition;
  return {
    ...(ctx.loginEnv ?? {}),
    ...(def.env ?? {}),
    ...(ctx.port !== undefined ? { [def.portEnv ?? "PORT"]: String(ctx.port) } : {}),
  };
}

/** `args` with `{port}` replaced. */
export function sidecarArgs(args: readonly string[] | undefined, port?: number): string[] {
  return (args ?? []).map((a) => port === undefined ? a : a.replaceAll("{port}", String(port)));
}

/**
 * Start module sidecars in workers.
 *
 * @param options The module and (for tests) the worker constructor.
 * @returns The launcher.
 */
export function workerSidecarLauncher(options: WorkerLauncherOptions): SidecarLauncher {
  const WorkerCtor = options.Worker ?? Worker;
  return (ctx) => {
    const def = ctx.definition;
    wrapperUrl ??= URL.createObjectURL(
      new Blob([SIDECAR_WORKER_WRAPPER.replace(HELPERS_URL, sidecarChildHelpersUrl())], {
        type: "text/javascript",
      }),
    );
    const worker = new WorkerCtor(wrapperUrl, { type: "module", name: `sidecar:${def.name}` });
    let settle!: (exit: SidecarExit) => void;
    const exited = new Promise<SidecarExit>((r) => settle = r);
    let ended = false;
    let onDone: (() => void) | undefined;
    const end = (exit: SidecarExit) => {
      if (ended) return;
      ended = true;
      worker.terminate();
      settle(exit);
    };
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { t?: string; s?: string; l?: string; code?: number; message?: string };
      if (m.t === "line") ctx.onLine(m.s === "stderr" ? "stderr" : "stdout", String(m.l ?? ""));
      else if (m.t === "ready") ctx.onReadySignal();
      else if (m.t === "exit") end({ code: m.code ?? 0 });
      else if (m.t === "error") end({ error: String(m.message) });
      else if (m.t === "done") onDone?.();
    };
    worker.onerror = (e: ErrorEvent) => {
      // Contain it: an uncaught error in the sidecar must not reach the app's own handler.
      e.preventDefault();
      end({ error: e.message || "uncaught error" });
    };
    worker.onmessageerror = () => end({ error: "a message from the sidecar could not be read" });
    const port = ctx.port;
    worker.postMessage({
      t: "init",
      name: def.name,
      entry: options.entry,
      path: options.entry.startsWith("file:") ? fromFileUrl(options.entry) : options.entry,
      args: sidecarArgs(def.args, port),
      env: sidecarEnv(ctx),
      port,
      bootstrap: ctx.bootstrap,
      secrets: ctx.secrets,
      child: options.child ?? { error: `sidecar ${def.name}: no child command (no app entry)` },
      ...(options.requireBase
        ? {
          requireBase: options.requireBase,
          modulesPath: join(dirname(options.requireBase), "node_modules"),
        }
        : {}),
    });
    const instance: SidecarInstance = {
      exited,
      stop: (graceMs) => {
        if (ended) return exited.then(() => {});
        return new Promise<void>((resolve) => {
          const timer = setTimeout(() => end({ code: 0 }), graceMs);
          onDone = () => {
            clearTimeout(timer);
            end({ code: 0 });
          };
          exited.then(() => {
            clearTimeout(timer);
            resolve();
          });
          try {
            worker.postMessage({ t: "shutdown" });
          } catch {
            end({ code: 0 });
          }
        });
      },
    };
    return Promise.resolve(instance);
  };
}

/** The runtime's own variables a program must not inherit (its page transport, relay, origin). */
function isRuntimeVariable(name: string): boolean {
  return name === "DENO_SERVE_ADDRESS" || name.startsWith("DENO_DESKTOP_") ||
    name === "DENO_INTERNAL_CHILD_ENTRYPOINT";
}

/**
 * The environment a program sidecar starts with: the app's (without the runtime's own variables),
 * then `extra`.
 *
 * @param base The app's environment.
 * @param extra The sidecar's variables.
 * @returns The environment.
 */
export function execSidecarEnv(
  base: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (!isRuntimeVariable(k)) out[k] = v;
  return { ...out, ...extra };
}

/** Options for {@linkcode execSidecarLauncher}. */
export interface ExecLauncherOptions {
  /** The program to spawn (resolved: absolute, or a bare name looked up on `PATH`). */
  readonly program: string;
  /** Its working directory. */
  readonly cwd?: string;
  /** The program's spawner (tests pass a fake `Deno.Command`). */
  readonly Command?: typeof Deno.Command;
  /** The spawner of a program with `run.bootstrapFd` (default `node:child_process`'s). */
  readonly spawn?: typeof nodeSpawn;
}

/** A running program, whichever way it was spawned: what the exec launcher drives. */
interface ProgramChild {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<{ readonly code: number; readonly signal: string | null }>;
  kill(signal?: Deno.Signal): void;
}

/** What spawning a program takes. */
interface ProgramSpawn {
  readonly program: string;
  readonly args: string[];
  readonly cwd?: string;
  readonly env: Record<string, string>;
}

/**
 * Spawn a program with one more pipe on descriptor `fd` (3 to 9; those below it closed), write
 * `line` to it and close it. Resolves once the program has started; rejects as `Deno.Command`
 * would (a missing program is `NotFound`).
 */
async function spawnWithBootstrapFd(
  o: ProgramSpawn,
  fd: number,
  line: string,
  spawnOverride?: typeof nodeSpawn,
): Promise<ProgramChild> {
  // Loaded only for such a program: an app without one never pays for Node's child_process.
  const spawn = spawnOverride ?? (await import("node:child_process")).spawn;
  const stream = await import("node:stream");
  const stdio = ["pipe", "pipe", "pipe", ...Array(fd - 3).fill("ignore"), "pipe"] as const;
  const child = spawn(o.program, o.args, {
    ...(o.cwd ? { cwd: o.cwd } : {}),
    env: o.env, // the whole environment, as `clearEnv` + `env` give Deno.Command
    stdio: [...stdio],
    windowsHide: true,
  });
  const status = new Promise<{ code: number; signal: string | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal: signal ?? null }))
  );
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (err: Error & { code?: string }) =>
      reject(
        err.code === "ENOENT" ? new Deno.errors.NotFound(`${o.program}: ${err.message}`) : err,
      ));
  });
  const pipe = child.stdio[fd] as Writable;
  // A program that never reads it must not hold the launch up, nor an EPIPE end the app.
  pipe.on("error", () => {});
  pipe.end(line);
  return {
    pid: child.pid!,
    stdin: stream.Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    stdout: stream.Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    stderr: stream.Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
    status,
    kill: (signal) => {
      child.kill(signal as Parameters<typeof child.kill>[0]);
    },
  };
}

/** Read `stream` line by line into `onLine` until it ends. */
async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  let buf = "";
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ""));
        buf = buf.slice(i + 1);
      }
    }
  } catch { /* the program went away */ }
  if (buf) onLine(buf);
}

/** The programs started by every exec launcher, for the synchronous kill at exit. */
const RUNNING = new Set<ProgramChild>();

/**
 * End every program sidecar now (synchronously): what the app does as it exits, and before a
 * full-app update is installed.
 */
export function killExecSidecars(): void {
  for (const child of RUNNING) {
    try {
      child.kill(Deno.build.os === "windows" ? undefined : "SIGTERM");
    } catch { /* already gone */ }
  }
}

/**
 * Spawn program sidecars.
 *
 * @param options The program, its working directory and (for tests) the spawner.
 * @returns The launcher.
 */
export function execSidecarLauncher(options: ExecLauncherOptions): SidecarLauncher {
  const Command = options.Command ?? Deno.Command;
  return async (ctx) => {
    const def = ctx.definition;
    if (options.cwd) await Deno.mkdir(options.cwd, { recursive: true });
    const spawn: ProgramSpawn = {
      program: options.program,
      args: sidecarArgs(def.args, ctx.port),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: execSidecarEnv(Deno.env.toObject(), sidecarEnv(ctx)),
    };
    const hello = JSON.stringify({
      name: def.name,
      port: ctx.port ?? null,
      bootstrap: ctx.bootstrap ?? null,
      secrets: ctx.secrets,
    }) + "\n";
    const fd = (def.run as { bootstrapFd?: number }).bootstrapFd;
    const child: ProgramChild = fd === undefined
      ? new Command(spawn.program, {
        args: spawn.args,
        ...(spawn.cwd ? { cwd: spawn.cwd } : {}),
        clearEnv: true,
        env: spawn.env,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn()
      : await spawnWithBootstrapFd(spawn, fd, hello, options.spawn);
    RUNNING.add(child);
    const writer = child.stdin.getWriter();
    // The program may not read stdin at all: never let a full pipe hold the launch up. With
    // `bootstrapFd` the line went there; stdin only stays open.
    if (fd === undefined) writer.write(new TextEncoder().encode(hello)).catch(() => {});
    const pumps = Promise.all([
      pumpLines(child.stdout, (l) => ctx.onLine("stdout", l)),
      pumpLines(child.stderr, (l) => ctx.onLine("stderr", l)),
    ]);
    const exited = child.status.then(async (s): Promise<SidecarExit> => {
      RUNNING.delete(child);
      writer.close().catch(() => {});
      await pumps;
      return s.signal ? { signal: s.signal } : { code: s.code };
    });
    return {
      pid: child.pid,
      exited,
      stop: async (graceMs) => {
        try {
          child.kill(Deno.build.os === "windows" ? undefined : "SIGTERM");
        } catch { /* already gone */ }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const killed = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch { /* gone */ }
            resolve();
          }, graceMs);
        });
        await Promise.race([exited.then(() => {}), killed]);
        clearTimeout(timer);
        await exited;
      },
    };
  };
}

/**
 * The path the runtime keeps a program at (`sidecarRecordedProgram`'s layout), when the app's
 * writes are denied there; else `undefined`.
 */
async function runtimeKeptProgram(
  cacheDir: string,
  name: string,
  file: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string | undefined> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  const path = join(cacheDir, "sidecars", name, sha256, file);
  return (await Deno.permissions.query({ name: "write", path })).state === "denied"
    ? path
    : undefined;
}

/**
 * Where a program sidecar runs from. An absolute path or a bare name (looked up on `PATH`) is used
 * as written. A project-relative path is the project's file in an unpackaged run; in a packaged app
 * it is embedded in the binary. A runtime that checks the program at spawn keeps it itself, in a
 * folder named by the hash and denied to the app's writes (Brainwires/deno DENEXT.md item 232), so
 * this only returns that path: the denial is what says so, since a grant packaged for a runtime
 * without the check leaves that folder writable. Otherwise the program is copied out (once per
 * content) to `<cacheDir>/sidecars/<name>/` and made executable.
 *
 * @param exec The configured program.
 * @param name The sidecar's name.
 * @param base The entry's `import.meta.url`.
 * @param cacheDir The app's cache folder.
 * @param standalone Whether this is a compiled (packaged) app.
 * @returns The path to spawn.
 */
export async function resolveSidecarProgram(
  exec: string,
  name: string,
  base: string | undefined,
  cacheDir: string | undefined,
  standalone: boolean,
): Promise<string> {
  if (isAbsolute(exec) || !/[\\/]/.test(exec) || !base) return exec;
  const sourcePath = fromFileUrl(new URL(exec, base));
  if (!standalone || !cacheDir) return sourcePath;
  const bytes = await Deno.readFile(sourcePath);
  const kept = await runtimeKeptProgram(cacheDir, name, basename(sourcePath), bytes);
  if (kept) return kept;
  const target = join(cacheDir, "sidecars", name, basename(sourcePath));
  const current = await Deno.readFile(target).catch(() => null);
  if (!current || current.length !== bytes.length || !current.every((b, i) => b === bytes[i])) {
    await Deno.mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    await Deno.writeFile(temp, bytes, { mode: 0o755 });
    await Deno.rename(temp, target);
  }
  if (Deno.build.os !== "windows") await Deno.chmod(target, 0o755);
  return target;
}

/** The parts of Node's `ChildProcess` the detached launcher drives. */
interface DetachedChildProcess {
  readonly pid?: number;
  send(msg: unknown): boolean;
  disconnect(): void;
  unref(): void;
  kill(signal?: string): boolean;
  readonly connected: boolean;
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  off(event: string, fn: (...args: unknown[]) => void): unknown;
}

/** Options for {@linkcode detachedSidecarLauncher}. */
export interface DetachedLauncherOptions {
  /** How the app starts itself again (`parentChildBase`); a base with an `error` fails each start. */
  readonly child: SidecarChildBase;
  /** The app's registry folder (`<app data>/sidecars`). */
  readonly registryDir: string;
  /** The log file its output is appended to (`logs: "file"` / `"both"`); without it, none. */
  readonly logFile?: string;
  /** The app's version (`currentAppVersion()`). */
  readonly appVersion: string;
  /** How often the sidecar re-reads its record (default 30 000 ms; tests shorten it). */
  readonly recordPollMs?: number;
  /** The log file size that rotates it to `.1`, at a start and while it runs (default 5 MB). */
  readonly logRotateBytes?: number;
  /** The forced kill (tests). */
  readonly stopOptions?: DetachedStopOptions;
}

/** What the start under the lock found or made. */
interface DetachedAttach {
  readonly session: DetachedSession;
  readonly record: DetachedRecord;
  readonly reattached: boolean;
}

/** The log file's descriptor (appended, `0600`), rotated to `.1` once it outgrew `rotateBytes`. */
async function openDetachedLog(path: string, rotateBytes: number): Promise<number> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const size = await Deno.stat(path).then((s) => s.size, () => 0);
  if (size > rotateBytes) await Deno.rename(path, `${path}.1`).catch(() => {});
  const fs = await import("node:fs");
  return fs.openSync(path, "a", 0o600);
}

/** The child's `{ t: "control", port, pid }`, or a rejection once it ends or `ms` passed. */
function controlMessage(
  child: DetachedChildProcess,
  ms: number,
): Promise<{ port: number; pid: number }> {
  return new Promise((resolve, reject) => {
    const off = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onMessage = (m: unknown) => {
      const msg = m as { t?: unknown; port?: unknown; pid?: unknown } | null;
      if (msg?.t !== "control" || typeof msg.port !== "number" || typeof msg.pid !== "number") {
        return;
      }
      off();
      resolve({ port: msg.port, pid: msg.pid });
    };
    const onExit = (code: unknown, signal: unknown) => {
      off();
      reject(new Error(`exited before it served its control endpoint (${signal ?? code})`));
    };
    const onError = (err: unknown) => {
      off();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const timer = setTimeout(() => {
      off();
      reject(new Error(`did not serve its control endpoint within ${ms} ms`));
    }, ms);
    child.on("message", onMessage);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

/** What one fresh start has made: the key and its moment. */
interface DetachedStart {
  readonly key: string;
  readonly startedAt: number;
}

/** The `init` message a fresh detached process gets over its IPC channel (the key travels only here). */
function detachedInit(o: DetachedLauncherOptions, ctx: SidecarLaunchContext, start: DetachedStart) {
  const def = ctx.definition;
  const { exitAfterMs } = detachedOptions(def);
  return {
    t: "init",
    name: def.name,
    ...(ctx.port !== undefined ? { port: ctx.port } : {}),
    bootstrap: ctx.bootstrap ?? null,
    secrets: ctx.secrets,
    key: start.key,
    appVersion: o.appVersion,
    startedAt: start.startedAt,
    ...(exitAfterMs !== undefined ? { exitAfterMs } : {}),
    recordPath: detachedRecordPath(o.registryDir, def.name),
    ...(o.recordPollMs !== undefined ? { recordPollMs: o.recordPollMs } : {}),
    graceMs: def.shutdown?.graceMs ?? SIDECAR_DEFAULTS.graceMs,
    // The process rotates its own log while it runs (the app's rotation covers only a start).
    ...(o.logFile !== undefined
      ? { logFile: o.logFile, logRotateBytes: o.logRotateBytes ?? 5 * 1024 * 1024 }
      : {}),
  };
}

/** The registry record of a fresh start, once the process reported its endpoint. */
function detachedRecordOf(
  o: DetachedLauncherOptions,
  ctx: SidecarLaunchContext,
  start: DetachedStart,
  control: { port: number; pid: number },
): DetachedRecord {
  return {
    v: 1,
    name: ctx.definition.name,
    pid: control.pid,
    startedAt: start.startedAt,
    appVersion: o.appVersion,
    control: { host: "127.0.0.1", port: control.port },
    key: start.key,
    ...(ctx.port !== undefined ? { port: ctx.port } : {}),
    ...(ctx.values !== undefined ? { values: ctx.values } : {}),
    secrets: ctx.secrets,
  };
}

/**
 * Spawn the app's executable as the detached process: in a session of its own, stdin closed, its
 * output appended to the log file (an open descriptor it keeps) or dropped, an IPC channel.
 */
async function spawnDetachedProcess(
  o: DetachedLauncherOptions,
  ctx: SidecarLaunchContext,
): Promise<DetachedChildProcess> {
  const helpers = await import(sidecarChildHelpersUrl()) as {
    childHelpers(base: SidecarChildBase): {
      spawnSelf(args: string[], options: Record<string, unknown>): DetachedChildProcess;
    };
  };
  const fd = o.logFile
    ? await openDetachedLog(o.logFile, o.logRotateBytes ?? 5 * 1024 * 1024)
    : undefined;
  const out = fd ?? "ignore";
  try {
    // spawnSelf checks the run permission (the same message as a sidecar's own spawnSelf) and
    // keeps the runtime's own variables out of the child's environment.
    const child = helpers.childHelpers(o.child).spawnSelf(
      sidecarArgs(ctx.definition.args, ctx.port),
      {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", out, out, "ipc"],
        // The app's environment where it may read it whole (`envAll`: `{}` under a scoped
        // `--allow-env`), then the sidecar's own variables.
        env: { ...envAll(), ...sidecarEnv(ctx), [SIDECAR_DETACHED_ENV]: "1" },
      },
    );
    // A failed spawn (a missing executable) is an `error` event: never an uncaught one. The wait
    // for the control message reports it.
    child.on("error", () => {});
    return child;
  } finally {
    if (fd !== undefined) (await import("node:fs")).closeSync(fd);
  }
}

/** End a detached process this launch spawned but could not attach to (by its handle). */
function abandonDetached(child: DetachedChildProcess): void {
  try {
    child.kill("SIGKILL"); // our own child, by its handle: never a pid read from anywhere
  } catch { /* gone */ }
  try {
    if (child.connected) child.disconnect();
  } catch { /* gone */ }
}

/** Start a fresh detached process, record it and attach: under the start lock. */
async function spawnDetached(
  o: DetachedLauncherOptions,
  ctx: SidecarLaunchContext,
): Promise<DetachedAttach> {
  const def = ctx.definition;
  const start: DetachedStart = { key: newDetachedKey(), startedAt: Date.now() };
  const child = await spawnDetachedProcess(o, ctx);
  try {
    child.send(detachedInit(o, ctx, start));
    const control = await controlMessage(
      child,
      def.ready?.timeoutMs ?? SIDECAR_DEFAULTS.readyTimeoutMs,
    );
    const record = detachedRecordOf(o, ctx, start, control);
    await writeDetachedRecord(o.registryDir, record);
    const session = await connectDetachedControl({
      port: control.port,
      key: start.key,
      name: def.name,
    });
    if (!session) {
      await removeDetachedRecord(o.registryDir, def.name, start.key);
      throw new Error("its control endpoint did not authenticate");
    }
    // Attached: nothing ties the process to the app any more.
    child.disconnect();
    child.unref();
    return { session, record, reattached: false };
  } catch (err) {
    abandonDetached(child);
    throw err;
  }
}

/**
 * The recorded instance's session when it runs and authenticates, or `null` when the record is
 * stale (dropped). A recorded instance that accepts the connection but is slow to answer is alive
 * (its event loop is busy): waited for, then the start fails rather than run a second one.
 */
async function recordedSession(
  o: DetachedLauncherOptions,
  def: SidecarDefinition,
  record: DetachedRecord,
): Promise<DetachedSession | null> {
  const probe = await probeDetachedRecordState(
    record,
    o.stopOptions?.busyWaitMs ?? def.ready?.timeoutMs ?? SIDECAR_DEFAULTS.readyTimeoutMs,
  );
  if (probe.state === "busy") {
    throw new Error(
      `its recorded instance (process ${record.pid}) is running but did not answer its ` +
        `control connection within ${probe.waitedMs} ms; not starting a second one`,
    );
  }
  if (probe.state === "session") return probe.session;
  // Stale (a reboot, a crash, another process on its port): dropped, its pid never touched.
  await removeDetachedRecord(o.registryDir, def.name, record.key);
  return null;
}

/** Shut down a running instance another app version started, and drop its record. */
async function replaceOtherVersion(
  o: DetachedLauncherOptions,
  def: SidecarDefinition,
  record: DetachedRecord,
  session: DetachedSession,
): Promise<void> {
  const graceMs = def.shutdown?.graceMs ?? SIDECAR_DEFAULTS.graceMs;
  const result = await endDetachedSession(session, graceMs, o.stopOptions);
  await removeDetachedRecord(o.registryDir, def.name, record.key);
  if (!result.ended) {
    throw new Error(`the instance app version ${record.appVersion} started ${result.reason}`);
  }
}

/** Reattach to the recorded instance, replace it, or start a fresh one: under the start lock. */
async function attachOrStart(
  o: DetachedLauncherOptions,
  ctx: SidecarLaunchContext,
): Promise<DetachedAttach> {
  const def = ctx.definition;
  const record = await readDetachedRecord(o.registryDir, def.name);
  const session = record ? await recordedSession(o, def, record) : null;
  if (record && session) {
    if (record.appVersion === o.appVersion || detachedOptions(def).keepAcrossUpdates) {
      return { session, record, reattached: true };
    }
    await replaceOtherVersion(o, def, record, session);
  }
  return await spawnDetached(o, ctx);
}

/** How the session's end reads as the sidecar's exit. */
function detachedExit(end: DetachedEnd, asked: boolean): SidecarExit {
  if (asked) return { code: 0 };
  if (end.bye?.error !== undefined) return { error: end.bye.error };
  if (end.bye) return { code: end.bye.code ?? 0 };
  return { error: "the detached sidecar ended (its control connection closed)" };
}

/**
 * Run a detached module sidecar as its own process, or reattach to the one running. Each start
 * takes the sidecar's start lock (`withDetachedLock`): a recorded instance whose endpoint
 * authenticates is reattached when it runs this app version (or `keepAcrossUpdates`), else asked to
 * shut down and replaced; a stale record is dropped. A fresh process gets its init over the IPC
 * channel, reports its control endpoint, is recorded and authenticated, then the channel is dropped
 * and the process unreferenced. The instance's `exited` settles when the control connection closes;
 * `stop()` ends the process (shutdown, then a forced kill of the authenticated pid where permitted)
 * and removes the record; `detach()` only closes the connection.
 *
 * @param options The child base, the registry, the log file and the app version.
 * @returns The launcher.
 */
export function detachedSidecarLauncher(options: DetachedLauncherOptions): SidecarLauncher {
  return async (ctx) => {
    const def: SidecarDefinition = ctx.definition;
    if ("error" in options.child) throw new Error(options.child.error);
    const { session, record, reattached } = await withDetachedLock(
      options.registryDir,
      def.name,
      () => attachOrStart(options, ctx),
    );
    if (!session.ready) void session.whenReady().then(() => ctx.onReadySignal());
    else ctx.onReadySignal();
    let asked = false;
    let detached = false;
    const exited = session.closed.then((end) => detachedExit(end, asked || detached));
    return {
      pid: session.info.pid,
      exited,
      detached: true,
      reattached,
      ready: reattached && session.ready,
      ...(record.port !== undefined ? { port: record.port } : {}),
      ...(record.values !== undefined ? { values: record.values } : {}),
      detach: () => {
        detached = true;
        session.close();
      },
      stop: async (graceMs) => {
        asked = true;
        const result = await endDetachedSession(session, graceMs, options.stopOptions);
        await removeDetachedRecord(options.registryDir, def.name, record.key);
        if (!result.ended) throw new Error(`sidecar ${def.name}: ${result.reason}`);
      },
    };
  };
}
