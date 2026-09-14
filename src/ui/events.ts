// The UI's two event channels, in one place.
//
//   * BROADCAST — the `/_ui/events` stream every open page subscribes to. Anything that changes
//     the project (a task finished, a plugin was wired, `denext dev` came up) is pushed here as
//     one JSON frame, so a second tab is never stale. `ui.js` dispatches on the frame's `type`.
//   * PER-REQUEST — the streamed answer to one mutation: a child process's output, line by line,
//     as SSE `data:` frames, closing with `— exited <code>`.
//
// Both live here rather than in `routes.ts` because every `features/*.ts` module needs them and
// `routes.ts` imports the features: the dependency runs one way (`features → events → proc`),
// so there is no cycle.

import { type SseClients, sseSend } from "../build/sse.ts";

/**
 * Push a JSON event to every open UI page.
 *
 * @param clients The `/_ui/events` subscribers.
 * @param event A JSON-serialisable payload (its `type` is what `ui.js` dispatches on).
 */
export function broadcast(clients: SseClients, event: unknown): void {
  sseSend(clients, JSON.stringify(event));
}

/** A finished run, as {@linkcode sseProcess} reports it in the closing frame. */
export interface SseRun {
  /** The child's exit code. */
  readonly code: number;
  /** Appended to the closing frame (e.g. `wrote denext.config.ts`). */
  readonly note?: string;
}

/** Options for {@linkcode sseProcess}. */
export interface SseProcessOptions {
  /** Frames written before the child starts (e.g. the command line it is about to run). */
  readonly prelude?: readonly string[];
  /**
   * Called once the stream is closing, with the exit code — or `null` when the run threw.
   * The place to {@linkcode broadcast} "this finished" to every other open page.
   */
  readonly settled?: (code: number | null) => void;
}

/** One SSE `data:` frame; a line break inside a line would end the frame, so it is flattened. */
function frameOf(line: string): string {
  return `data: ${line.replace(/\r?\n/g, " ")}\n\n`;
}

/**
 * The last line of every run, so a reader can tell "finished" from "still going" — the closing
 * SSE frame, and the same line a non-streaming run appends to its captured output.
 *
 * @param run The exit code, or a code with a note to append.
 * @returns The line.
 */
export function exitLine(run: number | SseRun): string {
  if (typeof run === "number") return `— exited ${run}`;
  return run.note ? `— exited ${run.code}, ${run.note}` : `— exited ${run.code}`;
}

/**
 * Turn one child-process run into a `text/event-stream` response: every line it writes becomes
 * a `data:` frame as it arrives, and the stream closes with `— exited <code>` (or
 * `— failed: <reason>` when the run itself threw). A page that navigated away mid-run simply
 * drops the frames — a write to a closed stream is never an error here.
 *
 * @param start Starts the run; call its `line` argument per output line (it is `runDeno`'s
 *   `onLine`). Resolve with the exit code, or an {@linkcode SseRun} to add to the closing frame.
 * @param options Prelude frames and the "this run settled" hook.
 * @returns The event-stream response.
 */
export function sseProcess(
  start: (line: (text: string) => void) => Promise<number | SseRun>,
  options: SseProcessOptions = {},
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const frame = (line: string): void => {
    writer.write(encoder.encode(frameOf(line))).catch(() => {/* the page navigated away */});
  };
  for (const line of options.prelude ?? []) frame(line);
  let code: number | null = null;
  start(frame)
    .then((run) => {
      code = typeof run === "number" ? run : run.code;
      frame(exitLine(run));
    })
    .catch((error) => frame(`— failed: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => {
      options.settled?.(code);
      writer.close().catch(() => {/* already closed by the client */});
    });
  return new Response(readable, { headers: { "content-type": "text/event-stream" } });
}
