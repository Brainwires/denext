// The ONE bounded `next.config.*` evaluator mechanism, shared by `denext migrate` (which turns
// the config into a generated denext.config.ts) and `denext ui`'s read-only `/config/next`
// panel (which tables it). Each caller keeps its own program text — its own translation table
// and output shape; this module owns only the part that must not drift between them: how the
// child is spawned, with what permissions, for how long, and how its answer is read back.
//
// The config is the app's own code, but it runs on the migrating/inspecting machine, so the
// child gets least privilege: read the project directory, or a workspace member's whole
// workspace (never through a symlink that leads out of it), read env, query the machine's
// CPU / memory / OS release — never write, spawn, or reach the network. It runs in the app's
// own directory so the config's npm plugin imports (`@next/mdx`, …) resolve from the app's
// node_modules, not from denext's module graph. Array args only, never a shell.

import { resolve, toFileUrl } from "@std/path";
import { denoExecutable } from "./bundle.ts";
import { allowReadFlags, containedReadGrants, containmentRoot } from "./contained-read.ts";
import { exitedOutput, type StderrMode } from "./exited-output.ts";

/** The evaluation deadline when neither the caller nor the environment sets one. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** How much of the child's stderr a failure reason quotes. */
const REASON_EXCERPT_CHARS = 200;

/**
 * The program prelude every evaluator starts with: it imports the config named by
 * `Deno.args[0]` (a `file:` URL — ESM, or CommonJS through Deno's `.cjs` interop) and unwraps
 * the default export, a factory function, and a promise, leaving the plain config object in a
 * `let cfg` binding for the caller's translation code that follows.
 */
export const LOAD_NEXT_CONFIG = `
const mod = await import(Deno.args[0]);
let cfg = mod?.default ?? mod;
// Called the way Next.js calls it, (phase, { defaultConfig }): a config that destructures
// its second argument must not throw.
if (typeof cfg === "function") cfg = await cfg("phase-production-build", { defaultConfig: {} });
cfg = await cfg;
`;

/** What {@linkcode evalNextConfigProgram} runs. */
export interface NextConfigEvalOptions {
  /**
   * The app directory: the child's cwd, and what it may read (with the rest of its workspace
   * when it is a member of one), minus any symlink that leads out.
   */
  readonly dir: string;
  /** The config file — a name relative to `dir`, or an absolute path already inside it. */
  readonly file: string;
  /**
   * The program piped to `deno run -` (so it never exists as a file or a `data:` URL). It
   * receives the config's `file:` URL as `Deno.args[0]` and prints its JSON result on one line
   * behind `marker`. It should `Deno.exit(0)` once it has: a config wrapper may keep the event
   * loop alive or crash asynchronously long after it handed the object over.
   */
  readonly program: string;
  /** The line prefix the program prints its JSON result behind. */
  readonly marker: string;
  /**
   * The deadline in milliseconds. Defaults to `DENEXT_NEXT_EVAL_TIMEOUT_MS` (read at call time,
   * so a CPU-starved test run can widen it), else 15 s.
   */
  readonly timeoutMs?: number;
}

/** The `--allow-sys` kinds the evaluator gets: what Node's `os` sizing functions read. */
const EVAL_SYS = "cpus,osRelease,systemMemoryInfo";

/** How long past the deadline the reaper waits before it kills the evaluator itself. */
const REAPER_GRACE_MS = 5_000;

/**
 * The reaper: a second, idle child that holds the evaluator's pid. A spawned child is NOT
 * killed when its parent exits, and the deadline is a timer in the PARENT — so a parent that
 * died mid-evaluation (a killed test run, a crashed `denext migrate`) left a config stuck in
 * `while (true) {}` spinning for days. The evaluator can't watch for that itself: a config that
 * never yields holds its only thread. The reaper waits on its stdin, which only this process
 * holds open: EOF means the parent is gone, and the evaluator is killed. Its own timer (the
 * deadline plus a grace) kills the evaluator even if no EOF ever comes. On a normal finish the
 * parent kills the reaper instead.
 */
const REAPER = `
const [pid, ms] = Deno.args.map(Number);
const reap = () => {
  try { Deno.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  Deno.exit(0);
};
setTimeout(reap, ms);
const buf = new Uint8Array(64);
while ((await Deno.stdin.read(buf).catch(() => null)) !== null) { /* the parent writes nothing */ }
reap();
`;

/**
 * Tie the evaluator `pid` to this process's life: a reaper that kills it when this process
 * exits (or `ms` from now). Returns the function that dismisses the reaper once the evaluator
 * has exited normally, or `null` when no reaper could be started (the caller's own deadline
 * still applies while it lives).
 */
function tieToParent(pid: number, ms: number): (() => Promise<void>) | null {
  try {
    const reaper = new Deno.Command(denoExecutable(), {
      args: ["eval", "--no-config", REAPER, String(pid), String(ms)],
      clearEnv: true,
      env: evalEnv(),
      stdin: "piped",
      stdout: "null",
      stderr: "null",
    }).spawn();
    return async () => {
      try {
        reaper.kill("SIGKILL");
      } catch { /* it already reaped on its own timer */ }
      await reaper.status.catch(() => {});
      await reaper.stdin.close().catch(() => {});
    };
  } catch {
    return null;
  }
}

/**
 * The failure reason when the calling process may not spawn the evaluator (it runs without
 * `--allow-run`). A caller tells it apart from a config that failed to evaluate: the config
 * itself may be fine, so its keys must not be reported as unportable.
 */
export const NEXT_CONFIG_NEEDS_RUN = "couldn't evaluate next.config (needs --allow-run)";

/** The evaluator's answer: the parsed marker line, or why there is none. */
export type NextConfigEvalResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

/** The deadline for one evaluation: the explicit option, else the env override, else 15 s. */
function timeoutFor(explicit: number | undefined): number {
  if (explicit !== undefined && explicit > 0) return explicit;
  return Number(Deno.env.get("DENEXT_NEXT_EVAL_TIMEOUT_MS")) || DEFAULT_TIMEOUT_MS;
}

/**
 * The line of the child's stderr worth quoting — Deno's own `error:` line (not a stack frame
 * under it), else the last non-empty line — trimmed to an excerpt (empty when there is none).
 */
function stderrExcerpt(stderr: Uint8Array): string {
  const lines = new TextDecoder().decode(stderr).split("\n").map((l) => l.trim())
    .filter((l) => l.length > 0);
  const line = lines.find((l) => l.startsWith("error:")) ?? lines.at(-1) ?? "";
  return line.length > REASON_EXCERPT_CHARS ? `${line.slice(0, REASON_EXCERPT_CHARS)}…` : line;
}

/**
 * `path` with every symlink resolved (or `path` itself when it cannot be). Deno's CommonJS
 * loader checks read permission against the REAL path, so a project reached through a
 * symlink (macOS's `/var` → `/private/var`, a linked checkout) must be granted by its real
 * path, and the config file named by its real path too. A config symlinked out of the project
 * therefore resolves outside the grant and is refused.
 */
async function canonical(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return path;
  }
}

/** A failure answer, quoting the child's last stderr line when it left one. */
function failure(reason: string, stderr: Uint8Array): NextConfigEvalResult {
  const excerpt = stderrExcerpt(stderr);
  return { ok: false, reason: excerpt ? `${reason}: ${excerpt}` : reason };
}

/**
 * Read the result back from the child's stdout: the FIRST line behind the per-run `marker`
 * (nonce included, so the evaluated config can't print a line that matches), parsed as JSON
 * regardless of the exit code — the config may have printed its result before a plugin's
 * background work crashed the process. Output before the marker line is ignored.
 */
function readMarker(stdout: Uint8Array, marker: string): unknown {
  const line = new TextDecoder().decode(stdout).split("\n").find((l) => l.startsWith(marker));
  if (line === undefined) throw new Error("no result line");
  return JSON.parse(line.slice(marker.length));
}

/** Variables the evaluator keeps besides `NEXT_PUBLIC_*`: the mode, and where Deno's cache is. */
const PASSED_ENV = new Set([
  "NODE_ENV",
  "HOME",
  "DENO_DIR",
  "XDG_CACHE_HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
]);

/**
 * The variables the evaluator keeps for Deno's own use that name a place on THIS machine. The
 * evaluated config sees each as {@linkcode machineEnvPlaceholder} instead (the child set them
 * before it imports the config), so a `redirects()` / `headers()` that interpolates one can't
 * freeze the migrating machine's home or temp path into a generated config; a value that
 * carries a placeholder is the caller's to flag. `SystemRoot` stays real: Windows itself needs
 * it inside the process.
 */
const MACHINE_ENV_KEYS: readonly string[] = [
  "HOME",
  "DENO_DIR",
  "XDG_CACHE_HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
];

/**
 * The well-known machine-specific variables the evaluated config reads as their placeholder
 * whether or not this machine sets them: a config that reads an unset one (`HOME` on Windows,
 * `USERPROFILE` elsewhere) still depends on the machine it is evaluated on, so the read is
 * flagged instead of coming back `undefined` and passing unnoticed. `DENO_DIR` and
 * `XDG_CACHE_HOME` are optional by design and are masked only when set.
 */
const ALWAYS_MASKED_ENV_KEYS: readonly string[] = [
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
];

/** What the evaluated config reads for the machine-path variable `key`. */
function machineEnvPlaceholder(key: string): string {
  return `__denext_machine_env_${key}__`;
}

/**
 * The machine-path variables `value` (any JSON-shaped value) carries a placeholder of.
 *
 * @param value An evaluated config value.
 * @returns The variable names, in {@linkcode MACHINE_ENV_KEYS} order.
 */
export function machineEnvIn(value: unknown): string[] {
  const text = JSON.stringify(value) ?? "";
  return MACHINE_ENV_KEYS.filter((key) => text.includes(machineEnvPlaceholder(key)));
}

/** Runs first in the evaluator: the machine-path variables become their placeholders. */
const MASK_MACHINE_ENV = `
// (in the evaluator child only: this module never changes its own process's environment)
const childEnv = Deno.env;
const alwaysMasked = ${JSON.stringify(ALWAYS_MASKED_ENV_KEYS)};
for (const key of ${JSON.stringify(MACHINE_ENV_KEYS)}) {
  if (childEnv.get(key) !== undefined || alwaysMasked.includes(key)) {
    childEnv.set(key, "__denext_machine_env_" + key + "__");
  }
}
`;

/**
 * The evaluator's whole environment. The child starts from an empty one: the user's shell
 * may hold secrets, and a config needs only Next's public variables, the mode, and the
 * variables Deno uses to find its cache.
 */
function evalEnv(): Record<string, string> {
  const env: Record<string, string> = { NO_COLOR: "1" }; // a quotable stderr excerpt, free of ANSI escapes
  for (const [key, value] of Object.entries(Deno.env.toObject())) {
    if (PASSED_ENV.has(key) || key.startsWith("NEXT_PUBLIC_")) env[key] = value;
  }
  return env;
}

/**
 * Evaluate an app's `next.config.*` with a caller-supplied program in a bounded,
 * least-privilege `deno run -` subprocess (read access to `<dir>`, or to its workspace when it
 * is a member of one, minus any symlink that leads out; `--allow-env`;
 * `--allow-sys=cpus,osRelease,systemMemoryInfo`; no prompt, no write/run/net, no downloads, and
 * an environment cleared down to Next's own public variables). A side-effectful config — a watcher, a DB connect, an unresolved
 * top-level await — would otherwise hang the caller forever: at the deadline the child is
 * killed and awaited, so it never outlives the call. A reaper process ties the child to this
 * one: if the caller dies mid-evaluation, the child is killed too, never left running.
 *
 * @param options The app dir, config file, program, result marker, and optional deadline.
 * @returns `{ ok: true, value }` with the parsed marker line, or `{ ok: false, reason }` —
 *   a timeout, a spawn failure, a missing marker, or an unparseable result.
 */
export async function evalNextConfigProgram(
  options: NextConfigEvalOptions,
): Promise<NextConfigEvalResult> {
  const timeoutMs = timeoutFor(options.timeoutMs);
  const dir = await canonical(options.dir);
  // `--allow-read=<a>,<b>` is a LIST: Deno splits the value on commas, and the `,,` escape its
  // docs describe is refused by 2.9 ("Empty path is not allowed"). A project directory with a
  // comma in its path would therefore be granted as its pieces — never itself, and a piece
  // may well name a real directory outside the project. Refused up front, with the reason.
  if (dir.includes(",")) {
    return {
      ok: false,
      reason: `the project directory path contains a comma (${JSON.stringify(dir)}), which ` +
        "Deno's --allow-read reads as a list separator; move the project to a path without one " +
        "(a symlink does not help: the real path is what is granted)",
    };
  }
  const file = await canonical(resolve(options.dir, options.file));
  // A workspace member reads its workspace (pnpm's store, sibling packages), never past it.
  const grants = await containedReadGrants(await containmentRoot(dir), dir);
  if (!grants.ok) {
    return { ok: false, reason: `couldn't grant the project read access safely: ${grants.reason}` };
  }
  const readFlags = allowReadFlags(grants.paths);
  const signal = AbortSignal.timeout(timeoutMs);
  // A per-run nonce on the marker. It exists only in the piped program, which the evaluated
  // config can't read (no file, no argv, no env), so a config that prints its own marker
  // line — to plant keys or code in what the caller writes — can't forge the result.
  const marker = `${options.marker}${crypto.randomUUID()}:`;
  const program = MASK_MACHINE_ENV + options.program.replaceAll(options.marker, marker);
  // stdout carries the result; stderr is discarded unless the evaluation fails, then the
  // evaluator runs once more with it piped for the error text (see quietThenExplain: a quiet
  // stderr pipe held for a child's whole life starves other children's reads on Windows).
  const evaluate = async (
    stderr: StderrMode,
  ): Promise<Deno.CommandOutput | NextConfigEvalResult> => {
    try {
      const child = new Deno.Command(denoExecutable(), {
        args: [
          "run",
          "--no-prompt",
          // A `next.config.js` written as CommonJS (`module.exports = …`) with no
          // `"type": "module"` package.json is the common Next.js shape; without detection it
          // fails with "module is not defined".
          "--unstable-detect-cjs",
          // No remote modules and no downloads: an evaluated config can import the project's
          // own files and the packages already in its node_modules, nothing from a registry or
          // a URL. npm resolution runs outside the permission sandbox, so --no-remote alone
          // doesn't stop an `npm:` import (an .npmrc can point it at any host, carrying data in
          // the name); --cached-only and a manual node_modules dir do.
          "--no-remote",
          "--cached-only",
          "--node-modules-dir=manual",
          // The project and nothing a symlink in it leads to elsewhere (contained-read.ts).
          ...readFlags,
          "--allow-env",
          // The machine sizing a config may read through node:os (`os.cpus()`,
          // `os.totalmem()`, `os.release()`) — not its hostname, user or home directory,
          // which a config could copy into what the caller writes or prints.
          `--allow-sys=${EVAL_SYS}`,
          "-",
          toFileUrl(file).href,
        ],
        cwd: dir,
        clearEnv: true,
        env: evalEnv(),
        stdin: "piped",
        stdout: "piped",
        stderr,
        signal,
      }).spawn();
      const dismissReaper = tieToParent(child.pid, timeoutMs + REAPER_GRACE_MS);
      try {
        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode(program)).catch(() => {});
        await writer.close().catch(() => {});
        // Read until the evaluator exits, not until its pipes close: a process the config left
        // running (or, on Windows, one another thread spawned meanwhile) can hold them open.
        return await exitedOutput(child, { stdout: true, stderr: stderr === "piped" });
      } finally {
        await dismissReaper?.();
      }
    } catch (err) {
      if (signal.aborted) return { ok: false, reason: `timed out after ${timeoutMs} ms` };
      // Spawning `deno` needs run permission; without it the config was never looked at.
      if (err instanceof Deno.errors.NotCapable || err instanceof Deno.errors.PermissionDenied) {
        return { ok: false, reason: NEXT_CONFIG_NEEDS_RUN };
      }
      return { ok: false, reason: `could not run the evaluator: ${(err as Error).message}` };
    }
  };
  // A complete marker line wins even when the deadline fired while the child was exiting.
  const read = (output: Deno.CommandOutput): NextConfigEvalResult | Error => {
    try {
      return { ok: true, value: readMarker(output.stdout, marker) };
    } catch (err) {
      return err as Error;
    }
  };
  const first = await evaluate("null");
  if ("ok" in first) return first;
  const result = read(first);
  if (!(result instanceof Error)) return result;
  // Past the deadline there is no time left to run it again for its stderr.
  if (signal.aborted) return { ok: false, reason: `timed out after ${timeoutMs} ms` };
  const again = await evaluate("piped");
  if ("ok" in again) return again;
  const second = read(again);
  if (!(second instanceof Error)) return second;
  const why = signal.aborted
    ? `timed out after ${timeoutMs} ms`
    : `${second.message} (exit code ${again.code})`;
  return failure(why, again.stderr);
}
