// Every piece of work `denext ui` does that would otherwise need the user's modules runs here,
// as a `deno` subprocess. That is the hard rule of the UI process: it never imports project
// code, so no user config, plugin, or dependency is ever evaluated inside the UI server — which
// is also what keeps the bundler (esbuild) out of the `denext ui` module graph entirely.
//
// Array args only, never a shell: a task name or package spec that came from the browser cannot
// become a command.

import { denoExecutable, frameworkFileUrl } from "../build/bundle.ts";
import { isStandaloneBinary, pinnedDenextCli } from "../cli/self-exec.ts";
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
}

/**
 * What keeps a denext-CLI child off the network under `denext ui --offline`. `--deny-net` takes
 * precedence over `-A` (and refuses listening as well as connecting); `--cached-only` covers the
 * module loader, which the net permission does not govern — without it a child would still
 * download an uncached import.
 */
const OFFLINE_FLAGS: readonly string[] = ["--deny-net", "--cached-only"];

/**
 * The argv prefix that runs a denext CLI as a child process — under whatever scheme denext
 * itself was loaded from, so a checkout runs its `cli.ts` and an installed copy runs the JSR
 * one.
 *
 * @param options `offline`: `denext ui --offline` — the child may neither open a socket nor
 *   download a module. `dir`: the project the child will act on, which decides WHICH denext a
 *   compiled binary hands it (see {@linkcode cliModule}).
 * @returns `["run", "-A", "<cli module>"]` (with `--deny-net --cached-only` after `-A`
 *   when offline), to be spread before the verb and its flags.
 */
export function cliInvocation(
  options: { readonly offline?: boolean; readonly dir?: string } = {},
): string[] {
  const offline = options.offline === true ? OFFLINE_FLAGS : [];
  return ["run", "-A", ...offline, cliModule(options.dir)];
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
 * cli.ts): the project's pin wins. `ui` is deliberately not a `loadsModules` verb, so the UI
 * process never defers on its own — without this the UI would run a project's verbs under the
 * binary's framework rather than the one the project pins, which is the exact substitution that
 * rule exists to prevent. Only a directory pinning no denext falls back to the binary's version.
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
 * @param args The `deno` argv (e.g. `["task", "test"]`), never shell-interpreted.
 * @param opts Working directory, streaming sink, abort signal, extra env.
 * @returns The exit code and captured output.
 */
export async function runDeno(args: string[], opts: RunDenoOptions): Promise<ProcResult> {
  const child = new Deno.Command(denoExecutable(), {
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
  await Promise.all([
    pump(child.stdout, stdout, opts.onLine),
    pump(child.stderr, stderr, opts.onLine),
  ]);
  const { code } = await child.status;
  return result(code, stdout.text(), stderr.text());
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

/** Decode one child stream into `sink`, emitting complete lines to `onLine` as they arrive. */
/** Longest partial line {@link pump} holds for `onLine` before delivering it as is. */
const MAX_PENDING_LINE = 64 * 1024;

async function pump(
  stream: ReadableStream<Uint8Array>,
  sink: Sink,
  onLine?: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    sink.push(text);
    if (!onLine) continue;
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
  }
  if (onLine && pending.length > 0) onLine(pending);
}
