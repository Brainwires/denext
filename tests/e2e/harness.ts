// Test harness for the real-browser E2E suite: build an example app and serve it
// from the production server on an ephemeral port, returning its origin and a
// clean shutdown. Not run by `deno task test`; see `deno task test:e2e`.

import { type Browser, launch } from "@astral/astral";
import { build } from "../../src/build/build.ts";
import { startProdServer } from "../../src/build/prod-server.ts";

// ── Signal-safe browser teardown ─────────────────────────────────────────────
// astral launches headless Chromium as a SEPARATE child process and registers NO
// exit hook, so a test run terminated before its `finally` runs — a `timeout`,
// Ctrl-C, or a CI cancel all send SIGTERM (SIGINT on Ctrl-C) first — orphans that
// Chromium child, which then lingers pegging a CPU core. We trap those signals and
// kill the Chromium process before exiting. (SIGKILL/-9 still can't be caught, but
// almost nothing sends it without a SIGTERM grace period first.)
//
// Teardown = astral's graceful `close()` (a CDP shutdown that exits Chromium's WHOLE
// process tree — main + renderer/GPU helpers), AWAITED before `Deno.exit`. A bare
// synchronous `Deno.kill` of the main pid is not enough: SIGKILL'ing the parent
// leaves its helper children reparented to launchd and still running. So we await
// close (bounded, so it can't hang the exit), then hard-kill the main pid as a
// fallback. Chromium's pid is captured at launch for that fallback.
//
// The handler is installed only while ≥1 browser is live and removed when the last
// one closes, so it never keeps the `deno test` process alive at the end of the run
// (a dangling refed signal listener would itself cause a hang).

interface TrackedBrowser {
  browser: Browser;
  /** Chromium's OS pid (for a synchronous kill on signal), or null if undetected. */
  pid: number | null;
}
const liveBrowsers = new Set<TrackedBrowser>();
const TEARDOWN_SIGNALS: Deno.Signal[] = Deno.build.os === "windows"
  ? ["SIGINT", "SIGBREAK"]
  : ["SIGINT", "SIGTERM"];
let signalHandler: (() => void) | null = null;

/** Chromium's pid from its debug-port endpoint (the process LISTENing on that port). */
async function chromiumPid(browser: Browser): Promise<number | null> {
  try {
    const port = new URL(browser.wsEndpoint()).port;
    if (!port) return null;
    const cmd = Deno.build.os === "windows"
      ? new Deno.Command("powershell", {
        args: [
          "-NoProfile",
          "-Command",
          `(Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess`,
        ],
        stdout: "piped",
        stderr: "null",
      })
      : new Deno.Command("lsof", {
        args: ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
        stdout: "piped",
        stderr: "null",
      });
    const out = await cmd.output();
    const pid = parseInt(new TextDecoder().decode(out.stdout).trim().split(/\s+/)[0], 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function teardownAndExit(): Promise<void> {
  const tracked = [...liveBrowsers];
  // Graceful close (whole Chromium tree), bounded so a broken CDP link can't hang us.
  await Promise.allSettled(tracked.map((t) =>
    Promise.race([
      t.browser.close(),
      new Promise((res) => setTimeout(res, 2500)),
    ]).catch(() => {})
  ));
  // Fallback: anything whose graceful close didn't finish — hard-kill the main pid.
  for (const t of tracked) {
    if (t.pid !== null) {
      try {
        Deno.kill(t.pid, "SIGKILL");
      } catch { /* already gone */ }
    }
  }
  Deno.exit(130);
}

function ensureSignalHandler(): void {
  if (signalHandler) return;
  signalHandler = () => void teardownAndExit();
  for (const sig of TEARDOWN_SIGNALS) {
    try {
      Deno.addSignalListener(sig, signalHandler);
    } catch { /* signal unsupported on this platform */ }
  }
}

function removeSignalHandlerIfIdle(): void {
  if (!signalHandler || liveBrowsers.size > 0) return;
  for (const sig of TEARDOWN_SIGNALS) {
    try {
      Deno.removeSignalListener(sig, signalHandler);
    } catch { /* ignore */ }
  }
  signalHandler = null;
}

/**
 * Launch a headless browser for the E2E suite that is torn down even if the run is
 * killed (SIGINT/SIGTERM) before its `finally` — so a cancelled or timed-out run
 * never orphans astral's Chromium child. Use this instead of astral's `launch`
 * directly; still `close()` it in a `finally` for the normal path.
 */
export async function launchBrowser(): Promise<Browser> {
  const browser = await launch({ headless: true });
  const tracked: TrackedBrowser = { browser, pid: await chromiumPid(browser) };
  liveBrowsers.add(tracked);
  ensureSignalHandler();
  // De-register on the normal `close()` so the set (and the signal handler) don't
  // outlive the browser; a double close is still harmless.
  const originalClose = browser.close.bind(browser);
  (browser as { close: () => Promise<void> }).close = async () => {
    liveBrowsers.delete(tracked);
    removeSignalHandlerIfIdle();
    await originalClose();
  };
  return browser;
}

/** A running server for the E2E suite. */
export interface RunningServer {
  /** The `http://host:port` origin the server is listening on. */
  origin: string;
  /** Abort the server and wait for it to finish draining. */
  close: () => Promise<void>;
}

/**
 * Build `dir` for production and start {@linkcode startProdServer} on an
 * ephemeral port (`port: 0`), capturing the actually-bound port via `onListen`
 * (never assume 3000). Shut down via the returned `close()`.
 *
 * @param dir Absolute path to the example app to build and serve.
 */
export async function buildAndServe(dir: string): Promise<RunningServer> {
  await build(dir);
  const controller = new AbortController();
  const { promise, resolve } = Promise.withResolvers<{ hostname: string; port: number }>();
  const server = await startProdServer({
    projectDir: dir,
    port: 0,
    hostname: "127.0.0.1",
    signal: controller.signal,
    onListen: (info) => resolve(info),
  });
  const { hostname, port } = await promise;
  return {
    origin: `http://${hostname}:${port}`,
    close: async () => {
      controller.abort();
      await server.finished;
    },
  };
}
