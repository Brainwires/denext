// A subprocess with a deadline. `new Deno.Command(...).output()` waits for the child to exit AND
// for its stdout / stderr to close, so a hung child, or a grandchild that inherited the pipes (an
// esbuild service, a `deno info`, the CLI's re-exec), keeps a test waiting until the CI job's
// own timeout. Here the output is read as it arrives; at the deadline the whole process tree is
// killed (`taskkill /T /F` on Windows, every `pgrep -P` descendant elsewhere), the reads are
// cancelled instead of awaited, and the result says it timed out, with what the child printed so
// far — the phase it was stuck in.

/** What {@linkcode runBounded} reports. */
export interface BoundedResult {
  /** The child exited 0 before the deadline. */
  readonly success: boolean;
  /** The deadline passed; the tree was killed. */
  readonly timedOut: boolean;
  /** stdout then stderr, as far as the child got. */
  readonly output: string;
}

/** Options for {@linkcode runBounded}. */
export interface BoundedOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  /** The deadline, in ms. */
  readonly timeoutMs: number;
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

/** Read `stream` into `sink` until it closes; `cancel()` stops it without waiting for EOF. */
function drain(stream: ReadableStream<Uint8Array>, sink: { text: string }) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        sink.text += decoder.decode(value, { stream: true });
      }
    } catch { /* cancelled */ }
  })();
  return { done, cancel: () => reader.cancel().catch(() => {}) };
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
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const out = { text: "" };
  const err = { text: "" };
  const reads = [drain(child.stdout, out), drain(child.stderr, err)];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.timeoutMs);
  });
  const done = await Promise.race([
    Promise.all([child.status, ...reads.map((r) => r.done)]).then((r) =>
      r[0] as Deno.CommandStatus
    ),
    deadline,
  ]);
  clearTimeout(timer);
  if (done !== "timeout") {
    return { success: done.success, timedOut: false, output: out.text + err.text };
  }
  await killProcessTree(child.pid);
  // A grandchild the kill could not reach may still hold the pipes: stop reading, don't wait.
  await Promise.all(reads.map((r) => r.cancel()));
  await within(child.status, 5_000);
  return { success: false, timedOut: true, output: out.text + err.text };
}
