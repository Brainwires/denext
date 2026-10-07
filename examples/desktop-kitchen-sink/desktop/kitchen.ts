// The kitchen sink's own desktop extension (`desktop.capabilities.extensions`): it runs in the app's
// Deno process, and the page reaches it through the same token-gated bridge as the built-ins
// (`desktopExtension("kitchen")` in `denext/desktop/client`). It is also the window test's harness:
//
// - `setup` tells the page whether it was started by `e2e/window-test.ts` and in which phase (the
//   runner writes `kitchen-sink-runner.json` into the app's data folder before each launch, so a
//   process the updater relaunches finds it too);
// - `mark` / `report` hand progress markers and the results back to the runner as files, and
//   `markerExists` reads a marker back (a probe that must NOT have reached the extension), and
//   `markerRead` its content (the navigation phase's progress across a full-page load);
// - `secondInstance` asks the runner to start a second instance with some arguments and waits for
//   its exit code;
// - `diskRead` reads a file in the app's data folder straight from disk, so the page can prove a
//   `writeFile` went through the native `fs` capability and not a browser-storage fallback;
// - `crc32` loads a Node-API addon (`@node-rs/crc32`, prebuilt for every desktop OS) in this process;
// - `updateCheck` / `updateStatus` / `updateDownload` / `updateInstall` / `updateConfirm` drive
//   `denext/desktop/updater`'s full-app updater;
// - `tcpProbe` sends bridge requests carrying the page's token to the runtime's loopback TCP relay;
// - `browserLog` reads what the runner's stand-in system browser was asked to open;
// - `mainThread` calls a native thread-identity function through `ctx.runOnMainThread` and on the
//   JavaScript thread, so the page can prove the first ran on the UI thread;
// - `osAuthSession` reads `Deno.desktop.authSession.capabilities()`, checks that `start` answers
//   `not_supported` where the OS has no auth session, and on macOS runs an unattended ephemeral
//   round trip through a loopback page that redirects to the app's callback scheme;
// - `devtools`, `scheduledTags` read the runtime's DevTools switch and scheduled notifications, and
//   `synthetic` dispatches an OS event (a notification click, a shortcut press, a menu click) on the
//   runtime object that would fire it, for the plumbing no unattended test can press.

import { defineDesktopExtension } from "denext/desktop";
import {
  appUpdateStatus,
  checkForAppUpdate,
  confirmAppUpdate,
  downloadAppUpdate,
  installAppUpdateAndRelaunch,
} from "denext/desktop/updater";
import { join, resolve, SEPARATOR } from "@std/path";
import config from "../denext.config.ts";

/** The file the runner writes into the app's data folder before each launch. */
const RUNNER_FILE = "kitchen-sink-runner.json";

/** What the runner left for this launch (see `e2e/window-test.ts`). */
interface RunnerState {
  /** The runner's scratch folder for markers, requests and reports. */
  readonly out: string;
  /**
   * `main`, or which launch of the full-app update test this is: the runner writes `update` once,
   * and the phase follows from the updater's own status (see {@link updatePhase}), so a launch the
   * updater starts never races the runner.
   */
  readonly phase: string;
  /** The loopback base URL the signed update manifests are served from. */
  readonly updateBase: string | null;
  /** The Linux session as the runner sees it (`XDG_SESSION_TYPE` / `WAYLAND_DISPLAY`). */
  readonly sessionType: "wayland" | "x11" | "tty" | null;
  /** The packaged app's backend (the runner looks for libcef in the bundle). */
  readonly backend: "webview" | "cef" | null;
}

/** The runner's state, read once per launch (`null` when the app was opened by hand). */
let runnerState: Promise<RunnerState | null> | undefined;

function readRunnerState(dataDir: string): Promise<RunnerState | null> {
  runnerState ??= Deno.readTextFile(join(dataDir, RUNNER_FILE)).then(
    (text) => {
      const s = JSON.parse(text) as Partial<RunnerState>;
      if (typeof s.out !== "string" || typeof s.phase !== "string") return null;
      return {
        out: s.out,
        phase: s.phase === "update"
          ? updatePhase()
          : s.phase === "trusted"
          ? trustedPhase()
          : s.phase,
        updateBase: typeof s.updateBase === "string" ? s.updateBase : null,
        sessionType: s.sessionType === "wayland" || s.sessionType === "x11" ||
            s.sessionType === "tty"
          ? s.sessionType
          : null,
        backend: s.backend === "webview" || s.backend === "cef" ? s.backend : null,
      };
    },
    () => null,
  );
  return runnerState;
}

/**
 * Which update launch this is: after a rollback (`--denext-rolled-back-from`), the new version's
 * trial launch, or the original install that downloads and installs the update.
 */
function updatePhase(): string {
  const status = appUpdateStatus();
  if (status?.rolledBackFrom) return "update-rollback";
  if (status?.trial) return "update-trial";
  return "update-install";
}

/**
 * Which launch of the trusted (Authenticode-signed, Windows) update this is: the new version's
 * trial launch, its relaunch once confirmed (or after a rollback, which that phase's check then
 * reports), or the original A-signed install that refuses a B-signed build and installs the
 * A-signed one.
 */
function trustedPhase(): string {
  const status = appUpdateStatus();
  if (!status) return "trusted-install"; // not configured: that phase's first check says so
  if (status.trial) return "trusted-trial";
  if (status.rolledBackFrom || status.version !== "1.0.0") return "trusted-relaunch";
  return "trusted-install";
}

/** The runner's scratch folder (`undefined` outside the window test). */
async function outDir(dataDir: string): Promise<string | undefined> {
  return (await readRunnerState(dataDir))?.out;
}

function field(args: unknown, key: string): unknown {
  return typeof args === "object" && args !== null
    ? (args as Record<string, unknown>)[key]
    : undefined;
}

function stringField(args: unknown, key: string): string {
  const value = field(args, key);
  if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
  return value;
}

/** A marker name: letters, digits and dashes only (it becomes a file name). */
function safeName(name: string): string {
  if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new TypeError(`bad name ${JSON.stringify(name)}`);
  return name;
}

function message(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The error code of a refused updater call, or the result. */
async function updaterCall<T>(f: () => T | Promise<T>) {
  try {
    return { ok: true as const, result: await f() };
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    return { ok: false as const, code: String(e.code ?? "unknown"), message: String(e.message) };
  }
}

/** Updater options for the runner's loopback server (dev-only flags: an unsigned local build). */
function updaterConfig(url: string) {
  return { manifestUrl: url, allowInsecureLoopback: true, allowUnsignedDev: true };
}

/** Send `request` over a fresh TCP connection to `port` and return the response's status line. */
async function rawRequest(port: number, request: string): Promise<string> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    await conn.write(new TextEncoder().encode(request));
    const buf = new Uint8Array(4096);
    let text = "";
    const deadline = Date.now() + 5000;
    while (!text.includes("\r\n") && Date.now() < deadline) {
      const n = await Promise.race([conn.read(buf), sleep(5000).then(() => null)]);
      if (n === null) break;
      text += new TextDecoder().decode(buf.subarray(0, n));
    }
    return text.split("\r\n")[0] || "(connection closed without a response)";
  } finally {
    try {
      conn.close();
    } catch { /* already closed */ }
  }
}

export default defineDesktopExtension({
  name: "kitchen",
  methods: {
    setup: {
      handler: async (_args, ctx) => {
        const state = await readRunnerState(ctx.appSupportDir);
        const updateBase = state?.updateBase ?? null;
        return {
          autorun: state !== null,
          phase: state?.phase ?? "main",
          // The runner serves signed manifests here: a valid newer one, one signed by another key,
          // one offering an older version, one for another app, an expired one, one replaying a
          // lower sequence, a real update to install, and (Windows) the update build signed with
          // the app's own certificate and with another one.
          updateUrls: updateBase
            ? {
              good: `${updateBase}good.json`,
              badSignature: `${updateBase}bad-signature.json`,
              downgrade: `${updateBase}downgrade.json`,
              wrongApp: `${updateBase}wrong-app.json`,
              expired: `${updateBase}expired.json`,
              replayed: `${updateBase}replayed.json`,
              real: `${updateBase}real.json`,
              trustedA: `${updateBase}trusted-a.json`,
              trustedB: `${updateBase}trusted-b.json`,
            }
            : null,
          os: Deno.build.os,
          target: Deno.build.target,
          // The pinned runtime's `Deno.desktop` (the stock runtime has none).
          pinnedRuntime: typeof (Deno as { desktop?: unknown }).desktop === "object",
          // The fs capability's "data" folder (`moveToTrash` takes an absolute path inside it).
          dataDir: ctx.appSupportDir,
          pid: Deno.pid,
          // The RPs the passkeys capability pins (the manual passkey check offers them).
          passkeyRpIds: config.desktop.capabilities.passkeys.rpIds,
          // `desktop.app.origin`: the checks compare the page against the configured origin, so a
          // renamed copy of the kitchen sink (another identifier and scheme) passes too.
          appOrigin: config.desktop.app.origin ?? "",
          // The runner's session and backend facts, for a runtime that cannot report them itself.
          sessionType: state?.sessionType ?? null,
          backend: state?.backend ?? null,
        };
      },
    },
    mark: {
      handler: async (args, ctx) => {
        const dir = await outDir(ctx.appSupportDir);
        if (!dir) return { written: false };
        const data = field(args, "data");
        await Deno.writeTextFile(
          join(dir, `${safeName(stringField(args, "name"))}.marker`),
          typeof data === "string" ? data : "",
        );
        return { written: true };
      },
    },
    markerExists: {
      handler: async (args, ctx) => {
        const dir = await outDir(ctx.appSupportDir) ?? ctx.appSupportDir;
        const file = join(dir, `${safeName(stringField(args, "name"))}.marker`);
        return { exists: await Deno.stat(file).then(() => true, () => false) };
      },
    },
    markerRead: {
      handler: async (args, ctx) => {
        const dir = await outDir(ctx.appSupportDir);
        if (!dir) return { data: null };
        const file = join(dir, `${safeName(stringField(args, "name"))}.marker`);
        return { data: await Deno.readTextFile(file).catch(() => null) };
      },
    },
    report: {
      handler: async (args, ctx) => {
        const state = await readRunnerState(ctx.appSupportDir);
        const dir = state?.out ?? ctx.appSupportDir;
        const phase = state?.phase ?? "main";
        const report = {
          at: new Date().toISOString(),
          phase,
          pid: Deno.pid,
          results: field(args, "results"),
          expected: field(args, "expected"),
        };
        const file = join(dir, `kitchen-sink-report-${phase}.json`);
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(`${file}.tmp`, JSON.stringify(report, null, 2));
        await Deno.rename(`${file}.tmp`, file); // the runner never sees a half-written report
        console.log(`kitchen-sink: report written to ${file}`);
        return { file };
      },
    },
    secondInstance: {
      // The runner starts the process, which hands its arguments over and exits: allow it time.
      timeoutMs: 60_000,
      handler: async (args, ctx) => {
        const dir = await outDir(ctx.appSupportDir);
        if (!dir) throw new TypeError("not started by the window test");
        const argv = field(args, "args");
        if (!Array.isArray(argv) || !argv.every((a) => typeof a === "string")) {
          throw new TypeError("args must be a string array");
        }
        const id = safeName(stringField(args, "id"));
        const done = join(dir, `second-${id}.done.json`);
        await Deno.writeTextFile(
          join(dir, `second-${id}.request.json`),
          JSON.stringify({ args: argv }),
        );
        const until = Date.now() + 50_000;
        while (Date.now() < until) {
          const text = await Deno.readTextFile(done).catch(() => null);
          if (text !== null) return JSON.parse(text) as { code: number | null };
          await sleep(200);
        }
        return { code: null, timedOut: true };
      },
    },
    diskRead: {
      handler: async (args, ctx) => {
        const base = resolve(ctx.appSupportDir);
        const target = resolve(base, stringField(args, "path"));
        if (!target.startsWith(base + SEPARATOR)) {
          throw new TypeError("path escapes the data folder");
        }
        try {
          return { text: await Deno.readTextFile(target) };
        } catch (err) {
          if (err instanceof Deno.errors.NotFound) return { text: null };
          throw err;
        }
      },
    },
    browserLog: {
      handler: async (_args, ctx) => {
        const dir = await outDir(ctx.appSupportDir);
        if (!dir) return { lines: null };
        const text = await Deno.readTextFile(join(dir, "bin", "browser.log")).catch(() => "");
        return { lines: text.split(/\r?\n/).filter((l) => l !== "") };
      },
    },
    crc32: {
      handler: async (args) => {
        // Loads the platform's prebuilt `.node` (darwin-x64/arm64, linux-x64/arm64-gnu, win32-x64)
        // through Node-API, inside the packaged app. A failure is returned with its message (a
        // packaged app's bridge reports only "the capability failed").
        try {
          const { crc32 } = await import("@node-rs/crc32");
          return { value: crc32(stringField(args, "text")) };
        } catch (err) {
          console.error("kitchen-sink: loading the Node-API addon failed", err);
          return { error: message(err) };
        }
      },
    },
    updateCheck: {
      handler: (args) =>
        updaterCall(() => checkForAppUpdate(updaterConfig(stringField(args, "url")))),
    },
    updateDownload: {
      timeoutMs: 120_000,
      handler: (args) =>
        updaterCall(async () => {
          const config = updaterConfig(stringField(args, "url"));
          const check = await checkForAppUpdate(config);
          if (!check.available) throw new Error(`no update offered (${check.version})`);
          return await downloadAppUpdate(config);
        }),
    },
    updateInstall: {
      handler: () => updaterCall(() => installAppUpdateAndRelaunch({ force: true })),
    },
    updateConfirm: {
      handler: () => updaterCall(() => confirmAppUpdate()),
    },
    updateStatus: {
      handler: () => appUpdateStatus(),
    },
    tcpProbe: {
      timeoutMs: 30_000,
      handler: async (args) => {
        // The runtime's WebSocket-only loopback relay is the app's one TCP listener in the memory
        // world. Each probe carries the page's real token and the exact app origin, and asks the
        // bridge to write a marker; the page then checks the marker was never written. The probes
        // that carry the relay's own per-launch token get past the relay, so they reach the app's
        // refusal of relayed requests; the one without it must stop at the relay.
        const relay = Deno.env.get("DENO_DESKTOP_WS_URL");
        if (!relay) return { relay: null, probes: [] };
        const relayUrl = new URL(relay.replace(/^ws/, "http"));
        const port = Number(relayUrl.port);
        const prefix = relayUrl.pathname;
        const token = stringField(args, "token");
        const origin = stringField(args, "origin");
        const body = JSON.stringify({
          cap: "kitchen",
          method: "mark",
          args: { name: "tcp-probe-reached" },
        });
        const headers = (extra: string) =>
          `Host: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\n` +
          `x-denext-desktop-token: ${token}\r\n${extra}Connection: close\r\n\r\n`;
        const post = (target: string) =>
          `POST ${target} HTTP/1.1\r\n` +
          headers(
            `Content-Type: application/json\r\nContent-Length: ${
              new TextEncoder().encode(body).byteLength
            }\r\n`,
          ) + body;
        const upgrade = `GET ${prefix}/_denext/desktop/rpc HTTP/1.1\r\n` +
          headers(
            "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n",
          );
        const probes: Array<{ name: string; status: string }> = [];
        for (
          const [name, request] of [
            ["POST to the relay", post(`${prefix}/_denext/desktop/rpc`)],
            ["POST without the relay token", post("/_denext/desktop/rpc")],
            ["absolute-form http+memory: target", post("http+memory://app/_denext/desktop/rpc")],
            ["WebSocket upgrade to the RPC path", upgrade],
          ] as const
        ) {
          probes.push({
            name,
            status: await rawRequest(port, request).catch((err) => `error: ${message(err)}`),
          });
        }
        // Never the token itself: the page gets only whether the relay was published.
        return { relay: relayUrl.origin, probes };
      },
    },
    mainThread: {
      handler: async (_args, ctx) => {
        const probe = threadProbe();
        try {
          const js = probe.callHere();
          const ui = await ctx.runOnMainThread(probe.pointer);
          return { fn: probe.name, js: String(js), ui: String(ui), pid: Deno.pid };
        } finally {
          probe.close();
        }
      },
    },
    osAuthSession: {
      timeoutMs: 60_000,
      handler: () => osAuthSessionProbe(),
    },
    devtools: {
      handler: () => ({ enabled: desktop()?.devtools?.enabled ?? null }),
    },
    scheduledTags: {
      handler: async () => {
        const list = await desktop()?.notifications?.getScheduled() ?? [];
        return list.map((n) => n.tag);
      },
    },
    synthetic: {
      handler: (args, ctx) => {
        const kind = stringField(args, "kind");
        const type = stringField(args, "type");
        // Only the three OS events the checks stand in for.
        if (!["notificationresponse", "shortcut", "menuclick"].includes(type)) {
          throw new TypeError(`event ${type} is not one the harness sends`);
        }
        const event = new CustomEvent(type, { detail: field(args, "detail") });
        const target = kind === "desktop"
          ? desktop()
          : kind === "shortcuts"
          ? desktop()?.shortcuts
          : kind === "window"
          ? ctx.window as EventTarget | undefined
          : undefined;
        if (!target) throw new TypeError(`no ${kind} event target in this runtime`);
        target.dispatchEvent(event);
        return { dispatched: true };
      },
    },
  },
});

/**
 * A native function that tells which thread calls it, both as a pointer for `ctx.runOnMainThread`
 * and callable here on the JavaScript thread: `pthread_main_np` on macOS (1 on the process main
 * thread), `gettid` on Linux (the main thread's id is the pid), `GetCurrentThreadId` on Windows.
 * The pointer comes from `dlsym` / `GetProcAddress`; each takes `(void*)` and ignores it.
 */
function threadProbe(): {
  name: string;
  pointer: Deno.PointerObject;
  callHere(): bigint;
  close(): void;
} {
  const os = Deno.build.os;
  if (os === "windows") {
    const k32 = Deno.dlopen("kernel32.dll", {
      GetModuleHandleA: { parameters: ["buffer"], result: "pointer" },
      GetProcAddress: { parameters: ["pointer", "buffer"], result: "pointer" },
      GetCurrentThreadId: { parameters: [], result: "u32" },
    });
    const module = k32.symbols.GetModuleHandleA(cString("kernel32.dll"));
    const pointer = k32.symbols.GetProcAddress(module, cString("GetCurrentThreadId"));
    if (!pointer) throw new Error("GetProcAddress(GetCurrentThreadId) failed");
    return {
      name: "GetCurrentThreadId",
      pointer,
      callHere: () => BigInt(k32.symbols.GetCurrentThreadId()),
      close: () => k32.close(),
    };
  }
  const name = os === "darwin" ? "pthread_main_np" : "gettid";
  const libc = Deno.dlopen(
    os === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
    {
      dlsym: { parameters: ["pointer", "buffer"], result: "pointer" },
      [name]: { name, parameters: [], result: "i32" },
    } as const,
  );
  // RTLD_DEFAULT: (void*)-2 on macOS, NULL with glibc.
  const rtldDefault = os === "darwin" ? Deno.UnsafePointer.create(0xfffffffffffffffen) : null;
  const pointer = libc.symbols.dlsym(rtldDefault, cString(name));
  if (!pointer) throw new Error(`dlsym(${name}) failed`);
  const callHere = libc.symbols[name] as () => number;
  return { name, pointer, callHere: () => BigInt(callHere()), close: () => libc.close() };
}

function cString(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${text}\0`) as Uint8Array<ArrayBuffer>;
}

/** What `Deno.desktop.authSession` answers here (see `osAuthSession` in the methods). */
async function osAuthSessionProbe(): Promise<Record<string, unknown>> {
  const auth = desktop()?.authSession;
  if (!auth) return { available: false };
  const caps = await auth.capabilities();
  if (!caps.supported) {
    // Windows and Linux: start() must refuse without opening anything.
    const code = await auth.start({
      url: "https://auth.invalid/",
      callbackScheme: "kitchensink-link",
    })
      .then(() => "resolved", (err) => String((err as { code?: unknown }).code ?? err));
    return { available: true, caps, start: code };
  }
  // macOS: an ephemeral session (no "wants to sign in" prompt, so it runs unattended) over a
  // loopback page that redirects straight to the callback scheme, which ends the session.
  const state = crypto.randomUUID();
  const callback = `kitchensink-link://auth/callback?code=os&state=${state}`;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    () => new Response(null, { status: 302, headers: { location: callback } }),
  );
  try {
    const url = `http://127.0.0.1:${server.addr.port}/authorize`;
    const outcome = await Promise.race([
      auth.start({ url, callbackScheme: "kitchensink-link", ephemeral: true }).then(
        (r) => ({ url: r.url }),
        (err) => ({ error: String((err as { code?: unknown }).code ?? err) }),
      ),
      sleep(45_000).then(() => ({ timeout: true })),
    ]);
    return { available: true, caps, expected: callback, ...outcome };
  } finally {
    await server.shutdown();
  }
}

/** The pinned runtime's `Deno.desktop`, as far as the harness uses it. */
interface DesktopApi extends EventTarget {
  devtools?: { enabled?: boolean };
  authSession?: {
    capabilities():
      | { supported: boolean; ephemeral: boolean }
      | Promise<
        { supported: boolean; ephemeral: boolean }
      >;
    start(options: { url: string; callbackScheme: string; ephemeral?: boolean }): Promise<
      { url: string }
    >;
  };
  notifications?: { getScheduled(): Promise<Array<{ tag: string }>> };
  shortcuts?: EventTarget;
}

function desktop(): DesktopApi | undefined {
  return (Deno as unknown as { desktop?: DesktopApi }).desktop;
}
