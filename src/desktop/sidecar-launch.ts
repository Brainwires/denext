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
 * `ready()`, `onShutdown(fn)`), and routes its console and `process.stdout` / `process.stderr` to
 * the app as lines. An uncaught error, `process.exit()` and
 * `self.close()` end the worker only, never the app. What a worker cannot contain: a V8
 * out-of-memory abort and a crash in a native addon end the whole app.
 *
 * A program gets the login-shell variables it asked for, its `env` and its port on top of the app's
 * environment (without the runtime's own `DENO_SERVE_ADDRESS` / `DENO_DESKTOP_*`), and one JSON
 * line on stdin: `{"name","port","bootstrap","secrets"}`. Its stdin then stays open for as long as
 * the app runs, so a program that exits on end-of-file on stdin never outlives the app, however
 * the app ends.
 *
 * Runtime-only (imported by `runDesktop`, never a client bundle).
 *
 * @module
 */

import { basename, dirname, fromFileUrl, isAbsolute, join } from "@std/path";
import type { SidecarExit } from "./sidecar.ts";
import type {
  SidecarInstance,
  SidecarLaunchContext,
  SidecarLauncher,
} from "./sidecar-supervisor.ts";

/**
 * The worker's wrapper module. Messages in: `init` (once), `shutdown`. Out: `line`, `ready`,
 * `exit`, `error`, `done` (shutdown handlers finished).
 */
const SIDECAR_WORKER_WRAPPER = `import process from "node:process";
import Module, { createRequire } from "node:module";
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
// without one): not a worker_threads worker, whose process.connected / channel / send throw.
for (const [key, value] of [["connected", false], ["channel", undefined], ["send", undefined], ["disconnect", undefined]]) {
  try { Object.defineProperty(process, key, { value, configurable: true, writable: true }); } catch { /* keep */ }
}
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
  if (m.requireBase) {
    globalThis.__denextSidecarRequire = createRequire(m.requireBase);
    // The backend's own createRequire(import.meta.url) resolves from the bundle: every lookup in
    // this worker also searches the unpacked packages.
    const extra = m.modulesPath;
    const paths = Module._nodeModulePaths;
    Module._nodeModulePaths = function (from) {
      const found = paths.call(this, from);
      return found.includes(extra) ? found : [...found, extra];
    };
  }
  try { process.env = { ...process.env, ...m.env }; } catch { /* keep the shared view */ }
  globalThis.denextSidecar = Object.freeze({
    name: m.name,
    port: m.port,
    bootstrap: m.bootstrap,
    secrets: Object.freeze({ ...m.secrets }),
    ready: () => post({ t: "ready" }),
    onShutdown: (fn) => { if (typeof fn === "function") handlers.push(fn); },
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
      new Blob([SIDECAR_WORKER_WRAPPER], { type: "text/javascript" }),
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
const RUNNING = new Set<Deno.ChildProcess>();

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
    const child = new Command(options.program, {
      args: sidecarArgs(def.args, ctx.port),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      clearEnv: true,
      env: execSidecarEnv(Deno.env.toObject(), sidecarEnv(ctx)),
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    RUNNING.add(child);
    const writer = child.stdin.getWriter();
    const hello = JSON.stringify({
      name: def.name,
      port: ctx.port ?? null,
      bootstrap: ctx.bootstrap ?? null,
      secrets: ctx.secrets,
    });
    // The program may not read stdin at all: never let a full pipe hold the launch up.
    writer.write(new TextEncoder().encode(hello + "\n")).catch(() => {});
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
 * Where a program sidecar runs from. An absolute path or a bare name (looked up on `PATH`) is used
 * as written. A project-relative path is the project's file in an unpackaged run; in a packaged app
 * it is embedded in the binary, so it is copied out (once per content) to
 * `<cacheDir>/sidecars/<name>/` and made executable.
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
  const target = join(cacheDir, "sidecars", name, basename(sourcePath));
  const bytes = await Deno.readFile(sourcePath);
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
