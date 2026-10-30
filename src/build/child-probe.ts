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
// The build's own children are probed only under `DENEXT_CHILD_PROBE=1` (a diagnostic: off by
// default); the repository's scripts and tests (scripts/deno-doc.ts) always probe theirs.

import { drainUntilExit } from "./exited-output.ts";
import { boundedOutput, ChildStallError } from "./serial-child.ts";

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

/**
 * Read a probed `child` (spawned with stderr piped, and {@linkcode DENO_CHILD_LOG} in its
 * `DENO_LOG`) until it exits; one still running after `deadlineMs` is sampled, killed, and
 * {@linkcode ChildStallError} thrown with the report (pid, CPU samples, output progress, the
 * debug log's tail) as its `probe`.
 *
 * @param child The spawned child; its stderr must be piped.
 * @param stdoutPiped Whether its stdout was spawned `"piped"`.
 * @param deadlineMs How long it may run.
 * @param label The command, for the error.
 * @param denoLog The child's `DENO_LOG`, for the report.
 * @returns Its status and output; stderr without the debug log's records.
 */
async function probedOutput(
  child: Deno.ChildProcess,
  stdoutPiped: boolean,
  deadlineMs: number,
  label: string,
  denoLog: string,
): Promise<Deno.CommandOutput> {
  const started = performance.now();
  const stdout: Uint8Array[] = [];
  let stdoutAt = 0;
  const stderr = new StderrTail();
  const reads = Promise.all([
    stdoutPiped
      ? drainUntilExit(child.stdout, child.status, (chunk) => {
        stdout.push(chunk);
        stdoutAt = performance.now();
      })
      : undefined,
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
    return Object.defineProperties({ ...ended } as Deno.CommandOutput, {
      stdout: {
        get: streamGetter("stdout", stdoutPiped ? joined(stdout) : null),
        enumerable: true,
      },
      stderr: {
        get: streamGetter("stderr", new TextEncoder().encode(stderr.plain())),
        enumerable: true,
      },
    });
  }
  // Still running: sample it BEFORE the kill, then kill it and stop reading.
  const sample = await sampleProcess(child.pid);
  const killedAt = performance.now();
  try {
    child.kill("SIGKILL");
  } catch { /* exited meanwhile */ }
  let grace: ReturnType<typeof setTimeout> | undefined;
  // Its exit too, not only its pipes: on Windows the pipes end before the killed child's exit is
  // reported, and a stall error thrown in between leaves that wait pending (a leaked op).
  await Promise.race([
    Promise.all([reads, child.status]),
    new Promise((r) => grace = setTimeout(r, 10_000)),
  ]);
  clearTimeout(grace);
  const ago = (t: number) =>
    t === 0 ? "never" : `${((killedAt - t) / 1000).toFixed(1)} s before the kill`;
  const bytes = stdout.reduce((n, c) => n + c.length, 0);
  const report = [
    `  pid ${child.pid}, killed ${((killedAt - started) / 1000).toFixed(1)} s after its start`,
    `    cpu: ${sample}`,
    `    stdout: ${stdoutPiped ? `${bytes} bytes, last ${ago(stdoutAt)}` : "not piped"}; ` +
    `stderr: ${stderr.lines} lines, last ${ago(stderr.lastAt)}`,
    `    its last stderr lines (DENO_LOG=${denoLog}):`,
    ...stderr.tail().map((l) => `      ${l}`),
  ].join("\n");
  throw new ChildStallError(label, child.pid, deadlineMs, stderr.plain(), report);
}

/**
 * Spawn `program` with `options` and read it until it exits, killing it at `deadlineMs`
 * ({@linkcode boundedOutput}): the attempt {@linkcode retryOnStall} runs. With `probe` (by default
 * `DENEXT_CHILD_PROBE`), the child runs with {@linkcode DENO_CHILD_LOG} in its `DENO_LOG` (unless
 * `options.env` sets one) and its stderr piped, and a stall throws {@linkcode ChildStallError}
 * carrying the debug log's tail and two CPU samples as its `probe`; a child that finishes returns
 * its stderr without the debug records. Without it the child runs exactly as `options` say.
 *
 * @param program The executable.
 * @param options How to spawn it (`stdout` / `stderr`: `"piped"`, `"null"` or `"inherit"`).
 * @param deadlineMs How long it may run.
 * @param label The command, for the error.
 * @param probe Whether to probe it.
 * @returns Its {@linkcode Deno.CommandOutput}.
 */
export async function boundedSpawn(
  program: string,
  options: Deno.CommandOptions,
  deadlineMs: number,
  label: string,
  probe: boolean = childProbeEnabled(),
): Promise<Deno.CommandOutput> {
  const stdoutPiped = options.stdout === "piped";
  if (!probe) {
    return await boundedOutput(
      new Deno.Command(program, options).spawn(),
      { stdout: stdoutPiped, stderr: options.stderr === "piped" },
      deadlineMs,
      label,
    );
  }
  const env = { DENO_LOG: DENO_CHILD_LOG, ...options.env };
  const child = new Deno.Command(program, { ...options, env, stderr: "piped" }).spawn();
  return await probedOutput(child, stdoutPiped, deadlineMs, label, env.DENO_LOG);
}
