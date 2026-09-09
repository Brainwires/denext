// Test harness for the real-browser E2E suite: build an example app and serve it
// from the production server on an ephemeral port, returning its origin and a
// clean shutdown. Not run by `deno task test`; see `deno task test:e2e`.

import type { Browser, Page } from "@astral/astral";
import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { build } from "../../src/build/build.ts";
import {
  buildNextCompatPages,
  type BuiltNextCompatPage,
} from "../../src/build/next-compat-build.ts";
import { serveEphemeral } from "../../src/build/prod-server.ts";
import { startDevServer } from "../../src/build/dev-server.ts";
import { startSpaDevServer } from "../../src/build/spa.ts";
import { resolveProject } from "../../src/build/paths.ts";

// Signal-safe headless-Chromium launch lives in the framework (used by `denext
// profile` too); the harness just re-exports it under its historical name.
import { launchManagedBrowser } from "../../src/profile/browser.ts";

/**
 * Launch a headless browser for the E2E suite that is torn down even if the run is
 * killed (SIGINT/SIGTERM) before its `finally`. Delegates to the framework's managed
 * launcher (which applies the CI sandbox flags); still `close()` it in a `finally` for
 * the normal path.
 */
export function launchBrowser(): Promise<Browser> {
  return launchManagedBrowser();
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
  return serveEphemeral(dir);
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

/**
 * Poll `expr` (a JS expression evaluated in the page) until it is truthy, or throw after
 * `ms`. CI-generous polling — prefer this over `page.waitForFunction` for multi-step
 * real-time sequences (Live socket round-trips, cross-tab convergence) whose timing varies
 * under load; `waitForFunction`'s short fixed timeout flakes there.
 */
export async function pollFor(page: Page, expr: string, ms = 45000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await page.evaluate(`!!(${expr})`)) return;
    if (Date.now() > deadline) throw new Error(`pollFor timed out after ${ms}ms: ${expr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Assert `expr` becomes truthy on EVERY page (cross-client convergence over one socket). */
export function waitForAll(pages: Page[], expr: string, ms = 45000): Promise<void[]> {
  return Promise.all(pages.map((p) => pollFor(p, expr, ms)));
}

/**
 * Emulate a network condition on `page` via CDP (Astral's raw celestial bindings). A
 * `latencyMs` adds a minimum request→response delay — long enough to observe transient
 * in-flight UI (an optimistic row, a `useFormStatus` pending button) that a fast localhost
 * round-trip would otherwise blow past; `offline: true` cuts the connection (Live-reconnect
 * tests). Call with no options (or `{}`) to restore normal conditions.
 */
export async function emulateNetwork(
  page: Page,
  opts: { latencyMs?: number; offline?: boolean } = {},
): Promise<void> {
  // deno-lint-ignore no-explicit-any
  const net = (page.unsafelyGetCelestialBindings() as any).Network;
  await net.enable({});
  await net.emulateNetworkConditions({
    offline: opts.offline ?? false,
    latency: opts.latencyMs ?? 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
}

/** A set of tabs opened on one origin, plus a shared console-error sink and teardown. */
export interface Clients {
  /** The opened pages, in order. */
  pages: Page[];
  /** Console `error` texts collected across ALL pages (attached before navigation). */
  errors: string[];
  /** Close every page (idempotent; ignores already-closed pages). */
  closeAll: () => Promise<void>;
}

/**
 * Open `n` tabs on the same `url` — each console-error-collected (listener attached BEFORE
 * `goto`, so post-load messages are caught) and navigated. Generalizes the two-tab pattern
 * the typed-api e2e hand-rolls, for any multi-client test (presence, cross-tab sync).
 */
export async function openClients(browser: Browser, url: string, n: number): Promise<Clients> {
  const errors: string[] = [];
  const pages: Page[] = [];
  for (let i = 0; i < n; i++) {
    const page = await browser.newPage();
    onConsole(page, (type, text) => {
      if (type === "error") errors.push(text);
    });
    await page.goto(url);
    pages.push(page);
  }
  return {
    pages,
    errors,
    closeAll: async () => {
      for (const p of pages) await p.close().catch(() => {});
    },
  };
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
