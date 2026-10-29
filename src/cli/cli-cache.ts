// Keep a CLI loaded from JSR (or any https URL) usable offline. The `denext` entrypoint imports a
// verb's implementation only when that verb runs (src/cli/lazy-command.ts), so `deno install -g
// jsr:@denext/denext/cli` caches the entrypoint's small graph but not the verbs': a verb first
// run offline (`--cached-only`, `denext ui --offline`'s children) would fail to load, and so would
// the framework modules a verb loads by URL (the client runtime a build bundles, a worker, the
// desktop sidecar bundler). This caches all of them — `deno cache` of
// src/cli/offline-modules.generated.ts (the on-demand CLI modules, the framework's exports and every
// module src/ names in a computed URL), from the same URL as the running CLI — once per CLI
// version:
//
//   * in the background on the first run of a remote CLI (`warmCliModules`, any verb);
//   * and in the foreground from `denext toolchain install` (`cacheCliModules`), the post-install
//     step the installers and the docs run.
//
// A local checkout (`file:`) and a compiled binary (its modules are embedded) need neither.
//
// Either way the `deno cache` child has a deadline (`DENEXT_CHILD_DEADLINE_MS`, else 5 min) and its
// stderr is kept (the last 8 KB): a foreground run that fails or is killed at the deadline prints
// it; a background one writes it to `<marker>.log`, which the next run reports once, as it retries.

import { join } from "@std/path";
import { denoCacheDir } from "../build/deno-cache-dir.ts";
import { drainUntilExit } from "../build/exited-output.ts";
import { childDeadlineMs } from "../build/serial-child.ts";

/** The module whose graph is every module a verb can load (scripts/gen-command-table.ts). */
// Spelled so no tool reads it as an import: this module is itself in that graph (through
// `denext toolchain install`), and the URL is only ever handed to `deno cache`.
export const CLI_MODULES_URL: string =
  new URL(["./offline-modules", "generated.ts"].join("."), import.meta.url)
    .href;

/** Retry a background warm-up that has not finished (failed, offline) after this long. */
const RETRY_AFTER_MS = 10 * 60_000;

/** The `deno cache` child's deadline unless `DENEXT_CHILD_DEADLINE_MS` replaces it. */
const CACHE_DEADLINE_MS = 5 * 60_000;

/** How much of the `deno cache` child's stderr is kept (its end). */
const STDERR_TAIL_BYTES = 8 * 1024;

/** Whether this CLI loads its modules over the network (not a checkout, not a binary). */
export function isRemoteCli(url: string = CLI_MODULES_URL): boolean {
  return !url.startsWith("file:") && (Deno.build as { standalone?: boolean }).standalone !== true;
}

/** Marker files under `<deno cache>/denext-cli/`, one per CLI module URL (version included). */
function cliCacheMarker(url: string = CLI_MODULES_URL, cacheDir = denoCacheDir()): string {
  const key = url.replace(/^[a-z]+:\/\//i, "").replace(/[^\w.@-]+/g, "_");
  return join(cacheDir, "denext-cli", `${key}.cached`);
}

/** Whether `path` exists (and, with `youngerThanMs`, was modified within that window). */
function fresh(path: string, youngerThanMs = Infinity): boolean {
  try {
    const mtime = Deno.statSync(path).mtime?.getTime() ?? 0;
    return Date.now() - mtime < youngerThanMs;
  } catch {
    return false;
  }
}

/** Where the cache writes, and with which config (tests point both away from the project). */
export interface CliCacheOptions {
  /** Deno's cache directory, where the markers go (default: Deno's own). */
  cacheDir?: string;
  /**
   * The config / lock flags `deno cache` gets (default: the ones this process was started with,
   * so the modules resolve as the running CLI's do).
   */
  configArgs?: string[];
  /** The `deno cache` child's deadline in ms (default `DENEXT_CHILD_DEADLINE_MS`, else 5 min). */
  deadlineMs?: number;
  /** Where a failure is reported (default `console.error`). */
  log?: (line: string) => void;
}

/** How one `deno cache` run ended. */
interface CacheRun {
  readonly success: boolean;
  readonly code: number;
  /** Killed at the deadline. */
  readonly timedOut: boolean;
  /** The end of its stderr. */
  readonly stderr: string;
}

/** Why a `deno cache` run failed, with the end of what it printed. */
function cacheFailureText(run: Omit<CacheRun, "success">, deadlineMs: number): string {
  const why = run.timedOut
    ? `it was still running after ${deadlineMs / 1000} s and was stopped ` +
      "(DENEXT_CHILD_DEADLINE_MS changes the deadline)"
    : `\`deno cache\` exited with code ${run.code}`;
  const said = run.stderr.trim().split("\n").slice(-12).map((l) => `    ${l}`).join("\n");
  return `${why}${said ? `; it printed:\n${said}` : " and printed nothing"}`;
}

/** Run `deno <args>` with stdout dropped, stderr kept (its end), and a deadline. */
async function runCache(args: string[], deadlineMs: number): Promise<CacheRun> {
  const child = new Deno.Command(Deno.execPath(), {
    args,
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).spawn();
  let timedOut = false;
  const timer = Number.isFinite(deadlineMs)
    ? setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch { /* it exited meanwhile */ }
    }, deadlineMs)
    : undefined;
  const decoder = new TextDecoder();
  let stderr = "";
  try {
    // Read until the child exits, not until every copy of its pipe closes.
    await drainUntilExit(child.stderr, child.status, (chunk) => {
      stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_BYTES);
    }, 2_000);
    const status = await child.status;
    return { success: status.success && !timedOut, code: status.code, timedOut, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** The `deno cache` argv for `url` with the resolution flags this process was started with. */
async function cacheArgs(url: string, configArgs?: string[]): Promise<string[]> {
  if (configArgs) return ["cache", "--quiet", ...configArgs, url];
  // A computed URL, so the CLI's startup graph does not take self-exec.ts in with this module.
  const { toolchainConfigArgs }: typeof import("./self-exec.ts") = await import(
    new URL("./self-exec.ts", import.meta.url).href
  );
  return ["cache", "--quiet", ...await toolchainConfigArgs(url), url];
}

/**
 * Cache every on-demand CLI module now (`denext toolchain install`). No-op for a local checkout or
 * a binary.
 *
 * @param url The offline-modules URL (the running CLI's own, by default).
 * @param options Where the marker goes and the config `deno cache` runs with.
 * @returns Whether the modules are cached (`true` when there was nothing to do).
 */
export async function cacheCliModules(
  url: string = CLI_MODULES_URL,
  options: CliCacheOptions = {},
): Promise<boolean> {
  if (!isRemoteCli(url)) return true;
  const deadlineMs = options.deadlineMs ?? childDeadlineMs(CACHE_DEADLINE_MS);
  const run = await runCache(await cacheArgs(url, options.configArgs), deadlineMs);
  if (run.success) {
    markCached(url, options.cacheDir);
    return true;
  }
  (options.log ?? ((l: string) => console.error(l)))(
    `denext: caching the CLI's modules failed: ${cacheFailureText(run, deadlineMs)}`,
  );
  return false;
}

/**
 * The background warm-up's child (`deno eval`): run `deno cache` with a deadline, keeping the end
 * of its stderr, and write the marker when it succeeded, else `<marker>.log` (JSON: when, the
 * exit code, whether the deadline stopped it, the stderr tail).
 */
const WARM_SCRIPT = `
const env = (k) => Deno.env.get(k);
const marker = env("DENEXT_CLI_CACHE_MARKER");
const deadline = Number(env("DENEXT_CLI_CACHE_DEADLINE_MS"));
const child = new Deno.Command(Deno.execPath(), {
  args: JSON.parse(env("DENEXT_CLI_CACHE_ARGS")), stdin: "null", stdout: "null", stderr: "piped",
}).spawn();
let timedOut = false;
if (deadline > 0) setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, deadline);
let stderr = "";
const decoder = new TextDecoder();
const reading = (async () => {
  try {
    for await (const c of child.stderr) {
      stderr = (stderr + decoder.decode(c, { stream: true })).slice(-${STDERR_TAIL_BYTES});
    }
  } catch {}
})();
const status = await child.status;
await Promise.race([reading, new Promise((r) => setTimeout(r, 2000))]);
if (status.success && !timedOut) {
  Deno.writeTextFileSync(marker, new Date().toISOString());
} else {
  Deno.writeTextFileSync(marker + ".log", JSON.stringify({
    at: new Date().toISOString(), code: status.code, timedOut, deadlineMs: deadline, stderr,
  }));
}
Deno.exit(0);
`;

/** Report, once, a background warm-up that failed (its `<marker>.log`), and drop the report. */
function reportFailedWarmUp(marker: string, log: (line: string) => void): void {
  const path = `${marker}.log`;
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    return;
  }
  try {
    Deno.removeSync(path);
  } catch { /* reported again next time */ }
  try {
    const r = JSON.parse(text) as Omit<CacheRun, "success"> & { deadlineMs?: number };
    const deadlineMs = r.deadlineMs && r.deadlineMs > 0 ? r.deadlineMs : Infinity;
    log(
      "denext: caching the CLI's verbs for offline use in the background failed last time: " +
        `${cacheFailureText(r, deadlineMs)}\n  Retrying it in the background now.`,
    );
  } catch { /* not ours to judge */ }
}

/** Record that `url`'s graph is cached. */
function markCached(url: string, cacheDir?: string): void {
  const marker = cliCacheMarker(url, cacheDir);
  Deno.mkdirSync(join(marker, ".."), { recursive: true });
  Deno.writeTextFileSync(marker, new Date().toISOString());
}

/**
 * On a remote CLI's first run (per version), cache every on-demand module in a detached
 * background `deno cache`, so the verbs work offline afterwards without the caller waiting on it.
 * Never throws: a warm-up that can't start (no write access, no `--allow-run`) leaves the CLI
 * exactly as it was, and is retried on a later run.
 *
 * @param url The offline-modules URL (the running CLI's own, by default).
 * @param options Where the markers go and the config `deno cache` runs with.
 */
export async function warmCliModules(
  url: string = CLI_MODULES_URL,
  options: CliCacheOptions = {},
): Promise<void> {
  if (!isRemoteCli(url)) return;
  try {
    const marker = cliCacheMarker(url, options.cacheDir);
    if (fresh(marker) || fresh(`${marker}.attempt`, RETRY_AFTER_MS)) return;
    reportFailedWarmUp(marker, options.log ?? ((l) => console.error(l)));
    Deno.mkdirSync(join(marker, ".."), { recursive: true });
    Deno.writeTextFileSync(`${marker}.attempt`, new Date().toISOString());
    // `deno eval` runs the cache (with its deadline) and writes the marker only when it
    // succeeded, else its failure to `<marker>.log`; it outlives this process (detached, unref'd,
    // no stdio). `detached` matters on Windows, where a child that is not detached ends with the
    // process that started it. It is in the background on purpose: no verb waits on it.
    const deadlineMs = options.deadlineMs ?? childDeadlineMs(CACHE_DEADLINE_MS);
    const child = new Deno.Command(Deno.execPath(), {
      args: ["eval", "--quiet", WARM_SCRIPT],
      env: {
        DENEXT_CLI_CACHE_ARGS: JSON.stringify(await cacheArgs(url, options.configArgs)),
        DENEXT_CLI_CACHE_MARKER: marker,
        DENEXT_CLI_CACHE_DEADLINE_MS: String(Number.isFinite(deadlineMs) ? deadlineMs : 0),
      },
      stdin: "null",
      stdout: "null",
      stderr: "null",
      detached: true,
    }).spawn();
    child.unref();
  } catch {
    // Best effort: the next run tries again.
  }
}
