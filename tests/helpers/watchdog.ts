// A deadline for the tests of a file that builds (or serves a dev build) IN this process, where
// the build's subject needs the process itself (returned objects, a live server, module state).
//
// Nothing can kill an in-process build that stalls, and `deno test` holds a test's output back
// until it ends, so a stall used to hold the CI job until its own timeout with no word on where
// it stuck (see `tests/helpers/bounded-build.ts` for the Windows pipe-inheritance stall). Under
// `watchTests()` every `Deno.test` of the file fails once it runs past the deadline, naming the
// subprocesses this file started that have not finished: the phase the build was in (a
// `deno info`, a `deno bundle`, an esbuild service). The stalled work is abandoned, not stopped;
// the rest of the run goes on. The file's `output()` calls also stop reading shortly after their
// child exits, which removes the one stall this harness is known to cause (the Windows pipe
// inheritance described in `tests/helpers/bounded-build.ts`).

import { exitedOutput as readExited } from "../../src/build/exited-output.ts";

/** The default deadline: minutes past the slowest healthy runner's time for one test (several builds). */
const TEST_DEADLINE_MS = 600_000;

/** A subprocess started in this file that has not finished. */
interface Open {
  readonly what: string;
  readonly since: number;
}

const open = new Set<Open>();

/** `[cmd, ...args]`, shortened for a failure message. */
function describe(cmd: string | URL, options?: Deno.CommandOptions): string {
  const text = [String(cmd), ...(options?.args ?? [])].join(" ");
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

/** Track `p` as open (`what`) until it settles. */
function track<T>(what: string, p: Promise<T>): Promise<T> {
  const entry = { what, since: Date.now() };
  open.add(entry);
  const done = () => open.delete(entry);
  p.then(done, done);
  return p;
}

/** How long `output()` reads a pipe after the child has exited (see {@linkcode exitedOutput}). */
const DRAIN_AFTER_EXIT_MS = 10_000;

/**
 * `new Deno.Command(cmd, options).output()`, except that the pipes are read for at most
 * `graceMs` once the child has exited (`src/build/exited-output.ts`): on Windows a process
 * another thread of this process spawned meanwhile can hold an inherited copy of the child's
 * stdout write end for as long as it lives (an esbuild service lives as long as the process), and
 * `output()` would wait for it.
 */
function exitedOutput(
  Original: typeof Deno.Command,
  cmd: string | URL,
  options: Deno.CommandOptions = {},
  graceMs = DRAIN_AFTER_EXIT_MS,
): Promise<Deno.CommandOutput> {
  const stdout = options.stdout ?? "piped";
  const stderr = options.stderr ?? "piped";
  const child = new Original(cmd, { ...options, stdin: options.stdin ?? "null", stdout, stderr })
    .spawn();
  return readExited(child, { stdout: stdout === "piped", stderr: stderr === "piped" }, graceMs);
}

let tracking = false;

/**
 * Record every `Deno.Command` this file runs (`output()` until it returns, `spawn()` until the
 * child exits), and read an `output()` child's pipes only briefly past its exit
 * ({@linkcode exitedOutput}).
 */
function trackSubprocesses(): void {
  if (tracking) return;
  tracking = true;
  const Original = Deno.Command;
  class Tracked extends Original {
    readonly #cmd: string | URL;
    readonly #options: Deno.CommandOptions | undefined;
    readonly #what: string;
    constructor(cmd: string | URL, options?: Deno.CommandOptions) {
      super(cmd, options);
      this.#cmd = cmd;
      this.#options = options;
      this.#what = describe(cmd, options);
    }
    override output(): Promise<Deno.CommandOutput> {
      return track(`${this.#what} (output)`, exitedOutput(Original, this.#cmd, this.#options));
    }
    override spawn(): Deno.ChildProcess {
      const child = super.spawn();
      track(`${this.#what} (pid ${child.pid})`, child.status);
      return child;
    }
  }
  Object.defineProperty(Deno, "Command", { value: Tracked, configurable: true, writable: true });
}

/** Test seam: {@linkcode exitedOutput} with a chosen grace. */
export const exitedOutputForTest = (
  cmd: string | URL,
  options: Deno.CommandOptions,
  graceMs: number,
): Promise<Deno.CommandOutput> => exitedOutput(Deno.Command, cmd, options, graceMs);

/** Why the test named `name` was failed at `ms`. */
function stallMessage(name: string, ms: number): string {
  const now = Date.now();
  const list = [...open].map((o) =>
    `  - ${o.what}, open for ${Math.round((now - o.since) / 1000)} s`
  );
  return `"${name}" still running after ${ms / 1000} s: failed here instead of holding the job ` +
    `until its timeout (an in-process build cannot be stopped).\n` +
    (list.length
      ? `Subprocesses this file started that have not finished:\n${list.join("\n")}`
      : "No subprocess of this file is open: the stall is in this process.");
}

type TestFn = (t: Deno.TestContext) => void | Promise<void>;

/** `fn` failing once it runs past `ms`. */
function bounded(name: string, fn: TestFn, ms: number): TestFn {
  const wrapped = async (t: Deno.TestContext) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stall = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(stallMessage(name, ms))), ms);
    });
    try {
      await Promise.race([fn(t), stall]);
    } finally {
      clearTimeout(timer);
    }
  };
  Object.defineProperty(wrapped, "name", { value: fn.name });
  return wrapped;
}

/** `Deno.test`'s arguments, its test function bounded (every overload). */
function boundArgs(args: unknown[], ms: number): unknown[] {
  const at = args.findLastIndex((a) => typeof a === "function");
  if (at !== -1) {
    const fn = args[at] as TestFn;
    const first = args[0];
    const name = typeof first === "string"
      ? first
      : (first as { name?: string } | undefined)?.name ?? fn.name;
    const out = [...args];
    out[at] = bounded(name, fn, ms);
    return out;
  }
  const def = args[0] as Deno.TestDefinition;
  return [{ ...def, fn: bounded(def.name, def.fn, ms) }, ...args.slice(1)];
}

/**
 * Give every `Deno.test` registered after this call (in this file: each test file has its own
 * globals) a deadline of `ms`, and track this file's subprocesses for the failure message.
 *
 * @param ms The per-test deadline.
 */
export function watchTests(ms: number = TEST_DEADLINE_MS): void {
  trackSubprocesses();
  const original = Deno.test;
  const call = (register: (...a: unknown[]) => void) => (...args: unknown[]) =>
    register(...boundArgs(args, ms));
  const test = call(original as (...a: unknown[]) => void) as typeof Deno.test;
  test.ignore = call(original.ignore as (...a: unknown[]) => void) as typeof Deno.test.ignore;
  test.only = call(original.only as (...a: unknown[]) => void) as typeof Deno.test.only;
  Object.defineProperty(Deno, "test", { value: test, configurable: true, writable: true });
}
