// A child's output, read until it EXITS rather than until its pipes close.
//
// `new Deno.Command(…).output()` resolves when the child's stdout and stderr reach EOF, which
// needs every copy of their write ends closed, not only the child's. On Windows a process another
// thread of this process spawns at the same moment inherits every inheritable handle that exists
// then, the pipes just made for this child included (Deno's Windows spawn takes no process-wide
// lock around pipe creation and `CreateProcessW`). When that process is long-lived (an esbuild
// service, a server, a sidecar), `output()` never returns: `deno test --parallel` runs every test
// file on a thread of one process, so a `createTestApp` (its `deno info` crawl) beside a build
// could hang the whole run. On every OS, a grandchild the child leaves running holds the pipes
// the same way. What the child wrote is in the pipe by the time it exits, so this reads until
// EOF or, at the latest, a short grace after the exit.

/** How long the pipes are read after the child has exited, by default. */
const DRAIN_AFTER_EXIT_MS = 5_000;

/** Read `stream` to its end, or until `graceMs` after `exited` resolves. */
async function readPipe(
  stream: ReadableStream<Uint8Array>,
  exited: Promise<unknown>,
  graceMs: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const all = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      chunks.push(value);
    }
  })().catch(() => {});
  let grace: ReturnType<typeof setTimeout> | undefined;
  const late = exited.then(() => new Promise<void>((r) => grace = setTimeout(r, graceMs)));
  await Promise.race([all, late]);
  clearTimeout(grace);
  await reader.cancel().catch(() => {});
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) out.set(c, (at += c.length) - c.length);
  return out;
}

/** Which of a child's output streams were spawned `"piped"`. */
export interface PipedStreams {
  /** Whether stdout is piped. */
  readonly stdout: boolean;
  /** Whether stderr is piped. */
  readonly stderr: boolean;
}

/**
 * `child`'s status and piped output, like `Deno.Command#output()`, except that the pipes are
 * read for at most `graceMs` once the child has exited (see the module comment). A stream that
 * was not piped throws `TypeError` when read, as `output()`'s does.
 *
 * @param child A spawned child.
 * @param piped Which of its output streams were spawned `"piped"`.
 * @param graceMs How long to keep reading after the exit.
 * @returns The child's {@linkcode Deno.CommandOutput}.
 */
export async function exitedOutput(
  child: Deno.ChildProcess,
  piped: PipedStreams,
  graceMs: number = DRAIN_AFTER_EXIT_MS,
): Promise<Deno.CommandOutput> {
  const [status, out, err] = await Promise.all([
    child.status,
    piped.stdout ? readPipe(child.stdout, child.status, graceMs) : null,
    piped.stderr ? readPipe(child.stderr, child.status, graceMs) : null,
  ]);
  const read = (name: string, bytes: Uint8Array | null) => () => {
    if (bytes === null) throw new TypeError(`${name} is not piped`);
    return bytes;
  };
  return Object.defineProperties({ ...status } as Deno.CommandOutput, {
    stdout: { get: read("stdout", out), enumerable: true },
    stderr: { get: read("stderr", err), enumerable: true },
  });
}

/** {@linkcode runToExit}'s options: `Deno.CommandOptions` without a writable stdin. */
export type RunToExitOptions = Omit<Deno.CommandOptions, "stdin"> & {
  /** The child's stdin: `"null"` (the default) or `"inherit"`; nothing writes to it. */
  readonly stdin?: "null" | "inherit";
};

/**
 * Run `cmd` to its exit and collect its output, like `new Deno.Command(cmd, options).output()`
 * but read with {@linkcode exitedOutput}, so a pipe handle another process inherited cannot keep
 * it waiting. stdout and stderr default to `"piped"` as `output()`'s do; stdin defaults to
 * `"null"`, so the child inherits no handle it does not need.
 *
 * @param cmd The program.
 * @param options How to run it.
 * @param graceMs How long to keep reading the pipes after the exit.
 * @returns The child's {@linkcode Deno.CommandOutput}; rejects when it cannot be started.
 */
export async function runToExit(
  cmd: string | URL,
  options: RunToExitOptions = {},
  graceMs: number = DRAIN_AFTER_EXIT_MS,
): Promise<Deno.CommandOutput> {
  const stdout = options.stdout ?? "piped";
  const stderr = options.stderr ?? "piped";
  const child = new Deno.Command(cmd, {
    ...options,
    stdin: options.stdin ?? "null",
    stdout,
    stderr,
  })
    .spawn();
  return await exitedOutput(
    child,
    { stdout: stdout === "piped", stderr: stderr === "piped" },
    graceMs,
  );
}
