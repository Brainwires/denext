// A request body as text, capped while it streams and bounded in time: shared by the endpoints
// that take a small JSON body from a page (the dev server's DevTools sink, the Deno Desktop
// bridge's RPC).

/** Returned by {@link readCapped} when the body stalled, ran past its deadline or was aborted. */
export const TIMED_OUT: unique symbol = Symbol("timed_out");

/** Default longest wait (ms) for the next body chunk before {@link readCapped} gives up. */
export const READ_CAPPED_IDLE_MS = 15_000;

/** Default longest time (ms) {@link readCapped} spends on a whole body, however it trickles. */
export const READ_CAPPED_TOTAL_MS = 60_000;

/** Time bounds and cancellation for {@link readCapped}. */
export interface ReadCappedOptions {
  /** Longest wait for the next chunk, in ms (default {@link READ_CAPPED_IDLE_MS}). */
  idleMs?: number;
  /** Longest time for the whole body, in ms (default {@link READ_CAPPED_TOTAL_MS}). */
  totalMs?: number;
  /** Stops the read when aborted (the request's own signal always does). */
  signal?: AbortSignal;
}

/**
 * The body as text, `null` once it passes `max` bytes, or {@link TIMED_OUT} when no chunk
 * arrives for `idleMs`, the whole body takes longer than `totalMs`, or `signal` (or the
 * request's own signal) aborts — counted while it streams, so a body without (or lying about)
 * `content-length` is cut off at the cap instead of buffered whole, and a body trickled or held
 * open cannot pin the handler. The body stream is cancelled whenever the read stops early.
 *
 * @param request The request whose body to read.
 * @param max The most bytes accepted.
 * @param options Time bounds and an extra abort signal.
 * @returns The decoded body (`""` when there is none), `null` past the cap, or
 *   {@link TIMED_OUT}.
 */
export async function readCapped(
  request: Request,
  max: number,
  options: ReadCappedOptions = {},
): Promise<string | null | typeof TIMED_OUT> {
  if (!request.body) return "";
  const signals = [request.signal, options.signal].filter((s): s is AbortSignal => !!s);
  const signal = AbortSignal.any([
    ...signals,
    AbortSignal.timeout(options.totalMs ?? READ_CAPPED_TOTAL_MS),
  ]);
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const step = await nextChunk(reader, signal, options.idleMs ?? READ_CAPPED_IDLE_MS);
    if (step === TIMED_OUT) {
      await reader.cancel().catch(() => {});
      return TIMED_OUT;
    }
    if (step.done) break;
    size += step.value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(step.value, { stream: true });
  }
  return text + decoder.decode();
}

/** The next read, or {@link TIMED_OUT} once `idleMs` passes or `signal` aborts first. */
function nextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  idleMs: number,
): Promise<ReadableStreamReadResult<Uint8Array> | typeof TIMED_OUT> {
  if (signal.aborted) return Promise.resolve(TIMED_OUT);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = { resolve: () => {} };
  const stop = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), idleMs);
    onAbort.resolve = () => resolve(TIMED_OUT);
    signal.addEventListener("abort", onAbort.resolve, { once: true });
  });
  return Promise.race([reader.read(), stop]).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort.resolve);
  });
}
