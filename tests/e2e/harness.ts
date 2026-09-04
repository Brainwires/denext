// Test harness for the real-browser E2E suite: build an example app and serve it
// from the production server on an ephemeral port, returning its origin and a
// clean shutdown. Not run by `deno task test`; see `deno task test:e2e`.

import { type Browser, launch, type Page } from "@astral/astral";
import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { build } from "../../src/build/build.ts";
import {
  buildNextCompatPages,
  type BuiltNextCompatPage,
} from "../../src/build/next-compat-build.ts";
import { startProdServer } from "../../src/build/prod-server.ts";
import { startDevServer } from "../../src/build/dev-server.ts";
import { startSpaDevServer } from "../../src/build/spa.ts";
import { resolveProject } from "../../src/build/paths.ts";

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
/**
 * Extra Chromium flags for CI. Recent `ubuntu-latest` runner images restrict
 * unprivileged user namespaces (AppArmor), which disables Chromium's SUID/namespace
 * sandbox — it then aborts on launch with `FATAL: No usable sandbox!` and every
 * browser test fails. Drop the sandbox on CI only (local runs stay sandboxed), and
 * disable `/dev/shm` usage to avoid the small-shared-memory crashes common on runners.
 */
function ciBrowserArgs(): string[] {
  return Deno.env.get("CI") ? ["--no-sandbox", "--disable-dev-shm-usage"] : [];
}

export async function launchBrowser(): Promise<Browser> {
  const browser = await launch({ headless: true, args: ciBrowserArgs() });
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

/**
 * Start the DEV server on `dir` (ephemeral port), for HMR / dev-loop e2e tests.
 * `env` values are set on `Deno.env` before the server boots (e.g.
 * `DENEXT_DEV_UNBUNDLED: "1"` to exercise the unbundled dev loop) and restored on
 * `close()`. No production build — the dev server bundles/transforms on demand.
 */
/** Start the SPA dev server (`mode: "spa"`) on `dir` on an ephemeral port. */
export async function startSpaDevOnDir(
  dir: string,
  env: Record<string, string> = {},
  opts: { unbundled?: boolean } = {},
): Promise<RunningServer> {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prior[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  const paths = await resolveProject(dir);
  const controller = new AbortController();
  const { promise, resolve } = Promise.withResolvers<{ hostname: string; port: number }>();
  const server = startSpaDevServer({
    paths,
    port: 0,
    hostname: "127.0.0.1",
    signal: controller.signal,
    onListen: (info) => resolve(info),
    // Per-server mode (parallel-safe) instead of the process-global DENEXT_DEV_UNBUNDLED.
    unbundled: opts.unbundled,
  });
  const { hostname, port } = await promise;
  return {
    origin: `http://${hostname}:${port}`,
    close: async () => {
      controller.abort();
      await server.finished;
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
    },
  };
}

export async function startDevOnDir(
  dir: string,
  env: Record<string, string> = {},
  opts: { unbundled?: boolean } = {},
): Promise<RunningServer> {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prior[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  const paths = await resolveProject(dir);
  const controller = new AbortController();
  const { promise, resolve } = Promise.withResolvers<{ hostname: string; port: number }>();
  const server = startDevServer({
    paths,
    port: 0,
    hostname: "127.0.0.1",
    signal: controller.signal,
    onListen: (info) => resolve(info),
    // Per-server mode (parallel-safe) instead of the process-global DENEXT_DEV_UNBUNDLED.
    unbundled: opts.unbundled,
  });
  const { hostname, port } = await promise;
  return {
    origin: `http://${hostname}:${port}`,
    close: async () => {
      controller.abort();
      await server.finished;
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
    },
  };
}

// ── Browser-side helpers shared by the e2e tests ─────────────────────────────

function onConsole(page: Page, sink: (type: string | undefined, text: string) => void): void {
  page.addEventListener("console", (e) => {
    // deno-lint-ignore no-explicit-any
    const detail = (e as any).detail;
    sink(detail?.type, String(detail?.text ?? ""));
  });
}

/** Collect the page's console `error` messages (a hydration crash surfaces here). */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  onConsole(page, (type, text) => {
    if (type === "error") errors.push(text);
  });
  return errors;
}

/**
 * Collect EVERY console message's text. Attach BEFORE navigating (`browser.newPage()`,
 * then `page.goto(url)`) so messages fired right after load are captured too.
 */
export function collectConsoleLogs(page: Page): string[] {
  const logs: string[] = [];
  onConsole(page, (_type, text) => logs.push(text));
  return logs;
}

/** Assert that no console errors were collected during the session. */
export function assertNoConsoleErrors(consoleErrors: string[]): void {
  assert(
    consoleErrors.length === 0,
    `unexpected console errors: ${consoleErrors.join(" | ")}`,
  );
}

/** Click the page's first `<button>` (a counter) and expect it to read "Clicked 1 time". */
export async function clickCounterAndExpectOne(page: Page): Promise<void> {
  const button = await page.$("button");
  assert(button, "counter button should exist");
  await button.click();
  const label = await page.evaluate(
    "document.querySelector('button') ? document.querySelector('button').textContent : ''",
  );
  assertStringIncludes(String(label), "Clicked 1 time");
}

/** Click the `<a>` whose trimmed text is `text` (in-app navigation via a real link). */
export function clickLinkByText(page: Page, text: string): Promise<unknown> {
  return page.evaluate(
    `Array.from(document.querySelectorAll('a')).find((a) => a.textContent.trim() === '${text}').click()`,
  );
}

/**
 * Wait for the `[data-testid=id]` button, mark the window with a no-reload flag (a full
 * page reload would clear it — HMR steps assert its survival), click it `clicks` times,
 * and wait for its text to include `expected`.
 */
export async function hydrateAndClick(
  page: Page,
  id: string,
  clicks: number,
  expected: string,
  existsMessage: string,
): Promise<void> {
  await page.waitForFunction(`!!document.querySelector('[data-testid="${id}"]')`);
  await page.evaluate("window.__noReload = true");
  const btn = await page.$(`[data-testid="${id}"]`);
  assert(btn, existsMessage);
  for (let i = 0; i < clicks; i++) await btn.click();
  await page.waitForFunction(
    `document.querySelector('[data-testid="${id}"]').textContent.includes('${expected}')`,
  );
}

/** A source edit that must hot-swap a single module in place. */
export interface HotSwapEdit {
  /** Absolute path of the module to edit. */
  file: string;
  /** Text replaced in the file … */
  from: string;
  /** … by this, which must then show up in `[data-testid=watch]` via HMR. */
  to: string;
  watch: string;
  /** `[data-testid=counter]` whose text must still include `count` (hook state preserved). */
  counter: string;
  count: string;
  /** Assertion message if the window's no-reload flag was lost (a full reload happened). */
  reloadMessage: string;
}

/**
 * Edit a module and assert the HMR contract: the new text appears, the counter's state
 * survived (a single-module swap, not a remount), and NO full page reload happened.
 */
export async function editAndAssertHotSwap(page: Page, edit: HotSwapEdit): Promise<void> {
  const src = await Deno.readTextFile(edit.file);
  await Deno.writeTextFile(edit.file, src.replace(edit.from, edit.to));
  await page.waitForFunction(
    `document.querySelector('[data-testid="${edit.watch}"]').textContent.includes('${edit.to}')`,
  );
  const counter = await page.evaluate(
    `document.querySelector('[data-testid="${edit.counter}"]').textContent`,
  );
  assertStringIncludes(String(counter), edit.count);
  const noReload = await page.evaluate("window.__noReload === true");
  assert(noReload, edit.reloadMessage);
}

// ── next-compat npm projects ─────────────────────────────────────────────────

/** Write a minimal npm-backed project: `deno.json` (nodeModulesDir: auto) + `package.json`. */
export async function writeCompatProject(
  dir: string,
  dependencies: Record<string, string>,
): Promise<void> {
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({ nodeModulesDir: "auto", imports: {} }),
  );
  await Deno.writeTextFile(`${dir}/package.json`, JSON.stringify({ dependencies }));
}

/** `deno cache --no-lock [--allow-scripts] --config <dir>/deno.json <specs…>` run in `dir`. */
export function cacheNpm(
  dir: string,
  specs: string[],
  allowScripts = false,
): Promise<Deno.CommandOutput> {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "cache",
      "--no-lock",
      ...(allowScripts ? ["--allow-scripts"] : []),
      "--config",
      `${dir}/deno.json`,
      ...specs,
    ],
    cwd: dir,
  }).output();
}

/** Build `<dir>/page.tsx` as the `/` route through the next-compat page pipeline. */
export function buildCompatIndexPage(
  dir: string,
  layouts?: string[],
): Promise<BuiltNextCompatPage[]> {
  return buildNextCompatPages({
    projectDir: dir,
    configPath: `${dir}/deno.json`,
    outDir: `${dir}/.denext`,
    pages: [{ routePath: "/", filePath: `${dir}/page.tsx`, ...(layouts ? { layouts } : {}) }],
  });
}

// ── CLI-subprocess servers ───────────────────────────────────────────────────
// Some e2es drive the real CLI as a subprocess ON PURPOSE: a server-side npm dep only
// resolves once the CLI re-execs with the merged framework+app config (see
// `maybeReexecForModules` in cli.ts). The in-process build harness runs under the
// framework's own config, where such a bare import can't resolve — so they can't use
// buildAndServe().

const DENO = Deno.execPath();
const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));

/** Run `deno <args>` in `cwd`, bounded by `timeoutMs`. Never throws — reports instead. */
export async function runDeno(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; out: string }> {
  try {
    const cmd = new Deno.Command(DENO, {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const { success, stdout, stderr } = await cmd.output();
    return {
      ok: success,
      out: new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr),
    };
  } catch (e) {
    // AbortSignal.timeout fired (or spawn failed): the child is killed. Report, don't hang.
    return {
      ok: false,
      out: `\`deno ${args.join(" ")}\` did not finish within ${timeoutMs}ms: ${e}`,
    };
  }
}

/** Recursively SIGKILL a process and its descendants (macOS/Linux; via `pgrep -P`). */
export async function killTree(pid: number): Promise<void> {
  try {
    const out = await new Deno.Command("pgrep", { args: ["-P", String(pid)], stdout: "piped" })
      .output();
    const kids = new TextDecoder().decode(out.stdout).trim().split(/\s+/).filter(Boolean);
    for (const k of kids) await killTree(Number(k));
  } catch { /* pgrep missing or no children */ }
  try {
    Deno.kill(pid, "SIGKILL");
  } catch { /* already exited */ }
}

/**
 * Read the child's stdout until the "denext start ▸ http://host:port" line. Returns the
 * origin, or `""` if the stream closes first. The caller bounds this with a deadline.
 *
 * The host may be `localhost` OR an IP (the CLI prints `http://localhost:PORT` even when
 * started with `--host 127.0.0.1`), so match any non-slash host — an IP-only pattern
 * (`[\d.]+`) silently never matches `localhost` and hangs forever.
 */
async function readOrigin(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return "";
      buf += decoder.decode(value, { stream: true });
      const m = buf.match(/https?:\/\/[^/\s]+:\d+/);
      if (m) return m[0];
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Drain the child's stderr concurrently so a startup crash (a locked SQLite file, a failed
 * re-exec) is captured for the failure message rather than lost.
 */
function drainStderr(child: Deno.ChildProcess): { text: () => string; done: Promise<void> } {
  let buf = "";
  const done = (async () => {
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
    } catch {
      /* cancelled on teardown */
    } finally {
      reader.releaseLock();
    }
  })();
  return { text: () => buf, done };
}

/**
 * `denext start . --host 127.0.0.1 --port 0` in `exampleDir` via the real CLI; resolves once
 * the server printed its listen URL (asserted within `readyTimeoutMs`). `close()` kills the
 * WHOLE tree — parent + the re-exec'd grandchild that actually binds the port and inherits
 * stdout. Killing only the parent leaves that grandchild orphaned (holding the stdout pipe
 * and the SQLite file), which is what poisoned earlier runs.
 */
export async function startCliServer(
  exampleDir: string,
  readyTimeoutMs: number,
): Promise<RunningServer> {
  const child = new Deno.Command(DENO, {
    args: ["run", "-A", CLI, "start", ".", "--host", "127.0.0.1", "--port", "0"],
    cwd: exampleDir,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stderr = drainStderr(child);
  const close = async () => {
    await killTree(child.pid);
    try {
      await child.status;
    } catch { /* already reaped */ }
    await stderr.done.catch(() => {});
  };
  // Hard-bound the readiness wait with Promise.race: `reader.cancel()` alone does NOT
  // unblock a pending read while the re-exec'd child holds the inherited stdout pipe
  // open, so a timeout timer isn't enough — race the read against a deadline that always
  // resolves. The losing readOrigin read is abandoned (sanitizeResources:false) and its
  // pipe closes when the tree is killed.
  const origin = await Promise.race([
    readOrigin(child.stdout),
    new Promise<string>((resolve) => setTimeout(() => resolve(""), readyTimeoutMs)),
  ]);
  if (!origin) await close();
  assert(
    origin,
    `server never printed its listen URL within ${readyTimeoutMs}ms` +
      (stderr.text() ? `\nserver stderr:\n${stderr.text()}` : ""),
  );
  return { origin, close };
}

/**
 * The write path shared by the ORM e2es: POST the home page's Server Action form
 * (`title=inserted-by-e2e`), expect the 303 redirect, then see the row rendered.
 */
export async function assertServerActionInsert(origin: string): Promise<void> {
  const home = await (await fetch(origin + "/")).text();
  const action = home.match(/action="([^"]+)"/)?.[1];
  assert(action, "no Server Action endpoint in the form markup");
  const post = await fetch(origin + action, {
    method: "POST",
    headers: { "Origin": origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: "title=inserted-by-e2e",
    redirect: "manual",
  });
  assert(post.status === 303, `expected 303 redirect, got ${post.status}`);
  await post.body?.cancel();
  const after = await (await fetch(origin + "/")).text();
  assertStringIncludes(after, "inserted-by-e2e");
}
