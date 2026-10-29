// Signal-safe headless-Chromium launch, shared by the profiler (`denext profile`)
// and the E2E harness.
//
// astral launches headless Chromium as a SEPARATE child process and registers NO exit
// hook, so a run terminated before its `finally` runs — a `timeout`, Ctrl-C, or a CI
// cancel all send SIGTERM (SIGINT on Ctrl-C) first — orphans that Chromium child, which
// then lingers pegging a CPU core. We trap those signals and kill the Chromium process
// before exiting. (SIGKILL/-9 still can't be caught, but almost nothing sends it without
// a SIGTERM grace period first.)
//
// Teardown = astral's graceful `close()` (a CDP shutdown that exits Chromium's WHOLE
// process tree — main + renderer/GPU helpers), AWAITED before `Deno.exit`. A bare
// synchronous `Deno.kill` of the main pid is not enough: SIGKILL'ing the parent leaves
// its helper children reparented to launchd and still running. So we await close
// (bounded, so it can't hang the exit), then hard-kill the main pid as a fallback.
//
// The handler is installed only while ≥1 browser is live and removed when the last one
// closes, so it never keeps the process alive at the end of a run (a dangling refed
// signal listener would itself cause a hang).

import { type Browser, launch } from "@astral/astral";
import { runToExit } from "../build/exited-output.ts";
import { withOwnModules } from "../build/windows-powershell.ts";
import { ensureBrowserBinary } from "./browser-binary.ts";

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

/**
 * The command that prints the pid LISTENing on `port`: `lsof`, or on Windows PowerShell's
 * `Get-NetTCPConnection`, loaded from Windows PowerShell's own modules whatever module path it
 * inherited.
 *
 * @param port The TCP port (digits only).
 * @param windows Whether the host is Windows.
 * @returns `[command, args]`.
 */
export function listeningPidCommand(port: string, windows: boolean): [string, string[]] {
  return windows
    ? [
      "powershell",
      [
        "-NoProfile",
        "-Command",
        withOwnModules(`(Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess`),
      ],
    ]
    : ["lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]];
}

/** Chromium's pid from its debug-port endpoint (the process LISTENing on that port). */
async function chromiumPid(browser: Browser): Promise<number | null> {
  try {
    const port = new URL(browser.wsEndpoint()).port;
    if (!port) return null;
    // Until the lookup exits: Chromium, started beside it, may hold an inherited copy of its pipes.
    const [cmd, args] = listeningPidCommand(port, Deno.build.os === "windows");
    const out = await runToExit(cmd, { args, stderr: "null" });
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
 * Extra Chromium flags for CI. Recent `ubuntu-latest` runner images restrict
 * unprivileged user namespaces (AppArmor), which disables Chromium's SUID/namespace
 * sandbox — it then aborts on launch with `FATAL: No usable sandbox!` and every browser
 * test fails. Drop the sandbox on CI only (local runs stay sandboxed), and disable
 * `/dev/shm` usage to avoid the small-shared-memory crashes common on runners.
 */
function ciBrowserArgs(): string[] {
  return Deno.env.get("CI") ? ["--no-sandbox", "--disable-dev-shm-usage"] : [];
}

/**
 * Launch a headless browser that is torn down even if the run is killed
 * (SIGINT/SIGTERM) before its `finally` — so a cancelled or timed-out run never orphans
 * astral's Chromium child. Always applies {@linkcode ciBrowserArgs}; `extraArgs` are
 * appended (e.g. `--enable-precise-memory-info` for heap measurement). Use this instead
 * of astral's `launch` directly; still `close()` it in a `finally` for the normal path.
 */
export async function launchManagedBrowser(extraArgs: string[] = []): Promise<Browser> {
  // The browser comes through denext's download deadlines and retries, not astral's own fetch.
  const path = await ensureBrowserBinary() ?? undefined;
  const browser = await launch({
    headless: true,
    args: [...ciBrowserArgs(), ...extraArgs],
    path,
  });
  const tracked: TrackedBrowser = { browser, pid: await chromiumPid(browser) };
  liveBrowsers.add(tracked);
  ensureSignalHandler();
  // De-register on the normal `close()` so the set (and the signal handler) don't outlive
  // the browser; a double close is still harmless.
  const originalClose = browser.close.bind(browser);
  (browser as { close: () => Promise<void> }).close = async () => {
    liveBrowsers.delete(tracked);
    removeSignalHandlerIfIdle();
    await originalClose();
  };
  return browser;
}
