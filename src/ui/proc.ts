// Every piece of work `denext ui` does that would otherwise need the user's modules runs here,
// as a `deno` subprocess. That is the hard rule of the UI process: it never imports project
// code, so no user config, plugin, or dependency is ever evaluated inside the UI server — which
// is also what keeps the bundler (esbuild) out of the `denext ui` module graph entirely.
//
// Array args only, never a shell: a task name or package spec that came from the browser cannot
// become a command.

import { denoExecutable } from "../build/bundle.ts";

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
}

/** The outcome of a {@linkcode runDeno} call. */
export interface ProcResult {
  /** The child's exit code. */
  readonly code: number;
  /** Everything it wrote to stdout. */
  readonly stdout: string;
  /** Everything it wrote to stderr. */
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
 * decoded and delivered line by line as they arrive (what the task runner streams over SSE);
 * without it the child is simply awaited.
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
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal: opts.signal,
  }).spawn();
  const stdout: string[] = [];
  const stderr: string[] = [];
  await Promise.all([
    pump(child.stdout, stdout, opts.onLine),
    pump(child.stderr, stderr, opts.onLine),
  ]);
  const { code } = await child.status;
  return result(code, stdout.join(""), stderr.join(""));
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
async function pump(
  stream: ReadableStream<Uint8Array>,
  sink: string[],
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
  }
  if (onLine && pending.length > 0) onLine(pending);
}
