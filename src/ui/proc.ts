// Every piece of work `denext ui` does that would otherwise need the user's modules runs here,
// as a `deno` subprocess. That is the hard rule of the UI process: it never imports project
// code, so no user config, plugin, or dependency is ever evaluated inside the UI server — which
// is also what keeps the bundler (esbuild) out of the `denext ui` module graph entirely.
//
// Array args only, never a shell: a task name or package spec that came from the browser cannot
// become a command.

import { denoExecutable, frameworkFileUrl } from "../build/bundle.ts";
import { isStandaloneBinary, nearestConfig, pinnedDenextCli } from "../cli/self-exec.ts";
import { cliNpmModeArgs } from "../build/pnpm-workspace.ts";
import { drainUntilExit } from "../build/exited-output.ts";
import { childExitGraceMs } from "../build/serial-child.ts";
import { parseJsonDocument } from "./child-json.ts";
import { VERSION } from "../../mod.ts";

/**
 * How much of a *streamed* run's output is kept in memory. A streaming caller consumes every
 * line as it arrives through `onLine`, so buffering the whole thing again only costs memory —
 * a wedged `deno task` used to retain tens of megabytes. The last few KB are still kept, so a
 * caller that wants a closing excerpt has one.
 */
const STREAM_TAIL_CHARS = 8192;

/** Options for {@linkcode runDeno}. */
export interface RunDenoOptions {
  /** Working directory for the child (normally the project dir). */
  readonly cwd: string;
  /** Called once per output line as it arrives; enables streaming mode. */
  readonly onLine?: (line: string) => void;
  /** Aborts the child (the UI's shutdown signal, or a per-request deadline). */
  readonly signal?: AbortSignal;
  /** Extra environment for the child, merged over the UI's own. */
  readonly env?: Record<string, string>;
  /**
   * A program (or any input) piped to the child's stdin, which lets `deno run -` evaluate a
   * generated program without it ever existing as a file or a `data:` URL.
   */
  readonly stdin?: string;
  /** The `deno` binary to run (default {@linkcode denoExecutable}). */
  readonly deno?: string;
  /**
   * The child's whole result is one JSON document on stdout (a `--json` verb): don't wait on its
   * exit once that document is complete. See {@linkcode JsonDocumentChild}.
   */
  readonly jsonDocument?: JsonDocumentChild;
}

/**
 * For a child whose result is one JSON document on stdout. On Windows such a child has been seen
 * to write its complete document, then spin at 100% CPU in its teardown and never exit (the same
 * failure `boundedSpawn`'s `jsonStdout` handles for `deno info --json`). Each chunk on either pipe
 * restarts a silence window; when it runs out and stdout ends with one complete JSON object or
 * array, the child and its descendants are killed and the run returns exit code 0 with that
 * output, after one notice line naming the pid. A partial document never parses, so a child that
 * stopped mid-output still waits for its exit or its `signal`; a child that exits first keeps its
 * own status.
 *
 * Only for a verb that prints its document as its LAST act and exits, and whose silent work
 * before it is short and read-mostly: `denext commands --json` and `denext job --list` /
 * `--history` / `--clear-history --json` (which prints after the clear is done). Not for a child
 * that runs project work for long silent stretches after project code may have printed a JSON
 * value of its own (`denext db-admin`, whose statements and migrations write; `denext doctor`'s
 * route probes): a silence there is work, so those wait for their exit or their deadline.
 */
export interface JsonDocumentChild {
  /** The silence that settles a complete document (default `DENEXT_CHILD_EXIT_GRACE_MS`, 5 s). */
  readonly graceMs?: number;
  /** Where the notice goes (default: this process's stderr). */
  readonly onSettled?: (line: string) => void;
}

/**
 * What keeps a denext-CLI child off the network under `denext ui --offline`. `--deny-net` takes
 * precedence over `-A` (and refuses listening as well as connecting); `--cached-only` covers the
 * module loader, which the net permission does not govern — without it a child would still
 * download an uncached import.
 *
 * What neither flag reaches is a GRANDCHILD: `-A` grants `--allow-run`, and a process the child
 * spawns starts with whatever permissions the OS gives it, not Deno's. That is why the discovery
 * children add {@linkcode DENY_RUN} — see {@linkcode cliInvocation}.
 */
const OFFLINE_FLAGS: readonly string[] = ["--deny-net", "--cached-only"];

/**
 * What closes the grandchild gap for a child that only READS the project: `--deny-run` takes
 * precedence over `-A`, so a `denext.config.ts` (or a plugin `setup()`) evaluated inside
 * `denext commands --json` or `denext job --list --json` cannot reach the network through a
 * `curl` of its own. Those verbs never spawn anything themselves, so nothing legitimate is lost.
 */
const DENY_RUN: readonly string[] = ["--deny-run"];

/** Options for {@linkcode cliInvocation}. */
export interface CliInvocationOptions {
  /** `denext ui --offline`: the child may neither open a socket nor download a module. */
  readonly offline?: boolean;
  /**
   * The project the child will act on, which decides WHICH denext a compiled binary hands it
   * (see {@linkcode cliModule}).
   */
  readonly dir?: string;
  /**
   * Under `offline`, also refuse the child every subprocess (`--deny-run`). For a DISCOVERY
   * child — one that evaluates the project's config and prints a listing — so that config cannot
   * route around `--deny-net` by spawning. Never for a verb run or `denext doctor`: a project
   * verb may legitimately spawn (a `seed` that shells out), and doctor's route conformance runs
   * `deno` itself; those children keep `-A`, and the panel says so.
   */
  readonly denyRun?: boolean;
}

/**
 * The argv prefix that runs a denext CLI as a child process — under whatever scheme denext
 * itself was loaded from, so a checkout runs its `cli.ts` and an installed copy runs the JSR
 * one.
 *
 * @param options See {@linkcode CliInvocationOptions}.
 * @returns `["run", "-A", "<cli module>"]` (with the project's `--config` after `-A` for a remote
 *   CLI module, `--node-modules-dir=none` after that when `dir`
 *   is in a pnpm workspace, then `--deny-net --cached-only` when offline, then `--deny-run` when
 *   `denyRun` too), to be spread before the verb and its flags.
 */
export function cliInvocation(options: CliInvocationOptions = {}): string[] {
  const offline = options.offline === true ? OFFLINE_FLAGS : [];
  const denyRun = options.offline === true && options.denyRun === true ? DENY_RUN : [];
  // In a pnpm workspace, keep the CLI's own npm imports off the pnpm tree: Deno would otherwise
  // rewrite the workspace's root package.json (see ../build/pnpm-workspace.ts).
  const npm = cliNpmModeArgs(options.dir);
  const module = cliModule(options.dir);
  return [
    "run",
    "-A",
    ...cliConfigArgs(module, options.dir),
    ...npm,
    ...offline,
    ...denyRun,
    module,
  ];
}

/**
 * The `--config` a CLI child needs to read the project's config: a remote CLI module discovers
 * none (an https URL) or the WORKING directory's (`jsr:`), which need not be the project. A local
 * checkout's `cli.ts` keeps discovering its own, as the process that spawned it did.
 *
 * @param module The child's CLI module ({@linkcode cliModule}).
 * @param dir The project the child acts on, when known.
 * @returns `["--config", <the project's deno.json>]`, or `[]`.
 */
export function cliConfigArgs(module: string, dir: string | undefined): string[] {
  if (dir === undefined || module.startsWith("file:")) return [];
  const config = nearestConfig(dir);
  return config === null ? [] : ["--config", config];
}

/**
 * The module a child `deno run` should load as the CLI.
 *
 * Normally that is this framework's own `cli.ts`, under whatever scheme denext was loaded from.
 * Inside a `deno compile`d binary there is no such file: `import.meta.url` was baked in at
 * compile time and names the BUILD machine's checkout, which does not exist on the machine the
 * binary was shipped to, so the child loads a JSR specifier instead.
 *
 * WHICH version it loads follows the rule the binary's own verbs follow (`maybeReexecPinned` in
 * src/cli/run-verb.ts): the project's pin wins. `ui` is deliberately not a `loadsModules` verb,
 * so the UI process never defers on its own — without this the UI would run a project's verbs
 * under the binary's framework rather than the one the project pins, which is the exact
 * substitution that rule exists to prevent. Only a directory pinning no denext falls back to the binary's version.
 *
 * Under `--offline` a JSR specifier resolves only if it is already in the module cache: a binary
 * on a machine that never fetched that version fails loudly instead of reaching the network,
 * which is the guarantee `--offline` is making.
 *
 * @param dir The project the child will act on, when the caller knows it.
 * @returns The module specifier for the child.
 */
function cliModule(dir?: string): string {
  if (!isStandaloneBinary()) return frameworkFileUrl("cli.ts");
  const pinned = dir === undefined ? null : pinnedDenextCli(dir);
  return pinned ?? `jsr:@denext/denext@${VERSION}/cli`;
}

/** The outcome of a {@linkcode runDeno} call. */
export interface ProcResult {
  /** The child's exit code. */
  readonly code: number;
  /** Everything it wrote to stdout (the last {@linkcode STREAM_TAIL_CHARS} for a streamed run). */
  readonly stdout: string;
  /** Everything it wrote to stderr (the last {@linkcode STREAM_TAIL_CHARS} for a streamed run). */
  readonly stderr: string;
  /**
   * `stdout` parsed as JSON — how the UI consumes `denext doctor --json` and friends.
   *
   * @returns The parsed value, or `null` when stdout was not JSON.
   */
  json(): unknown;
}

/**
 * Run `deno <args>` in `opts.cwd` and collect its output. With `onLine`, stdout and stderr are
 * decoded and delivered line by line as they arrive (what the task runner streams over SSE) and
 * only a bounded tail is retained; without it the child is simply awaited and everything kept.
 * `opts.signal` is handed to the child, so aborting it — a client that disconnected, or the UI
 * server shutting down — kills the process rather than orphaning it.
 *
 * The output is read until the child EXITS (plus a short grace for what is still in the pipes),
 * not until every copy of its pipes closes: a process spawned elsewhere in this process at the
 * same moment inherits them on Windows, and a grandchild the child leaves running holds them on
 * every OS, and either would otherwise keep this call waiting for its whole life.
 *
 * @param args The `deno` argv (e.g. `["task", "test"]`), never shell-interpreted.
 * @param opts Working directory, streaming sink, abort signal, extra env.
 * @returns The exit code and captured output.
 */
export async function runDeno(args: string[], opts: RunDenoOptions): Promise<ProcResult> {
  const child = new Deno.Command(opts.deno ?? denoExecutable(), {
    args,
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
    signal: opts.signal,
  }).spawn();
  if (opts.stdin !== undefined) await writeStdin(child, opts.stdin);
  const streaming = opts.onLine !== undefined;
  const stdout = sinkOf(streaming);
  const stderr = sinkOf(streaming);
  const watch = opts.jsonDocument === undefined ? undefined : new DocumentWatch(opts.jsonDocument);
  const reads = Promise.all([
    child.status,
    pump(child.stdout, child.status, stdout, opts.onLine, watch),
    pump(child.stderr, child.status, stderr, opts.onLine, watch, false),
  ]);
  const ended = await Promise.race([reads, watch?.settled ?? new Promise<never>(() => {})]);
  watch?.stop();
  if (ended !== "settled") return result(ended[0].code, stdout.text(), stderr.text());
  // Exited in the same turn: its own status stands.
  const exited = await Promise.race([child.status, Promise.resolve(null)]);
  if (exited !== null) {
    const [{ code }] = await reads;
    return result(code, stdout.text(), stderr.text());
  }
  await killTree(child, reads);
  watch!.notify(child.pid);
  return result(0, stdout.text(), stderr.text());
}

/**
 * The silence watch of a {@linkcode JsonDocumentChild}: each chunk restarts it, and when it runs
 * out with a complete document on stdout, {@linkcode settled} resolves.
 */
class DocumentWatch {
  readonly #graceMs: number;
  readonly #onSettled: (line: string) => void;
  readonly #stdout: string[] = [];
  #quiet: ReturnType<typeof setTimeout> | undefined;
  #watching: boolean;
  #settle: (v: "settled") => void = () => {};
  /** Resolves once a complete document has been followed by the grace's silence. */
  readonly settled = new Promise<"settled">((r) => this.#settle = r);

  constructor(options: JsonDocumentChild) {
    this.#graceMs = options.graceMs ?? childExitGraceMs();
    this.#onSettled = options.onSettled ?? writeStderr;
    this.#watching = Number.isFinite(this.#graceMs);
  }

  /** A chunk arrived (`text` is stdout's, `undefined` stderr's). */
  chunk(text: string | undefined): void {
    if (text !== undefined) this.#stdout.push(text);
    if (!this.#watching) return;
    clearTimeout(this.#quiet);
    this.#quiet = setTimeout(() => {
      if (completeDocument(this.#stdout.join(""))) this.#settle("settled");
    }, this.#graceMs);
  }

  /** The outcome is decided: no more timers. */
  stop(): void {
    this.#watching = false;
    clearTimeout(this.#quiet);
  }

  /** Report the killed child. */
  notify(pid: number): void {
    this.#onSettled(
      `warning: deno child (pid ${pid}): output complete; the process did not exit ` +
        `${this.#graceMs / 1000} s after its last output and was killed; its output is used ` +
        "(DENEXT_CHILD_EXIT_GRACE_MS sets the grace)",
    );
  }
}

/**
 * Whether `stdout` ENDS with one complete JSON object or array: the whole of it, or the bare-`{`
 * to bare-`}` span a pretty-printing verb writes ({@linkcode parseJsonDocument}) when that span
 * closes on stdout's last line. A document still being written never parses, and one followed by
 * more output (a JSON value a project logged early, then a progress line) is not the answer.
 */
function completeDocument(stdout: string): boolean {
  const text = stdout.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      JSON.parse(text);
      return true;
    } catch { /* not the whole of it; try the span */ }
  }
  return /(^|\n)\}$/.test(text.replace(/\r/g, "")) && parseJsonDocument(stdout) !== null;
}

/**
 * Kill `child` and everything it started (a CLI child re-execs itself, and the process that spins
 * may be a descendant): `taskkill /T /F` by its exact pid on Windows; elsewhere each descendant
 * `pgrep -P` finds, deepest first; then the child itself. Waits for its exit and `reads`, at most
 * 10 s.
 */
async function killTree(child: Deno.ChildProcess, reads: Promise<unknown>): Promise<void> {
  if (Deno.build.os === "windows") {
    await quietly("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  } else {
    for (const pid of (await descendants(child.pid)).reverse()) {
      try {
        Deno.kill(pid, "SIGKILL");
      } catch { /* exited meanwhile */ }
    }
  }
  try {
    child.kill("SIGKILL");
  } catch { /* exited meanwhile */ }
  let grace: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([reads, new Promise((r) => grace = setTimeout(r, 10_000))]);
  clearTimeout(grace);
}

/** Every descendant of `pid` (`pgrep -P`, breadth first); none when `pgrep` is missing. */
async function descendants(pid: number): Promise<number[]> {
  const found: number[] = [];
  for (let i = -1; i < found.length; i++) {
    const parent = i < 0 ? pid : found[i];
    const out = await quietly("pgrep", ["-P", String(parent)]);
    for (const line of out.split("\n")) {
      const n = Number(line.trim());
      if (Number.isInteger(n) && n > 0 && !found.includes(n)) found.push(n);
    }
  }
  return found;
}

/** Run `cmd` with `args` and return its stdout ("" when it cannot run). */
async function quietly(cmd: string, args: string[]): Promise<string> {
  try {
    const out = await new Deno.Command(cmd, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    })
      .output();
    return new TextDecoder().decode(out.stdout);
  } catch {
    return "";
  }
}

function writeStderr(line: string): void {
  try {
    Deno.stderr.writeSync(new TextEncoder().encode(`${line}\n`));
  } catch { /* stderr closed */ }
}

/** Where one child stream's decoded text is collected. */
interface Sink {
  /** Append one decoded chunk. */
  push(text: string): void;
  /** Everything collected (the tail, for a streamed run). */
  text(): string;
}

/**
 * A capture sink: every chunk for a plain run, a bounded tail for a streamed one.
 *
 * @param streaming Whether the caller is already consuming the output line by line.
 * @returns The sink.
 */
function sinkOf(streaming: boolean): Sink {
  const parts: string[] = [];
  let length = 0;
  return {
    push(text: string): void {
      parts.push(text);
      length += text.length;
      while (streaming && parts.length > 1 && length - parts[0].length >= STREAM_TAIL_CHARS) {
        length -= (parts.shift() as string).length;
      }
    },
    text(): string {
      return parts.join("");
    },
  };
}

/** Feed the child its program, then close the pipe so it stops reading. */
async function writeStdin(child: Deno.ChildProcess, input: string): Promise<void> {
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
}

/** Assemble a {@linkcode ProcResult} (its `json()` never throws). */
function result(code: number, stdout: string, stderr: string): ProcResult {
  return {
    code,
    stdout,
    stderr,
    json(): unknown {
      try {
        return JSON.parse(stdout);
      } catch {
        return null;
      }
    },
  };
}

/** Longest partial line {@link pump} holds for `onLine` before delivering it as is. */
const MAX_PENDING_LINE = 64 * 1024;

/**
 * Decode one child stream into `sink`, emitting complete lines to `onLine` as they arrive, until
 * the stream ends or the child has exited (see {@linkcode drainUntilExit}).
 */
async function pump(
  stream: ReadableStream<Uint8Array>,
  exited: Promise<unknown>,
  sink: Sink,
  onLine?: (line: string) => void,
  watch?: DocumentWatch,
  isStdout = true,
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  await drainUntilExit(stream, exited, (chunk) => {
    const text = decoder.decode(chunk, { stream: true });
    sink.push(text);
    watch?.chunk(isStdout ? text : undefined);
    if (!onLine) return;
    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line);
    // A child that never prints a newline (a \r progress bar, one huge blob) would otherwise
    // be held whole until it exits: past the cap the partial line goes out as a line.
    if (pending.length > MAX_PENDING_LINE) {
      onLine(pending);
      pending = "";
    }
  });
  if (onLine && pending.length > 0) onLine(pending);
}
