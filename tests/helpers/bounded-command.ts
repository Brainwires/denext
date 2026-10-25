// A subprocess with a deadline. `new Deno.Command(...).output()` waits for the child to exit AND
// for its stdout / stderr to close, so a hung child, or a grandchild that inherited the pipes (an
// esbuild service, a `deno info`, the CLI's re-exec), keeps a test waiting until the CI job's
// own timeout. Here the output is read as it arrives; at the deadline the whole process tree is
// killed (`taskkill /T /F` on Windows, every `pgrep -P` descendant elsewhere), the reads are
// cancelled instead of awaited, and the result says it timed out, with what the child printed so
// far — the phase it was stuck in.
//
// A child that has EXITED is not waited on past a short grace for its pipes: on Windows a process
// spawned by another thread of the same process (`deno test --parallel` runs each test file on a
// thread of its own) inherits whatever inheritable pipe handles exist at that moment, this child's
// included, and keeps them open for as long as it lives. Everything the child wrote is in the pipe
// by the time it exits, so reading stops once the pipes go quiet after the exit.

import { fromFileUrl } from "@std/path";

/** What {@linkcode runBounded} reports. */
export interface BoundedResult {
  /** The child exited 0 before the deadline. */
  readonly success: boolean;
  /** The deadline passed; the tree was killed. */
  readonly timedOut: boolean;
  /** stdout then stderr, as far as the child got. */
  readonly output: string;
  /** stdout alone. */
  readonly stdout: string;
  /** stderr alone. */
  readonly stderr: string;
  /**
   * The child exited but a pipe was still open after {@linkcode BoundedOptions.drainMs}: another
   * process holds an inherited copy of its write end (see the module comment).
   */
  readonly pipesHeld: boolean;
  /** The child's pid, to name it when it stalls. */
  readonly pid: number;
  /** Its exit code (`-1` when it timed out). */
  readonly code: number;
  /** Its exit signal, or `null`. */
  readonly signal: Deno.Signal | null;
  /** stdout's raw bytes. */
  readonly stdoutBytes: Uint8Array<ArrayBuffer>;
  /** stderr's raw bytes. */
  readonly stderrBytes: Uint8Array<ArrayBuffer>;
}

/** Options for {@linkcode runBounded}. */
export interface BoundedOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  /** Start from `env` alone instead of this process's environment plus `env`. */
  readonly clearEnv?: boolean;
  /** The deadline, in ms. */
  readonly timeoutMs: number;
  /** How long the pipes may stay open once the child has exited (default 10 s). */
  readonly drainMs?: number;
}

/** Kill `pid` and every descendant. */
async function killProcessTree(pid: number): Promise<void> {
  if (Deno.build.os === "windows") {
    await new Deno.Command("taskkill", {
      args: ["/PID", String(pid), "/T", "/F"],
      stdout: "null",
      stderr: "null",
    }).output().catch(() => {});
    // Where taskkill is refused (a restricted account), at least the child itself goes.
    try {
      Deno.kill(pid, "SIGKILL");
    } catch { /* already gone */ }
    return;
  }
  const kids = await new Deno.Command("pgrep", { args: ["-P", String(pid)], stdout: "piped" })
    .output()
    .then((o) => new TextDecoder().decode(o.stdout).trim().split(/\s+/).filter(Boolean))
    .catch(() => [] as string[]);
  // Stop the parent first so it cannot start another child while its tree is being walked.
  try {
    Deno.kill(pid, "SIGSTOP");
  } catch { /* already gone */ }
  for (const kid of kids) await killProcessTree(Number(kid));
  try {
    Deno.kill(pid, "SIGKILL");
  } catch { /* already gone */ }
}

/** What {@linkcode drain} has read so far. */
interface Sink {
  text: string;
  readonly chunks: Uint8Array[];
}

/** Read `stream` into `sink` until it closes; `cancel()` stops it without waiting for EOF. */
function drain(stream: ReadableStream<Uint8Array>, sink: Sink) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        sink.chunks.push(value);
        sink.text += decoder.decode(value, { stream: true });
      }
    } catch { /* cancelled */ }
  })();
  return { done, cancel: () => reader.cancel().catch(() => {}) };
}

/** The chunks in `sink`, joined. */
function joined(sink: Sink): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(sink.chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of sink.chunks) out.set(c, (at += c.length) - c.length);
  return out;
}

/** Resolve after `ms`, or as soon as `p` settles, leaving no timer behind. */
async function within(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p, new Promise((r) => timer = setTimeout(r, ms))]).catch(() => {});
  clearTimeout(timer);
}

/**
 * Run `cmd args` with a deadline; never waits past it.
 *
 * @param cmd The executable.
 * @param args Its arguments.
 * @param options The working directory, extra environment and the deadline.
 * @returns Whether it succeeded, whether it timed out, and its output.
 */
export async function runBounded(
  cmd: string,
  args: string[],
  options: BoundedOptions,
): Promise<BoundedResult> {
  const child = new Deno.Command(cmd, {
    args,
    cwd: options.cwd,
    env: options.env,
    clearEnv: options.clearEnv,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const out: Sink = { text: "", chunks: [] };
  const err: Sink = { text: "", chunks: [] };
  const reads = [drain(child.stdout, out), drain(child.stderr, err)];
  const result = (
    status: Deno.CommandStatus | null,
    timedOut: boolean,
    pipesHeld: boolean,
  ): BoundedResult => ({
    success: status?.success ?? false,
    timedOut,
    pipesHeld,
    pid: child.pid,
    code: status?.code ?? -1,
    signal: status?.signal ?? null,
    output: out.text + err.text,
    stdout: out.text,
    stderr: err.text,
    stdoutBytes: joined(out),
    stderrBytes: joined(err),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.timeoutMs);
  });
  const done = await Promise.race([child.status, deadline]);
  clearTimeout(timer);
  if (done !== "timeout") {
    // Exited: what it wrote is in the pipes. Read it, but not past the grace: a process another
    // thread spawned meanwhile may hold an inherited write end for as long as it lives.
    let grace: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.all(reads.map((r) => r.done)).then(() => true),
      new Promise<false>((resolve) =>
        grace = setTimeout(() => resolve(false), options.drainMs ?? 10_000)
      ),
    ]);
    clearTimeout(grace);
    if (!drained) await Promise.all(reads.map((r) => r.cancel()));
    return result(done, false, !drained);
  }
  await killProcessTree(child.pid);
  // A grandchild the kill could not reach may still hold the pipes: stop reading, don't wait.
  await Promise.all(reads.map((r) => r.cancel()));
  await within(child.status, 5_000);
  return result(null, true, false);
}

/** The deadline {@linkcode boundedOutput} uses unless told otherwise: 10 minutes, a failure bound for one CLI verb on a loaded runner. */
const OUTPUT_DEADLINE_MS = 600_000;

/** {@linkcode boundedOutput}'s options: `Deno.CommandOptions` with piped output and no stdin. */
export type BoundedOutputOptions =
  & Pick<Deno.CommandOptions, "args" | "cwd" | "env" | "clearEnv">
  & {
    /** The deadline, in ms (default {@linkcode OUTPUT_DEADLINE_MS}). */
    readonly timeoutMs?: number;
    /** How long the pipes may stay open once the child has exited. */
    readonly drainMs?: number;
  };

/**
 * `new Deno.Command(cmd, options).output()` with a deadline: the same `Deno.CommandOutput`
 * (stdout and stderr piped, stdin null), but a child still running at the deadline has its
 * whole tree killed and the call throws, naming the command, its pid and what it printed, where
 * `output()` would wait until the CI job's own timeout.
 *
 * @param cmd The executable.
 * @param options Its arguments, working directory, environment and the deadline.
 * @returns The child's output once it exits.
 */
export async function boundedOutput(
  cmd: string | URL,
  options: BoundedOutputOptions = {},
): Promise<Deno.CommandOutput> {
  const timeoutMs = options.timeoutMs ?? OUTPUT_DEADLINE_MS;
  const program = cmd instanceof URL ? fromFileUrl(cmd) : cmd;
  const args = options.args ?? [];
  const r = await runBounded(program, args, {
    cwd: options.cwd instanceof URL ? fromFileUrl(options.cwd) : options.cwd,
    env: options.env,
    clearEnv: options.clearEnv,
    timeoutMs,
    drainMs: options.drainMs,
  });
  if (r.timedOut) {
    throw new Error(
      `${[program, ...args].join(" ")} (pid ${r.pid}) still running after ${timeoutMs} ms; ` +
        `its tree was killed. It printed:\n${r.stdout}\n${r.stderr}`,
    );
  }
  return {
    code: r.code,
    success: r.success,
    signal: r.signal,
    stdout: r.stdoutBytes,
    stderr: r.stderrBytes,
  };
}
