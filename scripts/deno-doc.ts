/**
 * Shared `deno doc` / `deno info` runner for the scripts and tests that read a module's
 * documentation or graph (`gen-api-reference.ts`, `gen-config-schema.ts`, the public-surface
 * golden, the parity extractors, the graph tests). Spawns the current `deno` binary so the output
 * matches the toolchain that runs the caller.
 *
 * On a loaded Windows CI runner such a child sometimes never exits (no output, no children of its
 * own), and an unbounded `output()` then holds the test file until the job's own timeout. So every
 * child here runs the way the build runs its `deno info` / `deno bundle` children
 * (src/build/serial-child.ts): one at a time in this process, killed at a deadline and started
 * once more, and a second stall is a named failure.
 *
 * To say where a stalled child was, each runs with Deno's debug log on (`DENO_LOG`, minus the
 * import map's and the permission checker's per-specifier lines). Its stderr is kept as a short
 * tail in memory and printed only when the child stalls, with its CPU time sampled twice before
 * the kill (`Get-Process` on Windows, `ps` elsewhere), so a child blocked on a lock, a pipe or the
 * network reads differently from one that spins. A child that finishes costs only that tail.
 *
 * @module
 */

import { drainUntilExit } from "../src/build/exited-output.ts";
import {
  boundedOutput as boundedChildOutput,
  childDeadlineMs,
  ChildStallError,
  retryOnStall,
} from "../src/build/serial-child.ts";

/** Each attempt's deadline unless `DENEXT_CHILD_DEADLINE_MS` replaces it: room for a cold cache. */
const DENO_CHILD_DEADLINE_MS = 120_000;

/** How many of a stalled child's last stderr lines its failure carries. */
const TAIL_LINES = 80;

/**
 * The child's `DENO_LOG` filter: debug from every crate (the module graph, the HTTP and npm
 * caches, the resolver, the lockfile, the SQLite caches), except the import map's and the
 * permission checker's per-specifier lines, which are most of the volume and say nothing about a
 * stall.
 */
export const DENO_CHILD_LOG = "debug,import_map=info,deno_permissions=info";

/** A line Deno's logger writes at debug or trace level (`DEBUG RS - target:line - …`). */
// deno-lint-ignore no-control-regex -- a colored log line starts with ANSI escapes
const DEBUG_LINE = /^(?:\x1b\[[0-9;]*m)*(?:DEBUG|TRACE) RS - /;

/** What {@linkcode boundedDeno} reports. */
export interface BoundedDenoResult {
  /** The exit code. */
  readonly code: number;
  /** It exited 0. */
  readonly success: boolean;
  /** Its stdout. */
  readonly stdout: string;
  /** Its stderr without the debug log's lines: what it would have printed without `DENO_LOG`. */
  readonly stderr: string;
}

/** Options for {@linkcode boundedDeno}. */
export interface BoundedDenoOptions {
  /** The working directory. */
  readonly cwd?: string;
  /** Extra environment (a `DENO_LOG` here replaces {@linkcode DENO_CHILD_LOG}). */
  readonly env?: Record<string, string>;
  /** Each attempt's deadline in ms (default 120 s, or `DENEXT_CHILD_DEADLINE_MS`). */
  readonly deadlineMs?: number;
  /** Where the one-line retry notice goes (default: stderr). */
  readonly onStall?: (line: string) => void;
}

/** A `deno` child that was still running at its deadline on both attempts. */
export class DenoChildStallError extends Error {
  /** Each attempt's report: pid, CPU samples, output progress and the debug log's tail. */
  readonly attempts: readonly string[];
  /**
   * @param command The command line.
   * @param deadlineMs Each attempt's deadline.
   * @param attempts Each attempt's report.
   */
  constructor(command: string, deadlineMs: number, attempts: readonly string[]) {
    super(
      `${command} stalled: still running after ${deadlineMs / 1000} s on each of ` +
        `${attempts.length} attempts, and killed (DENEXT_CHILD_DEADLINE_MS raises the ` +
        `deadline).\n${attempts.join("\n")}`,
    );
    this.name = "DenoChildStallError";
    this.attempts = attempts;
  }
}

/** A stream's last {@linkcode TAIL_LINES} lines, and its non-debug lines (capped). */
class StderrTail {
  readonly #decoder = new TextDecoder();
  #partial = "";
  readonly #tail: string[] = [];
  #plain = "";
  #inDebug = false;
  /** Lines seen. */
  lines = 0;
  /** When the last chunk came (`performance.now()`; 0: none). */
  lastAt = 0;

  push(chunk: Uint8Array): void {
    this.lastAt = performance.now();
    const parts = (this.#partial + this.#decoder.decode(chunk, { stream: true })).split("\n");
    this.#partial = parts.pop() ?? "";
    for (const line of parts) this.#line(line.replace(/\r$/, ""));
  }

  #line(line: string): void {
    this.lines++;
    this.#tail.push(line);
    if (this.#tail.length > TAIL_LINES) this.#tail.shift();
    if (this.#isDebug(line)) return;
    if (this.#plain.length < 256 * 1024) this.#plain += `${line}\n`;
  }

  /**
   * Whether `line` belongs to a debug record: it starts one, or continues the one before it (a
   * record printing a value over several lines, such as the workspace's import map, goes on with
   * indented lines and a closing bracket).
   */
  #isDebug(line: string): boolean {
    this.#inDebug = DEBUG_LINE.test(line) ||
      (this.#inDebug && (/^\s/.test(line) || /^[}\]]/.test(line)));
    return this.#inDebug;
  }

  /** The stream without its debug records. */
  plain(): string {
    return this.#plain + (this.#partial && !this.#isDebug(this.#partial) ? this.#partial : "");
  }

  /** The last lines, the unterminated one included. */
  tail(): string[] {
    return this.#partial ? [...this.#tail.slice(1 - TAIL_LINES), this.#partial] : [...this.#tail];
  }
}

/** The command that samples `pid` twice, two seconds apart. */
function sampleCommand(pid: number): [string, string[]] {
  if (Deno.build.os === "windows") {
    // `Get-Process` gives the CPU time where `Win32_Process` is refused; the threads' wait
    // reasons tell a lock or a pipe (`Executive`, `UserRequest`) from a child at work.
    const once = `$p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
      `"cpu $([math]::Round($p.CPU, 2))s threads $($p.Threads.Count) " + ` +
      `"handles $($p.HandleCount) ws $([math]::Round($p.WorkingSet64 / 1MB))MB states " + ` +
      `(($p.Threads | ForEach-Object { if ($_.ThreadState -eq 'Wait') ` +
      `{ "Wait:$($_.WaitReason)" } else { "$($_.ThreadState)" } } | Group-Object | ` +
      `ForEach-Object { "$($_.Count)x$($_.Name)" }) -join ',')`;
    return [
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `${once}; Start-Sleep -Seconds 2; ${once}`],
    ];
  }
  const once = `ps -o time=,stat=,rss= -p ${pid}`;
  return ["sh", ["-c", `${once}; sleep 2; ${once}`]];
}

/**
 * `pid`'s CPU time, threads and state, sampled twice two seconds apart: equal CPU times mean a
 * child blocked on something (a lock, a pipe, the network), growing ones a child at work. Never
 * waits more than 30 s; returns why there is no sample instead of throwing.
 *
 * @param pid The process.
 * @returns One line per sample, joined by `->`.
 */
export async function sampleProcess(pid: number): Promise<string> {
  const [program, args] = sampleCommand(pid);
  try {
    const out = await boundedChildOutput(
      new Deno.Command(program, { args, stdin: "null", stdout: "piped", stderr: "piped" })
        .spawn(),
      { stdout: true, stderr: true },
      30_000,
      program,
    );
    const dec = new TextDecoder();
    const samples = dec.decode(out.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (samples.length === 0) {
      return `(no sample: ${dec.decode(out.stderr).trim() || `exit ${out.code}`})`;
    }
    return samples.join(" -> ") + (Deno.build.os === "windows" ? "" : " (time stat rss-KB)");
  } catch (err) {
    return `(no sample: ${err instanceof Error ? err.message.split("\n")[0] : err})`;
  }
}

/** One attempt's outcome: the output, or the stall report. */
type Attempt =
  | { readonly stalled: false; readonly result: BoundedDenoResult }
  | { readonly stalled: true; readonly pid: number; readonly report: string };

/** `chunks`, joined. */
function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) at += (out.set(c, at), c.length);
  return out;
}

/** Run `program args` once under `deadlineMs`; a child still running then is sampled and killed. */
async function attemptOnce(
  program: string,
  args: readonly string[],
  options: BoundedDenoOptions,
  deadlineMs: number,
): Promise<Attempt> {
  const started = performance.now();
  const child = new Deno.Command(program, {
    args: [...args],
    cwd: options.cwd,
    env: { DENO_LOG: DENO_CHILD_LOG, ...options.env },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stdout: Uint8Array[] = [];
  let stdoutAt = 0;
  const stderr = new StderrTail();
  const reads = Promise.all([
    drainUntilExit(child.stdout, child.status, (chunk) => {
      stdout.push(chunk);
      stdoutAt = performance.now();
    }),
    drainUntilExit(child.stderr, child.status, (chunk) => stderr.push(chunk)),
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    if (Number.isFinite(deadlineMs)) timer = setTimeout(() => resolve("late"), deadlineMs);
  });
  const ended = await Promise.race([child.status, late]);
  clearTimeout(timer);
  if (ended !== "late") {
    await reads;
    return {
      stalled: false,
      result: {
        code: ended.code,
        success: ended.success,
        stdout: new TextDecoder().decode(joined(stdout)),
        stderr: stderr.plain(),
      },
    };
  }
  // Still running: sample it BEFORE the kill, then kill it and stop reading.
  const sample = await sampleProcess(child.pid);
  const killedAt = performance.now();
  try {
    child.kill("SIGKILL");
  } catch { /* exited meanwhile */ }
  let grace: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([reads, new Promise((r) => grace = setTimeout(r, 10_000))]);
  clearTimeout(grace);
  const ago = (t: number) =>
    t === 0 ? "never" : `${((killedAt - t) / 1000).toFixed(1)} s before the kill`;
  const bytes = stdout.reduce((n, c) => n + c.length, 0);
  const report = [
    `  pid ${child.pid}, killed ${((killedAt - started) / 1000).toFixed(1)} s after its start`,
    `    cpu: ${sample}`,
    `    stdout: ${bytes} bytes, last ${ago(stdoutAt)}; ` +
    `stderr: ${stderr.lines} lines, last ${ago(stderr.lastAt)}`,
    `    its last stderr lines (DENO_LOG=${options.env?.DENO_LOG ?? DENO_CHILD_LOG}):`,
    ...stderr.tail().map((l) => `      ${l}`),
  ].join("\n");
  return { stalled: true, pid: child.pid, report };
}

/**
 * Run `deno <args>` (or `program <args>`) to its exit, at most twice: an attempt still running at
 * its deadline is sampled, killed and started once more, in its turn of this process's serial
 * child queue ({@linkcode retryOnStall}). A second stall throws {@linkcode DenoChildStallError}
 * with both attempts' CPU samples and debug-log tails.
 *
 * @param args The arguments, e.g. `["doc", "--json", file]`.
 * @param options Working directory, environment, deadline.
 * @param program The executable (default `Deno.execPath()`; a test passes a stand-in).
 * @returns The exit code and output of the attempt that finished.
 */
export async function boundedDeno(
  args: readonly string[],
  options: BoundedDenoOptions = {},
  program: string = Deno.execPath(),
): Promise<BoundedDenoResult> {
  const deadlineMs = options.deadlineMs ?? childDeadlineMs(DENO_CHILD_DEADLINE_MS);
  const label = `deno ${args[0] ?? ""}`.trim();
  const reports: string[] = [];
  try {
    return await retryOnStall(
      label,
      args.slice(1),
      async (deadline) => {
        const run = await attemptOnce(program, args, options, deadline);
        if (!run.stalled) return run.result;
        reports.push(run.report);
        throw new ChildStallError(label, run.pid, deadline, run.report);
      },
      deadlineMs,
      options.onStall,
    );
  } catch (err) {
    if (!(err instanceof ChildStallError)) throw err;
    throw new DenoChildStallError(`deno ${args.join(" ")}`, deadlineMs, reports);
  }
}

/**
 * Run `deno doc --json` over `file` ({@linkcode boundedDeno}) and return the parsed document.
 *
 * @param file The module.
 * @param options Working directory, environment, deadline.
 * @returns The `deno doc --json` document.
 */
export async function denoDocJson(
  file: string,
  options: BoundedDenoOptions = {},
): Promise<unknown> {
  const { code, stdout, stderr } = await boundedDeno(["doc", "--json", file], options);
  if (code !== 0) throw new Error(`deno doc failed for ${file}: ${stderr}`);
  return JSON.parse(stdout);
}
