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
// inheritance described in `tests/helpers/bounded-build.ts`). The failure also says, for each open
// subprocess, whether it is still running or has exited with its pipes still open, and lists the
// processes alive under this test process (pid, parent, command line), so a stall in CI names the
// process it waits on.
//
// `scripts/test-run.ts` preloads `tests/helpers/watchdog-preload.ts` into every stock test file,
// which calls {@linkcode watchAllTests}: every test of every file gets the default deadline and its
// subprocesses are tracked for the report, while `output()` keeps its own semantics there. A file
// that calls `watchTests(ms)` itself sets its own deadline (and the short pipe drain) on top of
// that, never a second wrapper.

import { exitedOutput as readExited } from "../../src/build/exited-output.ts";

// The timer functions as they were when this module loaded (preloaded: before any test file), so a
// test that fakes the clock (`FakeTime`) or jitters timers neither stalls nor leaks the deadline.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** The default deadline: minutes past the slowest healthy runner's time for one test (several builds). */
const TEST_DEADLINE_MS = 600_000;

/** A subprocess started in this file that has not finished. */
interface Open {
  readonly what: string;
  readonly since: number;
  /** The child's pid, once spawned. */
  pid?: number;
  /** Set when the child has exited (its `output()` may still be reading the pipes). */
  exited?: string;
}

const open = new Set<Open>();

/** `[cmd, ...args]`, shortened for a failure message. */
function describe(cmd: string | URL, options?: Deno.CommandOptions): string {
  const text = [String(cmd), ...(options?.args ?? [])].join(" ");
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

/** Track `p` as open (`what`) until it settles; the entry is returned for its pid and exit. */
function track<T>(
  what: string,
  p: Promise<T>,
  entry: Open = { what, since: Date.now() },
): Promise<T> {
  open.add(entry);
  const done = () => open.delete(entry);
  p.then(done, done);
  return p;
}

/** Record `child`'s pid in `entry`, and its exit once it happens. */
function watchChild(entry: Open, child: Deno.ChildProcess): void {
  entry.pid = child.pid;
  child.status.then(
    (s) => entry.exited = s.signal ? `signal ${s.signal}` : `code ${s.code}`,
    () => entry.exited = "status unknown",
  );
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
  entry?: Open,
): Promise<Deno.CommandOutput> {
  const stdout = options.stdout ?? "piped";
  const stderr = options.stderr ?? "piped";
  const child = new Original(cmd, { ...options, stdin: options.stdin ?? "null", stdout, stderr })
    .spawn();
  if (entry) watchChild(entry, child);
  return readExited(child, { stdout: stdout === "piped", stderr: stderr === "piped" }, graceMs);
}

/**
 * The watchdog's settings for this isolate (one test file), on `globalThis` so the preloaded copy
 * and a file's own `watchTests()` share them even if the module were loaded twice.
 */
interface Settings {
  /** The deadline given to each test registered from now on. */
  deadline: number;
  /** Whether `output()` stops reading shortly after the child exits ({@linkcode exitedOutput}). */
  drain: boolean;
  /** Whether `Deno.test` and `Deno.Command` are wrapped (once per isolate). */
  installed: boolean;
}

const SETTINGS = Symbol.for("denext.tests.watchdog");

/** This isolate's {@linkcode Settings}. */
function settings(): Settings {
  const g = globalThis as { [SETTINGS]?: Settings };
  return g[SETTINGS] ??= { deadline: TEST_DEADLINE_MS, drain: false, installed: false };
}

/**
 * `output()` as `Deno.Command` does it (EOF on both pipes; a spawn failure throws at once), but
 * spawned so the child's pid and exit are known while it runs.
 */
function faithfulOutput(
  Original: typeof Deno.Command,
  cmd: string | URL,
  options: Deno.CommandOptions = {},
  entry: Open,
): Promise<Deno.CommandOutput> {
  const child = new Original(cmd, {
    ...options,
    stdout: options.stdout ?? "piped",
    stderr: options.stderr ?? "piped",
  }).spawn();
  watchChild(entry, child);
  return child.output();
}

/**
 * Record every `Deno.Command` this file runs (`output()` until it returns, `spawn()` until the
 * child exits); under {@linkcode Settings.drain}, read an `output()` child's pipes only briefly
 * past its exit ({@linkcode exitedOutput}).
 */
function trackSubprocesses(): void {
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
      // `output()` refuses a piped stdin; let it say so.
      if (this.#options?.stdin === "piped") return super.output();
      const entry: Open = { what: `${this.#what} (output)`, since: Date.now() };
      return track(
        entry.what,
        settings().drain
          ? exitedOutput(Original, this.#cmd, this.#options, DRAIN_AFTER_EXIT_MS, entry)
          : faithfulOutput(Original, this.#cmd, this.#options, entry),
        entry,
      );
    }
    override spawn(): Deno.ChildProcess {
      const child = super.spawn();
      const entry: Open = { what: `${this.#what} (pid ${child.pid})`, since: Date.now() };
      watchChild(entry, child);
      track(entry.what, child.status, entry);
      return child;
    }
  }
  originalCommand = Original;
  Object.defineProperty(Deno, "Command", { value: Tracked, configurable: true, writable: true });
}

/** The `Deno.Command` from before {@linkcode trackSubprocesses} replaced it (the snapshot's own). */
let originalCommand: typeof Deno.Command = Deno.Command;

/** One process of a {@linkcode processSnapshot}. */
export interface ProcessRow {
  readonly pid: number;
  /** The parent's pid; `undefined` where the OS listing has none (Windows without CIM). */
  readonly ppid?: number;
  readonly command: string;
}

/** How long the process listing may take before the stall report goes without it. */
const SNAPSHOT_TIMEOUT_MS = 20_000;

/** Parse `ps -A -o pid=,ppid=,command=` output. */
export function parsePs(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3].trim() });
  }
  return rows;
}

/** Parse `Get-CimInstance Win32_Process | … | ConvertTo-Json` output (one object or an array). */
export function parseCimJson(text: string): ProcessRow[] {
  const parsed = JSON.parse(text) as unknown;
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((p) => {
    const o = p as {
      ProcessId: number;
      ParentProcessId: number;
      CommandLine: string | null;
      Name?: string;
    };
    return { pid: o.ProcessId, ppid: o.ParentProcessId, command: o.CommandLine ?? o.Name ?? "" };
  });
}

/**
 * Parse `<pid>,<name>` lines from `Get-Process` (no parent pids: CIM, and `tasklist` with it, are
 * refused without admin rights).
 */
export function parseGetProcess(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\d+),(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), command: m[2].trim() });
  }
  return rows;
}

/** The listing children's own pids, left out of the tree. */
const listingPids = new Set<number>();

/** Run a listing command to its exit within {@linkcode SNAPSHOT_TIMEOUT_MS}; its stdout, or null. */
async function listing(cmd: string, args: string[]): Promise<string | null> {
  let child: Deno.ChildProcess;
  try {
    child = new originalCommand(cmd, { args, stdin: "null", stdout: "piped", stderr: "null" })
      .spawn();
  } catch {
    return null;
  }
  listingPids.add(child.pid);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => timer = realSetTimeout(() => r(null), SNAPSHOT_TIMEOUT_MS));
  const out = await Promise.race([
    readExited(child, { stdout: true, stderr: false }, 2_000).then((o) =>
      o.success ? new TextDecoder().decode(o.stdout) : null
    ),
    late,
  ]).catch(() => null);
  realClearTimeout(timer);
  if (out === null) {
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }
  return out;
}

/** Every process the OS lists (best effort: `[]` when no listing could be had). */
export async function processSnapshot(): Promise<ProcessRow[]> {
  if (Deno.build.os === "windows") {
    const cim = await listing("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | " +
      "ConvertTo-Json -Compress",
    ]);
    if (cim) {
      try {
        return parseCimJson(cim);
      } catch { /* fall back to Get-Process */ }
    }
    const procs = await listing("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-Process | ForEach-Object { '{0},{1}' -f $_.Id,$_.ProcessName }",
    ]);
    return procs ? parseGetProcess(procs) : [];
  }
  const ps = await listing("ps", ["-A", "-o", "pid=,ppid=,command="]);
  return ps ? parsePs(ps) : [];
}

/** `rows` under `root` (its descendants), as an indented tree; empty when `rows` has no parents. */
export function processTree(rows: readonly ProcessRow[], root: number): string[] {
  const kids = new Map<number, ProcessRow[]>();
  for (const r of rows) {
    if (r.ppid === undefined || r.pid === root || listingPids.has(r.pid)) continue;
    kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r]);
  }
  const out: string[] = [];
  const seen = new Set<number>();
  const walk = (pid: number, depth: number) => {
    for (const r of kids.get(pid) ?? []) {
      if (seen.has(r.pid)) continue;
      seen.add(r.pid);
      const cmd = r.command.length > 300 ? `${r.command.slice(0, 300)}…` : r.command;
      out.push(`${"  ".repeat(depth)}- pid ${r.pid}: ${cmd}`);
      walk(r.pid, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

/** Test seam: {@linkcode exitedOutput} with a chosen grace. */
export const exitedOutputForTest = (
  cmd: string | URL,
  options: Deno.CommandOptions,
  graceMs: number,
): Promise<Deno.CommandOutput> => exitedOutput(Deno.Command, cmd, options, graceMs);

/** What `o` is doing now: still running, or exited with its pipes still being read. */
function stateOf(o: Open, alive: ReadonlySet<number> | null): string {
  if (o.exited) return `exited (${o.exited}) but its pipes are still open`;
  if (o.pid === undefined) return "not spawned yet";
  if (alive && !alive.has(o.pid)) return `pid ${o.pid}, no longer listed by the OS`;
  return `pid ${o.pid}, still running`;
}

/** Why the test named `name` was failed at `ms`, with what the OS lists under this process. */
export async function stallMessage(
  name: string,
  ms: number,
  snapshot: () => Promise<ProcessRow[]> = processSnapshot,
): Promise<string> {
  const rows = await snapshot().catch(() => [] as ProcessRow[]);
  const alive = rows.length ? new Set(rows.map((r) => r.pid)) : null;
  const now = Date.now();
  const list = [...open].map((o) =>
    `  - ${o.what}, open for ${Math.round((now - o.since) / 1000)} s: ${stateOf(o, alive)}`
  );
  const tree = processTree(rows, Deno.pid);
  const treeText = tree.length
    ? `Processes under this test process (pid ${Deno.pid}):\n${tree.join("\n")}`
    : rows.length && rows.every((r) => r.ppid === undefined)
    ? "The OS listing has no parent pids here (CIM refused): see the states above."
    : rows.length
    ? `No process is running under this test process (pid ${Deno.pid}).`
    : "The process list could not be read.";
  return `"${name}" still running after ${ms / 1000} s: failed here instead of holding the job ` +
    `until its timeout (an in-process build cannot be stopped).\n` +
    (list.length
      ? `Subprocesses this file started that have not finished:\n${list.join("\n")}`
      : "No subprocess of this file is open: the stall is in this process.") +
    `\n${treeText}`;
}

type TestFn = (t: Deno.TestContext) => void | Promise<void>;

/** `fn` failing once it runs past `ms`. */
function bounded(name: string, fn: TestFn, ms: number): TestFn {
  const wrapped = async (t: Deno.TestContext) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stall = new Promise<never>((_, reject) => {
      timer = realSetTimeout(() => {
        stallMessage(name, ms).then((m) => reject(new Error(m)), reject);
      }, ms);
    });
    try {
      await Promise.race([fn(t), stall]);
    } finally {
      realClearTimeout(timer);
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
 * Wrap `Deno.test` (each test registered gets the deadline current at its registration; none when
 * it is 0) and `Deno.Command`, once per isolate.
 */
function install(): void {
  const s = settings();
  if (s.installed) return;
  s.installed = true;
  trackSubprocesses();
  const original = Deno.test;
  const call = (register: (...a: unknown[]) => void) => (...args: unknown[]) =>
    register(...(s.deadline > 0 ? boundArgs(args, s.deadline) : args));
  const test = call(original as (...a: unknown[]) => void) as typeof Deno.test;
  test.ignore = call(original.ignore as (...a: unknown[]) => void) as typeof Deno.test.ignore;
  test.only = call(original.only as (...a: unknown[]) => void) as typeof Deno.test.only;
  Object.defineProperty(Deno, "test", { value: test, configurable: true, writable: true });
}

/**
 * Give every `Deno.test` registered after this call (in this file: each test file has its own
 * globals) a deadline of `ms`, track this file's subprocesses for the failure message, and read
 * an `output()` child's pipes only briefly past its exit. Under the global watchdog
 * ({@linkcode watchAllTests}) this only changes the deadline and the drain: tests are wrapped once.
 *
 * @param ms The per-test deadline.
 */
export function watchTests(ms: number = TEST_DEADLINE_MS): void {
  const s = settings();
  s.deadline = ms;
  s.drain = true;
  install();
}

/** The variable that sets {@linkcode watchAllTests}'s deadline in ms (`0` turns it off). */
const DEADLINE_ENV = "DENEXT_TEST_DEADLINE_MS";

/**
 * The global watchdog's deadline: {@linkcode DEADLINE_ENV} when it is a whole number of ms (0:
 * off), else the default.
 *
 * @param raw The variable's value.
 */
export function deadlineFrom(raw: string | undefined): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isInteger(n) && n >= 0
    ? n
    : TEST_DEADLINE_MS;
}

/**
 * The global watchdog (`tests/helpers/watchdog-preload.ts`, which `scripts/test-run.ts` preloads
 * into every stock test file): every test gets the default deadline (or
 * {@linkcode DEADLINE_ENV}'s) and the file's subprocesses are tracked for the report; `output()`
 * keeps its own semantics. A file's own `watchTests()` overrides it.
 */
export function watchAllTests(): void {
  let raw: string | undefined;
  try {
    raw = Deno.env.get(DEADLINE_ENV);
  } catch { /* no env permission: the default */ }
  settings().deadline = deadlineFrom(raw);
  install();
}
