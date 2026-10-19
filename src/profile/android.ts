// `denext profile --android`: profile the app's WebView on an Android device (a Capacitor shell,
// or any debuggable WebView) over the remote Chrome DevTools Protocol, with the same CPU self-time,
// heap and leak pipeline as the local run (`profilePage` in core.ts). Nothing is built or served:
// the app is profiled as installed.
//
// How it reaches the page (the path chrome://inspect takes):
//   1. `adb devices` picks the device (`--device <serial>` when several are attached).
//   2. `adb shell cat /proc/net/unix` lists the abstract DevTools sockets; a debuggable WebView
//      listens on `@webview_devtools_remote_<pid>`. With a package (`--package`, else the
//      Capacitor config's appId) `adb shell pidof <package>` names the process.
//   3. `adb forward tcp:0 localabstract:<socket>` forwards a free local port to it (adb prints
//      the port), removed again when the run ends.
//   4. `GET /json/list` on that port lists the WebView's pages; the run attaches to the page's
//      `webSocketDebuggerUrl` and speaks CDP (Page, Runtime, Profiler, HeapProfiler) to it.
//
// Sources: https://developer.chrome.com/docs/devtools/remote-debugging/webviews (WebView debugging,
// `setWebContentsDebuggingEnabled`), https://chromedevtools.github.io/devtools-protocol/ (the
// /json/list endpoint and the domains used), and adb's `forward` (tcp:0 prints the chosen port).

import { adbDevices } from "../build/mobile-inspect.ts";
import { profilePage } from "./core.ts";
import type { ProfileOptions, ProfileResult } from "./types.ts";

/** Runs `adb` with `args` and resolves its exit code and output (tests pass a fake). */
export type AdbRunner = (
  args: readonly string[],
) => Promise<{ code: number; stdout: string; stderr?: string }>;

/** Options for an on-device run: the profile options plus which device and app. */
export interface AndroidProfileOptions extends ProfileOptions {
  /** The adb serial (`--device`); needed only when several devices are attached. */
  serial?: string;
  /** The app's package (`--package`, else the Capacitor appId) whose WebView to profile. */
  package?: string;
  /** How long one CDP command or a page load may take, in ms (default 60 000). */
  timeoutMs?: number;
}

/** The I/O an on-device run uses (tests replace both). */
export interface AndroidProfileDeps {
  /** Runs adb (default: `adb` on the PATH, or `$ADB`). */
  run?: AdbRunner;
  /** Fetches the forwarded `/json/list` (default: `fetch`). */
  fetch?: typeof fetch;
}

/** One entry of a DevTools `/json/list` answer (the fields read). */
export interface DevtoolsTarget {
  id: string;
  type: string;
  title?: string;
  url: string;
  /** Absent while another DevTools client is attached to the page. */
  webSocketDebuggerUrl?: string;
  /** A WebView page's JSON-encoded `{ attached, visible, empty, … }`. */
  description?: string;
}

/**
 * Runs the `adb` binary (`$ADB` when set).
 *
 * @param adb The binary.
 * @returns A runner.
 */
export function adbRunner(adb = Deno.env.get("ADB") || "adb"): AdbRunner {
  return async (args) => {
    let out: Deno.CommandOutput;
    try {
      out = await new Deno.Command(adb, { args: [...args], stdout: "piped", stderr: "piped" })
        .output();
    } catch {
      throw new Error(
        `denext profile --android: ${adb} is not on the PATH (install the Android SDK ` +
          "platform-tools, or point $ADB at adb).",
      );
    }
    const dec = new TextDecoder();
    return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
  };
}

const PREFIX = "denext profile --android:";

/** Run adb and return its stdout, or throw with its stderr. */
async function adb(run: AdbRunner, args: readonly string[]): Promise<string> {
  const out = await run(args);
  if (out.code !== 0) {
    const why = (out.stderr || out.stdout).trim();
    throw new Error(`${PREFIX} \`adb ${args.join(" ")}\` failed${why ? `: ${why}` : ""}`);
  }
  return out.stdout;
}

/**
 * The abstract DevTools socket names in `/proc/net/unix` (without the leading `@`).
 *
 * @param procNetUnix The file's content.
 * @returns The unique names ending in `devtools_remote` or `devtools_remote_<pid>`.
 */
export function devtoolsSockets(procNetUnix: string): string[] {
  const names = new Set<string>();
  for (const line of procNetUnix.split("\n")) {
    const last = line.trim().split(/\s+/).pop() ?? "";
    if (/^@[\w.]*devtools_remote(_\d+)?$/.test(last)) names.add(last.slice(1));
  }
  return [...names];
}

/** The device to profile: `serial` when given (and ready), else the single ready one. */
async function pickDevice(run: AdbRunner, serial?: string): Promise<string> {
  const { ready, unauthorized } = adbDevices(await adb(run, ["devices"]));
  if (serial) {
    if (ready.includes(serial)) return serial;
    const state = unauthorized.includes(serial) ? "is unauthorized (accept the prompt)" : "";
    throw new Error(`${PREFIX} device ${serial} ${state || "is not attached"}.`);
  }
  if (ready.length === 1) return ready[0];
  if (ready.length === 0) {
    const hint = unauthorized.length > 0
      ? ` ${unauthorized.join(", ")} unauthorized: accept the "Allow USB debugging" prompt.`
      : " Connect one with USB debugging on, or start an emulator.";
    throw new Error(`${PREFIX} adb sees no device.${hint}`);
  }
  throw new Error(`${PREFIX} ${ready.length} devices attached; pick one with --device <serial>.`);
}

/** The WebView socket of `pkg`'s process, or the only debuggable WebView. */
async function pickSocket(
  run: AdbRunner,
  serial: string,
  pkg?: string,
): Promise<{ socket: string; package?: string }> {
  const sockets = devtoolsSockets(await adb(run, ["-s", serial, "shell", "cat", "/proc/net/unix"]))
    .filter((s) => /^webview_devtools_remote_\d+$/.test(s));
  if (pkg) {
    const pidOut = await run(["-s", serial, "shell", "pidof", pkg]);
    const pid = pidOut.code === 0 ? pidOut.stdout.trim().split(/\s+/)[0] : "";
    if (!pid) throw new Error(`${PREFIX} ${pkg} is not running on ${serial}; open the app first.`);
    const socket = `webview_devtools_remote_${pid}`;
    if (!sockets.includes(socket)) {
      throw new Error(
        `${PREFIX} ${pkg} (pid ${pid}) has no debuggable WebView: run a debug build, or one with ` +
          "android.webContentsDebuggingEnabled: true.",
      );
    }
    return { socket, package: pkg };
  }
  if (sockets.length === 1) return { socket: sockets[0] };
  if (sockets.length === 0) {
    throw new Error(
      `${PREFIX} no debuggable WebView is running on ${serial}: open a debug build of the app.`,
    );
  }
  throw new Error(
    `${PREFIX} ${sockets.length} debuggable WebViews (${sockets.join(", ")}); pick the app with ` +
      "--package <appId>.",
  );
}

/**
 * The page to attach to: a `page` target that can take a client, the attached + visible
 * WebView page first.
 *
 * @param targets The `/json/list` answer.
 * @returns The target.
 * @throws {Error} No page, or every page already has a DevTools client.
 */
export function pickPage(targets: readonly DevtoolsTarget[]): DevtoolsTarget {
  const pages = targets.filter((t) => t.type === "page");
  if (pages.length === 0) throw new Error(`${PREFIX} the WebView lists no page.`);
  const free = pages.filter((t) => t.webSocketDebuggerUrl);
  if (free.length === 0) {
    throw new Error(
      `${PREFIX} another DevTools client is attached to the page; close its chrome://inspect ` +
        "window and run again.",
    );
  }
  const shown = (t: DevtoolsTarget) => {
    try {
      const d = JSON.parse(t.description ?? "{}") as { attached?: boolean; visible?: boolean };
      return d.attached === true && d.visible !== false;
    } catch {
      return false;
    }
  };
  return free.find(shown) ?? free[0];
}

/** A pending CDP command. */
interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A CDP message: a response (`id`) or an event (`method`). */
interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** Parse one frame, or null when it is not JSON. */
function parseMessage(raw: string): CdpMessage | null {
  try {
    return JSON.parse(raw) as CdpMessage;
  } catch {
    return null;
  }
}

/** A minimal CDP client over one page's WebSocket: commands and one-shot event waits. */
export class CdpConnection {
  #ws: WebSocket;
  #next = 1;
  #pending = new Map<number, Pending>();
  #waiters = new Map<string, Array<(params: unknown) => void>>();
  #timeoutMs: number;

  private constructor(ws: WebSocket, timeoutMs: number) {
    this.#ws = ws;
    this.#timeoutMs = timeoutMs;
    ws.onmessage = (e) => this.#onMessage(String(e.data));
    ws.onclose = () => this.#failAll(new Error(`${PREFIX} the DevTools connection closed.`));
  }

  /**
   * Connect to a page's `webSocketDebuggerUrl`.
   *
   * @param url The WebSocket URL.
   * @param timeoutMs The per-command timeout.
   * @returns The open connection.
   */
  static open(url: string, timeoutMs = 60_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new CdpConnection(ws, timeoutMs));
      ws.onerror = () => reject(new Error(`${PREFIX} could not connect to ${url}.`));
    });
  }

  #onMessage(raw: string): void {
    const msg = parseMessage(raw);
    if (typeof msg?.id === "number") this.#onResponse(msg.id, msg);
    else if (msg?.method) this.#onEvent(msg.method, msg.params);
  }

  #onResponse(id: number, msg: CdpMessage): void {
    const p = this.#pending.get(id);
    if (!p) return;
    this.#pending.delete(id);
    clearTimeout(p.timer);
    if (msg.error) {
      p.reject(
        new Error(`${PREFIX} CDP error ${msg.error.code ?? ""}: ${msg.error.message ?? ""}`),
      );
    } else p.resolve(msg.result ?? {});
  }

  #onEvent(method: string, params: unknown): void {
    const waiting = this.#waiters.get(method);
    if (!waiting?.length) return;
    this.#waiters.delete(method);
    for (const w of waiting) w(params);
  }

  #failAll(err: Error): void {
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
  }

  /**
   * Send a command.
   *
   * @param method The CDP method (`Domain.command`).
   * @param params Its parameters.
   * @returns The result.
   */
  send<T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> {
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${PREFIX} ${method} timed out after ${this.#timeoutMs} ms.`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.#ws.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
    });
  }

  /**
   * Resolve on the next `event`. Register before sending the command that causes it.
   *
   * @param event The CDP event (`Domain.event`).
   * @returns Its params.
   */
  once(event: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const waiter = (params: unknown) => {
        clearTimeout(timer);
        resolve(params);
      };
      const timer = setTimeout(() => {
        const list = this.#waiters.get(event) ?? [];
        this.#waiters.set(event, list.filter((w) => w !== waiter));
        reject(new Error(`${PREFIX} no ${event} within ${this.#timeoutMs} ms.`));
      }, this.#timeoutMs);
      this.#waiters.set(event, [...(this.#waiters.get(event) ?? []), waiter]);
    });
  }

  /** Close the socket (pending commands reject). */
  close(): void {
    this.#ws.onclose = null;
    this.#failAll(new Error(`${PREFIX} the DevTools connection closed.`));
    try {
      this.#ws.close();
    } catch { /* already closed */ }
  }
}

/** A `Runtime.evaluate` answer (the fields read). */
interface EvaluateResult {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/**
 * The page + domain objects `profilePage` drives, over a raw CDP connection: `goto` navigates
 * and waits for the load event, `evaluate` runs a script (awaiting a promise), and `heapBytes`
 * reads `Runtime.getHeapUsage` (exact, unlike a WebView's quantised `performance.memory`).
 *
 * @param conn The connection.
 * @returns `{ page, cdp }`.
 */
export function remotePage(conn: CdpConnection) {
  const page = {
    async goto(url: string): Promise<void> {
      const loaded = conn.once("Page.loadEventFired");
      // A failed navigation never loads; its waiter's timeout must not surface unhandled.
      loaded.catch(() => {});
      const nav = await conn.send<{ errorText?: string }>("Page.navigate", { url });
      if (nav.errorText) throw new Error(`${PREFIX} could not open ${url}: ${nav.errorText}`);
      await loaded;
    },
    async evaluate(expression: string): Promise<unknown> {
      const r = await conn.send<EvaluateResult>("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error(`${PREFIX} the script threw: ${d.exception?.description ?? d.text ?? ""}`);
      }
      return r.result?.value;
    },
    async heapBytes(): Promise<number> {
      const { usedSize } = await conn.send<{ usedSize?: number }>("Runtime.getHeapUsage");
      return typeof usedSize === "number" ? usedSize : 0;
    },
  };
  const domain = (name: string) =>
    new Proxy({}, {
      get: (_t, cmd) => (params?: unknown) => conn.send(`${name}.${String(cmd)}`, params),
    });
  const cdp = { Profiler: domain("Profiler"), HeapProfiler: domain("HeapProfiler") };
  return { page, cdp };
}

/** List the forwarded port's pages. */
async function listTargets(port: number, fetchFn: typeof fetch): Promise<DevtoolsTarget[]> {
  const res = await fetchFn(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`${PREFIX} /json/list answered ${res.status}.`);
  return await res.json() as DevtoolsTarget[];
}

/** The page's WebSocket URL, pointed at the forwarded port (WebViews may name another host). */
function socketUrl(target: DevtoolsTarget, port: number): string {
  const url = new URL(target.webSocketDebuggerUrl!);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return url.href;
}

/**
 * Profile the app's WebView on an Android device: forward its DevTools socket, attach to the page
 * and run `denext profile`'s startup or interaction capture against the page's own origin.
 *
 * @param options The run's options (route, interaction, budget, …) plus the device and package.
 * @param deps adb and fetch (tests pass fakes).
 * @returns The result, with `device` set and `origin` the WebView's (e.g. https://localhost).
 */
export async function profileAndroid(
  options: AndroidProfileOptions = {},
  deps: AndroidProfileDeps = {},
): Promise<ProfileResult> {
  const run = deps.run ?? adbRunner();
  const fetchFn = deps.fetch ?? fetch;
  const serial = await pickDevice(run, options.serial);
  const { socket, package: pkg } = await pickSocket(run, serial, options.package);
  const forwarded = (await adb(run, [
    "-s",
    serial,
    "forward",
    "tcp:0",
    `localabstract:${socket}`,
  ])).trim();
  const port = Number(forwarded);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `${PREFIX} adb forward did not print a port (got ${JSON.stringify(forwarded)}).`,
    );
  }
  let conn: CdpConnection | undefined;
  try {
    const target = pickPage(await listTargets(port, fetchFn));
    const origin = new URL(target.url).origin;
    if (origin === "null") throw new Error(`${PREFIX} the page (${target.url}) has no origin.`);
    conn = await CdpConnection.open(socketUrl(target, port), options.timeoutMs);
    const { page, cdp } = remotePage(conn);
    await conn.send("Page.enable");
    await conn.send("Runtime.enable");
    const result = await profilePage(page, cdp, origin, options);
    return { ...result, device: { serial, socket, ...(pkg ? { package: pkg } : {}) } };
  } finally {
    conn?.close();
    await run(["-s", serial, "forward", "--remove", `tcp:${port}`]).catch(() => {});
  }
}
