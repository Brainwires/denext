// A probe for a bounded `deno` child that stalls: where was it when its deadline passed?
//
// On a loaded Windows CI runner a `deno info` / `deno bundle` / `deno doc` child sometimes never
// exits, alive, with no output. serial-child.ts kills it at a deadline and starts it once more;
// this module says why it was stuck. A probed child runs with Deno's debug log on (`DENO_LOG`,
// minus the import map's and the permission checker's per-specifier lines); its stderr is kept
// as an 80-line tail in memory and reported only when it stalls, with its CPU time sampled twice
// before the kill (`Get-Process` on Windows, with the threads' wait reasons; `ps` elsewhere), so a
// child blocked on a lock, a pipe or the network reads differently from one that spins. A child
// that finishes costs only that tail, and its stderr comes back without the debug records.
//
// A child whose whole result is one JSON document on stdout (`deno info --json`, `deno doc --json`)
// can be read with `jsonStdout`: on Windows such a child has been seen to write its complete
// output and its last debug line, then spin at 100% CPU in its teardown and never exit. Once its
// stdout parses as a complete JSON object or array and it has been silent on both pipes for a grace
// (`DENEXT_CHILD_EXIT_GRACE_MS`, 5 s), it is killed and its output used as a success, after one
// line naming its pid (with the probe's report when probed). A partial document never parses, so a
// child that stopped mid-output still ends at its deadline. Runtime 3.0.0-denext.5 fixes the cause
// on Windows (a finished process ends with `TerminateProcess`, not `ExitProcess`, whose teardown
// could spin on a lock a killed thread held); the grace stays for older runtimes.
//
// The build's own children are probed only under `DENEXT_CHILD_PROBE=1` (a diagnostic: off by
// default); the repository's scripts and tests (scripts/deno-doc.ts) always probe theirs.

import { drainUntilExit } from "./exited-output.ts";
import { boundedOutput, childExitGraceMs, ChildStallError } from "./serial-child.ts";

/** How many of a stalled child's last stderr lines its report carries. */
const TAIL_LINES = 80;

/**
 * A probed child's `DENO_LOG` filter: debug from every crate (the module graph, the HTTP and npm
 * caches, the resolver, the lockfile, the SQLite caches), except the import map's and the
 * permission checker's per-specifier lines, which are most of the volume and say nothing about a
 * stall.
 */
export const DENO_CHILD_LOG = "debug,import_map=info,deno_permissions=info";

/** A line Deno's logger writes at debug or trace level (`DEBUG RS - target:line - …`). */
// deno-lint-ignore no-control-regex -- a colored log line starts with ANSI escapes
const DEBUG_LINE = /^(?:\x1b\[[0-9;]*m)*(?:DEBUG|TRACE) RS - /;

/** Reads one environment variable. */
type EnvGet = (k: string) => string | undefined;

function readEnv(k: string): string | undefined {
  try {
    return Deno.env.get(k);
  } catch {
    return undefined; // no env permission
  }
}

/**
 * Whether the build's bounded children are probed: `DENEXT_CHILD_PROBE` is `1` or `true`.
 *
 * @param env Env reader.
 * @returns Whether to probe.
 */
export function childProbeEnabled(env: EnvGet = readEnv): boolean {
  const raw = env("DENEXT_CHILD_PROBE")?.trim().toLowerCase();
  return raw === "1" || raw === "true";
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
    const out = await boundedOutput(
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

/** `chunks`, joined. */
function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) at += (out.set(c, at), c.length);
  return out;
}

/** `bytes` as a {@linkcode Deno.CommandOutput}'s stream: throws when it was not piped. */
function streamGetter(name: string, bytes: Uint8Array | null): () => Uint8Array {
  return () => {
    if (bytes === null) throw new TypeError(`${name} is not piped`);
    return bytes;
  };
}

/** `status` with `stdout` / `stderr` as a {@linkcode Deno.CommandOutput} (`null`: not piped). */
function commandOutput(
  status: Deno.CommandStatus,
  stdout: Uint8Array | null,
  stderr: Uint8Array | null,
): Deno.CommandOutput {
  return Object.defineProperties({ ...status } as Deno.CommandOutput, {
    stdout: { get: streamGetter("stdout", stdout), enumerable: true },
    stderr: { get: streamGetter("stderr", stderr), enumerable: true },
  });
}

/**
 * Whether `chunks` (a child's stdout so far) hold one complete JSON object or array: a document
 * cut off anywhere inside it never parses, so a child that stopped mid-document is never taken
 * for a finished one.
 */
function completeJson(chunks: readonly Uint8Array[]): boolean {
  if (chunks.length === 0) return false;
  const text = new TextDecoder().decode(joined(chunks)).trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function writeStderr(line: string): void {
  try {
    Deno.stderr.writeSync(new TextEncoder().encode(`${line}\n`));
  } catch { /* stderr closed */ }
}

/**
 * For a child whose whole result is one JSON document on stdout (`deno info --json`,
 * `deno doc --json`): don't wait on its exit once that document is complete.
 */
export interface JsonStdout {
  /**
   * How long the child must have been silent on both pipes, with its stdout parsing as a complete
   * JSON object or array, before it is killed and that output used as a success (default
   * `DENEXT_CHILD_EXIT_GRACE_MS`, else 5 s; `Infinity`: wait for the exit).
   */
  readonly graceMs?: number;
  /** Where the line naming the killed child goes (default: stderr). */
  readonly onSettled?: (line: string) => void;
}

/** How {@linkcode watchedOutput} reads a child. */
interface Watch {
  /** Whether its stdout was spawned `"piped"`. */
  readonly stdoutPiped: boolean;
  /** Whether its stderr was spawned `"piped"`. */
  readonly stderrPiped: boolean;
  /** How long it may run. */
  readonly deadlineMs: number;
  /** The command, for the error and the notice. */
  readonly label: string;
  /** The child's `DENO_LOG` when it is probed; `undefined`: not probed. */
  readonly denoLog: string | undefined;
  /** The finished-JSON grace (`Infinity`: none). */
  readonly graceMs: number;
  /** Where the finished-JSON notice goes. */
  readonly onSettled: (line: string) => void;
}

/**
 * A watched child's pipes, read as they arrive. Each chunk on either pipe restarts the silence
 * window; when it runs out, the stdout so far is parsed once, and {@linkcode settled} resolves
 * when it is one complete JSON object or array. A child still writing, or one that stopped
 * mid-document, never settles.
 */
class WatchedPipes {
  readonly stdout: Uint8Array[] = [];
  /** When the last stdout chunk came (`performance.now()`; 0: none). */
  stdoutAt = 0;
  readonly stderr = new StderrTail();
  readonly #stderrRaw: Uint8Array[] = [];
  readonly #w: Watch;
  #quiet: ReturnType<typeof setTimeout> | undefined;
  #watching: boolean;
  #settle: (v: "settled") => void = () => {};
  /** Resolves once the child's complete JSON output has been followed by the grace's silence. */
  readonly settled = new Promise<"settled">((r) => this.#settle = r);
  /** Settles once both pipes are read (to their end, or a grace after the exit). */
  readonly reads: Promise<unknown>;

  constructor(child: Deno.ChildProcess, w: Watch) {
    this.#w = w;
    this.#watching = w.stdoutPiped && Number.isFinite(w.graceMs);
    const probed = w.denoLog !== undefined;
    this.reads = Promise.all([
      w.stdoutPiped
        ? drainUntilExit(child.stdout, child.status, (chunk) => {
          this.stdout.push(chunk);
          this.stdoutAt = performance.now();
          this.#activity();
        })
        : undefined,
      w.stderrPiped
        ? drainUntilExit(child.stderr, child.status, (chunk) => {
          this.stderr.push(chunk);
          if (!probed) this.#stderrRaw.push(chunk);
          this.#activity();
        })
        : undefined,
    ]);
  }

  #activity(): void {
    if (!this.#watching) return; // no grace, or decided: a chunk read after that starts no timer
    clearTimeout(this.#quiet);
    this.#quiet = setTimeout(() => {
      if (completeJson(this.stdout)) this.#settle("settled");
    }, this.#w.graceMs);
  }

  /** Stop watching for silence (the outcome is decided). */
  stop(): void {
    this.#watching = false;
    clearTimeout(this.#quiet);
  }

  /** stdout as read (`null`: not piped). */
  stdoutBytes(): Uint8Array | null {
    return this.#w.stdoutPiped ? joined(this.stdout) : null;
  }

  /** stderr as read, a probed child's without its debug records (`null`: not piped). */
  stderrBytes(): Uint8Array | null {
    if (!this.#w.stderrPiped) return null;
    return this.#w.denoLog !== undefined
      ? new TextEncoder().encode(this.stderr.plain())
      : joined(this.#stderrRaw);
  }
}

/**
 * How `child` ended: its status, `"late"` at `deadlineMs`, or `"settled"` once `pipes` settled
 * while it was still running (one that settled in the same turn as its exit gets its status).
 */
async function outcome(
  child: Deno.ChildProcess,
  pipes: WatchedPipes,
  deadlineMs: number,
): Promise<Deno.CommandStatus | "late" | "settled"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    if (Number.isFinite(deadlineMs)) timer = setTimeout(() => resolve("late"), deadlineMs);
  });
  const ended = await Promise.race([child.status, late, pipes.settled]);
  pipes.stop();
  clearTimeout(timer);
  if (ended !== "settled") return ended;
  return await Promise.race([child.status, Promise.resolve("settled" as const)]);
}

/**
 * Kill `child` and wait for its exit and `reads`, at most 10 s: on Windows the pipes end before
 * the killed child's exit is reported, and an error thrown in between leaves that wait pending (a
 * leaked op).
 *
 * @returns When it was killed (`performance.now()`).
 */
async function killAndWait(child: Deno.ChildProcess, reads: Promise<unknown>): Promise<number> {
  const killedAt = performance.now();
  try {
    child.kill("SIGKILL");
  } catch { /* exited meanwhile */ }
  let grace: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all([reads, child.status]),
    new Promise((r) => grace = setTimeout(r, 10_000)),
  ]);
  clearTimeout(grace);
  return killedAt;
}

/** A probed child's report: pid, CPU samples, output progress and the debug log's tail. */
function probeReport(
  pid: number,
  pipes: WatchedPipes,
  w: Watch,
  times: { started: number; killedAt: number; sample: string },
): string {
  const { started, killedAt, sample } = times;
  const ago = (t: number) =>
    t === 0 ? "never" : `${((killedAt - t) / 1000).toFixed(1)} s before the kill`;
  const bytes = pipes.stdout.reduce((n, c) => n + c.length, 0);
  return [
    `  pid ${pid}, killed ${((killedAt - started) / 1000).toFixed(1)} s after its start`,
    `    cpu: ${sample}`,
    `    stdout: ${w.stdoutPiped ? `${bytes} bytes, last ${ago(pipes.stdoutAt)}` : "not piped"}; ` +
    `stderr: ${pipes.stderr.lines} lines, last ${ago(pipes.stderr.lastAt)}`,
    `    its last stderr lines (DENO_LOG=${w.denoLog}):`,
    ...pipes.stderr.tail().map((l) => `      ${l}`),
  ].join("\n");
}

/**
 * Read `child` until it exits; one still running after `deadlineMs` is killed (sampled first when
 * probed) and {@linkcode ChildStallError} thrown, with the report (pid, CPU samples, output
 * progress, the debug log's tail) as its `probe` when probed. With a finite `graceMs`, a child
 * whose stdout parses as a complete JSON object or array after `graceMs` of silence on both pipes
 * is killed instead, one line naming it goes to `onSettled` (with the probe's report when
 * probed), and its output is returned as a success.
 *
 * @param child The spawned child; its stderr must be piped when probed.
 * @param w How to read it.
 * @returns Its status and output; a probed child's stderr without the debug log's records.
 */
async function watchedOutput(child: Deno.ChildProcess, w: Watch): Promise<Deno.CommandOutput> {
  const started = performance.now();
  const pipes = new WatchedPipes(child, w);
  const ended = await outcome(child, pipes, w.deadlineMs);
  if (ended !== "late" && ended !== "settled") {
    await pipes.reads;
    return commandOutput(ended, pipes.stdoutBytes(), pipes.stderrBytes());
  }
  // Still running: sample it BEFORE the kill (when probed), then kill it and stop reading.
  const probed = w.denoLog !== undefined;
  const sample = probed ? await sampleProcess(child.pid) : "";
  const killedAt = await killAndWait(child, pipes.reads);
  const report = probed
    ? probeReport(child.pid, pipes, w, { started, killedAt, sample })
    : undefined;
  if (ended === "settled") {
    w.onSettled(
      `    warning: ${w.label} (pid ${child.pid}): output complete; the process did not exit ` +
        `${w.graceMs / 1000} s after its last output and was killed; its output is used ` +
        `(DENEXT_CHILD_EXIT_GRACE_MS sets the grace)` + (report === undefined ? "" : `\n${report}`),
    );
    const ok = { success: true, code: 0, signal: null };
    return commandOutput(ok, pipes.stdoutBytes(), pipes.stderrBytes());
  }
  const stderrText = new TextDecoder().decode(pipes.stderrBytes() ?? new Uint8Array());
  throw new ChildStallError(w.label, child.pid, w.deadlineMs, stderrText, report);
}
/**
 * Spawn `program` with `options` and read it until it exits, killing it at `deadlineMs`
 * ({@linkcode boundedOutput}): the attempt {@linkcode retryOnStall} runs. With `probe` (by default
 * `DENEXT_CHILD_PROBE`), the child runs with {@linkcode DENO_CHILD_LOG} in its `DENO_LOG` (unless
 * `options.env` sets one) and its stderr piped, and a stall throws {@linkcode ChildStallError}
 * carrying the debug log's tail and two CPU samples as its `probe`; a child that finishes returns
 * its stderr without the debug records. Without it the child runs exactly as `options` say.
 *
 * With `jsonStdout` (a child whose whole result is one JSON document on stdout, piped), the child
 * is not waited on past its output: once its stdout parses as a complete JSON object or array and
 * it has been silent on both pipes for `jsonStdout.graceMs`, it is killed, one line naming its pid
 * goes to `jsonStdout.onSettled` (with the probe's report when probed), and its output is returned
 * with exit code 0. A child that exits first is returned as it exited, its exit code included.
 *
 * @param program The executable.
 * @param options How to spawn it (`stdout` / `stderr`: `"piped"`, `"null"` or `"inherit"`).
 * @param deadlineMs How long it may run.
 * @param label The command, for the error.
 * @param probe Whether to probe it.
 * @param jsonStdout Settle on a complete JSON document on stdout; `undefined`: wait for the exit.
 * @returns Its {@linkcode Deno.CommandOutput}.
 */
export async function boundedSpawn(
  program: string,
  options: Deno.CommandOptions,
  deadlineMs: number,
  label: string,
  probe: boolean = childProbeEnabled(),
  jsonStdout?: JsonStdout,
): Promise<Deno.CommandOutput> {
  const stdoutPiped = options.stdout === "piped";
  const graceMs = jsonStdout && stdoutPiped ? jsonStdout.graceMs ?? childExitGraceMs() : Infinity;
  const watch = {
    stdoutPiped,
    deadlineMs,
    label,
    graceMs,
    onSettled: jsonStdout?.onSettled ?? writeStderr,
  };
  if (!probe) {
    const stderrPiped = options.stderr === "piped";
    const child = new Deno.Command(program, options).spawn();
    if (!Number.isFinite(graceMs)) {
      return await boundedOutput(
        child,
        { stdout: stdoutPiped, stderr: stderrPiped },
        deadlineMs,
        label,
      );
    }
    return await watchedOutput(child, { ...watch, stderrPiped, denoLog: undefined });
  }
  const env = { DENO_LOG: DENO_CHILD_LOG, ...options.env };
  const child = new Deno.Command(program, { ...options, env, stderr: "piped" }).spawn();
  return await watchedOutput(child, { ...watch, stderrPiped: true, denoLog: env.DENO_LOG });
}
