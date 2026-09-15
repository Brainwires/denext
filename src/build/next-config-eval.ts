// The ONE bounded `next.config.*` evaluator mechanism, shared by `denext migrate` (which turns
// the config into a generated denext.config.ts) and `denext ui`'s read-only `/config/next`
// panel (which tables it). Each caller keeps its own program text — its own translation table
// and output shape; this module owns only the part that must not drift between them: how the
// child is spawned, with what permissions, for how long, and how its answer is read back.
//
// The config is the app's own code, but it runs on the migrating/inspecting machine, so the
// child gets least privilege: read the project directory, read env, query the OS (what a real
// `next build` sees) — never write, spawn, or reach the network. It runs in the app's own
// directory so the config's npm plugin imports (`@next/mdx`, …) resolve from the app's
// node_modules, not from denext's module graph. Array args only, never a shell.

import { resolve, toFileUrl } from "@std/path";
import { denoExecutable } from "./bundle.ts";

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
  /** The app directory: the child's cwd and the only path it may read. */
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
 * least-privilege `deno run -` subprocess (`--allow-read=<dir> --allow-env --allow-sys`, no
 * prompt, no write/run/net, no downloads, and an environment cleared down to Next's own public
 * variables). A side-effectful config — a watcher, a DB connect, an unresolved
 * top-level await — would otherwise hang the caller forever: at the deadline the child is
 * killed and awaited, so it never outlives the call.
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
  const file = await canonical(resolve(options.dir, options.file));
  const signal = AbortSignal.timeout(timeoutMs);
  // A per-run nonce on the marker. It exists only in the piped program, which the evaluated
  // config can't read (no file, no argv, no env), so a config that prints its own marker
  // line — to plant keys or code in what the caller writes — can't forge the result.
  const marker = `${options.marker}${crypto.randomUUID()}:`;
  const program = options.program.replaceAll(options.marker, marker);
  let output: Deno.CommandOutput;
  try {
    const child = new Deno.Command(denoExecutable(), {
      args: [
        "run",
        "--no-prompt",
        // A `next.config.js` written as CommonJS (`module.exports = …`) with no
        // `"type": "module"` package.json is the common Next.js shape; without detection it
        // fails with "module is not defined".
        "--unstable-detect-cjs",
        // No remote modules and no downloads: an evaluated config can import the project's own
        // files and the packages already in its node_modules, nothing from a registry or a URL.
        // npm resolution runs outside the permission sandbox, so --no-remote alone doesn't stop
        // an `npm:` import (an .npmrc can point it at any host, carrying data in the name);
        // --cached-only and a manual node_modules dir do.
        "--no-remote",
        "--cached-only",
        "--node-modules-dir=manual",
        `--allow-read=${dir}`,
        "--allow-env",
        "--allow-sys",
        "-",
        toFileUrl(file).href,
      ],
      cwd: dir,
      clearEnv: true,
      env: evalEnv(),
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      signal,
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(program)).catch(() => {});
    await writer.close().catch(() => {});
    output = await child.output();
  } catch (err) {
    if (signal.aborted) return { ok: false, reason: `timed out after ${timeoutMs} ms` };
    return { ok: false, reason: `could not run the evaluator: ${(err as Error).message}` };
  }
  try {
    // A complete marker line wins even when the deadline fired while the child was exiting.
    return { ok: true, value: readMarker(output.stdout, marker) };
  } catch (err) {
    const why = signal.aborted
      ? `timed out after ${timeoutMs} ms`
      : `${(err as Error).message} (exit code ${output.code})`;
    return failure(why, output.stderr);
  }
}
