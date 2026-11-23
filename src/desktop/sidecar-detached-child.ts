/**
 * A detached sidecar's own process: the app's executable started again, headless, by the app's
 * detached launcher (`detachedSidecarLauncher` in `sidecar-launch.ts`), with
 * `DENEXT_SIDECAR_CHILD=<name>`, `DENEXT_SIDECAR_DETACHED=1` and a Node IPC channel. Before the
 * sidecar's module is imported, denext's code here:
 *
 * 1. takes the app's `init` message over the IPC channel (`name`, `port`, `bootstrap`, `secrets`,
 *    the control `key`, `appVersion`, `exitAfterMs`, the record's path, the shutdown grace): the key
 *    never travels in argv or the environment;
 * 2. opens the loopback control endpoint (`serveDetachedControl`, `sidecar-detached.ts`) and tells
 *    the app its port and pid over the IPC channel, which the app then drops;
 * 3. installs `globalThis.denextSidecar` (`name`, `child: true`, `port`, `bootstrap`, `secrets`,
 *    `ready()` (told to the attached apps over the control connection), `onShutdown(fn)`,
 *    `detached: { attached, onAttachedChange(fn) }`, and `childCommand` / `spawnSelf`).
 *
 * Then it keeps the orphan policy: it ends itself gracefully when its registry record is gone,
 * unreadable or holds another key (re-read every 30 s and whenever an app detaches: the app was
 * uninstalled, its data reset, or another start replaced it), when no app attached within 30 s of
 * the start, and (`detached.exitAfterMs`) once no app has been attached for that long. It is never
 * restarted on its own; the OS ends it at logout.
 *
 * Runtime-only (imported by `sidecar-child.ts` in a detached sidecar's process).
 *
 * @module
 */

import {
  DETACHED_MAX_GRACE_MS,
  parseDetachedRecord,
  serveDetachedControl,
} from "./sidecar-detached.ts";
import { SIDECAR_DEFAULTS } from "./sidecar.ts";

/** The app's first (and only) IPC message to a detached sidecar's process. */
interface DetachedChildInit {
  /** `"init"`. */
  readonly t: "init";
  /** The sidecar's name. */
  readonly name: string;
  /** Its service port, when it has one. */
  readonly port?: number;
  /** Its `bootstrap` value. */
  readonly bootstrap?: unknown;
  /** Its secrets. */
  readonly secrets: Readonly<Record<string, string>>;
  /** The control key. */
  readonly key: string;
  /** The app version that starts it. */
  readonly appVersion: string;
  /** When the app started it (epoch ms). */
  readonly startedAt: number;
  /** End once no app was attached this long (none: never). */
  readonly exitAfterMs?: number;
  /** Its registry record. */
  readonly recordPath: string;
  /** How often the record is re-read (default 30 000 ms). */
  readonly recordPollMs?: number;
  /** The grace of a shutdown it starts itself (its `shutdown.graceMs`). */
  readonly graceMs?: number;
}

/** The `node:process` parts this module drives. */
export interface DetachedChildProcess {
  /** Send over the IPC channel. */
  send?: (msg: unknown) => unknown;
  /** Subscribe to the IPC channel's events. */
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  /** Unsubscribe. */
  off(event: string, fn: (...args: unknown[]) => void): unknown;
  /** The number of listeners of an event (`SIGTERM`). */
  listenerCount(event: string): number;
  /** Emit an event (`SIGTERM` to the module's listeners at shutdown). */
  emit(event: string, ...args: unknown[]): boolean;
}

/** Options for {@linkcode runDetachedSidecarChild}. */
export interface RunDetachedChildOptions {
  /** The sidecar's name (from the launch). */
  readonly name: string;
  /** The module to import once everything is in place. */
  readonly entry: string;
  /** `childCommand` / `spawnSelf` (from the shared helpers). */
  readonly childHelpers: Record<string, unknown>;
  /** This process's `node:process`. */
  readonly process: DetachedChildProcess;
  /** End the process (tests pass a fake). */
  readonly exit?: (code: number) => void;
  /** How long to wait for `init` (default 30 000 ms). */
  readonly initTimeoutMs?: number;
  /** How long to wait for the first attachment (default 30 000 ms). */
  readonly firstAttachMs?: number;
}

/**
 * Why a message is not a valid {@linkcode DetachedChildInit}, or `null` when it is one.
 *
 * @param msg The message the app sent over the IPC channel.
 * @returns The first bad field (`"init.key"`), or `null`.
 */
export function detachedChildInitError(msg: unknown): string | null {
  const m = msg as Partial<DetachedChildInit> | null;
  if (typeof m !== "object" || m === null || m.t !== "init") return "not an init message";
  if (typeof m.name !== "string" || m.name === "") return "init.name";
  if (typeof m.key !== "string") return "init.key";
  if (typeof m.recordPath !== "string" || m.recordPath === "") return "init.recordPath";
  if (typeof m.appVersion !== "string") return "init.appVersion";
  if (typeof m.startedAt !== "number") return "init.startedAt";
  if (typeof m.secrets !== "object" || m.secrets === null) return "init.secrets";
  if (m.port !== undefined && typeof m.port !== "number") return "init.port";
  if (m.exitAfterMs !== undefined && !(typeof m.exitAfterMs === "number" && m.exitAfterMs >= 0)) {
    return "init.exitAfterMs";
  }
  return null;
}

/** Wait for the app's `init` over the IPC channel. */
function receiveInit(proc: DetachedChildProcess, timeoutMs: number): Promise<DetachedChildInit> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      proc.off("message", onMessage);
      proc.off("disconnect", onDisconnect);
    };
    const onMessage = (msg: unknown) => {
      if ((msg as { t?: unknown } | null)?.t !== "init") return;
      done();
      const problem = detachedChildInitError(msg);
      if (problem) reject(new Error(`a detached sidecar got a bad init (${problem})`));
      else resolve(msg as DetachedChildInit);
    };
    const onDisconnect = () => {
      done();
      reject(new Error("the app dropped a detached sidecar's IPC channel before its init"));
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`a detached sidecar got no init within ${timeoutMs} ms`));
    }, timeoutMs);
    proc.on("message", onMessage);
    proc.on("disconnect", onDisconnect);
  });
}

/** Whether the record at `path` still holds `key`. */
async function recordHolds(path: string, key: string): Promise<boolean> {
  try {
    return parseDetachedRecord(await Deno.readTextFile(path))?.key === key;
  } catch {
    return false;
  }
}

/**
 * Run a detached sidecar's process: take the init, open the control endpoint, report it, install
 * `globalThis.denextSidecar`, keep the orphan policy, then import the module.
 *
 * @param options The launch, this process and (for tests) the exit.
 */
export async function runDetachedSidecarChild(options: RunDetachedChildOptions): Promise<void> {
  const proc = options.process;
  const exit = options.exit ?? ((code: number) => Deno.exit(code));
  if (typeof proc.send !== "function") {
    throw new Error(
      `sidecar ${options.name}: a detached sidecar's process needs the IPC channel its app ` +
        "starts it with",
    );
  }
  const init = await receiveInit(proc, options.initTimeoutMs ?? 30_000);
  if (init.name !== options.name) {
    throw new Error(`sidecar ${options.name}: the init names another sidecar (${init.name})`);
  }
  const graceMs = Math.min(init.graceMs ?? SIDECAR_DEFAULTS.graceMs, DETACHED_MAX_GRACE_MS);
  const handlers: Array<() => unknown> = [];
  const attachedListeners = new Set<(attached: boolean) => void>();
  let attached = false;
  let everAttached = false;
  let ending = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  /** Armed once the endpoint serves: no app attaching within the budget ends the process. */
  const firstAttach: { timer?: ReturnType<typeof setTimeout> } = {};

  const shutdown = async (grace: number, reason: string): Promise<void> => {
    if (ending) return;
    ending = true;
    clearTimeout(idleTimer);
    clearInterval(pollTimer);
    clearTimeout(firstAttach.timer);
    // Unconditional: past the grace the process ends, whatever the handlers do.
    setTimeout(() => exit(0), grace);
    await Promise.allSettled(handlers.map((fn) => (async () => await fn())()));
    try {
      if (proc.listenerCount("SIGTERM") > 0) proc.emit("SIGTERM", "SIGTERM");
    } catch { /* no signals here */ }
    await server.bye({ code: 0, reason });
    server.close();
    exit(0);
  };

  const checkRecord = async (): Promise<void> => {
    if (ending) return;
    if (!(await recordHolds(init.recordPath, init.key))) {
      void shutdown(graceMs, "its registry record is gone or was replaced");
    }
  };

  /** The first attachment: the start is complete, the record exists, its checks begin. */
  const firstAttachment = (): void => {
    everAttached = true;
    clearTimeout(firstAttach.timer);
    pollTimer = setInterval(
      () => void checkRecord(),
      init.recordPollMs ?? SIDECAR_DEFAULTS.detachedRecordPollMs,
    );
  };

  /** No app attached: check the record, and arm the idle exit (`exitAfterMs`). */
  const lastDetached = (): void => {
    void checkRecord();
    if (init.exitAfterMs === undefined || idleTimer !== undefined) return;
    idleTimer = setTimeout(
      () => void shutdown(graceMs, `no app attached for ${init.exitAfterMs} ms`),
      init.exitAfterMs,
    );
  };

  /** Tell the module's listeners. */
  const notifyAttached = (now: boolean): void => {
    for (const fn of [...attachedListeners]) {
      try {
        fn(now);
      } catch (err) {
        console.error(`sidecar ${init.name}: an onAttachedChange listener failed`, err);
      }
    }
  };

  const onAttachedChange = (count: number): void => {
    const now = count > 0;
    if (now && !everAttached) firstAttachment();
    if (now) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    } else lastDetached();
    if (now === attached) return;
    attached = now;
    notifyAttached(now);
  };

  const server = await serveDetachedControl({
    key: init.key,
    identity: {
      name: init.name,
      pid: Deno.pid,
      startedAt: init.startedAt,
      appVersion: init.appVersion,
    },
    onShutdown: (grace) => void shutdown(grace, "the app asked it to stop"),
    onAttachedChange,
  });
  firstAttach.timer = setTimeout(
    () => void shutdown(graceMs, "no app attached after the start"),
    options.firstAttachMs ?? 30_000,
  );
  proc.send({ t: "control", port: server.port, pid: Deno.pid });

  (globalThis as { denextSidecar?: unknown }).denextSidecar = Object.freeze({
    name: init.name,
    child: true,
    port: init.port,
    bootstrap: init.bootstrap,
    secrets: Object.freeze({ ...init.secrets }),
    ready: () => server.setReady(),
    onShutdown: (fn: unknown) => {
      if (typeof fn === "function") handlers.push(fn as () => unknown);
    },
    detached: Object.freeze({
      get attached() {
        return attached;
      },
      onAttachedChange(fn: unknown): () => void {
        if (typeof fn !== "function") return () => {};
        const listener = fn as (attached: boolean) => void;
        attachedListeners.add(listener);
        return () => void attachedListeners.delete(listener);
      },
    }),
    ...options.childHelpers,
  });
  try {
    await import(options.entry);
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`sidecar ${init.name}: ${message}`);
    // A shutdown that began while the module was still loading (the first-attach deadline, the
    // app's stop) already ends the process: never a second exit. Otherwise its deadline must not
    // fire after this exit (it held the event loop open).
    if (ending) return;
    clearTimeout(firstAttach.timer);
    ending = true;
    await server.bye({ code: 1, error: message, reason: "its module failed to load" });
    server.close();
    exit(1);
  }
}
